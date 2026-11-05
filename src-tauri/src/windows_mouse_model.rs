// Windows native adapter profile, not an AXTP registry bit assignment. Mouse
// records must carry explicit button semantics; gesture interpretation belongs
// to the receiver. Zero-button Touch DOWN records are never inferred as clicks.
#[derive(Clone, Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Record {
    pub contact_id: u16,
    pub phase: u8,
    pub x: u16,
    pub y: u16,
    #[serde(default)]
    pub buttons: u8,
    #[serde(default)]
    pub modifiers: u16,
    #[serde(default)]
    pub wheel: i16,
    #[serde(default)]
    pub dt_ms: u16,
    #[serde(default)]
    pub record_flags: u16,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct MouseState {
    pub contact: Option<u16>,
    pub buttons: u8,
    pub owned_modifiers: u16,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Event {
    Move(u16, u16),
    Button(u8, bool),
    Key(u16, bool),
    Wheel(i16),
}

#[derive(Clone, Debug)]
pub struct Step {
    pub event: Event,
    pub after: MouseState,
}

fn emit(plan: &mut Vec<Step>, state: MouseState, event: Event) {
    plan.push(Step {
        event,
        after: state,
    });
}

pub fn reset_plan(mut state: MouseState) -> Vec<Step> {
    let mut plan = Vec::new();
    for button in [1, 2, 4] {
        if state.buttons & button != 0 {
            state.buttons &= !button;
            state.contact = None;
            emit(&mut plan, state, Event::Button(button, false));
        }
    }
    for key in [1, 2, 4, 8] {
        if state.owned_modifiers & key != 0 {
            state.owned_modifiers &= !key;
            emit(&mut plan, state, Event::Key(key, false));
        }
    }
    plan
}

// Validate the entire batch before the first OS call. Every planned event has
// a state checkpoint so even a partially accepted SendInput retains ownership
// of exactly the buttons/keys that a subsequent reset must release.
pub fn batch_plan(
    mut state: MouseState,
    records: &[Record],
    physical_modifiers: u16,
) -> Result<Vec<Step>, String> {
    if records.is_empty() || records.len() > 1024 {
        return Err("invalid_windows_mouse_batch".into());
    }
    let mut plan = Vec::new();
    let borrowed_modifiers = physical_modifiers & !state.owned_modifiers;
    for record in records {
        if record.record_flags != 0
            || record.modifiers & !15 != 0
            || ![0, 1, 2, 4].contains(&record.buttons)
        {
            return Err("not_supported_windows_mouse_fields".into());
        }
        let _ = record.dt_ms; // Ordered DataChannel delivery supplies timing.
        let button = record.buttons;
        match record.phase {
            0 if state.contact.is_none() && state.buttons == 0 && button != 0 => {}
            1 if state.contact.map_or(record.buttons == 0, |id| {
                id == record.contact_id && record.buttons == state.buttons
            }) => {}
            2 | 3
                if state.contact == Some(record.contact_id)
                    && (record.buttons == 0 || record.buttons == state.buttons) => {}
            _ => return Err("invalid_windows_mouse_contact_lifecycle".into()),
        }
        let desired = if record.phase == 3 {
            0
        } else {
            record.modifiers
        };
        for key in [1, 2, 4, 8] {
            let was_owned = state.owned_modifiers & key != 0;
            let own = desired & key != 0 && borrowed_modifiers & key == 0;
            if was_owned != own {
                if own {
                    state.owned_modifiers |= key;
                } else {
                    state.owned_modifiers &= !key;
                }
                emit(&mut plan, state, Event::Key(key, own));
            }
        }
        emit(&mut plan, state, Event::Move(record.x, record.y));
        if record.phase == 0 {
            state.contact = Some(record.contact_id);
            state.buttons = button;
            emit(&mut plan, state, Event::Button(button, true));
        } else if record.phase >= 2 {
            let held = state.buttons;
            state.buttons = 0;
            state.contact = None;
            emit(&mut plan, state, Event::Button(held, false));
        }
        if record.wheel != 0 && record.phase != 3 {
            emit(&mut plan, state, Event::Wheel(record.wheel));
        }
    }
    Ok(plan)
}

pub fn commit_prefix(state: &mut MouseState, plan: &[Step], sent: usize) {
    if let Some(step) = plan
        .get(sent.min(plan.len()).saturating_sub(1))
        .filter(|_| sent > 0)
    {
        *state = step.after;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn record(phase: u8) -> Record {
        Record {
            contact_id: 42,
            phase,
            x: 0,
            y: 65535,
            buttons: 0,
            modifiers: 0,
            wheel: 0,
            dt_ms: 0,
            record_flags: 0,
        }
    }
    fn events(plan: &[Step]) -> Vec<Event> {
        plan.iter().map(|step| step.event).collect()
    }

    #[test]
    fn explicit_primary_records_become_drag_and_release() {
        let mut down = record(0);
        down.buttons = 1;
        let mut drag = record(1);
        drag.buttons = 1;
        let plan = batch_plan(MouseState::default(), &[down, drag, record(2)], 0).unwrap();
        assert_eq!(
            events(&plan),
            vec![
                Event::Move(0, 65535),
                Event::Button(1, true),
                Event::Move(0, 65535),
                Event::Move(0, 65535),
                Event::Button(1, false)
            ]
        );
        assert_eq!(plan.last().unwrap().after, MouseState::default());
    }
    #[test]
    fn zero_button_touch_records_are_not_guessed_as_primary_mouse_input() {
        assert!(batch_plan(MouseState::default(), &[record(0), record(1), record(2)], 0).is_err());
    }
    #[test]
    fn explicit_buttons_and_signed_wheel_are_preserved() {
        for button in [1, 2, 4] {
            let mut down = record(0);
            down.buttons = button;
            let plan = batch_plan(MouseState::default(), &[down, record(3)], 0).unwrap();
            assert!(events(&plan).contains(&Event::Button(button, true)));
            assert_eq!(plan.last().unwrap().event, Event::Button(button, false));
        }
        let mut hover = record(1);
        hover.wheel = -120;
        assert_eq!(
            events(&batch_plan(MouseState::default(), &[hover], 0).unwrap()),
            vec![Event::Move(0, 65535), Event::Wheel(-120)]
        );
    }
    #[test]
    fn reset_releases_owned_buttons_and_modifiers_but_preserves_borrowed_keys() {
        let mut down = record(0);
        down.buttons = 1;
        down.modifiers = 3;
        let plan = batch_plan(MouseState::default(), &[down], 1).unwrap();
        assert!(
            !events(&plan).contains(&Event::Key(1, true)),
            "locally held Shift must not become owned"
        );
        assert_eq!(
            events(&reset_plan(plan.last().unwrap().after)),
            vec![Event::Button(1, false), Event::Key(2, false)]
        );
    }
    #[test]
    fn malformed_late_record_rejects_whole_batch_without_a_plan() {
        let mut down = record(0);
        down.buttons = 1;
        let mut invalid = record(1);
        invalid.contact_id = 43;
        assert!(batch_plan(MouseState::default(), &[down, invalid], 0).is_err());
        for field in [1, 2, 3] {
            let mut invalid = record(1);
            match field {
                1 => invalid.buttons = 8,
                2 => invalid.modifiers = 16,
                _ => invalid.record_flags = 1,
            }
            assert!(batch_plan(MouseState::default(), &[invalid], 0).is_err());
        }
        assert!(batch_plan(MouseState::default(), &[record(2)], 0).is_err());
        assert!(batch_plan(MouseState::default(), &vec![record(1); 1025], 0).is_err());
    }
    #[test]
    fn partial_send_retains_only_the_inserted_prefix_for_cleanup() {
        let mut down = record(0);
        down.buttons = 1;
        down.modifiers = 2;
        let plan = batch_plan(MouseState::default(), &[down], 0).unwrap();
        let mut state = MouseState::default();
        commit_prefix(&mut state, &plan, 0);
        assert_eq!(state, MouseState::default());
        commit_prefix(&mut state, &plan, 1);
        assert_eq!(events(&reset_plan(state)), vec![Event::Key(2, false)]);
        commit_prefix(&mut state, &plan, plan.len());
        assert_eq!(
            events(&reset_plan(state)),
            vec![Event::Button(1, false), Event::Key(2, false)]
        );
    }
}
