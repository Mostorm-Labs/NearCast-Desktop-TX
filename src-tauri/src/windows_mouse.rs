#![cfg(windows)]

use crate::windows_mouse_model::{self as model, Event, MouseState, Record, Step};
use std::sync::Mutex;
use windows::Win32::Foundation::{GetLastError, SetLastError, WIN32_ERROR};
use windows::Win32::UI::Input::KeyboardAndMouse::*;

struct Runtime {
    state: MouseState,
    initialized: bool,
    cleanup_pending: bool,
}
static RUNTIME: Mutex<Runtime> = Mutex::new(Runtime {
    state: MouseState {
        contact: None,
        buttons: 0,
        owned_modifiers: 0,
    },
    initialized: false,
    cleanup_pending: false,
});

fn key(bit: u16) -> VIRTUAL_KEY {
    match bit {
        1 => VK_LSHIFT,
        2 => VK_LCONTROL,
        4 => VK_LMENU,
        8 => VK_LWIN,
        _ => unreachable!("validated modifier"),
    }
}

fn input(event: Event) -> INPUT {
    match event {
        Event::Key(bit, down) => INPUT {
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
        },
        event => {
            let mut mi = MOUSEINPUT::default();
            match event {
                // AXTP normalized coordinates already match the Win32 absolute
                // primary-monitor range. Do not route through CSS pixels/DPI.
                Event::Move(x, y) => {
                    mi.dx = i32::from(x);
                    mi.dy = i32::from(y);
                    mi.dwFlags = MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE;
                }
                Event::Button(button, down) => {
                    mi.dwFlags = match (button, down) {
                        (1, true) => MOUSEEVENTF_LEFTDOWN,
                        (1, false) => MOUSEEVENTF_LEFTUP,
                        (2, true) => MOUSEEVENTF_RIGHTDOWN,
                        (2, false) => MOUSEEVENTF_RIGHTUP,
                        (4, true) => MOUSEEVENTF_MIDDLEDOWN,
                        (4, false) => MOUSEEVENTF_MIDDLEUP,
                        _ => unreachable!("validated button"),
                    }
                }
                Event::Wheel(delta) => {
                    mi.mouseData = i32::from(delta) as u32;
                    mi.dwFlags = MOUSEEVENTF_WHEEL;
                }
                Event::Key(..) => unreachable!(),
            }
            INPUT {
                r#type: INPUT_MOUSE,
                Anonymous: INPUT_0 { mi },
            }
        }
    }
}

fn physical_modifiers() -> u16 {
    let mut mask = 0;
    for (bit, keys) in [
        (1, [VK_LSHIFT, VK_RSHIFT]),
        (2, [VK_LCONTROL, VK_RCONTROL]),
        (4, [VK_LMENU, VK_RMENU]),
        (8, [VK_LWIN, VK_RWIN]),
    ] {
        if keys
            .iter()
            .any(|key| unsafe { GetAsyncKeyState(i32::from(key.0)) } < 0)
        {
            mask |= bit;
        }
    }
    mask
}

fn execute_with(
    runtime: &mut Runtime,
    plan: &[Step],
    send: impl FnOnce(&[INPUT]) -> (usize, u32),
) -> Result<(), String> {
    if plan.is_empty() {
        runtime.state = MouseState::default();
        runtime.cleanup_pending = false;
        return Ok(());
    }
    let inputs = plan
        .iter()
        .map(|step| input(step.event))
        .collect::<Vec<_>>();
    let (sent, error) = send(&inputs);
    model::commit_prefix(&mut runtime.state, plan, sent);
    if sent != inputs.len() {
        runtime.cleanup_pending = true;
        // UIPI can return zero with GetLastError()==0; do not mislabel that as
        // successful input or claim a specific privilege/desktop diagnosis.
        return Err(format!(
            "windows_mouse_send_input_failed:win32={error}:sent={sent}/{}",
            inputs.len()
        ));
    }
    runtime.cleanup_pending = false;
    Ok(())
}

fn execute(runtime: &mut Runtime, plan: &[Step]) -> Result<(), String> {
    execute_with(runtime, plan, |inputs| unsafe {
        SetLastError(WIN32_ERROR(0));
        let sent = SendInput(inputs, std::mem::size_of::<INPUT>() as i32) as usize;
        (sent, GetLastError().0)
    })
}

pub fn initialize() -> Result<bool, String> {
    let mut runtime = RUNTIME.lock().map_err(|_| "windows_mouse_state_poisoned")?;
    let plan = model::reset_plan(runtime.state);
    execute(&mut runtime, &plan)?;
    runtime.initialized = true;
    Ok(true)
}

pub fn inject(records: &[Record]) -> Result<(), String> {
    let mut runtime = RUNTIME.lock().map_err(|_| "windows_mouse_state_poisoned")?;
    if !runtime.initialized || runtime.cleanup_pending {
        return Err("windows_mouse_reset_required".into());
    }
    let plan = model::batch_plan(runtime.state, records, physical_modifiers())?;
    execute(&mut runtime, &plan)
}

pub fn reset() -> Result<(), String> {
    let mut runtime = RUNTIME.lock().map_err(|_| "windows_mouse_state_poisoned")?;
    let plan = model::reset_plan(runtime.state);
    execute(&mut runtime, &plan)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn windows_input_flags_preserve_normalized_coordinates_buttons_and_wheel() {
        unsafe {
            let move_input = input(Event::Move(65535, 0));
            assert_eq!(move_input.Anonymous.mi.dx, 65535);
            assert_eq!(move_input.Anonymous.mi.dy, 0);
            assert_eq!(
                move_input.Anonymous.mi.dwFlags,
                MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE
            );
            assert_eq!(
                input(Event::Button(2, false)).Anonymous.mi.dwFlags,
                MOUSEEVENTF_RIGHTUP
            );
            assert_eq!(
                input(Event::Button(4, true)).Anonymous.mi.dwFlags,
                MOUSEEVENTF_MIDDLEDOWN
            );
            assert_eq!(
                input(Event::Wheel(-120)).Anonymous.mi.mouseData,
                (-120i32) as u32
            );
            assert_eq!(
                input(Event::Key(8, false)).Anonymous.ki.dwFlags,
                KEYEVENTF_KEYUP | KEYEVENTF_EXTENDEDKEY
            );
        }
    }
    #[test]
    fn partial_send_failure_retains_ownership_and_successful_reset_clears_it() {
        let mut runtime = Runtime {
            state: MouseState::default(),
            initialized: true,
            cleanup_pending: false,
        };
        let record = Record {
            contact_id: 7,
            phase: 0,
            x: 0,
            y: 0,
            buttons: 1,
            modifiers: 2,
            wheel: 0,
            dt_ms: 0,
            record_flags: 0,
        };
        let plan = model::batch_plan(runtime.state, &[record], 0).unwrap();
        let error = execute_with(&mut runtime, &plan, |_| (1, 5)).unwrap_err();
        assert_eq!(error, "windows_mouse_send_input_failed:win32=5:sent=1/3");
        assert!(runtime.cleanup_pending);
        assert_eq!(runtime.state.owned_modifiers, 2);
        assert_eq!(runtime.state.buttons, 0);
        let reset = model::reset_plan(runtime.state);
        assert!(execute_with(&mut runtime, &reset, |_| (0, 5)).is_err());
        assert!(runtime.cleanup_pending);
        assert_eq!(runtime.state.owned_modifiers, 2);
        execute_with(&mut runtime, &reset, |inputs| (inputs.len(), 0)).unwrap();
        assert!(!runtime.cleanup_pending);
        assert_eq!(runtime.state, MouseState::default());
    }

    // Opt-in OS integration test: input targets only this temporary test window.
    // Ordinary cargo test never moves the user's cursor or changes focus.
    #[test]
    #[ignore = "creates an owned foreground test window and briefly moves the cursor"]
    fn native_mouse_events_and_reset_reach_an_owned_window() {
        use std::sync::atomic::{AtomicI32, AtomicIsize, Ordering};
        use std::time::{Duration, Instant};
        use windows::core::w;
        use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, POINT, WPARAM};
        use windows::Win32::UI::WindowsAndMessaging::*;
        static PREVIOUS: AtomicIsize = AtomicIsize::new(0);
        static LEFT_DOWN: AtomicI32 = AtomicI32::new(0);
        static LEFT_UP: AtomicI32 = AtomicI32::new(0);
        static RIGHT_DOWN: AtomicI32 = AtomicI32::new(0);
        static RIGHT_UP: AtomicI32 = AtomicI32::new(0);
        static MIDDLE_DOWN: AtomicI32 = AtomicI32::new(0);
        static MIDDLE_UP: AtomicI32 = AtomicI32::new(0);
        static WHEEL: AtomicI32 = AtomicI32::new(0);
        static CTRL_CLICK: AtomicI32 = AtomicI32::new(0);
        unsafe extern "system" fn procedure(
            hwnd: HWND,
            msg: u32,
            wp: WPARAM,
            lp: LPARAM,
        ) -> LRESULT {
            let counter = match msg {
                WM_LBUTTONDOWN => Some(&LEFT_DOWN),
                WM_LBUTTONUP => Some(&LEFT_UP),
                WM_RBUTTONDOWN => Some(&RIGHT_DOWN),
                WM_RBUTTONUP => Some(&RIGHT_UP),
                WM_MBUTTONDOWN => Some(&MIDDLE_DOWN),
                WM_MBUTTONUP => Some(&MIDDLE_UP),
                _ => None,
            };
            if let Some(counter) = counter {
                counter.fetch_add(1, Ordering::SeqCst);
            }
            if msg == WM_LBUTTONDOWN && wp.0 & 8 != 0 {
                CTRL_CLICK.fetch_add(1, Ordering::SeqCst);
            }
            if msg == WM_MOUSEWHEEL {
                WHEEL.fetch_add(((wp.0 >> 16) as u16 as i16) as i32, Ordering::SeqCst);
            }
            let previous = PREVIOUS.load(Ordering::SeqCst);
            if previous == 0 {
                DefWindowProcW(hwnd, msg, wp, lp)
            } else {
                CallWindowProcW(
                    std::mem::transmute::<isize, WNDPROC>(previous),
                    hwnd,
                    msg,
                    wp,
                    lp,
                )
            }
        }
        fn pump(hwnd: HWND) {
            let until = Instant::now() + Duration::from_millis(150);
            while Instant::now() < until {
                let mut message = MSG::default();
                unsafe {
                    while PeekMessageW(&mut message, Some(hwnd), 0, 0, PM_REMOVE).as_bool() {
                        let _ = TranslateMessage(&message);
                        DispatchMessageW(&message);
                    }
                }
                std::thread::sleep(Duration::from_millis(5));
            }
        }
        struct Guard {
            hwnd: HWND,
            previous: HWND,
            cursor: POINT,
        }
        impl Drop for Guard {
            fn drop(&mut self) {
                let _ = reset();
                unsafe {
                    let _ = DestroyWindow(self.hwnd);
                    let _ = SetCursorPos(self.cursor.x, self.cursor.y);
                    if !self.previous.0.is_null() {
                        let _ = SetForegroundWindow(self.previous);
                    }
                }
            }
        }
        assert_eq!(
            physical_modifiers(),
            0,
            "release local modifier keys before running this opt-in test"
        );
        let mut cursor = POINT::default();
        unsafe {
            GetCursorPos(&mut cursor).unwrap();
        }
        let previous = unsafe { GetForegroundWindow() };
        let hwnd = unsafe {
            CreateWindowExW(
                WS_EX_TOPMOST,
                w!("BUTTON"),
                w!("NearCast native Mouse self-test"),
                WS_OVERLAPPEDWINDOW | WS_VISIBLE,
                80,
                80,
                500,
                320,
                None,
                None,
                None,
                None,
            )
            .unwrap()
        };
        let _guard = Guard {
            hwnd,
            previous,
            cursor,
        };
        PREVIOUS.store(
            unsafe { SetWindowLongPtrW(hwnd, GWLP_WNDPROC, procedure as *const () as isize) },
            Ordering::SeqCst,
        );
        unsafe {
            let _ = SetForegroundWindow(hwnd);
            let _ = SetFocus(Some(hwnd));
        }
        pump(hwnd);
        assert_eq!(
            unsafe { GetForegroundWindow() },
            hwnd,
            "owned test window must be foreground before SendInput"
        );
        assert_eq!(unsafe { WindowFromPoint(POINT { x: 300, y: 230 }) }, hwnd);
        let width = unsafe { GetSystemMetrics(SM_CXSCREEN) };
        let height = unsafe { GetSystemMetrics(SM_CYSCREEN) };
        let record = |phase, buttons, modifiers, wheel| Record {
            contact_id: 42,
            phase,
            x: (300 * 65535 / (width - 1)) as u16,
            y: (230 * 65535 / (height - 1)) as u16,
            buttons,
            modifiers,
            wheel,
            dt_ms: 0,
            record_flags: 0,
        };
        initialize().unwrap();
        inject(&[
            record(1, 0, 0, 0),
            record(0, 1, 2, 0),
            record(1, 1, 2, 0),
            record(2, 0, 0, 0),
            record(0, 2, 0, 0),
            record(2, 0, 0, 0),
            record(0, 4, 0, 0),
            record(2, 0, 0, 0),
            record(1, 0, 0, -120),
        ])
        .unwrap();
        pump(hwnd);
        assert_eq!(LEFT_DOWN.load(Ordering::SeqCst), 1);
        assert_eq!(LEFT_UP.load(Ordering::SeqCst), 1);
        assert_eq!(RIGHT_DOWN.load(Ordering::SeqCst), 1);
        assert_eq!(RIGHT_UP.load(Ordering::SeqCst), 1);
        assert_eq!(MIDDLE_DOWN.load(Ordering::SeqCst), 1);
        assert_eq!(MIDDLE_UP.load(Ordering::SeqCst), 1);
        assert_eq!(WHEEL.load(Ordering::SeqCst), -120);
        assert_eq!(CTRL_CLICK.load(Ordering::SeqCst), 1);
        assert_eq!(unsafe { GetForegroundWindow() }, hwnd);
        inject(&[record(0, 1, 2, 0)]).unwrap();
        pump(hwnd);
        reset().unwrap();
        pump(hwnd);
        assert_eq!(LEFT_DOWN.load(Ordering::SeqCst), 2);
        assert_eq!(LEFT_UP.load(Ordering::SeqCst), 2);
        assert_eq!(
            unsafe { GetAsyncKeyState(i32::from(VK_LCONTROL.0)) } as u16 & 0x8000,
            0
        );
        assert_eq!(RUNTIME.lock().unwrap().state, MouseState::default());
        eprintln!("native Mouse PASS: left=2/2 right=1/1 middle=1/1 wheel=-120 Ctrl-click=1 reset released held button and Ctrl");
    }
}
