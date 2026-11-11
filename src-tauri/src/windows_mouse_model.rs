// Local typed Mouse output; these events are not AXTP wire records.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct State {
    pub buttons: u32,
    pub owned_modifiers: u16,
    pub scroll: Option<Scroll>,
}
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Scroll {
    pub x: f64,
    pub y: f64,
    pub remainder_x: f64,
    pub remainder_y: f64,
}
#[derive(Clone, Copy, Debug)]
pub struct Wheel {
    pub unit: u8,
    pub phase: u8,
    pub x: i32,
    pub y: i32,
}
#[derive(Clone, Copy, Debug)]
pub struct Action {
    pub kind: u8,
    pub buttons: u32,
    pub modifiers: u16,
    pub x: f64,
    pub y: f64,
    pub wheel: Option<Wheel>,
}
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Event {
    Move(i32, i32),
    Button(u32, bool),
    Key(u16, bool),
    Wheel(bool, i32),
}
#[derive(Clone, Copy, Debug)]
pub struct Step {
    pub event: Event,
    pub after: State,
}
pub struct Plan {
    pub steps: Vec<Step>,
    pub after: State,
}

fn emit(steps: &mut Vec<Step>, state: State, event: Event) {
    steps.push(Step {
        event,
        after: state,
    });
}
pub fn reset_plan(mut state: State) -> Plan {
    let mut steps = vec![];
    for button in [1, 2, 4, 8, 16] {
        if state.buttons & button != 0 {
            state.buttons &= !button;
            emit(&mut steps, state, Event::Button(button, false));
        }
    }
    for key in [1, 2, 4, 8] {
        if state.owned_modifiers & key != 0 {
            state.owned_modifiers &= !key;
            emit(&mut steps, state, Event::Key(key, false));
        }
    }
    state.scroll = None;
    Plan {
        steps,
        after: state,
    }
}
pub fn absolute(x: f64, y: f64, region: [f64; 4]) -> Result<(i32, i32), String> {
    let [left, top, width, height] = region;
    if ![x, y, left, top, width, height]
        .iter()
        .all(|v| v.is_finite())
        || width < 1.0
        || height < 1.0
        || x < left
        || y < top
        || x > left + width - 1.0
        || y > top + height - 1.0
    {
        return Err("invalid_virtual_desktop_point".into());
    }
    // Select the center of a physical pixel's SendInput bin, rather than
    // endpoints that can round to an adjacent pixel on a multi-monitor desktop.
    let axis = |p: f64, start: f64, size: f64| {
        (((p - start + 0.5) * 65536.0 / size).floor() as i32).clamp(0, 65535)
    };
    Ok((axis(x, left, width), axis(y, top, height)))
}
fn wheel_delta(value: i32, extent: f64, remainder: f64) -> Result<(i32, f64), String> {
    // Match the macOS adapter's 40 display units per detent. Win32 receives
    // 120 units per detent; fractional movement is retained until a full unit.
    let delta = f64::from(value) / 65536.0 * (extent - 1.0) * 3.0 + remainder;
    if !delta.is_finite() || delta.abs() > 3_000_000.0 {
        return Err("wheel_delta_out_of_range".into());
    }
    let rounded = delta.round();
    Ok((rounded as i32, delta - rounded))
}
pub fn plan(
    mut state: State,
    a: Action,
    physical: u16,
    width: f64,
    height: f64,
) -> Result<Plan, String> {
    if a.kind > 4
        || a.buttons & !31 != 0
        || a.modifiers & !15 != 0
        || !width.is_finite()
        || !height.is_finite()
        || width < 1.0
        || height < 1.0
    {
        return Err("unsupported_native_mouse_fields".into());
    }
    if a.kind == 3 {
        if a.wheel.is_some() {
            return Err("unexpected_mouse_wheel".into());
        }
        return Ok(reset_plan(state));
    }
    if (a.kind == 2) != a.wheel.is_some() {
        return Err("mouse_wheel_fields".into());
    }
    if a.kind != 4
        && (!a.x.is_finite()
            || !a.y.is_finite()
            || a.x.abs() > i32::MAX as f64
            || a.y.abs() > i32::MAX as f64)
    {
        return Err("invalid_native_mouse_point".into());
    }
    if a.kind == 1 {
        if a.buttons == state.buttons {
            return Err("native_mouse_transition_missing".into());
        }
    } else if a.kind != 4 && a.buttons != state.buttons {
        return Err("native_mouse_implicit_buttons".into());
    }
    let mut steps = vec![];
    let borrowed = physical & !state.owned_modifiers;
    for key in [1, 2, 4, 8] {
        let owned = state.owned_modifiers & key != 0;
        let desired = a.modifiers & key != 0 && borrowed & key == 0;
        if owned != desired {
            if desired {
                state.owned_modifiers |= key;
            } else {
                state.owned_modifiers &= !key;
            }
            emit(&mut steps, state, Event::Key(key, desired));
        }
    }
    if a.kind != 4 {
        emit(
            &mut steps,
            state,
            Event::Move(a.x.round() as i32, a.y.round() as i32),
        );
    }
    if a.kind == 1 {
        let old = state.buttons;
        for button in [1, 2, 4, 8, 16] {
            if old & button != 0 && a.buttons & button == 0 {
                state.buttons &= !button;
                emit(&mut steps, state, Event::Button(button, false));
            }
        }
        for button in [1, 2, 4, 8, 16] {
            if old & button == 0 && a.buttons & button != 0 {
                state.buttons |= button;
                emit(&mut steps, state, Event::Button(button, true));
            }
        }
    }
    if let Some(wheel) = a.wheel {
        let (dx, dy) = match wheel.unit {
            0 => {
                if wheel.phase != 0 || (wheel.x == 0 && wheel.y == 0) || state.scroll.is_some() {
                    return Err("invalid_detent_scroll".into());
                }
                (wheel.x, wheel.y)
            }
            1 => {
                if !(1..=4).contains(&wheel.phase)
                    || (wheel.phase >= 3 && (wheel.x != 0 || wheel.y != 0))
                {
                    return Err("invalid_scroll_phase".into());
                }
                if (wheel.phase == 1 && state.scroll.is_some())
                    || (wheel.phase != 1 && state.scroll.is_none())
                {
                    return Err("invalid_scroll_lifecycle".into());
                }
                let previous = state.scroll.unwrap_or(Scroll {
                    x: a.x,
                    y: a.y,
                    remainder_x: 0.0,
                    remainder_y: 0.0,
                });
                if previous.x != a.x || previous.y != a.y {
                    return Err("scroll_anchor_changed".into());
                }
                if wheel.phase >= 3 {
                    state.scroll = None;
                    (0, 0)
                } else {
                    let (dx, rx) = wheel_delta(wheel.x, width, previous.remainder_x)?;
                    let (dy, ry) = wheel_delta(wheel.y, height, previous.remainder_y)?;
                    state.scroll = Some(Scroll {
                        remainder_x: rx,
                        remainder_y: ry,
                        ..previous
                    });
                    (dx, dy)
                }
            }
            _ => return Err("unsupported_wheel_unit".into()),
        };
        if dx != 0 {
            emit(&mut steps, state, Event::Wheel(true, dx));
        }
        if dy != 0 {
            emit(&mut steps, state, Event::Wheel(false, dy));
        }
    }
    Ok(Plan {
        steps,
        after: state,
    })
}
pub fn commit_prefix(state: &mut State, plan: &Plan, sent: usize) {
    if sent == plan.steps.len() {
        *state = plan.after;
    } else if sent > 0 {
        *state = plan.steps[sent.min(plan.steps.len()) - 1].after;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn action(kind: u8, buttons: u32, modifiers: u16) -> Action {
        Action {
            kind,
            buttons,
            modifiers,
            x: -100.0,
            y: 120.0,
            wheel: None,
        }
    }
    fn events(plan: &Plan) -> Vec<Event> {
        plan.steps.iter().map(|step| step.event).collect()
    }
    #[test]
    fn typed_mouse_buttons_drag_and_reset_preserve_borrowed_modifiers() {
        let down = plan(State::default(), action(1, 1, 3), 1, 1920.0, 1080.0).unwrap();
        assert_eq!(
            events(&down),
            vec![
                Event::Key(2, true),
                Event::Move(-100, 120),
                Event::Button(1, true)
            ]
        );
        let drag = plan(down.after, action(0, 1, 3), 1, 1920.0, 1080.0).unwrap();
        assert_eq!(events(&drag), vec![Event::Move(-100, 120)]);
        assert_eq!(
            events(&reset_plan(drag.after)),
            vec![Event::Button(1, false), Event::Key(2, false)]
        );
        for button in [1, 2, 4, 8, 16, 31] {
            let down = plan(State::default(), action(1, button, 0), 0, 1920.0, 1080.0).unwrap();
            let up = plan(down.after, action(1, 0, 0), 0, 1920.0, 1080.0).unwrap();
            for bit in [1, 2, 4, 8, 16] {
                if button & bit != 0 {
                    assert!(events(&up).contains(&Event::Button(bit, false)));
                }
            }
            assert_eq!(up.after, State::default());
        }
    }
    #[test]
    fn wheel_units_horizontal_axis_and_continuous_anchor_are_preserved() {
        let mut a = action(2, 0, 2);
        a.wheel = Some(Wheel {
            unit: 0,
            phase: 0,
            x: -120,
            y: 240,
        });
        assert!(
            events(&plan(State::default(), a, 0, 1001.0, 1001.0).unwrap())
                .ends_with(&[Event::Wheel(true, -120), Event::Wheel(false, 240)])
        );
        a.modifiers = 0;
        a.wheel = Some(Wheel {
            unit: 1,
            phase: 1,
            x: 0,
            y: 65536,
        });
        let start = plan(State::default(), a, 0, 1001.0, 1001.0).unwrap();
        assert!(events(&start).contains(&Event::Wheel(false, 3000)));
        a.x += 1.0;
        a.wheel.as_mut().unwrap().phase = 2;
        assert!(plan(start.after, a, 0, 1001.0, 1001.0).is_err());
        a.x -= 1.0;
        a.wheel = Some(Wheel {
            unit: 1,
            phase: 3,
            x: 0,
            y: 0,
        });
        assert!(plan(start.after, a, 0, 1001.0, 1001.0)
            .unwrap()
            .after
            .scroll
            .is_none());
    }
    #[test]
    fn continuous_scroll_accumulates_sub_unit_deltas_and_cancel_releases_modifiers() {
        let mut a = action(2, 0, 2);
        a.wheel = Some(Wheel {
            unit: 1,
            phase: 1,
            x: 0,
            y: 1,
        });
        let mut state = State::default();
        let mut sum = 0;
        for index in 0..4 {
            a.wheel.as_mut().unwrap().phase = if index == 0 { 1 } else { 2 };
            let p = plan(state, a, 0, 1001.0, 5462.333333333333).unwrap();
            sum += p
                .steps
                .iter()
                .map(|step| {
                    if let Event::Wheel(false, v) = step.event {
                        v
                    } else {
                        0
                    }
                })
                .sum::<i32>();
            state = p.after;
        }
        assert_eq!(sum, 1);
        let canceled = plan(state, action(3, 0, 0), 0, 1001.0, 5462.333333333333).unwrap();
        assert!(events(&canceled).contains(&Event::Key(2, false)));
        assert_eq!(canceled.after, State::default());
    }
    #[test]
    fn partial_prefix_keeps_only_submitted_keys_and_buttons_for_cleanup() {
        let p = plan(State::default(), action(1, 1, 2), 0, 1920.0, 1080.0).unwrap();
        let mut state = State::default();
        commit_prefix(&mut state, &p, 0);
        assert_eq!(state, State::default());
        commit_prefix(&mut state, &p, 1);
        assert_eq!(events(&reset_plan(state)), vec![Event::Key(2, false)]);
        commit_prefix(&mut state, &p, p.steps.len());
        assert_eq!(
            events(&reset_plan(state)),
            vec![Event::Button(1, false), Event::Key(2, false)]
        );
    }
    #[test]
    fn virtual_desktop_coordinates_include_secondary_negative_origin_and_reject_outside() {
        assert_eq!(
            absolute(-1920.0, 0.0, [-1920.0, 0.0, 3840.0, 1080.0]).unwrap(),
            (8, 30)
        );
        assert_eq!(
            absolute(1919.0, 1079.0, [-1920.0, 0.0, 3840.0, 1080.0]).unwrap(),
            (65527, 65505)
        );
        assert!(absolute(-1921.0, 0.0, [-1920.0, 0.0, 3840.0, 1080.0]).is_err());
        assert!(absolute(f64::NAN, 0.0, [0.0, 0.0, 1920.0, 1080.0]).is_err());
    }
    #[test]
    fn implicit_buttons_and_unsupported_fields_never_produce_input() {
        for a in [
            action(1, 0, 0),
            action(1, 32, 0),
            action(0, 1, 0),
            action(0, 0, 16),
            action(5, 0, 0),
        ] {
            assert!(plan(State::default(), a, 0, 1920.0, 1080.0).is_err());
        }
    }
}
