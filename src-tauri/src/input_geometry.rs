use serde::Serialize;
use sha2::{Digest, Sha256};

#[derive(Clone, Debug, Serialize)]
pub struct Region {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Display {
    pub native_id: String,
    pub primary: bool,
    pub units: String,
    pub rotation: i32,
    pub region: Region,
    pub capture_width: u32,
    pub capture_height: u32,
}
#[derive(Clone, Debug, Serialize)]
pub struct Geometry {
    pub revision: String,
    pub displays: Vec<Display>,
}
impl Display {
    pub fn contains(&self, x: f64, y: f64) -> bool {
        x.is_finite()
            && y.is_finite()
            && x >= self.region.x
            && y >= self.region.y
            && x <= self.region.x + self.region.width - 1.0
            && y <= self.region.y + self.region.height - 1.0
    }
}
pub fn snapshot() -> Result<Geometry, String> {
    let mut displays = enumerate()?;
    displays.sort_by(|a, b| a.native_id.cmp(&b.native_id));
    let bytes = serde_json::to_vec(&displays).map_err(|error| error.to_string())?;
    let revision = format!("{:x}", Sha256::digest(bytes));
    Ok(Geometry { revision, displays })
}
pub fn current(revision: &str, native_id: &str) -> Result<Display, String> {
    let geometry = snapshot()?;
    if geometry.revision != revision || geometry.displays.len() != 1 {
        return Err("input_geometry_changed_or_unproven".into());
    }
    let display = geometry
        .displays
        .into_iter()
        .next()
        .ok_or("input_geometry_unavailable")?;
    if display.native_id != native_id
        || !display.primary
        || display.rotation != 0
        || display.region.width < 1.0
        || display.region.height < 1.0
    {
        return Err("input_geometry_unsupported".into());
    }
    Ok(display)
}

#[cfg(windows)]
fn enumerate() -> Result<Vec<Display>, String> {
    use windows::core::{BOOL, PCWSTR};
    use windows::Win32::Foundation::{LPARAM, RECT};
    use windows::Win32::Graphics::Gdi::*;
    use windows::Win32::UI::HiDpi::{
        SetThreadDpiAwarenessContext, DPI_AWARENESS_CONTEXT,
        DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2,
    };
    struct DpiGuard(DPI_AWARENESS_CONTEXT);
    impl Drop for DpiGuard {
        fn drop(&mut self) {
            unsafe {
                SetThreadDpiAwarenessContext(self.0);
            }
        }
    }
    let previous =
        unsafe { SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2) };
    if previous.0.is_null() {
        return Err("input_geometry_dpi_context_unavailable".into());
    }
    let _dpi = DpiGuard(previous);
    unsafe extern "system" fn collect(
        monitor: HMONITOR,
        _dc: HDC,
        _rect: *mut RECT,
        data: LPARAM,
    ) -> BOOL {
        let displays = &mut *(data.0 as *mut Vec<Display>);
        let mut info = MONITORINFOEXW::default();
        info.monitorInfo.cbSize = std::mem::size_of::<MONITORINFOEXW>() as u32;
        if !GetMonitorInfoW(monitor, &mut info.monitorInfo).as_bool() {
            return BOOL(0);
        }
        let end = info
            .szDevice
            .iter()
            .position(|ch| *ch == 0)
            .unwrap_or(info.szDevice.len());
        let name = String::from_utf16_lossy(&info.szDevice[..end]);
        let mut mode = DEVMODEW::default();
        mode.dmSize = std::mem::size_of::<DEVMODEW>() as u16;
        if !EnumDisplaySettingsW(
            PCWSTR(info.szDevice.as_ptr()),
            ENUM_CURRENT_SETTINGS,
            &mut mode,
        )
        .as_bool()
        {
            return BOOL(0);
        }
        let rect = info.monitorInfo.rcMonitor;
        // Both queries are made in a physical-pixel DPI context. Refuse a
        // descriptor whose monitor rectangle and native mode disagree.
        if rect.right - rect.left != mode.dmPelsWidth as i32
            || rect.bottom - rect.top != mode.dmPelsHeight as i32
        {
            return BOOL(0);
        }
        displays.push(Display {
            native_id: name,
            primary: info.monitorInfo.dwFlags & 1 != 0,
            units: "physical-pixels".into(),
            rotation: (mode.Anonymous1.Anonymous2.dmDisplayOrientation.0 * 90) as i32,
            region: Region {
                x: rect.left as f64,
                y: rect.top as f64,
                width: (rect.right - rect.left) as f64,
                height: (rect.bottom - rect.top) as f64,
            },
            capture_width: mode.dmPelsWidth,
            capture_height: mode.dmPelsHeight,
        });
        BOOL(1)
    }
    let mut displays = Vec::new();
    if !unsafe {
        EnumDisplayMonitors(
            None,
            None,
            Some(collect),
            LPARAM(&mut displays as *mut Vec<Display> as isize),
        )
    }
    .as_bool()
    {
        return Err("input_geometry_display_enumeration_failed".into());
    }
    Ok(displays)
}

#[cfg(target_os = "macos")]
fn enumerate() -> Result<Vec<Display>, String> {
    #[repr(C)]
    #[derive(Clone, Copy)]
    struct Point {
        x: f64,
        y: f64,
    }
    #[repr(C)]
    #[derive(Clone, Copy)]
    struct Size {
        width: f64,
        height: f64,
    }
    #[repr(C)]
    struct Rect {
        origin: Point,
        size: Size,
    }
    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGMainDisplayID() -> u32;
        fn CGGetActiveDisplayList(max: u32, displays: *mut u32, count: *mut u32) -> i32;
        fn CGDisplayBounds(display: u32) -> Rect;
        fn CGDisplayPixelsWide(display: u32) -> usize;
        fn CGDisplayPixelsHigh(display: u32) -> usize;
        fn CGDisplayRotation(display: u32) -> f64;
    }
    let mut ids = [0u32; 64];
    let mut count = 0;
    if unsafe { CGGetActiveDisplayList(ids.len() as u32, ids.as_mut_ptr(), &mut count) } != 0
        || count == 0
        || count as usize >= ids.len()
    {
        return Err("input_geometry_display_enumeration_failed".into());
    }
    let primary = unsafe { CGMainDisplayID() };
    Ok(ids[..count as usize]
        .iter()
        .map(|id| {
            let rect = unsafe { CGDisplayBounds(*id) };
            Display {
                native_id: format!("cg-display-{id}"),
                primary: *id == primary,
                units: "points".into(),
                rotation: unsafe { CGDisplayRotation(*id) } as i32,
                region: Region {
                    x: rect.origin.x,
                    y: rect.origin.y,
                    width: rect.size.width,
                    height: rect.size.height,
                },
                capture_width: unsafe { CGDisplayPixelsWide(*id) } as u32,
                capture_height: unsafe { CGDisplayPixelsHigh(*id) } as u32,
            }
        })
        .collect())
}
#[cfg(not(any(windows, target_os = "macos")))]
fn enumerate() -> Result<Vec<Display>, String> {
    Ok(Vec::new())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn native_bounds_reject_nonfinite_and_outside_coordinates() {
        let d = Display {
            native_id: "test".into(),
            primary: true,
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
        };
        assert!(d.contains(-1920.0, 0.0));
        assert!(d.contains(-1.0, 1079.0));
        assert!(!d.contains(0.0, 1079.0));
        assert!(!d.contains(f64::NAN, 0.0));
    }
}
