use serde::Serialize;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    mpsc, Arc, Mutex,
};
use std::time::Duration;
use windows::{
    core::w,
    Win32::{
        Foundation::{COLORREF, HWND, LPARAM, LRESULT, RECT, WPARAM},
        Graphics::Gdi::*,
        UI::WindowsAndMessaging::*,
    },
};
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Painted {
    pub mode: String,
    pub visible: bool,
    pub excluded_from_capture: bool,
}
struct Desired {
    revision: String,
    active: bool,
    owner_id: String,
    sequence: u32,
}
struct Controller {
    id: String,
    stop: Arc<AtomicBool>,
    desired: Arc<Mutex<Desired>>,
    painted: Arc<Mutex<Painted>>,
    done: mpsc::Receiver<()>,
}
static ACTIVE: Mutex<Option<Controller>> = Mutex::new(None);

unsafe extern "system" fn procedure(hwnd: HWND, msg: u32, wp: WPARAM, lp: LPARAM) -> LRESULT {
    match msg {
        WM_NCHITTEST => return LRESULT(HTTRANSPARENT as isize),
        WM_MOUSEACTIVATE => return LRESULT(MA_NOACTIVATE as isize),
        WM_ERASEBKGND => return LRESULT(1),
        WM_PAINT => {
            let mut paint = PAINTSTRUCT::default();
            let dc = BeginPaint(hwnd, &mut paint);
            let mut rect = RECT::default();
            let _ = GetClientRect(hwnd, &mut rect);
            let color = GetWindowLongPtrW(hwnd, GWLP_USERDATA) as u32;
            let brush = CreateSolidBrush(COLORREF(color));
            FillRect(dc, &rect, brush);
            let _ = DeleteObject(brush.into());
            let _ = EndPaint(hwnd, &paint);
            return LRESULT(0);
        }
        _ => {}
    }
    DefWindowProcW(hwnd, msg, wp, lp)
}
pub fn status(id: &str) -> Option<Painted> {
    let active = ACTIVE.lock().ok()?;
    let c = active.as_ref().filter(|c| c.id == id)?;
    let value = c.painted.lock().ok()?.clone();
    Some(value)
}
pub fn set(
    id: &str,
    revision: &str,
    active: bool,
    owner_id: &str,
    sequence: u32,
) -> Result<(), String> {
    let guard = ACTIVE.lock().map_err(|_| "capture_indicator_poisoned")?;
    let c = guard
        .as_ref()
        .filter(|c| c.id == id)
        .ok_or("capture_indicator_retired")?;
    let mut desired = c.desired.lock().map_err(|_| "capture_indicator_poisoned")?;
    if sequence <= desired.sequence {
        return Ok(());
    }
    *desired = Desired {
        revision: revision.into(),
        active,
        owner_id: owner_id.into(),
        sequence,
    };
    Ok(())
}
pub fn start(id: &str) -> Result<(), String> {
    let mut active = ACTIVE.lock().map_err(|_| "capture_indicator_poisoned")?;
    if active.is_some() {
        return Err("capture_indicator_already_active".into());
    }
    let stop = Arc::new(AtomicBool::new(false));
    let desired = Arc::new(Mutex::new(Desired {
        revision: String::new(),
        active: false,
        owner_id: String::new(),
        sequence: 0,
    }));
    let painted = Arc::new(Mutex::new(Painted {
        mode: "red".into(),
        visible: false,
        excluded_from_capture: false,
    }));
    let worker_stop = stop.clone();
    let worker_desired = desired.clone();
    let worker_painted = painted.clone();
    let worker_id = id.to_owned();
    let (ready_tx, ready_rx) = mpsc::sync_channel(1);
    let (done_tx, done_rx) = mpsc::channel();
    std::thread::spawn(move || {
        let run = || -> Result<(), String> {
            let _dpi = crate::capture_target::DpiGuard::new()?;
            let hwnd = unsafe {
                CreateWindowExW(
                    WS_EX_TOPMOST
                        | WS_EX_TOOLWINDOW
                        | WS_EX_NOACTIVATE
                        | WS_EX_LAYERED
                        | WS_EX_TRANSPARENT,
                    w!("STATIC"),
                    w!("NearCast sharing outline"),
                    WS_POPUP,
                    0,
                    0,
                    1,
                    1,
                    None,
                    None,
                    None,
                    None,
                )
            }
            .map_err(|e| e.to_string())?;
            struct Window(HWND);
            impl Drop for Window {
                fn drop(&mut self) {
                    unsafe {
                        let _ = DestroyWindow(self.0);
                    }
                }
            }
            let _window = Window(hwnd);
            unsafe {
                SetWindowLongPtrW(hwnd, GWLP_WNDPROC, procedure as *const () as isize);
                SetWindowLongPtrW(hwnd, GWLP_USERDATA, 0x0000ff);
                SetLayeredWindowAttributes(hwnd, COLORREF(0), 255, LWA_COLORKEY)
                    .map_err(|e| e.to_string())?;
            }
            let excluded =
                unsafe { SetWindowDisplayAffinity(hwnd, WDA_EXCLUDEFROMCAPTURE) }.is_ok();
            let _ = ready_tx.send(Ok(()));
            let mut last = None;
            while !worker_stop.load(Ordering::Acquire) {
                let mut msg = MSG::default();
                unsafe {
                    while PeekMessageW(&mut msg, Some(hwnd), 0, 0, PM_REMOVE).as_bool() {
                        let _ = TranslateMessage(&msg);
                        DispatchMessageW(&msg);
                    }
                }
                let capture =
                    crate::native_capture::snapshot().filter(|c| c.capture_id == worker_id);
                if let Some(capture) = capture {
                    // Native target watching is independent of the renderer and
                    // network: a held contact cannot survive a moved/hidden target.
                    let _ = crate::input_native::release_stale_capture(
                        &capture.native_id,
                        &capture.revision,
                        capture.input_ready,
                    );
                    let visible = !capture.disabled_reason.as_deref().is_some_and(|reason| {
                        reason.contains("closed")
                            || reason.contains("removed")
                            || reason.contains("minimized")
                    });
                    let desired = worker_desired
                        .lock()
                        .map_err(|_| "capture_indicator_poisoned")?;
                    let green = desired.active
                        && desired.revision == capture.revision
                        && capture.input_ready
                        && crate::input_native::capture_ready(
                            &capture.native_id,
                            &capture.revision,
                            &desired.owner_id,
                        );
                    let padding = if capture.kind == "window" { 3 } else { 0 };
                    let region = &capture.region;
                    let bounds = (
                        region.x as i32 - padding,
                        region.y as i32 - padding,
                        region.width as i32 + padding * 2,
                        region.height as i32 + padding * 2,
                        green,
                        visible,
                    );
                    if last != Some(bounds) {
                        let (x, y, width, height, green, visible) = bounds;
                        unsafe {
                            SetWindowLongPtrW(
                                hwnd,
                                GWLP_USERDATA,
                                if green { 0x00c000 } else { 0x0000ff },
                            );
                            if visible && width >= 6 && height >= 6 {
                                let outer = CreateRectRgn(0, 0, width, height);
                                let inner = CreateRectRgn(3, 3, width - 3, height - 3);
                                CombineRgn(Some(outer), Some(outer), Some(inner), RGN_DIFF);
                                let _ = DeleteObject(inner.into());
                                if SetWindowRgn(hwnd, Some(outer), true) == 0 {
                                    let _ = DeleteObject(outer.into());
                                }
                                SetWindowPos(
                                    hwnd,
                                    Some(HWND_TOPMOST),
                                    x,
                                    y,
                                    width,
                                    height,
                                    SWP_NOACTIVATE | SWP_SHOWWINDOW,
                                )
                                .map_err(|e| e.to_string())?;
                                let _ = InvalidateRect(Some(hwnd), None, false);
                            } else {
                                let _ = ShowWindow(hwnd, SW_HIDE);
                            }
                        }
                        *worker_painted
                            .lock()
                            .map_err(|_| "capture_indicator_poisoned")? = Painted {
                            mode: if green { "green" } else { "red" }.into(),
                            visible,
                            excluded_from_capture: excluded,
                        };
                        last = Some(bounds);
                    }
                } else {
                    unsafe {
                        let _ = ShowWindow(hwnd, SW_HIDE);
                    }
                    worker_painted
                        .lock()
                        .map_err(|_| "capture_indicator_poisoned")?
                        .visible = false;
                }
                std::thread::sleep(Duration::from_millis(25));
            }
            Ok(())
        };
        if let Err(error) = run() {
            let _ = ready_tx.send(Err(error));
            if let Ok(mut painted) = worker_painted.lock() {
                painted.visible = false;
                painted.mode = "red".into();
            }
            crate::native_capture::fail(&worker_id);
        }
        let _ = done_tx.send(());
    });
    ready_rx
        .recv_timeout(Duration::from_secs(2))
        .map_err(|_| "capture_indicator_start_timeout")??;
    *active = Some(Controller {
        id: id.into(),
        stop,
        desired,
        painted,
        done: done_rx,
    });
    Ok(())
}
pub fn stop(id: &str) -> Result<(), String> {
    let controller = {
        let mut active = ACTIVE.lock().map_err(|_| "capture_indicator_poisoned")?;
        if active.as_ref().is_none_or(|c| c.id != id) {
            return Ok(());
        }
        active.take().unwrap()
    };
    controller.stop.store(true, Ordering::Release);
    controller
        .done
        .recv_timeout(Duration::from_secs(1))
        .map_err(|_| "capture_indicator_stop_timeout")?;
    Ok(())
}
