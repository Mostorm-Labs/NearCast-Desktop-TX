#![cfg(windows)]
use crate::native_capture;
use std::time::{Duration, Instant};
use windows::{
    core::w,
    Win32::{Foundation::*, Graphics::Gdi::*, UI::WindowsAndMessaging::*},
};

unsafe extern "system" fn paint_marker(
    window: HWND,
    message: u32,
    wp: WPARAM,
    lp: LPARAM,
) -> LRESULT {
    if message == WM_PAINT {
        let mut paint = PAINTSTRUCT::default();
        let dc = BeginPaint(window, &mut paint);
        let mut client = RECT::default();
        let _ = GetClientRect(window, &mut client);
        FillRect(dc, &client, HBRUSH(GetStockObject(WHITE_BRUSH).0));
        let marker = CreateSolidBrush(COLORREF(0x0030b0f0));
        FillRect(
            dc,
            &RECT {
                left: 40,
                top: 40,
                right: 52,
                bottom: 52,
            },
            marker,
        );
        let _ = DeleteObject(marker.into());
        let _ = EndPaint(window, &paint);
        return LRESULT(0);
    }
    DefWindowProcW(window, message, wp, lp)
}

fn pump(window: HWND) {
    let until = Instant::now() + Duration::from_millis(60);
    while Instant::now() < until {
        let mut message = MSG::default();
        unsafe {
            while PeekMessageW(&mut message, Some(window), 0, 0, PM_REMOVE).as_bool() {
                let _ = TranslateMessage(&message);
                DispatchMessageW(&message);
            }
        }
        std::thread::sleep(Duration::from_millis(3));
    }
}

fn ready_frame(window: HWND, id: &str) -> serde_json::Value {
    let mut metadata = serde_json::Value::Null;
    let mut marker_origin = None;
    for _ in 0..40 {
        pump(window);
        let packet = native_capture::frame(id).unwrap();
        let length = u32::from_be_bytes(packet[..4].try_into().unwrap()) as usize;
        metadata = serde_json::from_slice(&packet[4..4 + length]).unwrap();
        if let Some(index) = packet[4 + length..]
            .chunks_exact(4)
            .position(|p| p[..3] == [0x30, 0xb0, 0xf0])
        {
            let width = metadata["width"].as_u64().unwrap() as usize;
            let mut point = POINT { x: 40, y: 40 };
            assert!(unsafe { ClientToScreen(window, &mut point) }.as_bool());
            marker_origin = Some((
                point.x - (index % width) as i32,
                point.y - (index / width) as i32,
            ));
        }
        if metadata["geometry"]["inputReady"] == true && packet.len() > 4 + length {
            let origin = marker_origin.expect("captured frame must include the owned marker");
            assert_eq!(
                metadata["geometry"]["region"]["x"].as_f64().unwrap() as i32,
                origin.0,
                "pixel marker proves the physical x origin"
            );
            assert_eq!(
                metadata["geometry"]["region"]["y"].as_f64().unwrap() as i32,
                origin.1,
                "pixel marker proves the physical y origin"
            );
            return metadata;
        }
    }
    let mut outer = RECT::default();
    let mut visible = RECT::default();
    let mut border = 0u32;
    unsafe {
        GetWindowRect(window, &mut outer).unwrap();
        windows::Win32::Graphics::Dwm::DwmGetWindowAttribute(
            window,
            windows::Win32::Graphics::Dwm::DWMWA_EXTENDED_FRAME_BOUNDS,
            &mut visible as *mut _ as *mut _,
            std::mem::size_of::<RECT>() as u32,
        )
        .unwrap();
        let result = windows::Win32::Graphics::Dwm::DwmGetWindowAttribute(
            window,
            windows::Win32::Graphics::Dwm::DWMWA_VISIBLE_FRAME_BORDER_THICKNESS,
            &mut border as *mut _ as *mut _,
            4,
        );
        let dpi = windows::Win32::UI::HiDpi::GetDpiForWindow(window);
        eprintln!(
            "border={border} result={result:?} dpi={dpi} frame_x={} frame_y={} padded={}",
            windows::Win32::UI::HiDpi::GetSystemMetricsForDpi(SM_CXSIZEFRAME, dpi),
            windows::Win32::UI::HiDpi::GetSystemMetricsForDpi(SM_CYSIZEFRAME, dpi),
            windows::Win32::UI::HiDpi::GetSystemMetricsForDpi(SM_CXPADDEDBORDER, dpi)
        );
    }
    panic!("no proven resized frame: {metadata}; outer={outer:?}; dwm={visible:?}; pixel_proven_origin={marker_origin:?}");
}

#[test]
#[ignore = "creates and resizes only its own foreground window to verify the native sharing outline"]
fn outline_hides_unproven_resize_and_returns_at_current_bounds() {
    let _dpi = crate::capture_target::DpiGuard::new().unwrap();
    let previous = unsafe { GetForegroundWindow() };
    let window = unsafe {
        CreateWindowExW(
            WS_EX_TOPMOST,
            w!("BUTTON"),
            w!("NearCast outline resize fixture"),
            WS_OVERLAPPEDWINDOW | WS_VISIBLE,
            100,
            100,
            700,
            460,
            None,
            None,
            None,
            None,
        )
        .unwrap()
    };
    struct Guard(HWND, HWND);
    impl Drop for Guard {
        fn drop(&mut self) {
            native_capture::shutdown();
            unsafe {
                let _ = DestroyWindow(self.0);
                let _ = SetForegroundWindow(self.1);
            }
        }
    }
    let _guard = Guard(window, previous);
    unsafe {
        SetWindowLongPtrW(window, GWLP_WNDPROC, paint_marker as *const () as isize);
        let _ = InvalidateRect(Some(window), None, true);
        use windows::Win32::System::Threading::{AttachThreadInput, GetCurrentThreadId};
        let own = GetCurrentThreadId();
        let foreground = GetWindowThreadProcessId(previous, None);
        let attached = foreground != own
            && foreground != 0
            && AttachThreadInput(own, foreground, true).as_bool();
        let _ = SetForegroundWindow(window);
        if attached {
            let _ = AttachThreadInput(own, foreground, false);
        }
    }
    pump(window);
    let choice = crate::capture_target::list()
        .unwrap()
        .into_iter()
        .find(|c| c.title == "NearCast outline resize fixture")
        .unwrap();
    let started = native_capture::start(&choice.target_id).unwrap();
    let initial = ready_frame(window, &started.capture_id);
    pump(window);
    let mut after = None;
    let overlay = loop {
        let found =
            unsafe { FindWindowExW(None, after, w!("STATIC"), w!("NearCast sharing outline")) }
                .unwrap();
        let mut pid = 0;
        unsafe {
            GetWindowThreadProcessId(found, Some(&mut pid));
        }
        if pid == std::process::id() {
            break found;
        }
        after = Some(found);
    };
    assert!(unsafe { IsWindowVisible(overlay) }.as_bool());
    unsafe {
        SetWindowPos(
            window,
            None,
            200,
            150,
            800,
            520,
            SWP_NOACTIVATE | SWP_NOZORDER,
        )
        .unwrap();
    }
    pump(window);
    let pending = native_capture::snapshot().unwrap();
    eprintln!(
        "pending_outline_resize={}",
        serde_json::to_string(&pending).unwrap()
    );
    assert_eq!(
        pending.disabled_reason.as_deref(),
        Some("capture_window_pixels_do_not_match_native_bounds")
    );
    assert!(
        !unsafe { IsWindowVisible(overlay) }.as_bool(),
        "old outline must disappear without requesting a new frame"
    );
    assert!(
        !crate::capture_indicator::status(&started.capture_id)
            .unwrap()
            .visible
    );

    for action in [None, Some(SW_MAXIMIZE), Some(SW_RESTORE)] {
        if let Some(action) = action {
            unsafe {
                let _ = ShowWindow(window, action);
            }
        }
        let metadata = ready_frame(window, &started.capture_id);
        assert_ne!(
            metadata["geometry"]["revision"],
            initial["geometry"]["revision"]
        );
        eprintln!("ready_outline_geometry={metadata}");
        assert!(metadata["nativeCapture"]["nativeRegion"]["width"].as_i64().is_some(), "diagnostics must expose current native bounds independently of the last proven pixel region");
        pump(window);
        assert!(unsafe { IsWindowVisible(overlay) }.as_bool());
        let mut bounds = RECT::default();
        let mut visible = RECT::default();
        unsafe {
            GetWindowRect(overlay, &mut bounds).unwrap();
            windows::Win32::Graphics::Dwm::DwmGetWindowAttribute(
                window,
                windows::Win32::Graphics::Dwm::DWMWA_EXTENDED_FRAME_BOUNDS,
                &mut visible as *mut _ as *mut _,
                std::mem::size_of::<RECT>() as u32,
            )
            .unwrap();
        }
        assert_eq!(
            (bounds.left, bounds.top, bounds.right, bounds.bottom),
            (
                visible.left - 3,
                visible.top - 3,
                visible.right + 3,
                visible.bottom + 3
            ),
            "outline must follow visible native bounds, including maximized windows"
        );
    }
    native_capture::stop(&started.capture_id).unwrap();
    assert!(
        !unsafe { IsWindow(Some(overlay)) }.as_bool(),
        "stop must destroy the overlay"
    );
}
