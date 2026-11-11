#![cfg(target_os = "macos")]

use std::sync::Mutex;
use crate::macos_input_model::{coordinate, modifier_flags, mouse_button, scroll_delta, scroll_phase, wheel_points, browser_zoom_key};

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
    fn CGEventCreateKeyboardEvent(source: CGEventSourceRef, keycode: u16, down: bool) -> CGEventRef;
    fn CGEventPost(tap: u32, event: CGEventRef);
    fn CGEventSetFlags(event: CGEventRef, flags: u64);
    fn CGEventCreateScrollWheelEvent2(source: CGEventSourceRef, units: u32, wheel_count: u32, wheel1: i32, wheel2: i32, wheel3: i32) -> CGEventRef;
    fn CGEventSetLocation(event: CGEventRef, point: CGPoint);
    fn CGEventSetIntegerValueField(event: CGEventRef, field: u32, value: i64);
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
    scroll: Option<ScrollState>,
}
#[derive(Clone, Copy)]
struct ScrollState { point: CGPoint, remainder_x: f64, remainder_y: f64 }
static POINTER: Mutex<PointerState> = Mutex::new(PointerState {button: None, point: CGPoint {x: 0.0, y: 0.0}, scroll: None});

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

fn create_scroll_event(point: CGPoint, dx: i32, dy: i32, phase: u32, modifiers: u16) -> Result<CGEventRef, String> {
    let flags = modifier_flags(modifiers)?;
    unsafe {
        // Pixel units and explicit phases make this a continuous scroll gesture.
        // Keep the location at touch-down so routing stays in the original view.
        let event = CGEventCreateScrollWheelEvent2(std::ptr::null_mut(), 0, 2, dy, dx, 0);
        if event.is_null() { return Err("Unable to create macOS scroll event".into()); }
        CGEventSetLocation(event, point);
        CGEventSetIntegerValueField(event, 88, 1); // kCGScrollWheelEventIsContinuous
        CGEventSetIntegerValueField(event, 99, i64::from(phase)); // kCGScrollWheelEventScrollPhase
        CGEventSetFlags(event, flags);
        Ok(event)
    }
}

fn post_scroll(point: CGPoint, dx: i32, dy: i32, phase: u32, modifiers: u16) -> Result<(), String> {
    let event = create_scroll_event(point, dx, dy, phase, modifiers)?;
    unsafe { CGEventPost(HID_EVENT_TAP, event); CFRelease(event.cast()); }
    Ok(())
}

pub fn initialize() -> bool { unsafe { AXIsProcessTrusted() != 0 } }

fn ensure_trusted() -> Result<(), String> {
    if initialize() { Ok(()) } else { Err("not_authorized".into()) }
}

pub fn move_pointer(x: i32, y: i32, modifiers: u16) -> Result<(), String> {
    let point = display_point(x, y)?;
    move_at_point(point.x,point.y,modifiers)
}

pub fn move_at_point(x:f64,y:f64,modifiers:u16)->Result<(),String>{
    ensure_trusted()?;
    if !x.is_finite()||!y.is_finite(){return Err("invalid_native_point".into());}
    let point=CGPoint{x,y};
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
    let point = display_point(x, y)?;
    button_at_point(button,down,point.x,point.y,modifiers)
}

pub fn button_at_point(button:u8,down:bool,x:f64,y:f64,modifiers:u16)->Result<(),String>{
    ensure_trusted()?;
    if !x.is_finite()||!y.is_finite(){return Err("invalid_native_point".into());}
    let descriptor = mouse_button(button)?;
    let point=CGPoint{x,y};
    let mut state = POINTER.lock().map_err(|_| "macOS input state poisoned")?;
    if state.scroll.is_some() || (down && state.button.is_some()) || (!down && state.button != Some(button)) { return Err("invalid_state".into()); }
    post_mouse(if down {descriptor.down} else {descriptor.up}, point, descriptor.number, modifiers)?;
    state.button = if down {Some(button)} else {None};
    state.point = point;
    Ok(())
}

pub fn scroll(x: i32, y: i32, delta_x: i32, delta_y: i32, phase: &str, modifiers: u16) -> Result<(), String> {
    ensure_trusted()?;
    let phase = scroll_phase(phase)?;
    if (phase == 4 || phase == 8) && (delta_x != 0 || delta_y != 0) { return Err("invalid_state".into()); }
    let point = display_point(x, y)?;
    let bounds = unsafe { CGDisplayBounds(CGMainDisplayID()) };
    let mut state = POINTER.lock().map_err(|_| "macOS input state poisoned")?;
    if state.button.is_some() || (phase == 1 && state.scroll.is_some()) || (phase != 1 && state.scroll.is_none()) { return Err("invalid_state".into()); }
    let previous = state.scroll.unwrap_or(ScrollState {point, remainder_x: 0.0, remainder_y: 0.0});
    if previous.point.x != point.x || previous.point.y != point.y { return Err("invalid_state".into()); }
    let terminal = phase == 4 || phase == 8;
    let (dx, remainder_x) = if terminal {(0, 0.0)} else {scroll_delta(delta_x, bounds.size.width, previous.remainder_x)?};
    let (dy, remainder_y) = if terminal {(0, 0.0)} else {scroll_delta(delta_y, bounds.size.height, previous.remainder_y)?};
    post_scroll(point, dx, dy, phase, modifiers)?;
    state.scroll = if phase == 4 || phase == 8 {None} else {Some(ScrollState {point, remainder_x, remainder_y})};
    Ok(())
}

pub fn reset() -> Result<(), String> {
    let mut state = POINTER.lock().map_err(|_| "macOS input state poisoned")?;
    if let Some(mask) = state.button {
        ensure_trusted()?;
        let descriptor = mouse_button(mask)?;
        post_mouse(descriptor.up, state.point, descriptor.number, 0)?;
        state.button = None;
    }
    if let Some(scroll) = state.scroll {
        ensure_trusted()?;
        post_scroll(scroll.point, 0, 0, 8, 0)?;
        state.scroll = None;
    }
    Ok(())
}

pub fn scroll_at_point(x:f64,y:f64,delta_x:i32,delta_y:i32,unit:u8,phase:u8,width:f64,height:f64,modifiers:u16)->Result<(),String>{
    ensure_trusted()?;
    modifier_flags(modifiers)?;
    if !x.is_finite()||!y.is_finite()||unit>1||(unit==0&&(phase!=0||(delta_x==0&&delta_y==0)))||
        (unit==1&&(!(1..=4).contains(&phase)||(phase>=3&&(delta_x!=0||delta_y!=0)))){return Err("invalid_scroll_event".into());}
    let point=CGPoint{x,y};
    let mut state=POINTER.lock().map_err(|_|"macOS input state poisoned")?;
    if state.button.is_some(){return Err("scroll_while_mouse_button_held".into());}
    if unit==0 {
        if state.scroll.is_some(){return Err("overlapping_scroll".into());}
        let (dx,_)=wheel_points(unit,delta_x,width,0.0)?;
        let (dy,_)=wheel_points(unit,delta_y,height,0.0)?;
        return post_scroll(point,dx,dy,0,modifiers);
    }
    if (phase==1&&state.scroll.is_some())||(phase!=1&&state.scroll.is_none()){return Err("invalid_scroll_lifecycle".into());}
    let previous=state.scroll.unwrap_or(ScrollState{point,remainder_x:0.0,remainder_y:0.0});
    if previous.point.x!=x||previous.point.y!=y{return Err("scroll_anchor_changed".into());}
    let terminal=phase>=3;
    let (dx,remainder_x)=if terminal{(0,0.0)}else{wheel_points(unit,delta_x,width,previous.remainder_x)?};
    let (dy,remainder_y)=if terminal{(0,0.0)}else{wheel_points(unit,delta_y,height,previous.remainder_y)?};
    post_scroll(point,dx,dy,match phase{1=>1,2=>2,3=>4,_=>8},modifiers)?;
    state.scroll=if terminal{None}else{Some(ScrollState{point,remainder_x,remainder_y})};
    Ok(())
}

pub fn browser_zoom(steps:i32)->Result<(),String>{
    ensure_trusted()?;
    let key=browser_zoom_key(steps)?;
    let state=POINTER.lock().map_err(|_|"macOS input state poisoned")?;
    if state.button.is_some()||state.scroll.is_some(){return Err("zoom_during_active_mouse_gesture".into());}
    // Command is scoped to each event, never posted as a held modifier key.
    // Construct all events before posting so allocation failure cannot leave
    // an unmatched key-down. This is explicit browser shortcut compatibility.
    let mut events:Vec<CGEventRef>=Vec::new();
    unsafe{
        for _ in 0..steps.abs(){for down in [true,false]{
            let event=CGEventCreateKeyboardEvent(std::ptr::null_mut(),key,down);
            if event.is_null(){for event in events{CFRelease(event);}return Err("Unable to create zoom shortcut".into());}
            CGEventSetFlags(event,1<<20);events.push(event);
        }}
        for event in events{CGEventPost(HID_EVENT_TAP,event);CFRelease(event);}
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGEventGetIntegerValueField(event: CGEventRef, field: u32) -> i64;
        fn CGEventGetLocation(event: CGEventRef) -> CGPoint;
    }

    #[test]
    fn creates_continuous_pixel_scroll_at_the_gesture_anchor_without_posting_input() {
        for phase in [1, 2, 4, 8] {
            let event = create_scroll_event(CGPoint {x: 400.0, y: 300.0}, 12, -24, phase, 0).unwrap();
            unsafe {
                assert_eq!(CGEventGetIntegerValueField(event, 88), 1);
                assert_eq!(CGEventGetIntegerValueField(event, 96), -24);
                assert_eq!(CGEventGetIntegerValueField(event, 97), 12);
                assert_eq!(CGEventGetIntegerValueField(event, 99), i64::from(phase));
                assert_eq!(CGEventGetLocation(event).x, 400.0);
                assert_eq!(CGEventGetLocation(event).y, 300.0);
                CFRelease(event.cast());
            }
        }
    }
}
