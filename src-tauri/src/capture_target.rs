use serde::Serialize;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}
impl Rect {
    pub fn valid(self) -> bool {
        self.width > 0 && self.height > 0 && self.width <= 16384 && self.height <= 16384
    }
    pub fn contains(self, x: i32, y: i32) -> bool {
        self.valid()
            && x >= self.x
            && y >= self.y
            && (x as i64) < self.x as i64 + self.width as i64
            && (y as i64) < self.y as i64 + self.height as i64
    }
}
pub fn capture_rect(width: i32, height: i32, visible: Rect, window: Rect) -> Result<Rect, String> {
    [visible, window]
        .into_iter()
        .find(|r| r.valid() && r.width == width && r.height == height)
        .ok_or("capture_window_pixels_do_not_match_native_bounds".into())
}

#[cfg(windows)]
pub use platform::*;
#[cfg(windows)]
mod platform {
    use super::*;
    use std::sync::Mutex;
    use windows::core::BOOL;
    use windows::Win32::{
        Foundation::{HWND, LPARAM, RECT},
        Graphics::{Dwm::*, Gdi::*},
        UI::{HiDpi::*, WindowsAndMessaging::*},
    };
    #[derive(Clone, Debug)]
    pub enum Target {
        Monitor { handle: isize, name: String },
        Window { handle: isize, pid: u32 },
    }
    #[derive(Clone, Debug, PartialEq, Eq, Serialize)]
    #[serde(rename_all = "camelCase")]
    pub struct CaptureLayout {
        dpi: u32,
        maximized: bool,
        client_insets: [i32; 4],
        frame_style: u32,
    }
    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    pub struct Choice {
        pub target_id: String,
        pub kind: &'static str,
        pub title: String,
        pub region: Rect,
        pub primary: bool,
    }
    static CHOICES: Mutex<Vec<(String, Target)>> = Mutex::new(Vec::new());
    pub struct DpiGuard(DPI_AWARENESS_CONTEXT);
    impl DpiGuard {
        pub fn new() -> Result<Self, String> {
            let old =
                unsafe { SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2) };
            if old.0.is_null() {
                Err("capture_dpi_context_unavailable".into())
            } else {
                Ok(Self(old))
            }
        }
    }
    impl Drop for DpiGuard {
        fn drop(&mut self) {
            unsafe {
                SetThreadDpiAwarenessContext(self.0);
            }
        }
    }
    fn rect(r: RECT) -> Rect {
        Rect {
            x: r.left,
            y: r.top,
            width: r.right - r.left,
            height: r.bottom - r.top,
        }
    }
    fn nonce() -> Result<String, String> {
        let mut b = [0; 16];
        getrandom::fill(&mut b).map_err(|e| e.to_string())?;
        Ok(b.iter().map(|v| format!("{v:02x}")).collect())
    }
    impl Target {
        pub fn kind(&self) -> &'static str {
            match self {
                Self::Monitor { .. } => "monitor",
                Self::Window { .. } => "window",
            }
        }
        pub fn bounds(&self, size: Option<(i32, i32)>) -> Result<Rect, String> {
            let _dpi = DpiGuard::new()?;
            match self {
                Self::Monitor { handle, name } => {
                    let mut info = MONITORINFOEXW::default();
                    info.monitorInfo.cbSize = std::mem::size_of::<MONITORINFOEXW>() as u32;
                    if !unsafe {
                        GetMonitorInfoW(HMONITOR(*handle as *mut _), &mut info.monitorInfo)
                    }
                    .as_bool()
                    {
                        return Err("capture_monitor_removed".into());
                    }
                    let end = info
                        .szDevice
                        .iter()
                        .position(|v| *v == 0)
                        .unwrap_or(info.szDevice.len());
                    if String::from_utf16_lossy(&info.szDevice[..end]) != *name {
                        return Err("capture_monitor_identity_changed".into());
                    }
                    let r = rect(info.monitorInfo.rcMonitor);
                    if !r.valid() || size.is_some_and(|(w, h)| w != r.width || h != r.height) {
                        return Err("capture_monitor_geometry_changed".into());
                    }
                    Ok(r)
                }
                Self::Window { handle, pid } => {
                    let hwnd = HWND(*handle as *mut _);
                    let mut now_pid = 0;
                    if !unsafe { IsWindow(Some(hwnd)) }.as_bool()
                        || unsafe { GetWindowThreadProcessId(hwnd, Some(&mut now_pid)) } == 0
                        || now_pid != *pid
                    {
                        return Err("capture_window_closed".into());
                    }
                    if !unsafe { IsWindowVisible(hwnd) }.as_bool()
                        || unsafe { IsIconic(hwnd) }.as_bool()
                    {
                        return Err("capture_window_minimized_or_hidden".into());
                    }
                    let mut cloaked = 0u32;
                    if unsafe {
                        DwmGetWindowAttribute(
                            hwnd,
                            DWMWA_CLOAKED,
                            &mut cloaked as *mut _ as *mut _,
                            4,
                        )
                    }
                    .is_ok()
                        && cloaked != 0
                    {
                        return Err("capture_window_minimized_or_hidden".into());
                    }
                    let mut window = RECT::default();
                    unsafe { GetWindowRect(hwnd, &mut window) }.map_err(|e| e.to_string())?;
                    let mut visible = window;
                    let _ = unsafe {
                        DwmGetWindowAttribute(
                            hwnd,
                            DWMWA_EXTENDED_FRAME_BOUNDS,
                            &mut visible as *mut _ as *mut _,
                            std::mem::size_of::<RECT>() as u32,
                        )
                    };
                    match size {
                        Some((w, h)) => capture_rect(w, h, rect(visible), rect(window)),
                        None => Ok(rect(visible)),
                    }
                }
            }
        }
        pub fn capture_layout(&self) -> Result<Option<CaptureLayout>, String> {
            let Self::Window { handle, .. } = self else {
                return Ok(None);
            };
            let _dpi = DpiGuard::new()?;
            self.bounds(None)?; // Revalidate the selected HWND/PID and visibility.
            let hwnd = HWND(*handle as *mut _);
            let mut outer = RECT::default();
            let mut client = RECT::default();
            let mut origin = windows::Win32::Foundation::POINT::default();
            unsafe {
                GetWindowRect(hwnd, &mut outer).map_err(|e| e.to_string())?;
                GetClientRect(hwnd, &mut client).map_err(|e| e.to_string())?;
                if !ClientToScreen(hwnd, &mut origin).as_bool() {
                    return Err("capture_client_geometry_unavailable".into());
                }
            }
            Ok(Some(CaptureLayout {
                dpi: unsafe { GetDpiForWindow(hwnd) },
                maximized: unsafe { IsZoomed(hwnd) }.as_bool(),
                client_insets: [
                    origin.x - outer.left,
                    origin.y - outer.top,
                    outer.right - origin.x - client.right,
                    outer.bottom - origin.y - client.bottom,
                ],
                frame_style: unsafe { GetWindowLongW(hwnd, GWL_STYLE) } as u32
                    & (WS_CAPTION | WS_THICKFRAME | WS_BORDER).0,
            }))
        }
        pub fn input_ready(&self) -> bool {
            match self {
                Self::Monitor { .. } => true,
                Self::Window { handle, .. } => {
                    (unsafe { GetForegroundWindow() }) == HWND(*handle as *mut _)
                }
            }
        }
        pub fn hit_target(&self, x: i32, y: i32) -> bool {
            if !self.bounds(None).is_ok_and(|r| r.contains(x, y)) {
                return false;
            }
            match self {
                Self::Monitor { .. } => true,
                Self::Window { handle, .. } => {
                    (unsafe {
                        GetAncestor(
                            WindowFromPoint(windows::Win32::Foundation::POINT { x, y }),
                            GA_ROOT,
                        )
                    }) == HWND(*handle as *mut _)
                }
            }
        }
        pub fn activate(&self) {
            if let Self::Window { handle, .. } = self {
                unsafe {
                    let _ = SetForegroundWindow(HWND(*handle as *mut _));
                }
            }
        }
    }
    pub fn resolve(id: &str) -> Result<Target, String> {
        CHOICES
            .lock()
            .map_err(|_| "capture_choices_poisoned")?
            .iter()
            .find(|(key, _)| key == id)
            .map(|(_, target)| target.clone())
            .ok_or("capture_selection_expired".into())
    }
    pub fn list() -> Result<Vec<Choice>, String> {
        let _dpi = DpiGuard::new()?;
        let mut targets: Vec<(Target, String, bool)> = Vec::new();
        unsafe extern "system" fn monitor(h: HMONITOR, _: HDC, _: *mut RECT, data: LPARAM) -> BOOL {
            let targets = &mut *(data.0 as *mut Vec<(Target, String, bool)>);
            let mut info = MONITORINFOEXW::default();
            info.monitorInfo.cbSize = std::mem::size_of::<MONITORINFOEXW>() as u32;
            if GetMonitorInfoW(h, &mut info.monitorInfo).as_bool() {
                let end = info
                    .szDevice
                    .iter()
                    .position(|v| *v == 0)
                    .unwrap_or(info.szDevice.len());
                let name = String::from_utf16_lossy(&info.szDevice[..end]);
                targets.push((
                    Target::Monitor {
                        handle: h.0 as isize,
                        name: name.clone(),
                    },
                    name,
                    info.monitorInfo.dwFlags & 1 != 0,
                ));
            }
            BOOL(1)
        }
        unsafe extern "system" fn window(h: HWND, data: LPARAM) -> BOOL {
            if !IsWindowVisible(h).as_bool()
                || IsIconic(h).as_bool()
                || GetWindowTextLengthW(h) == 0
                || GetWindowLongW(h, GWL_EXSTYLE) as u32 & WS_EX_TOOLWINDOW.0 != 0
            {
                return BOOL(1);
            }
            let mut cloaked = 0u32;
            if DwmGetWindowAttribute(h, DWMWA_CLOAKED, &mut cloaked as *mut _ as *mut _, 4).is_ok()
                && cloaked != 0
            {
                return BOOL(1);
            }
            let mut text = [0u16; 512];
            let length = GetWindowTextW(h, &mut text);
            if length > 0 {
                let mut pid = 0;
                GetWindowThreadProcessId(h, Some(&mut pid));
                let targets = &mut *(data.0 as *mut Vec<(Target, String, bool)>);
                if targets.len() < 256 {
                    targets.push((
                        Target::Window {
                            handle: h.0 as isize,
                            pid,
                        },
                        String::from_utf16_lossy(&text[..length as usize]),
                        false,
                    ));
                }
            }
            BOOL(1)
        }
        unsafe {
            if !EnumDisplayMonitors(
                None,
                None,
                Some(monitor),
                LPARAM(&mut targets as *mut _ as isize),
            )
            .as_bool()
            {
                return Err("capture_monitor_enumeration_failed".into());
            }
            EnumWindows(Some(window), LPARAM(&mut targets as *mut _ as isize))
                .map_err(|e| e.to_string())?;
        }
        let mut choices = Vec::new();
        let mut registry = Vec::new();
        for (target, title, primary) in targets {
            if let Ok(region) = target.bounds(None) {
                if region.width < 64 || region.height < 64 {
                    continue;
                }
                let id = nonce()?;
                choices.push(Choice {
                    target_id: id.clone(),
                    kind: target.kind(),
                    title,
                    region,
                    primary,
                });
                registry.push((id, target));
            }
        }
        *CHOICES.lock().map_err(|_| "capture_choices_poisoned")? = registry;
        Ok(choices)
    }
}
