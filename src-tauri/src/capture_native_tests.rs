#![cfg(windows)]
use crate::native_capture;
use std::sync::atomic::{AtomicIsize, AtomicU32, Ordering};
use std::time::{Duration, Instant};
use windows::{
    core::w,
    Win32::{
        Foundation::{HWND, LPARAM, LRESULT, POINT, RECT, WPARAM},
        Graphics::Gdi::*,
        UI::WindowsAndMessaging::*,
    },
};
static PREVIOUS: AtomicIsize = AtomicIsize::new(0);
static TOUCH_DOWN: AtomicU32 = AtomicU32::new(0);
static TOUCH_UP: AtomicU32 = AtomicU32::new(0);
static PAINT_TINT: AtomicU32 = AtomicU32::new(0);
unsafe extern "system" fn procedure(hwnd: HWND, msg: u32, wp: WPARAM, lp: LPARAM) -> LRESULT {
    if msg == WM_POINTERDOWN || msg == WM_POINTERUP {
        let mut pointer = windows::Win32::UI::Input::Pointer::POINTER_INFO::default();
        if windows::Win32::UI::Input::Pointer::GetPointerInfo((wp.0 & 0xffff) as u32, &mut pointer)
            .is_ok()
            && pointer.pointerType == PT_TOUCH
        {
            if msg == WM_POINTERDOWN {
                TOUCH_DOWN.fetch_add(1, Ordering::SeqCst);
            } else {
                TOUCH_UP.fetch_add(1, Ordering::SeqCst);
            }
        }
    }
    if msg == WM_PAINT {
        let mut paint = PAINTSTRUCT::default();
        let dc = BeginPaint(hwnd, &mut paint);
        let mut client = RECT::default();
        let _ = GetClientRect(hwnd, &mut client);
        for (r, color) in [
            (
                RECT {
                    left: 0,
                    top: 0,
                    right: client.right / 2,
                    bottom: client.bottom / 2,
                },
                0x00332211u32,
            ),
            (
                RECT {
                    left: client.right / 2,
                    top: 0,
                    right: client.right,
                    bottom: client.bottom / 2,
                },
                0x00665544,
            ),
            (
                RECT {
                    left: 0,
                    top: client.bottom / 2,
                    right: client.right / 2,
                    bottom: client.bottom,
                },
                0x00998877,
            ),
            (
                RECT {
                    left: client.right / 2,
                    top: client.bottom / 2,
                    right: client.right,
                    bottom: client.bottom,
                },
                0x00ccbbaa,
            ),
        ] {
            let brush = CreateSolidBrush(windows::Win32::Foundation::COLORREF(
                color ^ PAINT_TINT.load(Ordering::Relaxed),
            ));
            FillRect(dc, &r, brush);
            let _ = DeleteObject(brush.into());
        }
        let _ = EndPaint(hwnd, &paint);
        return LRESULT(0);
    }
    CallWindowProcW(
        std::mem::transmute::<isize, WNDPROC>(PREVIOUS.load(Ordering::SeqCst)),
        hwnd,
        msg,
        wp,
        lp,
    )
}
// Only the fixture uses a temporary input-queue attachment to establish its
// foreground window deterministically; production capture never forces focus.
unsafe fn activate_fixture(hwnd: HWND) {
    use windows::Win32::System::Threading::{AttachThreadInput, GetCurrentThreadId};
    let own = GetCurrentThreadId();
    let foreground = GetWindowThreadProcessId(GetForegroundWindow(), None);
    let attached =
        foreground != 0 && foreground != own && AttachThreadInput(own, foreground, true).as_bool();
    let _ = SetForegroundWindow(hwnd);
    if attached {
        let _ = AttachThreadInput(own, foreground, false);
    }
}
// Match production: thumbnail acquisition runs on a fresh blocking worker,
// not on the fixture UI thread, which may already be initialized as STA.
fn thumbnail_on_worker(target_id: &str) -> Vec<u8> {
    let id = target_id.to_owned();
    std::thread::spawn(move || native_capture::thumbnail(&id))
        .join()
        .unwrap()
        .unwrap()
}
fn owned_circle_has_color(source: HWND, overlay: HWND, point: POINT, color: u32) -> bool {
    unsafe {
        SetWindowDisplayAffinity(overlay, WDA_NONE).unwrap();
    }
    pump(source);
    let mut found = false;
    unsafe {
        let dc = GetDC(None);
        for y in point.y - 3..=point.y + 3 {
            for x in point.x - 3..=point.x + 3 {
                found |= GetPixel(dc, x, y).0 == color;
            }
        }
        let _ = ReleaseDC(None, dc);
        SetWindowDisplayAffinity(overlay, WDA_EXCLUDEFROMCAPTURE).unwrap();
    }
    found
}
fn pump(hwnd: HWND) {
    let until = Instant::now() + Duration::from_millis(120);
    while Instant::now() < until {
        let mut msg = MSG::default();
        unsafe {
            while PeekMessageW(&mut msg, Some(hwnd), 0, 0, PM_REMOVE).as_bool() {
                let _ = TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }
        }
        std::thread::sleep(Duration::from_millis(3));
    }
}

#[test]
#[ignore = "creates and captures only an owned foreground window; no user application is captured"]
fn native_window_pixels_geometry_border_and_cleanup_are_bound_to_one_target() {
    assert!(native_capture::supported());
    let _dpi = crate::capture_target::DpiGuard::new().unwrap();
    let previous = unsafe { GetForegroundWindow() };
    let mut cursor = POINT::default();
    unsafe {
        GetCursorPos(&mut cursor).unwrap();
    }
    let hwnd = unsafe {
        CreateWindowExW(
            WS_EX_TOPMOST,
            w!("BUTTON"),
            w!("NearCast capture geometry fixture"),
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
    struct Guard {
        hwnd: HWND,
        previous: HWND,
        cursor: POINT,
    }
    impl Drop for Guard {
        fn drop(&mut self) {
            native_capture::shutdown();
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
    };
    PREVIOUS.store(
        unsafe { SetWindowLongPtrW(hwnd, GWLP_WNDPROC, procedure as *const () as isize) },
        Ordering::SeqCst,
    );
    unsafe {
        activate_fixture(hwnd);
        let _ = InvalidateRect(Some(hwnd), None, true);
    }
    pump(hwnd);
    let choice = crate::capture_target::list()
        .unwrap()
        .into_iter()
        .find(|c| c.title == "NearCast capture geometry fixture")
        .unwrap();
    let foreground_before_preview = unsafe { GetForegroundWindow() };
    let preview = thumbnail_on_worker(&choice.target_id);
    assert_eq!(&preview[..2], b"BM");
    assert!(preview.len() <= 54 + 320 * 180 * 4);
    assert!(native_capture::snapshot().is_none());
    assert!(!crate::input_native::is_owned());
    assert_eq!(unsafe { GetForegroundWindow() }, foreground_before_preview);
    let started = native_capture::start(&choice.target_id).unwrap();
    let mut packet = Vec::new();
    for _ in 0..40 {
        pump(hwnd);
        packet = native_capture::frame(&started.capture_id).unwrap();
        if packet.len() > 4 {
            let n = u32::from_be_bytes(packet[..4].try_into().unwrap()) as usize;
            if packet.len() > 4 + n {
                break;
            }
        }
    }
    let meta_len = u32::from_be_bytes(packet[..4].try_into().unwrap()) as usize;
    let metadata: serde_json::Value = serde_json::from_slice(&packet[4..4 + meta_len]).unwrap();
    eprintln!("owned_capture_metadata={metadata}");
    let width = metadata["width"].as_u64().unwrap() as usize;
    let height = metadata["height"].as_u64().unwrap() as usize;
    assert_eq!(metadata["nativeCapture"]["readbackWidth"], width);
    assert_eq!(metadata["nativeCapture"]["readbackHeight"], height);
    assert!(
        metadata["nativeCapture"]["sourceTimestamp100ns"]
            .as_i64()
            .unwrap_or(0)
            > 0
    );
    assert!(
        metadata["nativeCapture"]["surfaceWidth"]
            .as_u64()
            .unwrap_or(0)
            >= width as u64
    );
    let pixels = &packet[4 + meta_len..];
    assert_eq!(pixels.len(), width * height * 4);
    let origin_x = metadata["geometry"]["region"]["x"].as_f64().unwrap() as i32;
    let origin_y = metadata["geometry"]["region"]["y"].as_f64().unwrap() as i32;
    let mut client = RECT::default();
    unsafe {
        GetClientRect(hwnd, &mut client).unwrap();
    }
    for (x, y, want) in [
        (1, 1, [0x33, 0x22, 0x11]),
        (client.right - 2, 1, [0x66, 0x55, 0x44]),
        (1, client.bottom - 2, [0x99, 0x88, 0x77]),
        (client.right - 2, client.bottom - 2, [0xcc, 0xbb, 0xaa]),
    ] {
        let mut point = POINT { x, y };
        assert!(unsafe { ClientToScreen(hwnd, &mut point) }.as_bool());
        let at = ((point.y - origin_y) as usize * width + (point.x - origin_x) as usize) * 4;
        assert_eq!(
            &pixels[at..at + 3],
            &want,
            "native capture and global pixel origin disagree at {x},{y}"
        );
    }
    let preview_w = i32::from_le_bytes(preview[18..22].try_into().unwrap()) as usize;
    let preview_h = -i32::from_le_bytes(preview[22..26].try_into().unwrap()) as usize;
    for (x, y, want) in [
        (client.right / 4, client.bottom / 4, [0x33, 0x22, 0x11]),
        (3 * client.right / 4, client.bottom / 4, [0x66, 0x55, 0x44]),
        (client.right / 4, 3 * client.bottom / 4, [0x99, 0x88, 0x77]),
        (
            3 * client.right / 4,
            3 * client.bottom / 4,
            [0xcc, 0xbb, 0xaa],
        ),
    ] {
        let mut point = POINT { x, y };
        assert!(unsafe { ClientToScreen(hwnd, &mut point) }.as_bool());
        let tx = (point.x - origin_x) as usize * preview_w / width;
        let ty = (point.y - origin_y) as usize * preview_h / height;
        let at = 54 + (ty * preview_w + tx) * 4;
        assert_eq!(
            &preview[at..at + 3],
            &want,
            "thumbnail must capture this window's upright pixels"
        );
    }
    // A frame count alone cannot prove freshness: actually repaint the source
    // after the first frame/pool transition and require the new pixel color.
    PAINT_TINT.store(0x00ffffff, Ordering::Relaxed);
    unsafe {
        let _ = InvalidateRect(Some(hwnd), None, true);
    }
    let mut changed = false;
    for _ in 0..20 {
        pump(hwnd);
        let bytes = native_capture::frame(&started.capture_id).unwrap();
        let n = u32::from_be_bytes(bytes[..4].try_into().unwrap()) as usize;
        if bytes.len() == 4 + n {
            continue;
        }
        let mut point = POINT {
            x: client.right / 4,
            y: client.bottom / 4,
        };
        assert!(unsafe { ClientToScreen(hwnd, &mut point) }.as_bool());
        let at =
            4 + n + ((point.y - origin_y) as usize * width + (point.x - origin_x) as usize) * 4;
        if bytes[at..at + 3] == [0xcc, 0xdd, 0xee] {
            changed = true;
            break;
        }
    }
    PAINT_TINT.store(0, Ordering::Relaxed);
    unsafe {
        let _ = InvalidateRect(Some(hwnd), None, true);
    }
    pump(hwnd);
    assert!(
        changed,
        "new native frames must contain repainted window pixels, not only advance frameId"
    );
    assert_eq!(
        native_capture::snapshot().unwrap().capture_id,
        started.capture_id
    );
    assert_eq!(
        crate::capture_indicator::status(&started.capture_id)
            .unwrap()
            .mode,
        "red"
    );
    let revision = metadata["geometry"]["revision"]
        .as_str()
        .unwrap()
        .to_owned();
    assert!(
        native_capture::indicator(
            &started.capture_id,
            &revision,
            true,
            Some("owned-capture-input"),
            2
        )
        .is_err(),
        "UI request alone must not grant green"
    );
    let prepared = crate::input_native::prepare(
        "owned-capture-input".into(),
        "source-fixture".into(),
        revision.clone(),
        format!("capture:{}", started.capture_id),
        vec!["touch".into()],
        10,
    );
    assert_eq!(prepared["status"], "ready", "{prepared}");
    let mark = crate::touch_feedback::Point {
        contact_id: 99,
        x: 300,
        y: 250,
        phase: 0,
        submitted: false,
        expires_in_ms: None,
    };
    assert!(crate::capture_indicator::touch_scene(
        &started.capture_id,
        &revision,
        "owned-capture-input",
        1,
        vec![mark]
    )
    .unwrap());

    pump(hwnd);
    assert_eq!(
        crate::capture_indicator::status(&started.capture_id)
            .unwrap()
            .touch_points,
        1
    );
    let radius =
        (unsafe { windows::Win32::UI::HiDpi::GetDpiForWindow(hwnd) } as i32 / 4).clamp(24, 48);
    let stroke = POINT {
        x: 300 + radius - 2,
        y: 250,
    };
    assert_eq!(
        unsafe { WindowFromPoint(stroke) },
        hwnd,
        "circle stroke must not intercept reverse input"
    );
    // Affinity scrubs screen readback. Remove it only on this owned test
    // overlay for the color assertion; always restore it before WGC checks.
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
    assert!(
        owned_circle_has_color(hwnd, overlay, stroke, 0x0030c0ff),
        "received Touch circle must be visibly amber"
    );
    let green = crate::touch_feedback::Point {
        contact_id: 99,
        x: 300,
        y: 250,
        phase: 0,
        submitted: true,
        expires_in_ms: None,
    };
    crate::capture_indicator::touch_scene(
        &started.capture_id,
        &revision,
        "owned-capture-input",
        2,
        vec![green.clone()],
    )
    .unwrap();
    pump(hwnd);
    assert!(
        owned_circle_has_color(hwnd, overlay, stroke, 0x0066e676),
        "submitted circle must be visibly green"
    );
    let terminal = crate::touch_feedback::Point {
        phase: 2,
        expires_in_ms: Some(700),
        ..green
    };
    crate::capture_indicator::touch_scene(
        &started.capture_id,
        &revision,
        "owned-capture-input",
        3,
        vec![terminal],
    )
    .unwrap();
    pump(hwnd);
    assert_eq!(
        crate::capture_indicator::status(&started.capture_id)
            .unwrap()
            .touch_points,
        1
    );
    for _ in 0..6 {
        pump(hwnd);
    }
    assert_eq!(
        crate::capture_indicator::status(&started.capture_id)
            .unwrap()
            .touch_points,
        0,
        "terminal pulse must expire without another message"
    );
    native_capture::indicator(
        &started.capture_id,
        &revision,
        true,
        Some("owned-capture-input"),
        2,
    )
    .unwrap();
    pump(hwnd);
    assert_eq!(
        crate::capture_indicator::status(&started.capture_id)
            .unwrap()
            .mode,
        "green"
    );
    native_capture::indicator(&started.capture_id, &revision, false, None, 1).unwrap();
    pump(hwnd);
    assert_eq!(
        crate::capture_indicator::status(&started.capture_id)
            .unwrap()
            .mode,
        "green",
        "late red callback must not override newer green"
    );
    assert_eq!(
        unsafe { WindowFromPoint(POINT { x: 300, y: 250 }) },
        hwnd,
        "border must not intercept input"
    );
    for phase in [0, 1, 2] {
        assert_eq!(unsafe { GetForegroundWindow() }, hwnd);
        assert_eq!(unsafe { WindowFromPoint(POINT { x: 300, y: 250 }) }, hwnd);
        let action=serde_json::from_value(serde_json::json!({"inputType":"touch","records":[{"contactId":1,"phase":phase,"x":300+20*phase as i32,"y":250}]})).unwrap();
        let (reply, receive) = std::sync::mpsc::channel();
        let lease = prepared["leaseId"].as_str().unwrap().to_owned();
        let revision = revision.clone();
        tauri::async_runtime::spawn(async move {
            let result =
                crate::nearcast_input_apply("owned-capture-input".into(), lease, revision, action)
                    .await;
            let _ = reply.send(result);
        });
        let until = Instant::now() + Duration::from_secs(5);
        let applied = loop {
            if let Ok(result) = receive.try_recv() {
                break result.unwrap();
            }
            assert!(
                Instant::now() < until,
                "background native command timed out"
            );
            pump(hwnd);
        };
        assert!(applied["nativeDurationMs"].is_number());
        assert_eq!(applied["inputType"], "touch");
        assert_eq!(applied["nativeApi"], "InjectTouchInput");
        assert_eq!(applied["pointerType"], "PT_TOUCH");
        assert_eq!(applied["status"], "submitted", "{applied}");
        pump(hwnd);
    }
    assert_eq!(TOUCH_DOWN.load(Ordering::SeqCst), 1);
    assert_eq!(TOUCH_UP.load(Ordering::SeqCst), 1);
    unsafe {
        SetWindowPos(
            hwnd,
            None,
            200,
            150,
            700,
            460,
            SWP_NOACTIVATE | SWP_NOZORDER,
        )
        .unwrap();
    }
    pump(hwnd);
    assert_ne!(native_capture::snapshot().unwrap().revision, revision);
    assert!(native_capture::indicator(
        &started.capture_id,
        &revision,
        true,
        Some("owned-capture-input"),
        4
    )
    .is_err());
    assert_eq!(
        crate::capture_indicator::status(&started.capture_id)
            .unwrap()
            .mode,
        "red"
    );
    let released = crate::input_native::release("owned-capture-input".into(), None);
    assert_eq!(released["status"], "released");
    pump(hwnd);
    assert_eq!(
        crate::capture_indicator::status(&started.capture_id)
            .unwrap()
            .mode,
        "red"
    );
    // A held contact must be canceled by the native target watcher even if the
    // renderer stops sending samples or cleanup requests.
    let moved = native_capture::snapshot().unwrap();
    let held = crate::input_native::prepare(
        "held-on-resize".into(),
        "fixture-resize".into(),
        moved.revision.clone(),
        moved.native_id.clone(),
        vec!["touch".into()],
        10,
    );
    assert_eq!(held["status"], "ready", "{held}");
    let down=serde_json::from_value(serde_json::json!({"inputType":"touch","records":[{"contactId":1,"phase":0,"x":300,"y":250}]})).unwrap();
    assert_eq!(
        crate::input_native::apply(
            "held-on-resize".into(),
            held["leaseId"].as_str().unwrap().into(),
            moved.revision.clone(),
            down
        )["status"],
        "submitted"
    );
    pump(hwnd);
    assert_eq!(crate::pointer::active_points().len(), 1);
    unsafe {
        SetWindowPos(
            hwnd,
            None,
            200,
            150,
            800,
            520,
            SWP_NOACTIVATE | SWP_NOZORDER,
        )
        .unwrap();
    }
    pump(hwnd);
    assert!(
        crate::pointer::active_points().is_empty(),
        "target resize must cancel held native contacts without renderer cooperation"
    );
    assert!(!crate::input_native::is_owned());
    let mut resized = None;
    for _ in 0..30 {
        pump(hwnd);
        let bytes = native_capture::frame(&started.capture_id).unwrap();
        let n = u32::from_be_bytes(bytes[..4].try_into().unwrap()) as usize;
        let meta: serde_json::Value = serde_json::from_slice(&bytes[4..4 + n]).unwrap();
        if meta["geometry"]["inputReady"] == true && meta["width"].as_u64().unwrap() > width as u64
        {
            resized = Some(meta);
            break;
        }
    }
    let resized = resized.expect("resized source must publish new pixels before input resumes");
    assert_ne!(resized["geometry"]["revision"], revision);
    let ready = native_capture::snapshot().unwrap();
    let prepared = crate::input_native::prepare(
        "held-on-minimize".into(),
        "fixture-minimize".into(),
        ready.revision.clone(),
        ready.native_id.clone(),
        vec!["touch".into()],
        10,
    );
    assert_eq!(prepared["status"], "ready", "{prepared}");
    let down=serde_json::from_value(serde_json::json!({"inputType":"touch","records":[{"contactId":1,"phase":0,"x":300,"y":250}]})).unwrap();
    assert_eq!(
        crate::input_native::apply(
            "held-on-minimize".into(),
            prepared["leaseId"].as_str().unwrap().into(),
            ready.revision.clone(),
            down
        )["status"],
        "submitted"
    );
    pump(hwnd);
    unsafe {
        let _ = ShowWindow(hwnd, SW_MINIMIZE);
    }
    pump(hwnd);
    assert!(!native_capture::snapshot().unwrap().input_ready);
    assert!(crate::pointer::active_points().is_empty());
    assert!(!crate::input_native::is_owned());
    assert!(
        !crate::capture_indicator::status(&started.capture_id)
            .unwrap()
            .visible
    );
    unsafe {
        let _ = ShowWindow(hwnd, SW_RESTORE);
        activate_fixture(hwnd);
        let _ = InvalidateRect(Some(hwnd), None, true);
    }
    pump(hwnd);
    for _ in 0..20 {
        let _ = native_capture::frame(&started.capture_id);
        pump(hwnd);
        if native_capture::snapshot().unwrap().input_ready {
            break;
        }
    }
    let ready = native_capture::snapshot().unwrap();
    assert!(ready.input_ready);
    let prepared = crate::input_native::prepare(
        "held-on-close".into(),
        "fixture-close".into(),
        ready.revision.clone(),
        ready.native_id.clone(),
        vec!["touch".into()],
        10,
    );
    assert_eq!(prepared["status"], "ready", "{prepared}");
    let down=serde_json::from_value(serde_json::json!({"inputType":"touch","records":[{"contactId":1,"phase":0,"x":300,"y":250}]})).unwrap();
    assert_eq!(
        crate::input_native::apply(
            "held-on-close".into(),
            prepared["leaseId"].as_str().unwrap().into(),
            ready.revision.clone(),
            down
        )["status"],
        "submitted"
    );
    pump(hwnd);
    unsafe {
        DestroyWindow(hwnd).unwrap();
    }
    pump(hwnd);
    assert!(!native_capture::snapshot().unwrap().input_ready);
    assert!(crate::pointer::active_points().is_empty());
    assert!(!crate::input_native::is_owned());
    assert!(
        !crate::capture_indicator::status(&started.capture_id)
            .unwrap()
            .visible
    );
    native_capture::stop(&started.capture_id).unwrap();
    assert!(native_capture::snapshot().is_none());
    assert!(crate::capture_indicator::status(&started.capture_id).is_none());
    eprintln!("native WGC owned-window pixel/geometry/border/touch receipt/move/resize/minimize/close/cleanup PASS");
    owned_monitor_capture_fixtures();
}

fn owned_monitor_capture_fixtures() {
    let monitors: Vec<_> = crate::capture_target::list()
        .unwrap()
        .into_iter()
        .filter(|c| c.kind == "monitor")
        .collect();
    assert!(!monitors.is_empty());
    for monitor in monitors {
        let r = monitor.region;
        let hwnd = unsafe {
            CreateWindowExW(
                WS_EX_TOPMOST,
                w!("BUTTON"),
                w!("NearCast owned monitor capture fixture"),
                WS_POPUP | WS_VISIBLE,
                r.x,
                r.y,
                r.width,
                r.height,
                None,
                None,
                None,
                None,
            )
            .unwrap()
        };
        struct Window(HWND);
        impl Drop for Window {
            fn drop(&mut self) {
                native_capture::shutdown();
                unsafe {
                    let _ = DestroyWindow(self.0);
                }
            }
        }
        let _window = Window(hwnd);
        PREVIOUS.store(
            unsafe { SetWindowLongPtrW(hwnd, GWLP_WNDPROC, procedure as *const () as isize) },
            Ordering::SeqCst,
        );
        unsafe {
            activate_fixture(hwnd);
            let _ = InvalidateRect(Some(hwnd), None, true);
        }
        pump(hwnd);
        let point = POINT {
            x: r.x + r.width / 2,
            y: r.y + r.height / 2,
        };
        assert_eq!(
            unsafe { WindowFromPoint(point) },
            hwnd,
            "test must cover the selected monitor with its own window"
        );
        let foreground = unsafe { GetForegroundWindow() };
        let preview = thumbnail_on_worker(&monitor.target_id);
        assert_eq!(i32::from_le_bytes(preview[18..22].try_into().unwrap()), 320);
        assert_eq!(
            i32::from_le_bytes(preview[22..26].try_into().unwrap()),
            -180
        );
        assert_eq!(
            &preview[54 + (320 + 1) * 4..54 + (320 + 1) * 4 + 3],
            &[0x33, 0x22, 0x11]
        );
        assert!(native_capture::snapshot().is_none());
        assert!(!crate::input_native::is_owned());
        assert_eq!(unsafe { GetForegroundWindow() }, foreground);
        let started = native_capture::start(&monitor.target_id).unwrap();
        let mut metadata = serde_json::Value::Null;
        let mut frames = 0;
        let begin = Instant::now();
        for _ in 0..40 {
            unsafe {
                let _ = InvalidateRect(Some(hwnd), None, true);
            }
            let mut message = MSG::default();
            unsafe {
                while PeekMessageW(&mut message, Some(hwnd), 0, 0, PM_REMOVE).as_bool() {
                    let _ = TranslateMessage(&message);
                    DispatchMessageW(&message);
                }
            }
            let bytes = native_capture::frame(&started.capture_id).unwrap();
            let n = u32::from_be_bytes(bytes[..4].try_into().unwrap()) as usize;
            let meta: serde_json::Value = serde_json::from_slice(&bytes[4..4 + n]).unwrap();
            if bytes.len() > 4 + n {
                frames += 1;
                assert_eq!(meta["width"], r.width);
                assert_eq!(meta["height"], r.height);
                // The red monitor ring is inside these pixels, but must be
                // absent from the captured surface (WDA_EXCLUDEFROMCAPTURE).
                let at = (r.width as usize + 1) * 4 + 4 + n;
                assert_eq!(
                    &bytes[at..at + 3],
                    &[0x33, 0x22, 0x11],
                    "sharing outline leaked into monitor pixels"
                );
                metadata = meta;
            }
        }
        assert!(
            frames >= 20,
            "owned animated surface did not produce enough frames"
        );
        let ready = native_capture::snapshot().unwrap();
        assert!(ready.input_ready);
        assert_eq!(ready.region.x, r.x as f64);
        assert_eq!(ready.region.y, r.y as f64);
        assert_eq!(
            metadata["geometry"]["region"]["x"].as_f64().unwrap(),
            r.x as f64
        );
        eprintln!("owned monitor {}x{} origin=({},{}), {} frames in {:.3}s, native WGC read/copy/packet {:.1} fps (IPC/encoding excluded)",r.width,r.height,r.x,r.y,frames,begin.elapsed().as_secs_f64(),frames as f64/begin.elapsed().as_secs_f64());
        let prepared = crate::input_native::prepare(
            "owned-monitor-input".into(),
            "fixture-monitor".into(),
            ready.revision.clone(),
            ready.native_id.clone(),
            vec!["touch".into()],
            10,
        );
        assert_eq!(prepared["status"], "ready", "{prepared}");
        let cx = r.x + r.width / 4;
        let cy = r.y + r.height / 4;
        let mark = crate::touch_feedback::Point {
            contact_id: 1,
            x: cx,
            y: cy,
            phase: 0,
            submitted: false,
            expires_in_ms: None,
        };
        crate::capture_indicator::touch_scene(
            &started.capture_id,
            &ready.revision,
            "owned-monitor-input",
            1,
            vec![mark],
        )
        .unwrap();
        pump(hwnd);
        assert_eq!(
            crate::capture_indicator::status(&started.capture_id)
                .unwrap()
                .touch_points,
            1
        );
        assert_eq!(
            unsafe { WindowFromPoint(POINT { x: cx + 22, y: cy }) },
            hwnd,
            "monitor circle cannot intercept input"
        );
        unsafe {
            let _ = InvalidateRect(Some(hwnd), None, true);
        }
        pump(hwnd);
        let image = native_capture::frame(&started.capture_id).unwrap();
        let n = u32::from_be_bytes(image[..4].try_into().unwrap()) as usize;
        assert!(
            image.len() > 4 + n,
            "owned repaint must yield pixels for the exclusion check"
        );
        let offset = 4 + n + (((cy - r.y) * r.width + (cx - r.x + 22)) as usize) * 4;
        assert_eq!(
            &image[offset..offset + 3],
            &[0x33, 0x22, 0x11],
            "Touch circle leaked into monitor capture"
        );
        let before = TOUCH_DOWN.load(Ordering::SeqCst);
        for phase in [0, 2] {
            assert_eq!(unsafe { WindowFromPoint(point) }, hwnd);
            let action=serde_json::from_value(serde_json::json!({"inputType":"touch","records":[{"contactId":1,"phase":phase,"x":point.x,"y":point.y}]})).unwrap();
            let applied = crate::input_native::apply(
                "owned-monitor-input".into(),
                prepared["leaseId"].as_str().unwrap().into(),
                ready.revision.clone(),
                action,
            );
            assert_eq!(applied["status"], "submitted", "{applied}");
            pump(hwnd);
        }
        assert_eq!(
            TOUCH_DOWN.load(Ordering::SeqCst),
            before + 1,
            "selected monitor fixture must receive native Touch"
        );
        native_capture::stop(&started.capture_id).unwrap();
        assert!(crate::pointer::active_points().is_empty());
        assert!(!crate::input_native::is_owned());
    }
    eprintln!("owned monitor pixel/origin/outline exclusion/native Touch PASS");
}
