#![cfg(windows)]
use crate::native_capture;
use std::{
    process::{Child, Command},
    time::{Duration, Instant},
};
use windows::Win32::{
    Foundation::*,
    Graphics::{Dwm::*, Gdi::*},
    UI::WindowsAndMessaging::*,
};

fn geometry(window: HWND) -> serde_json::Value {
    let mut outer = RECT::default();
    let mut visible = RECT::default();
    let mut client = RECT::default();
    let mut origin = POINT::default();
    unsafe {
        GetWindowRect(window, &mut outer).unwrap();
        GetClientRect(window, &mut client).unwrap();
        assert!(ClientToScreen(window, &mut origin).as_bool());
        DwmGetWindowAttribute(
            window,
            DWMWA_EXTENDED_FRAME_BOUNDS,
            &mut visible as *mut _ as *mut _,
            std::mem::size_of::<RECT>() as u32,
        )
        .unwrap();
    }
    serde_json::json!({"outer":[outer.left,outer.top,outer.right,outer.bottom],"visible":[visible.left,visible.top,visible.right,visible.bottom],
        "client":[origin.x,origin.y,client.right,client.bottom],"style":unsafe{GetWindowLongW(window,GWL_STYLE)},"maximized":unsafe{IsZoomed(window)}.as_bool()})
}
fn frame(window: HWND, id: &str) -> serde_json::Value {
    let until = Instant::now() + Duration::from_secs(8);
    loop {
        let packet = native_capture::frame(id).unwrap();
        let n = u32::from_be_bytes(packet[..4].try_into().unwrap()) as usize;
        let mut metadata: serde_json::Value = serde_json::from_slice(&packet[4..4 + n]).unwrap();
        if metadata["geometry"]["inputReady"] != true {
            assert!(
                Instant::now() < until,
                "Chrome geometry did not recover: {} capture={metadata}",
                geometry(window)
            );
            std::thread::sleep(Duration::from_millis(25));
            continue;
        }
        if packet.len() > 4 + n {
            let width = metadata["width"].as_u64().unwrap() as usize;
            if let Some(at) = packet[4 + n..]
                .chunks_exact(4)
                .position(|p| p[..3] == [0x30, 0xb0, 0xf0])
            {
                eprintln!("chrome_geometry={} capture={metadata}", geometry(window));
                assert_eq!(
                    metadata["geometry"]["inputReady"], true,
                    "Chrome pixels must obtain a proven mapping"
                );
                let x = metadata["geometry"]["region"]["x"].as_f64().unwrap() as i32
                    + (at % width) as i32;
                let y = metadata["geometry"]["region"]["y"].as_f64().unwrap() as i32
                    + (at / width) as i32;
                unsafe {
                    DwmFlush().unwrap();
                    let dc = GetDC(None);
                    let actual = GetPixel(dc, x, y).0;
                    let left = GetPixel(dc, x - 1, y).0;
                    let top = GetPixel(dc, x, y - 1).0;
                    let _ = ReleaseDC(None, dc);
                    assert_eq!(
                        actual, 0x0030b0f0,
                        "mapped Chrome pixel must match desktop at {x},{y}"
                    );
                    assert_ne!(
                        left, 0x0030b0f0,
                        "mapped marker must be its actual left edge"
                    );
                    assert_ne!(top, 0x0030b0f0, "mapped marker must be its actual top edge");
                }
                metadata["fixtureMarker"] = serde_json::json!([x, y]);
                return metadata;
            }
        }
        assert!(
            Instant::now() < until,
            "Chrome frame did not become ready: {} capture={metadata}",
            geometry(window)
        );
        std::thread::sleep(Duration::from_millis(25));
    }
}

#[test]
#[ignore = "opens an isolated Chrome profile with a local owned test page, then resizes only that window"]
fn chrome_pixels_keep_native_origin_across_repeated_window_changes() {
    let _dpi = crate::capture_target::DpiGuard::new().unwrap();
    let profile = tempfile::tempdir().unwrap();
    let page = profile.path().join("capture-fixture.html");
    std::fs::write(&page,r#"<!doctype html><title>NearCast isolated Chrome geometry fixture</title><style>body{background:white}#marker{position:fixed;left:40px;top:40px;width:5px;height:5px;background:#f0b030}</style><div id=marker></div><script>setInterval(()=>{document.body.style.outlineColor=Date.now()%2?'red':'blue'},100)</script>"#).unwrap();
    let previous = unsafe { GetForegroundWindow() };
    let child = Command::new(r"C:\Program Files\Google\Chrome\Application\chrome.exe")
        .arg(format!(
            "--user-data-dir={}",
            profile.path().join("profile").display()
        ))
        .args([
            "--no-first-run",
            "--no-default-browser-check",
            "--force-color-profile=srgb",
            "--new-window",
        ])
        .arg(format!(
            "file:///{}",
            page.display().to_string().replace('\\', "/")
        ))
        .spawn()
        .unwrap();
    struct Browser {
        child: Child,
        window: HWND,
        previous: HWND,
    }
    impl Drop for Browser {
        fn drop(&mut self) {
            native_capture::shutdown();
            if !self.window.0.is_null() {
                unsafe {
                    let _ = PostMessageW(Some(self.window), WM_CLOSE, WPARAM(0), LPARAM(0));
                }
            }
            let until = Instant::now() + Duration::from_secs(3);
            while self.child.try_wait().ok().flatten().is_none() && Instant::now() < until {
                std::thread::sleep(Duration::from_millis(20));
            }
            if self.child.try_wait().ok().flatten().is_none() {
                let _ = self.child.kill();
                let _ = self.child.wait();
            }
            unsafe {
                let _ = SetForegroundWindow(self.previous);
            }
        }
    }
    let mut browser = Browser {
        child,
        window: HWND::default(),
        previous,
    };
    let until = Instant::now() + Duration::from_secs(15);
    let (choice, target) = loop {
        if let Some(choice) = crate::capture_target::list()
            .unwrap()
            .into_iter()
            .find(|c| {
                c.title
                    .contains("NearCast isolated Chrome geometry fixture")
            })
        {
            let target = crate::capture_target::resolve(&choice.target_id).unwrap();
            break (choice, target);
        }
        assert!(Instant::now() < until, "isolated Chrome window not found");
        std::thread::sleep(Duration::from_millis(100));
    };
    if let crate::capture_target::Target::Window { handle, .. } = target {
        browser.window = HWND(handle as *mut _);
    } else {
        panic!("expected owned Chrome window")
    }
    unsafe {
        SetWindowPos(
            browser.window,
            Some(HWND_TOPMOST),
            557,
            84,
            962,
            876,
            SWP_NOACTIVATE,
        )
        .unwrap();
    }
    let started = native_capture::start(&choice.target_id).unwrap();
    let initial = frame(browser.window, &started.capture_id);
    let prepared = crate::input_native::prepare(
        "chrome-held-before-maximize".into(),
        "chrome-fixture-source".into(),
        initial["geometry"]["revision"].as_str().unwrap().into(),
        started.native_id.clone(),
        vec!["touch".into()],
        10,
    );
    assert_eq!(prepared["status"], "ready", "{prepared}");
    let down = serde_json::from_value(
        serde_json::json!({"inputType":"touch","records":[{"contactId":1,"phase":0,
        "x":initial["fixtureMarker"][0],"y":initial["fixtureMarker"][1]}]}),
    )
    .unwrap();
    assert_eq!(
        crate::input_native::apply(
            "chrome-held-before-maximize".into(),
            prepared["leaseId"].as_str().unwrap().into(),
            initial["geometry"]["revision"].as_str().unwrap().into(),
            down
        )["status"],
        "submitted"
    );
    assert_eq!(crate::pointer::active_points().len(), 1);
    let mut last = initial.clone();
    for round in 0..4 {
        for show in [SW_MAXIMIZE, SW_RESTORE] {
            unsafe {
                let _ = ShowWindow(browser.window, show);
            }
            std::thread::sleep(Duration::from_millis(100));
            let transition = native_capture::frame(&started.capture_id).unwrap();
            let length = u32::from_be_bytes(transition[..4].try_into().unwrap()) as usize;
            let transition_meta: serde_json::Value =
                serde_json::from_slice(&transition[4..4 + length]).unwrap();
            assert_eq!(
                transition.len(),
                4 + length,
                "announce invalid geometry before rebuilding the native backend"
            );
            assert_eq!(transition_meta["geometry"]["inputReady"], false);
            assert_eq!(
                transition_meta["nativeCapture"]["captureGeneration"],
                last["nativeCapture"]["captureGeneration"],
                "invalidation must precede backend generation change"
            );
            last = frame(browser.window, &started.capture_id);
            assert_eq!(
                last["captureId"], started.capture_id,
                "native backend refresh must retain the capture lease"
            );
            assert!(
                !crate::input_native::is_owned(),
                "layout change must release the previous input owner"
            );
            assert!(
                crate::pointer::active_points().is_empty(),
                "layout change must cancel held Touch"
            );
        }
        unsafe {
            SetWindowPos(
                browser.window,
                None,
                557 + round * 7,
                84 + round * 5,
                962 + round * 11,
                876 - round * 13,
                SWP_NOACTIVATE | SWP_NOZORDER,
            )
            .unwrap();
        }
        std::thread::sleep(Duration::from_millis(100));
        last = frame(browser.window, &started.capture_id);
    }
    assert_ne!(
        last["geometry"]["revision"],
        initial["geometry"]["revision"]
    );
    let prepared = crate::input_native::prepare(
        "chrome-new-touch".into(),
        "chrome-new-source".into(),
        last["geometry"]["revision"].as_str().unwrap().into(),
        started.native_id.clone(),
        vec!["touch".into()],
        10,
    );
    assert_eq!(prepared["status"], "ready", "{prepared}");
    for phase in [0, 2] {
        let action = serde_json::from_value(
            serde_json::json!({"inputType":"touch","records":[{"contactId":1,"phase":phase,
            "x":last["fixtureMarker"][0],"y":last["fixtureMarker"][1]}]}),
        )
        .unwrap();
        assert_eq!(
            crate::input_native::apply(
                "chrome-new-touch".into(),
                prepared["leaseId"].as_str().unwrap().into(),
                last["geometry"]["revision"].as_str().unwrap().into(),
                action
            )["status"],
            "submitted"
        );
        std::thread::sleep(Duration::from_millis(50));
    }
    assert!(crate::pointer::active_points().is_empty());
    assert_eq!(
        crate::input_native::release("chrome-new-touch".into(), None)["status"],
        "released"
    );
    native_capture::stop(&started.capture_id).unwrap();
    eprintln!("isolated Chrome repeated resize/maximize/restore and physical marker mapping PASS");
}
