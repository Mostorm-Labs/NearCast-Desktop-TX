// Explicit OS integration fixture: only our temporary foreground window receives
// input. Never runs as part of ordinary cargo test.
use crate::{input_geometry, input_native};
use serde_json::json;
use std::sync::atomic::{AtomicIsize, AtomicU32, Ordering};
use std::time::{Duration, Instant};
use windows::core::w;
use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, POINT, WPARAM};
use windows::Win32::UI::Input::KeyboardAndMouse::SetFocus;
use windows::Win32::UI::WindowsAndMessaging::*;
static PREVIOUS: AtomicIsize = AtomicIsize::new(0);
static DOWN: AtomicU32 = AtomicU32::new(0);
static UP: AtomicU32 = AtomicU32::new(0);
static MOUSE_DOWN: AtomicU32 = AtomicU32::new(0);
static MOUSE_UP: AtomicU32 = AtomicU32::new(0);
static DRAG: AtomicU32 = AtomicU32::new(0);
static CTRL_CLICK: AtomicU32 = AtomicU32::new(0);
static WHEEL_Y: std::sync::atomic::AtomicI32 = std::sync::atomic::AtomicI32::new(0);
static WHEEL_X: std::sync::atomic::AtomicI32 = std::sync::atomic::AtomicI32::new(0);
unsafe extern "system" fn procedure(hwnd: HWND, msg: u32, wp: WPARAM, lp: LPARAM) -> LRESULT {
    if msg == WM_POINTERDOWN {
        DOWN.fetch_add(1, Ordering::SeqCst);
    }
    if msg == WM_POINTERUP {
        UP.fetch_add(1, Ordering::SeqCst);
    }
    let button = match msg {
        WM_LBUTTONDOWN | WM_LBUTTONUP | WM_LBUTTONDBLCLK => 1,
        WM_RBUTTONDOWN | WM_RBUTTONUP | WM_RBUTTONDBLCLK => 2,
        WM_MBUTTONDOWN | WM_MBUTTONUP | WM_MBUTTONDBLCLK => 4,
        WM_XBUTTONDOWN | WM_XBUTTONUP | WM_XBUTTONDBLCLK => {
            if (wp.0 >> 16) & 0xffff == 1 {
                8
            } else {
                16
            }
        }
        _ => 0,
    };
    if [
        WM_LBUTTONDOWN,
        WM_LBUTTONDBLCLK,
        WM_RBUTTONDOWN,
        WM_RBUTTONDBLCLK,
        WM_MBUTTONDOWN,
        WM_MBUTTONDBLCLK,
        WM_XBUTTONDOWN,
        WM_XBUTTONDBLCLK,
    ]
    .contains(&msg)
    {
        MOUSE_DOWN.fetch_or(button, Ordering::SeqCst);
    }
    if [WM_LBUTTONUP, WM_RBUTTONUP, WM_MBUTTONUP, WM_XBUTTONUP].contains(&msg) {
        MOUSE_UP.fetch_or(button, Ordering::SeqCst);
    }
    if msg == WM_MOUSEMOVE && wp.0 & 1 != 0 {
        DRAG.fetch_add(1, Ordering::SeqCst);
    }
    if [WM_LBUTTONDOWN, WM_LBUTTONDBLCLK].contains(&msg) && wp.0 & 8 != 0 {
        CTRL_CLICK.fetch_add(1, Ordering::SeqCst);
    }
    if msg == WM_MOUSEWHEEL {
        WHEEL_Y.fetch_add(((wp.0 >> 16) as u16 as i16) as i32, Ordering::SeqCst);
    }
    if msg == WM_MOUSEHWHEEL {
        WHEEL_X.fetch_add(((wp.0 >> 16) as u16 as i16) as i32, Ordering::SeqCst);
    }
    CallWindowProcW(
        std::mem::transmute::<isize, WNDPROC>(PREVIOUS.load(Ordering::SeqCst)),
        hwnd,
        msg,
        wp,
        lp,
    )
}
fn pump(hwnd: HWND) {
    let until = Instant::now() + Duration::from_millis(100);
    while Instant::now() < until {
        let mut message = MSG::default();
        unsafe {
            while PeekMessageW(&mut message, Some(hwnd), 0, 0, PM_REMOVE).as_bool() {
                let _ = TranslateMessage(&message);
                DispatchMessageW(&message);
            }
        }
        std::thread::sleep(Duration::from_millis(2));
    }
}
#[test]
#[ignore = "creates a temporary foreground window; injects Touch and explicit Mouse only into it"]
fn typed_native_touch_mouse_and_owned_cleanup_reach_our_window() {
    let probe = input_native::probe();
    eprintln!("typed_native_probe={probe}");
    assert_eq!(probe["nativeReady"], true);
    let geometry = input_geometry::snapshot().unwrap();
    let display = geometry
        .displays
        .iter()
        .find(|d| !d.primary)
        .unwrap_or(&geometry.displays[0]);
    let source_id = "1cc04c93-e9ce-4f91-a14c-c8d6421c4f59".to_string();
    let challenge = crate::display_binding::begin(source_id.clone()).unwrap();
    // This test supplies the owned native marker identity directly. Browser
    // pixel recognition is independently covered by the Edge integration.
    let marker = challenge["displays"]
        .as_array()
        .unwrap()
        .iter()
        .find(|d| d["nativeId"].as_str() == Some(display.native_id.as_str()))
        .unwrap();
    let binding = crate::display_binding::confirm(
        source_id.clone(),
        challenge["challengeId"].as_str().unwrap().into(),
        marker["token"].as_str().unwrap().into(),
        vec![0, 1, 2, 3],
        display.capture_width,
        display.capture_height,
    )
    .unwrap();
    let previous = unsafe { GetForegroundWindow() };
    let mut cursor = POINT::default();
    unsafe {
        GetCursorPos(&mut cursor).unwrap();
    }
    let hwnd = unsafe {
        CreateWindowExW(
            WS_EX_TOPMOST,
            w!("BUTTON"),
            w!("NearCast typed Touch self-test"),
            WS_OVERLAPPEDWINDOW | WS_VISIBLE,
            display.region.x as i32 + 80,
            display.region.y as i32 + 80,
            500,
            320,
            None,
            None,
            None,
            None,
        )
        .unwrap()
    };
    struct Guard {
        hwnd: HWND,
        previous: HWND,
        cursor: POINT,
        source_id: String,
    }
    impl Drop for Guard {
        fn drop(&mut self) {
            let _ = input_native::release("owned-touch-test".into(), None);
            let _ = crate::display_binding::release(self.source_id.clone());
            unsafe {
                let _ = DestroyWindow(self.hwnd);
                let _ = SetCursorPos(self.cursor.x, self.cursor.y);
                if !self.previous.0.is_null() {
                    let _ = SetForegroundWindow(self.previous);
                }
            }
        }
    }
    let _guard = Guard {
        hwnd,
        previous,
        cursor,
        source_id,
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
    assert_eq!(unsafe { GetForegroundWindow() }, hwnd);
    let point = POINT {
        x: display.region.x as i32 + 300,
        y: display.region.y as i32 + 230,
    };
    assert_eq!(unsafe { WindowFromPoint(point) }, hwnd);
    let prepared = input_native::prepare(
        "owned-touch-test".into(),
        "capture-test".into(),
        binding["revision"].as_str().unwrap().into(),
        binding["nativeId"].as_str().unwrap().into(),
        vec!["touch".into(), "mouse".into()],
        10,
    );
    assert_eq!(prepared["status"], "ready", "{prepared}");
    let lease = prepared["leaseId"].as_str().unwrap().to_owned();
    let apply = |phase| {
        assert_eq!(unsafe { GetForegroundWindow() }, hwnd);
        assert_eq!(unsafe { WindowFromPoint(point) }, hwnd);
        let action=serde_json::from_value(json!({"inputType":"touch","records":[{"contactId":1,"phase":phase,"x":point.x,"y":point.y}]})).unwrap();
        let result = input_native::apply(
            "owned-touch-test".into(),
            lease.clone(),
            binding["revision"].as_str().unwrap().into(),
            action,
        );
        assert_eq!(result["status"], "submitted", "{result}");
        pump(hwnd);
    };
    apply(0);
    apply(1);
    apply(2);
    // Ensure all Mouse fields enter through the production IPC deserializer,
    // lease checks and calibrated secondary-monitor binding.
    let mouse = |action: serde_json::Value| {
        assert_eq!(unsafe { GetForegroundWindow() }, hwnd);
        let result = input_native::apply(
            "owned-touch-test".into(),
            lease.clone(),
            binding["revision"].as_str().unwrap().into(),
            serde_json::from_value(action).unwrap(),
        );
        assert_eq!(result["status"], "submitted", "{result}");
        assert_eq!(result["nativeApi"], "SendInput");
        pump(hwnd);
    };
    let mut cursor_at = point;
    mouse(
        json!({"inputType":"mouse","eventKind":0,"buttons":0,"modifiers":0,"x":point.x,"y":point.y}),
    );
    unsafe {
        GetCursorPos(&mut cursor_at).unwrap();
    }
    assert_eq!((cursor_at.x, cursor_at.y), (point.x, point.y));
    MOUSE_DOWN.store(0, Ordering::SeqCst);
    MOUSE_UP.store(0, Ordering::SeqCst);
    for button in [1, 2, 4, 8, 16] {
        let modifiers = if button == 1 { 2 } else { 0 };
        mouse(
            json!({"inputType":"mouse","eventKind":1,"buttons":button,"modifiers":modifiers,"x":point.x,"y":point.y}),
        );
        if button == 1 {
            mouse(
                json!({"inputType":"mouse","eventKind":0,"buttons":1,"modifiers":2,"x":point.x+10,"y":point.y+10}),
            );
        }
        mouse(
            json!({"inputType":"mouse","eventKind":1,"buttons":0,"modifiers":0,"x":point.x,"y":point.y}),
        );
    }
    mouse(
        json!({"inputType":"mouse","eventKind":2,"buttons":0,"modifiers":0,"x":point.x,"y":point.y,"wheelUnit":0,"wheelPhase":0,"wheelX":-120,"wheelY":240}),
    );
    assert_eq!(MOUSE_DOWN.load(Ordering::SeqCst), 31);
    assert_eq!(MOUSE_UP.load(Ordering::SeqCst), 31);
    assert!(DRAG.load(Ordering::SeqCst) > 0);
    assert!(CTRL_CLICK.load(Ordering::SeqCst) > 0);
    assert_eq!(WHEEL_X.load(Ordering::SeqCst), -120);
    assert_eq!(WHEEL_Y.load(Ordering::SeqCst), 240);
    mouse(
        json!({"inputType":"mouse","eventKind":1,"buttons":2,"modifiers":2,"x":point.x,"y":point.y}),
    );
    mouse(json!({"inputType":"mouse","eventKind":3}));
    assert_eq!(
        unsafe { windows::Win32::UI::Input::KeyboardAndMouse::GetAsyncKeyState(0xA2) } as u16
            & 0x8000,
        0
    );
    mouse(json!({"inputType":"mouse","eventKind":4,"modifiers":2}));
    mouse(
        json!({"inputType":"mouse","eventKind":1,"buttons":2,"modifiers":2,"x":point.x,"y":point.y}),
    );
    // A simultaneous Touch is also released on source revocation.
    apply(0);
    crate::display_binding::release(_guard.source_id.clone()).unwrap();
    let released = input_native::release("owned-touch-test".into(), Some(lease));
    assert_eq!(released["status"], "released", "{released}");
    pump(hwnd);
    assert!(crate::pointer::active_points().is_empty());
    for key in [0xA2, 0x02] {
        assert_eq!(
            unsafe { windows::Win32::UI::Input::KeyboardAndMouse::GetAsyncKeyState(key) } as u16
                & 0x8000,
            0
        );
    }
    assert_eq!(DOWN.load(Ordering::SeqCst), 2);
    assert_eq!(UP.load(Ordering::SeqCst), 2);
    eprintln!(
        "typed native Touch + Mouse PASS: calibrated secondary pixel, five buttons, Ctrl drag, wheel X/Y, cancel and source-revocation cleanup"
    );
}
