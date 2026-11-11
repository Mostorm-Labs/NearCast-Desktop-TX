// Typed Mouse semantics only. Gesture interpretation belongs to RX.
use crate::{
    input_geometry::{Display, Region},
    input_native::MouseAction,
};
use serde_json::{json, Value};
use windows::Win32::{
    Foundation::{GetLastError, SetLastError, WIN32_ERROR},
    UI::Input::KeyboardAndMouse::*,
    UI::WindowsAndMessaging::{XBUTTON1, XBUTTON2},
};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct State {
    buttons: u32,
    modifiers: u16,
    owned_modifiers: u16,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Event {
    Move(i32, i32),
    Button(u32, bool),
    Key(u16, bool),
    Wheel(i32, bool),
}
#[derive(Clone, Copy, Debug)]
struct Step {
    event: Event,
    after: State,
}
struct Plan {
    steps: Vec<Step>,
    final_state: State,
}

pub fn capabilities() -> Value {
    json!({"buttonsMask":31,"modifierMask":15,"allowChords":true,"wheelUnits":["detent120"],"continuousScroll":false})
}
fn emit(steps: &mut Vec<Step>, state: State, event: Event) {
    steps.push(Step {
        event,
        after: state,
    });
}
fn modifiers(state: &mut State, desired: u16, physical: u16, steps: &mut Vec<Step>) {
    let borrowed = physical & !state.owned_modifiers;
    for bit in [1, 2, 4, 8] {
        let own = desired & bit != 0 && borrowed & bit == 0;
        if own != (state.owned_modifiers & bit != 0) {
            if own {
                state.owned_modifiers |= bit;
            } else {
                state.owned_modifiers &= !bit;
            }
            emit(steps, *state, Event::Key(bit, own));
        }
    }
    state.modifiers = desired;
}
fn reset_plan(mut state: State) -> Plan {
    let mut steps = Vec::new();
    for bit in [1, 2, 4, 8, 16] {
        if state.buttons & bit != 0 {
            state.buttons &= !bit;
            emit(&mut steps, state, Event::Button(bit, false));
        }
    }
    modifiers(&mut state, 0, 0, &mut steps);
    Plan {
        steps,
        final_state: state,
    }
}
fn absolute(x: f64, y: f64, virtual_region: &Region) -> Result<(i32, i32), String> {
    let r = virtual_region;
    if ![x, y, r.x, r.y, r.width, r.height]
        .iter()
        .all(|v| v.is_finite())
        || r.width < 1.0
        || r.height < 1.0
        || x < r.x
        || y < r.y
        || x > r.x + r.width - 1.0
        || y > r.y + r.height - 1.0
        || x.fract() != 0.0
        || y.fract() != 0.0
    {
        return Err("native_mouse_virtual_coordinates".into());
    }
    // SendInput partitions the virtual desktop into 65536 bins. Aim at the
    // center of the physical pixel's bin, including monitors left of the origin.
    let axis = |p: f64, start: f64, size: f64| {
        (((p - start + 0.5) * 65536.0 / size).floor() as i32).clamp(0, 65535)
    };
    Ok((axis(x, r.x, r.width), axis(y, r.y, r.height)))
}
fn plan(
    mut state: State,
    display: &Display,
    action: &MouseAction,
    virtual_region: &Region,
    physical_keys: u16,
    physical_buttons: u32,
) -> Result<Plan, String> {
    if !action.valid_shape() {
        return Err("native_mouse_action_shape".into());
    }
    let kind = action.event_kind;
    if kind == 3 {
        return Ok(reset_plan(state));
    }
    let keys = action.modifiers.unwrap();
    if keys & !15 != 0 {
        return Err("native_mouse_modifier_bits".into());
    }
    let mut steps = Vec::new();
    let point = if kind != 4 {
        let (x, y, buttons) = (
            action.x.unwrap(),
            action.y.unwrap(),
            action.buttons.unwrap(),
        );
        if buttons & !31 != 0 || !display.contains(x, y) {
            return Err("native_mouse_buttons_or_coordinates".into());
        }
        if (kind == 1 && buttons == state.buttons) || (kind != 1 && buttons != state.buttons) {
            return Err("native_mouse_button_transition".into());
        }
        if kind == 1 && buttons & !state.buttons & physical_buttons != 0 {
            return Err("native_mouse_local_button_busy".into());
        }
        if kind == 2
            && (action.wheel_unit != Some(0)
                || action.wheel_phase != Some(0)
                || (action.wheel_x == Some(0) && action.wheel_y == Some(0)))
        {
            return Err("NOT_SUPPORTED native Mouse wheel unit/phase".into());
        }
        Some(absolute(x, y, virtual_region)?)
    } else {
        None
    };
    // Validate the whole action before producing any native input.
    modifiers(&mut state, keys, physical_keys, &mut steps);
    if let Some((x, y)) = point {
        emit(&mut steps, state, Event::Move(x, y));
    }
    if kind == 1 {
        let desired = action.buttons.unwrap();
        for down in [false, true] {
            for bit in [1, 2, 4, 8, 16] {
                if state.buttons & bit != desired & bit && (desired & bit != 0) == down {
                    if down {
                        state.buttons |= bit;
                    } else {
                        state.buttons &= !bit;
                    }
                    emit(&mut steps, state, Event::Button(bit, down));
                }
            }
        }
    }
    if kind == 2 {
        for (delta, horizontal) in [
            (action.wheel_x.unwrap(), true),
            (action.wheel_y.unwrap(), false),
        ] {
            if delta != 0 {
                emit(&mut steps, state, Event::Wheel(delta, horizontal));
            }
        }
    }
    Ok(Plan {
        steps,
        final_state: state,
    })
}
fn key(bit: u16) -> VIRTUAL_KEY {
    match bit {
        1 => VK_LSHIFT,
        2 => VK_LCONTROL,
        4 => VK_LMENU,
        8 => VK_LWIN,
        _ => unreachable!(),
    }
}
fn native_input(event: Event) -> INPUT {
    if let Event::Key(bit, down) = event {
        return INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: key(bit),
                    dwFlags: (if down {
                        KEYBD_EVENT_FLAGS(0)
                    } else {
                        KEYEVENTF_KEYUP
                    }) | (if bit == 8 {
                        KEYEVENTF_EXTENDEDKEY
                    } else {
                        KEYBD_EVENT_FLAGS(0)
                    }),
                    ..Default::default()
                },
            },
        };
    }
    let mut mi = MOUSEINPUT::default();
    match event {
        Event::Move(x, y) => {
            mi.dx = x;
            mi.dy = y;
            mi.dwFlags = MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK;
        }
        Event::Button(bit, down) => {
            mi.dwFlags = match (bit, down) {
                (1, true) => MOUSEEVENTF_LEFTDOWN,
                (1, false) => MOUSEEVENTF_LEFTUP,
                (2, true) => MOUSEEVENTF_RIGHTDOWN,
                (2, false) => MOUSEEVENTF_RIGHTUP,
                (4, true) => MOUSEEVENTF_MIDDLEDOWN,
                (4, false) => MOUSEEVENTF_MIDDLEUP,
                (_, true) => MOUSEEVENTF_XDOWN,
                (_, false) => MOUSEEVENTF_XUP,
            };
            if bit >= 8 {
                mi.mouseData = if bit == 8 {
                    XBUTTON1 as u32
                } else {
                    XBUTTON2 as u32
                };
            }
        }
        Event::Wheel(delta, horizontal) => {
            mi.mouseData = delta as u32;
            mi.dwFlags = if horizontal {
                MOUSEEVENTF_HWHEEL
            } else {
                MOUSEEVENTF_WHEEL
            };
        }
        Event::Key(..) => unreachable!(),
    }
    INPUT {
        r#type: INPUT_MOUSE,
        Anonymous: INPUT_0 { mi },
    }
}
fn physical_keys() -> u16 {
    let mut mask = 0;
    for (bit, keys) in [
        (1, [VK_LSHIFT, VK_RSHIFT]),
        (2, [VK_LCONTROL, VK_RCONTROL]),
        (4, [VK_LMENU, VK_RMENU]),
        (8, [VK_LWIN, VK_RWIN]),
    ] {
        if keys
            .iter()
            .any(|key| unsafe { GetAsyncKeyState(key.0 as i32) } < 0)
        {
            mask |= bit;
        }
    }
    mask
}
fn physical_buttons() -> u32 {
    let mut mask = 0;
    for (bit, key) in [
        (1, VK_LBUTTON),
        (2, VK_RBUTTON),
        (4, VK_MBUTTON),
        (8, VK_XBUTTON1),
        (16, VK_XBUTTON2),
    ] {
        if unsafe { GetAsyncKeyState(key.0 as i32) } < 0 {
            mask |= bit;
        }
    }
    mask
}
fn execute_with(
    state: &mut State,
    plan: &Plan,
    send: impl FnOnce(&[INPUT]) -> (usize, u32),
) -> Value {
    let inputs: Vec<_> = plan.steps.iter().map(|s| native_input(s.event)).collect();
    let (sent, error) = if inputs.is_empty() {
        (0, 0)
    } else {
        send(&inputs)
    };
    if sent == inputs.len() {
        *state = plan.final_state;
        return json!({"status":"submitted","submittedActions":sent,"inputType":"mouse","nativeApi":"SendInput","lastWin32Error":0});
    }
    if sent > 0 {
        *state = plan.steps[sent.min(plan.steps.len()) - 1].after;
    }
    json!({"status":if sent>0{"partial"}else{"unknown"},"submittedActions":sent,"inputType":"mouse","nativeApi":"SendInput","cleanupRequired":true,"lastWin32Error":error,
        "error":format!("windows_mouse_send_input_failed:win32={error}:sent={sent}/{}",inputs.len())})
}
fn execute(state: &mut State, plan: &Plan) -> Value {
    execute_with(state, plan, |inputs| unsafe {
        SetLastError(WIN32_ERROR(0));
        let sent = SendInput(inputs, std::mem::size_of::<INPUT>() as i32);
        (sent as usize, GetLastError().0)
    })
}
fn virtual_region() -> Result<Region, String> {
    let geometry = crate::input_geometry::snapshot()?;
    if geometry.displays.is_empty() {
        return Err("native_mouse_virtual_desktop_unavailable".into());
    }
    let left = geometry
        .displays
        .iter()
        .map(|d| d.region.x)
        .fold(f64::INFINITY, f64::min);
    let top = geometry
        .displays
        .iter()
        .map(|d| d.region.y)
        .fold(f64::INFINITY, f64::min);
    let right = geometry
        .displays
        .iter()
        .map(|d| d.region.x + d.region.width)
        .fold(f64::NEG_INFINITY, f64::max);
    let bottom = geometry
        .displays
        .iter()
        .map(|d| d.region.y + d.region.height)
        .fold(f64::NEG_INFINITY, f64::max);
    Ok(Region {
        x: left,
        y: top,
        width: right - left,
        height: bottom - top,
    })
}
pub fn apply(state: &mut State, display: &Display, action: &MouseAction) -> Value {
    let planned = if action.event_kind == 3 && action.valid_shape() {
        Ok(reset_plan(*state))
    } else {
        virtual_region().and_then(|region| {
            plan(
                *state,
                display,
                action,
                &region,
                physical_keys(),
                physical_buttons(),
            )
        })
    };
    match planned {
        Ok(plan) => execute(state, &plan),
        Err(error) => json!({"status":"rejected","error":error}),
    }
}
pub fn reset(state: &mut State) -> Result<(), String> {
    let result = execute(state, &reset_plan(*state));
    if result["status"] == "submitted" {
        Ok(())
    } else {
        Err(result["error"]
            .as_str()
            .unwrap_or("native_mouse_cleanup_unconfirmed")
            .into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn display() -> Display {
        Display {
            native_id: "test".into(),
            primary: false,
            units: "physical-pixels".into(),
            rotation: 0,
            region: Region {
                x: -1920.0,
                y: 0.0,
                width: 1920.0,
                height: 1080.0,
            },
            capture_width: 1920,
            capture_height: 1080,
        }
    }
    fn action(kind: u8, buttons: u32, keys: u16) -> MouseAction {
        serde_json::from_value(
            json!({"eventKind":kind,"buttons":buttons,"modifiers":keys,"x":-1000,"y":400}),
        )
        .unwrap()
    }
    fn events(plan: &Plan) -> Vec<Event> {
        plan.steps.iter().map(|s| s.event).collect()
    }
    #[test]
    fn explicit_buttons_chords_drag_wheel_and_cancel_keep_their_typed_meaning() {
        let d = display();
        let r = &d.region;
        let down = plan(State::default(), &d, &action(1, 31, 2), r, 0, 0).unwrap();
        assert_eq!(down.final_state.buttons, 31);
        assert!(events(&down).contains(&Event::Key(2, true)));
        let drag = plan(down.final_state, &d, &action(0, 31, 2), r, 2, 31).unwrap();
        assert_eq!(drag.steps.len(), 1);
        let wheel=serde_json::from_value(json!({"eventKind":2,"buttons":31,"modifiers":2,"x":-1000,"y":400,"wheelUnit":0,"wheelPhase":0,"wheelX":-120,"wheelY":240})).unwrap();
        let wheel = plan(drag.final_state, &d, &wheel, r, 2, 31).unwrap();
        assert!(events(&wheel).contains(&Event::Wheel(-120, true)));
        assert!(events(&wheel).contains(&Event::Wheel(240, false)));
        let reset = reset_plan(wheel.final_state);
        assert_eq!(reset.final_state, State::default());
        assert_eq!(reset.steps.len(), 6);
        let up = plan(drag.final_state, &d, &action(1, 0, 0), r, 2, 31).unwrap();
        assert_eq!(up.final_state, State::default());
    }
    #[test]
    fn invalid_shapes_lifecycle_coordinates_and_unnegotiated_continuous_wheel_reject_before_input()
    {
        let d = display();
        assert!(plan(State::default(), &d, &action(1, 0, 0), &d.region, 0, 0).is_err());
        assert!(plan(State::default(), &d, &action(0, 1, 0), &d.region, 0, 0).is_err());
        assert!(plan(State::default(), &d, &action(1, 1, 0), &d.region, 0, 1).is_err());
        for change in [
            json!({"x":0}),
            json!({"x":-1000.5}),
            json!({"modifiers":16}),
            json!({"buttons":32}),
            json!({"wheelX":120}),
        ] {
            let mut value = serde_json::to_value(
                json!({"eventKind":0,"buttons":0,"modifiers":0,"x":-1000,"y":400}),
            )
            .unwrap();
            for (key, v) in change.as_object().unwrap() {
                value[key] = v.clone();
            }
            let a = serde_json::from_value(value).unwrap();
            assert!(plan(State::default(), &d, &a, &d.region, 0, 0).is_err());
        }
        let continuous=serde_json::from_value(json!({"eventKind":2,"buttons":0,"modifiers":0,"x":-1000,"y":400,"wheelUnit":1,"wheelPhase":1,"wheelX":0,"wheelY":65536})).unwrap();
        assert!(plan(State::default(), &d, &continuous, &d.region, 0, 0).is_err());
    }
    #[test]
    fn reset_only_releases_owned_modifiers_and_partial_send_keeps_exact_prefix() {
        let d = display();
        let planned = plan(State::default(), &d, &action(1, 1, 3), &d.region, 1, 0).unwrap();
        assert!(!events(&planned).contains(&Event::Key(1, true)));
        let mut state = State::default();
        let result = execute_with(&mut state, &planned, |_| (1, 5));
        assert_eq!(result["status"], "partial");
        assert_eq!(state.owned_modifiers, 2);
        assert_eq!(state.buttons, 0);
        let cleanup = reset_plan(state);
        assert_eq!(events(&cleanup), vec![Event::Key(2, false)]);
        assert_eq!(
            execute_with(&mut state, &cleanup, |_| (0, 0))["status"],
            "unknown"
        );
        assert_eq!(state.owned_modifiers, 2);
        execute_with(&mut state, &cleanup, |inputs| (inputs.len(), 0));
        assert_eq!(state, State::default());
    }
    #[test]
    fn negative_desktop_pixels_and_windows_flags_are_exact() {
        let r = Region {
            x: -1920.0,
            y: 0.0,
            width: 3840.0,
            height: 1080.0,
        };
        let (x, y) = absolute(-1920.0, 1079.0, &r).unwrap();
        assert_eq!((x, y), (8, 65505));
        unsafe {
            assert_eq!(
                native_input(Event::Move(x, y)).Anonymous.mi.dwFlags,
                MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK
            );
            assert_eq!(
                native_input(Event::Button(16, true)).Anonymous.mi.mouseData,
                XBUTTON2 as u32
            );
            assert_eq!(
                native_input(Event::Wheel(-120, true)).Anonymous.mi.dwFlags,
                MOUSEEVENTF_HWHEEL
            );
        }
    }
}
