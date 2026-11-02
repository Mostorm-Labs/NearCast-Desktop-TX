#![cfg(target_os = "macos")]

use std::sync::Mutex;
use crate::macos_input_model::{coordinate, modifier_flags, mouse_button};

#[repr(C)]
#[derive(Clone, Copy)]
struct CGPoint { x: f64, y: f64 }

#[repr(C)]
#[derive(Clone, Copy)]
struct CGSize { width: f64, height: f64 }

#[repr(C)]
struct CGRect { origin: CGPoint, size: CGSize }

type CGEventRef = *mut std::ffi::c_void;
type CGEventSourceRef = *mut std::ffi::c_void;

#[link(name = "ApplicationServices", kind = "framework")]
extern "C" {
    fn AXIsProcessTrusted() -> u8;
    fn CGEventCreateMouseEvent(source: CGEventSourceRef, mouse_type: u32, point: CGPoint, button: u32) -> CGEventRef;
    fn CGEventPost(tap: u32, event: CGEventRef);
    fn CGEventSetFlags(event: CGEventRef, flags: u64);
    fn CFRelease(value: *const std::ffi::c_void);
}

#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGMainDisplayID() -> u32;
    fn CGDisplayBounds(display: u32) -> CGRect;
}

const HID_EVENT_TAP: u32 = 0;
const MOUSE_MOVED: u32 = 5;
struct PointerState {
    button: Option<u8>,
    point: CGPoint,
}
static POINTER: Mutex<PointerState> = Mutex::new(PointerState {button: None, point: CGPoint {x: 0.0, y: 0.0}});

fn display_point(x: i32, y: i32) -> Result<CGPoint, String> {
    // CGEvent coordinates use desktop points, not Retina backing pixels.
    // The v1 profile targets the primary display; other capture targets need
    // a negotiated display/region mapping before enabling input.
    let bounds = unsafe { CGDisplayBounds(CGMainDisplayID()) };
    Ok(CGPoint {
        x: coordinate(x, bounds.origin.x, bounds.size.width)?,
        y: coordinate(y, bounds.origin.y, bounds.size.height)?,
    })
}

fn post_mouse(mouse_type: u32, point: CGPoint, button: u32, modifiers: u16) -> Result<(), String> {
    let flags = modifier_flags(modifiers)?;
    unsafe {
        let event = CGEventCreateMouseEvent(std::ptr::null_mut(), mouse_type, point, button);
        if event.is_null() { return Err("Unable to create macOS mouse event".into()); }
        CGEventSetFlags(event, flags);
        CGEventPost(HID_EVENT_TAP, event);
        CFRelease(event.cast());
    }
    Ok(())
}

pub fn initialize() -> bool { unsafe { AXIsProcessTrusted() != 0 } }

fn ensure_trusted() -> Result<(), String> {
    if initialize() { Ok(()) } else { Err("not_authorized".into()) }
}

pub fn move_pointer(x: i32, y: i32, modifiers: u16) -> Result<(), String> {
    ensure_trusted()?;
    let point = display_point(x, y)?;
    let mut state = POINTER.lock().map_err(|_| "macOS input state poisoned")?;
    let (event, button) = match state.button {
        Some(mask) => { let button = mouse_button(mask)?; (button.drag, button.number) },
        None => (MOUSE_MOVED, 0),
    };
    post_mouse(event, point, button, modifiers)?;
    state.point = point;
    Ok(())
}

pub fn button(button: u8, down: bool, x: i32, y: i32, modifiers: u16) -> Result<(), String> {
    ensure_trusted()?;
    let descriptor = mouse_button(button)?;
    let point = display_point(x, y)?;
    let mut state = POINTER.lock().map_err(|_| "macOS input state poisoned")?;
    if (down && state.button.is_some()) || (!down && state.button != Some(button)) { return Err("invalid_state".into()); }
    post_mouse(if down {descriptor.down} else {descriptor.up}, point, descriptor.number, modifiers)?;
    state.button = if down {Some(button)} else {None};
    state.point = point;
    Ok(())
}

pub fn reset() -> Result<(), String> {
    let (mask, point) = {
        let state = POINTER.lock().map_err(|_| "macOS input state poisoned")?;
        (state.button, state.point)
    };
    if let Some(mask) = mask {
        ensure_trusted()?;
        let descriptor = mouse_button(mask)?;
        post_mouse(descriptor.up, point, descriptor.number, 0)?;
        POINTER.lock().map_err(|_| "macOS input state poisoned")?.button = None;
    }
    Ok(())
}
