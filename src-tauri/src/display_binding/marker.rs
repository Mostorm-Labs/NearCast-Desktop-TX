use super::MarkedDisplay;
use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc,
    },
    time::{Duration, Instant},
};
use windows::{
    core::{w, PCWSTR},
    Win32::{
        Foundation::{HWND, LPARAM, LRESULT, WPARAM},
        Graphics::Gdi::*,
        UI::{HiDpi::*, WindowsAndMessaging::*},
    },
};
const GRID: i32 = 12;
const CELL: i32 = 8;
const SIZE: i32 = GRID * CELL;
const INSET: i32 = 16;
struct Paint {
    bits: Vec<bool>,
}
fn bits(token: &str, corner: u8) -> Vec<bool> {
    let mut data: Vec<bool> = (0..8).rev().map(|n| 0xa7u8 & (1 << n) != 0).collect();
    data.extend([corner & 2 != 0, corner & 1 != 0]);
    for char in token.chars() {
        let v = char.to_digit(16).unwrap() as u8;
        data.extend((0..4).rev().map(|n| v & (1 << n) != 0));
    }
    while data.len() < 100 {
        data.push(data.len() % 2 != 0);
    }
    (0..GRID * GRID)
        .map(|i| {
            let x = i % GRID;
            let y = i / GRID;
            if x == 0 || y == 0 || x == GRID - 1 || y == GRID - 1 {
                (x + y) % 2 != 0
            } else {
                data[((y - 1) * 10 + x - 1) as usize]
            }
        })
        .collect()
}
unsafe extern "system" fn procedure(hwnd: HWND, msg: u32, wp: WPARAM, lp: LPARAM) -> LRESULT {
    match msg {
        WM_NCHITTEST => return LRESULT(HTTRANSPARENT as isize),
        WM_MOUSEACTIVATE => return LRESULT(MA_NOACTIVATE as isize),
        WM_PAINT => {
            let mut ps = PAINTSTRUCT::default();
            let dc = BeginPaint(hwnd, &mut ps);
            if let Some(paint) = (GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *const Paint).as_ref() {
                for (i, bit) in paint.bits.iter().enumerate() {
                    let x = i as i32 % GRID * CELL;
                    let y = i as i32 / GRID * CELL;
                    let rect = windows::Win32::Foundation::RECT {
                        left: x,
                        top: y,
                        right: x + CELL,
                        bottom: y + CELL,
                    };
                    FillRect(
                        dc,
                        &rect,
                        HBRUSH(GetStockObject(if *bit { WHITE_BRUSH } else { BLACK_BRUSH }).0),
                    );
                }
            }
            let _ = EndPaint(hwnd, &ps);
            return LRESULT(0);
        }
        WM_ERASEBKGND => return LRESULT(1),
        _ => {}
    }
    DefWindowProcW(hwnd, msg, wp, lp)
}
pub struct Overlay {
    stop: Arc<AtomicBool>,
    done: mpsc::Receiver<()>,
}
impl Overlay {
    pub fn start(displays: &[MarkedDisplay]) -> Result<Self, String> {
        let displays = displays.to_vec();
        let stop = Arc::new(AtomicBool::new(false));
        let stopped = stop.clone();
        let (ready, wait) = mpsc::sync_channel(1);
        let (done, finished) = mpsc::sync_channel(1);
        std::thread::spawn(move || {
            let mut windows: Vec<HWND> = Vec::new();
            let mut paints: Vec<Box<Paint>> = Vec::new();
            let result = (|| -> Result<(), String> {
                let previous = unsafe {
                    SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2)
                };
                if previous.0.is_null() {
                    return Err("Marker DPI context unavailable".into());
                }
                struct Dpi(DPI_AWARENESS_CONTEXT);
                impl Drop for Dpi {
                    fn drop(&mut self) {
                        unsafe {
                            SetThreadDpiAwarenessContext(self.0);
                        }
                    }
                }
                let _dpi = Dpi(previous);
                let class = w!("NearCastDisplayCalibration");
                let wc = WNDCLASSW {
                    lpfnWndProc: Some(procedure),
                    lpszClassName: class,
                    ..Default::default()
                };
                unsafe {
                    RegisterClassW(&wc);
                }
                for display in &displays {
                    for corner in 0..4u8 {
                        let r = &display.display.region;
                        let x = r.x as i32
                            + if corner % 2 == 0 {
                                INSET
                            } else {
                                r.width as i32 - INSET - SIZE
                            };
                        let y = r.y as i32
                            + if corner < 2 {
                                INSET
                            } else {
                                r.height as i32 - INSET - SIZE
                            };
                        let mut paint = Box::new(Paint {
                            bits: bits(&display.token, corner),
                        });
                        let hwnd = unsafe {
                            CreateWindowExW(
                                WS_EX_TOPMOST
                                    | WS_EX_TOOLWINDOW
                                    | WS_EX_NOACTIVATE
                                    | WS_EX_TRANSPARENT,
                                class,
                                PCWSTR::null(),
                                WS_POPUP,
                                x,
                                y,
                                SIZE,
                                SIZE,
                                None,
                                None,
                                None,
                                None,
                            )
                        }
                        .map_err(|e| e.to_string())?;
                        unsafe {
                            SetWindowLongPtrW(
                                hwnd,
                                GWLP_USERDATA,
                                (&mut *paint) as *mut Paint as isize,
                            );
                            let _ = ShowWindow(hwnd, SW_SHOWNOACTIVATE);
                            let _ = UpdateWindow(hwnd);
                        }
                        windows.push(hwnd);
                        paints.push(paint);
                    }
                }
                let _ = ready.send(Ok(()));
                let until = Instant::now() + Duration::from_secs(6);
                while !stopped.load(Ordering::Acquire) && Instant::now() < until {
                    let mut message = MSG::default();
                    unsafe {
                        while PeekMessageW(&mut message, None, 0, 0, PM_REMOVE).as_bool() {
                            DispatchMessageW(&message);
                        }
                    }
                    std::thread::sleep(Duration::from_millis(10));
                }
                Ok(())
            })();
            if let Err(e) = result {
                let _ = ready.send(Err(e));
            }
            for hwnd in windows {
                unsafe {
                    SetWindowLongPtrW(hwnd, GWLP_USERDATA, 0);
                    let _ = DestroyWindow(hwnd);
                }
            }
            drop(paints);
            let _ = done.send(());
        });
        match wait.recv_timeout(Duration::from_secs(2)) {
            Ok(Ok(())) => Ok(Self {
                stop,
                done: finished,
            }),
            other => {
                stop.store(true, Ordering::Release);
                Err(match other {
                    Ok(Err(e)) => e,
                    _ => "Display marker startup timed out".into(),
                })
            }
        }
    }
    pub fn stop(self) {
        self.stop.store(true, Ordering::Release);
        let _ = self.done.recv_timeout(Duration::from_secs(1));
    }
}
impl Drop for Overlay {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
    }
}
#[cfg(test)]
pub(super) fn verify_visible(displays: &[MarkedDisplay]) -> Result<(), String> {
    let previous =
        unsafe { SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2) };
    let dc = unsafe { GetDC(None) };
    if dc.0.is_null() {
        return Err("Marker test DC unavailable".into());
    }
    let result = (|| {
        for display in displays {
            for corner in 0..4u8 {
                let r = &display.display.region;
                let x = r.x as i32
                    + if corner % 2 == 0 {
                        INSET
                    } else {
                        r.width as i32 - INSET - SIZE
                    };
                let y = r.y as i32
                    + if corner < 2 {
                        INSET
                    } else {
                        r.height as i32 - INSET - SIZE
                    };
                let cells = bits(&display.token, corner);
                for i in [0usize, 13, 38, 71, 130, 143] {
                    let bit = &cells[i];
                    let color = unsafe {
                        GetPixel(
                            dc,
                            x + i as i32 % GRID * CELL + CELL / 2,
                            y + i as i32 / GRID * CELL + CELL / 2,
                        )
                    }
                    .0 & 0xffffff;
                    let expected = if *bit { 0xffffff } else { 0 };
                    if color != expected {
                        return Err(format!(
                            "Marker pixel mismatch corner={corner} cell={i} got={color:x}"
                        ));
                    }
                }
            }
        }
        Ok(())
    })();
    unsafe {
        ReleaseDC(None, dc);
        SetThreadDpiAwarenessContext(previous);
    }
    result
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn marker_layout_has_random_identity_and_four_distinct_corner_codes() {
        let a = bits("0123456789abcdef", 0);
        assert_eq!(a.len(), 144);
        assert_ne!(a, bits("0123456789abcdef", 1));
        assert_ne!(a, bits("1123456789abcdef", 0));
        assert_eq!(
            &a[..12],
            &[false, true, false, true, false, true, false, true, false, true, false, true]
        );
    }
}
