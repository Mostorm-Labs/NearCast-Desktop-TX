use super::{PcmQueue, CHANNELS, RATE};
use std::{
    ffi::c_void,
    sync::{Arc, Condvar, Mutex},
    time::Duration,
};

struct State {
    id: String,
    queue: Mutex<PcmQueue>,
    changed: Condvar,
}
// The retained Objective-C handle is only operated under ACTIVE. The Arc keeps
// its callback context stable until stop closes and drains the callback gate.
struct Controller {
    state: Arc<State>,
    handle: usize,
}
static ACTIVE: Mutex<Option<Controller>> = Mutex::new(None);
extern "C" {
    fn nearcast_macos_audio_create(
        context: *const c_void,
        callback: unsafe extern "C" fn(*const c_void, *const f32, *const f32, usize, i32),
    ) -> *mut c_void;
    fn nearcast_macos_audio_start(handle: *mut c_void) -> i32;
    fn nearcast_macos_audio_stop(handle: *mut c_void) -> i32;
    fn nearcast_macos_audio_destroy(handle: *mut c_void);
}
fn error(code: i32) -> String {
    match code {
        -3801 => "macos_audio_permission_required".into(),
        -1001 | -1003 => "macos_audio_start_timeout".into(),
        -1002 => "macos_audio_no_display".into(),
        -1004 => "macos_audio_stop_timeout".into(),
        -1005 => "macos_audio_format_unsupported".into(),
        _ => format!("macos_audio_capture_failed:{code}"),
    }
}
unsafe extern "C" fn receive(
    context: *const c_void,
    left: *const f32,
    right: *const f32,
    frames: usize,
    status: i32,
) {
    let state = &*(context as *const State);
    if let Ok(mut queue) = state.queue.lock() {
        if queue.stopped {
            return;
        }
        if status != 0 {
            queue.error = Some(error(status));
        } else if frames > RATE as usize || left.is_null() {
            queue.error = Some(error(-1005));
        } else if right.is_null() {
            queue.push(std::slice::from_raw_parts(left, frames * CHANNELS), false);
        } else {
            let left = std::slice::from_raw_parts(left, frames);
            let right = std::slice::from_raw_parts(right, frames);
            let samples: Vec<f32> = left.iter().zip(right).flat_map(|(&l, &r)| [l, r]).collect();
            queue.push(&samples, false);
        }
        drop(queue);
        state.changed.notify_all();
    }
}
fn format() -> serde_json::Value {
    serde_json::json!({"source":"screencapturekit","scope":"system-excluding-self","sampleRate":RATE,"channels":CHANNELS})
}
pub fn start(id: &str) -> Result<serde_json::Value, String> {
    let mut active = ACTIVE.lock().map_err(|_| "native_audio_state_poisoned")?;
    if let Some(owner) = active.as_ref() {
        if owner.state.id == id {
            let queue = owner
                .state
                .queue
                .lock()
                .map_err(|_| "native_audio_queue_poisoned")?;
            if let Some(error) = &queue.error {
                return Err(error.clone());
            }
            if !queue.stopped {
                return Ok(format());
            }
        }
        return Err("native_audio_cleanup_required".into());
    }
    let state = Arc::new(State {
        id: id.into(),
        queue: Mutex::new(PcmQueue::default()),
        changed: Condvar::new(),
    });
    let handle = unsafe { nearcast_macos_audio_create(Arc::as_ptr(&state).cast(), receive) };
    if handle.is_null() {
        return Err("macos_audio_create_failed".into());
    }
    *active = Some(Controller {
        state: state.clone(),
        handle: handle as usize,
    });
    let status = unsafe { nearcast_macos_audio_start(handle) };
    if status != 0 {
        if let Ok(mut queue) = state.queue.lock() {
            queue.error = Some(error(status));
            queue.stopped = true;
        }
        state.changed.notify_all();
        // A timed-out framework start can still own resources. Preserve this
        // controller if stop fails, so the caller must retry cleanup first.
        if unsafe { nearcast_macos_audio_stop(handle) } == 0 {
            unsafe {
                nearcast_macos_audio_destroy(handle);
            }
            *active = None;
        }
        return Err(error(status));
    }
    Ok(format())
}
pub fn read(id: &str) -> Result<Vec<u8>, String> {
    let state = ACTIVE
        .lock()
        .map_err(|_| "native_audio_state_poisoned")?
        .as_ref()
        .filter(|owner| owner.state.id == id)
        .map(|owner| owner.state.clone())
        .ok_or("native_audio_not_active")?;
    let queue = state
        .queue
        .lock()
        .map_err(|_| "native_audio_queue_poisoned")?;
    let (mut queue, _) = state
        .changed
        .wait_timeout_while(queue, Duration::from_millis(40), |q| {
            q.samples.len() < 960 * CHANNELS && q.error.is_none() && !q.stopped
        })
        .map_err(|_| "native_audio_queue_poisoned")?;
    queue.packet(id)
}
pub fn stop(id: &str) -> Result<(), String> {
    let mut active = ACTIVE.lock().map_err(|_| "native_audio_state_poisoned")?;
    if let Some(owner) = active.as_ref().filter(|owner| owner.state.id == id) {
        if let Ok(mut queue) = owner.state.queue.lock() {
            queue.stopped = true;
        }
        owner.state.changed.notify_all();
        let handle = owner.handle as *mut c_void;
        let status = unsafe { nearcast_macos_audio_stop(handle) };
        if status != 0 {
            return Err(error(status));
        }
        unsafe {
            nearcast_macos_audio_destroy(handle);
        }
        *active = None;
    }
    Ok(())
}
pub fn shutdown() {
    let id = ACTIVE
        .lock()
        .ok()
        .and_then(|active| active.as_ref().map(|owner| owner.state.id.clone()));
    if let Some(id) = id {
        let _ = stop(&id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn native_planar_and_interleaved_samples_preserve_stereo_and_retirement() {
        let state = State {
            id: "fixture".into(),
            queue: Mutex::new(PcmQueue::default()),
            changed: Condvar::new(),
        };
        let (left, right) = ([0.25, 0.5], [-0.25, -0.5]);
        unsafe {
            receive(
                (&state as *const State).cast(),
                left.as_ptr(),
                right.as_ptr(),
                2,
                0,
            );
        }
        let mut queue = state.queue.lock().unwrap();
        assert_eq!(
            queue.samples.drain(..).collect::<Vec<_>>(),
            vec![0.25, -0.25, 0.5, -0.5]
        );
        drop(queue);
        let interleaved = [0.75, -0.75, 0.1, -0.1];
        unsafe {
            receive(
                (&state as *const State).cast(),
                interleaved.as_ptr(),
                std::ptr::null(),
                2,
                0,
            );
        }
        let mut queue = state.queue.lock().unwrap();
        assert_eq!(queue.samples.drain(..).collect::<Vec<_>>(), interleaved);
        queue.stopped = true;
        drop(queue);
        unsafe {
            receive(
                (&state as *const State).cast(),
                left.as_ptr(),
                right.as_ptr(),
                2,
                0,
            );
        }
        assert!(state.queue.lock().unwrap().samples.is_empty());
    }
    #[test]
    fn native_audio_errors_cannot_be_misreported_as_silence() {
        let state = State {
            id: "fixture".into(),
            queue: Mutex::new(PcmQueue::default()),
            changed: Condvar::new(),
        };
        unsafe {
            receive(
                (&state as *const State).cast(),
                std::ptr::null(),
                std::ptr::null(),
                0,
                -3801,
            );
        }
        assert_eq!(
            state.queue.lock().unwrap().packet("fixture").unwrap_err(),
            "macos_audio_permission_required"
        );
    }
}
