use crate::{
    input_geometry::Display,
    windows_mouse_model::{self as model, Action, Event, Plan, State},
};
use windows::Win32::UI::HiDpi::{
    SetThreadDpiAwarenessContext, DPI_AWARENESS_CONTEXT, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2,
};
use windows::Win32::{
    Foundation::{GetLastError, SetLastError, WIN32_ERROR},
    UI::{Input::KeyboardAndMouse::*, WindowsAndMessaging::*},
};

struct DpiGuard(DPI_AWARENESS_CONTEXT);
impl Drop for DpiGuard {
    fn drop(&mut self) {
        unsafe {
            SetThreadDpiAwarenessContext(self.0);
        }
    }
}
fn physical_coordinates() -> Result<DpiGuard, String> {
    let previous =
        unsafe { SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2) };
    if previous.0.is_null() {
        return Err("mouse_dpi_context_unavailable".into());
    }
    Ok(DpiGuard(previous))
}

pub struct SubmissionError {
    pub error: String,
    pub submitted: usize,
}
fn key(bit: u16) -> VIRTUAL_KEY {
    match bit {
        1 => VK_LSHIFT,
        2 => VK_LCONTROL,
        4 => VK_LMENU,
        8 => VK_LWIN,
        _ => unreachable!("validated modifier"),
    }
}
fn input(event: Event, desktop: [f64; 4]) -> Result<INPUT, String> {
    if let Event::Key(bit, down) = event {
        return Ok(INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: key(bit),
                    dwFlags: if down {
                        KEYBD_EVENT_FLAGS(0)
                    } else {
                        KEYEVENTF_KEYUP
                    } | if bit == 8 {
                        KEYEVENTF_EXTENDEDKEY
                    } else {
                        KEYBD_EVENT_FLAGS(0)
                    },
                    ..Default::default()
                },
            },
        });
    }
    let mut mi = MOUSEINPUT::default();
    match event {
        Event::Move(x, y) => {
            let (x, y) = model::absolute(x as f64, y as f64, desktop)?;
            mi.dx = x;
            mi.dy = y;
            mi.dwFlags = MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK;
        }
        Event::Button(button, down) => {
            mi.dwFlags = match (button, down) {
                (1, true) => MOUSEEVENTF_LEFTDOWN,
                (1, false) => MOUSEEVENTF_LEFTUP,
                (2, true) => MOUSEEVENTF_RIGHTDOWN,
                (2, false) => MOUSEEVENTF_RIGHTUP,
                (4, true) => MOUSEEVENTF_MIDDLEDOWN,
                (4, false) => MOUSEEVENTF_MIDDLEUP,
                _ => return Err("invalid_mouse_button".into()),
            }
        }
        Event::Wheel(horizontal, delta) => {
            mi.dwFlags = if horizontal {
                MOUSEEVENTF_HWHEEL
            } else {
                MOUSEEVENTF_WHEEL
            };
            mi.mouseData = delta as u32;
        }
        Event::Key(..) => unreachable!(),
    }
    Ok(INPUT {
        r#type: INPUT_MOUSE,
        Anonymous: INPUT_0 { mi },
    })
}
fn physical_modifiers() -> u16 {
    [
        (1, [VK_LSHIFT, VK_RSHIFT]),
        (2, [VK_LCONTROL, VK_RCONTROL]),
        (4, [VK_LMENU, VK_RMENU]),
        (8, [VK_LWIN, VK_RWIN]),
    ]
    .into_iter()
    .filter(|(_, keys)| {
        keys.iter()
            .any(|key| unsafe { GetAsyncKeyState(key.0 as i32) } < 0)
    })
    .fold(0, |mask, (bit, _)| mask | bit)
}
fn execute_with(
    state: &mut State,
    plan: &Plan,
    desktop: [f64; 4],
    send: impl FnOnce(&[INPUT]) -> (usize, u32),
) -> Result<usize, SubmissionError> {
    // Construct and validate the complete batch before the first OS call.
    let inputs = plan
        .steps
        .iter()
        .map(|step| input(step.event, desktop))
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| SubmissionError {
            error,
            submitted: 0,
        })?;
    let (sent, code) = if inputs.is_empty() {
        (0, 0)
    } else {
        send(&inputs)
    };
    model::commit_prefix(state, plan, sent);
    if sent != inputs.len() {
        return Err(SubmissionError {
            error: format!(
                "windows_mouse_send_input_failed:win32={code}:sent={sent}/{}",
                inputs.len()
            ),
            submitted: sent,
        });
    }
    Ok(sent)
}
fn desktop() -> [f64; 4] {
    unsafe {
        [
            GetSystemMetrics(SM_XVIRTUALSCREEN) as f64,
            GetSystemMetrics(SM_YVIRTUALSCREEN) as f64,
            GetSystemMetrics(SM_CXVIRTUALSCREEN) as f64,
            GetSystemMetrics(SM_CYVIRTUALSCREEN) as f64,
        ]
    }
}
fn send(inputs: &[INPUT]) -> (usize, u32) {
    unsafe {
        SetLastError(WIN32_ERROR(0));
        let sent = SendInput(inputs, std::mem::size_of::<INPUT>() as i32);
        (sent as usize, GetLastError().0)
    }
}
pub fn apply(
    state: &mut State,
    action: Action,
    display: &Display,
) -> Result<usize, SubmissionError> {
    let _dpi = physical_coordinates().map_err(|error| SubmissionError {
        error,
        submitted: 0,
    })?;
    let plan = model::plan(
        *state,
        action,
        physical_modifiers(),
        display.region.width,
        display.region.height,
    )
    .map_err(|error| SubmissionError {
        error,
        submitted: 0,
    })?;
    execute_with(state, &plan, desktop(), send)
}
pub fn reset(state: &mut State) -> Result<(), String> {
    let plan = model::reset_plan(*state);
    execute_with(state, &plan, desktop(), send)
        .map(|_| ())
        .map_err(|failure| failure.error)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn native_mapping_preserves_secondary_coordinates_wheel_and_modifier_flags() {
        let desktop = [-1920.0, 0.0, 3840.0, 1080.0];
        unsafe {
            let movement = input(Event::Move(-1920, 0), desktop).unwrap().Anonymous.mi;
            assert_eq!((movement.dx, movement.dy), (0, 0));
            assert_eq!(
                movement.dwFlags,
                MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK
            );
            assert_eq!(
                input(Event::Wheel(true, -120), desktop)
                    .unwrap()
                    .Anonymous
                    .mi
                    .dwFlags,
                MOUSEEVENTF_HWHEEL
            );
            assert_eq!(
                input(Event::Wheel(false, -120), desktop)
                    .unwrap()
                    .Anonymous
                    .mi
                    .mouseData,
                (-120i32) as u32
            );
            assert_eq!(
                input(Event::Key(8, false), desktop)
                    .unwrap()
                    .Anonymous
                    .ki
                    .dwFlags,
                KEYEVENTF_KEYUP | KEYEVENTF_EXTENDEDKEY
            );
        }
    }
    #[test]
    fn partial_os_submission_preserves_exact_owned_prefix_until_retry_cleanup() {
        let mut state = State::default();
        let plan = model::plan(
            state,
            Action {
                kind: 1,
                buttons: 1,
                modifiers: 2,
                x: 10.0,
                y: 10.0,
                wheel: None,
            },
            0,
            1920.0,
            1080.0,
        )
        .unwrap();
        let error = execute_with(&mut state, &plan, [0.0, 0.0, 1920.0, 1080.0], |_| (1, 5))
            .err()
            .unwrap();
        assert_eq!(
            error.error,
            "windows_mouse_send_input_failed:win32=5:sent=1/3"
        );
        assert_eq!((state.buttons, state.owned_modifiers), (0, 2));
        let reset = model::reset_plan(state);
        assert!(execute_with(&mut state, &reset, [0.0, 0.0, 1920.0, 1080.0], |_| (0, 5)).is_err());
        assert_eq!(state.owned_modifiers, 2);
        assert_eq!(
            execute_with(&mut state, &reset, [0.0, 0.0, 1920.0, 1080.0], |items| (
                items.len(),
                0
            ))
            .ok(),
            Some(1)
        );
        assert_eq!(state, State::default());
    }
}
