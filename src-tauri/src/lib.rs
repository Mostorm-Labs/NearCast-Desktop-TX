use std::sync::Mutex;
use mdns_sd::{ServiceDaemon, ServiceEvent};
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

struct MdnsState(Mutex<Option<ServiceDaemon>>);

#[derive(Debug, Clone, Serialize)]
struct MdnsService {
    instance: String,
    hostname: String,
    port: u16,
    txt: std::collections::BTreeMap<String, String>,
}

#[tauri::command]
fn nearcast_mdns_start(app: AppHandle, state: State<'_, MdnsState>) -> Result<(), String> {
    let daemon = ServiceDaemon::new().map_err(|error| error.to_string())?;
    let receiver = daemon.browse("_nearcast._tcp.local.").map_err(|error| error.to_string())?;
    *state.0.lock().map_err(|_| "mDNS state poisoned".to_string())? = Some(daemon);
    std::thread::spawn(move || {
        for event in receiver.iter() {
            let ServiceEvent::ServiceResolved(info) = event else { continue };
            let txt = info.get_properties().iter().map(|property| (property.key().to_string(), property.val_str().to_string())).collect();
            let service = MdnsService {instance: info.get_fullname().to_string(), hostname: info.get_hostname().to_string(), port: info.get_port(), txt};
            let _ = app.emit("nearcast://mdns-service", service);
        }
    });
    Ok(())
}

#[tauri::command]
fn nearcast_mdns_stop(state: State<'_, MdnsState>) -> Result<(), String> {
    if let Some(daemon) = state.0.lock().map_err(|_| "mDNS state poisoned".to_string())?.take() { let _ = daemon.shutdown(); }
    Ok(())
}

#[cfg(windows)]
mod pointer {
    use windows::Win32::UI::Input::Pointer::{InitializeTouchInjection, InjectTouchInput, POINTER_TOUCH_INFO, TOUCH_FEEDBACK_NONE, POINTER_FLAG_INCONTACT, POINTER_FLAG_INRANGE, POINTER_FLAG_DOWN, POINTER_FLAG_UPDATE, POINTER_FLAG_UP, POINTER_FLAG_CANCELED};
    use windows::Win32::UI::WindowsAndMessaging::PT_TOUCH;
    use windows::Win32::Foundation::POINT;
    use std::sync::Mutex;
    static ACTIVE: Mutex<Vec<u32>> = Mutex::new(Vec::new());

    pub fn initialize(max: u32) -> bool { unsafe { InitializeTouchInjection(max, TOUCH_FEEDBACK_NONE).is_ok() } }
    pub fn inject(contact_id: u32, phase: u8, x: i32, y: i32) -> bool {
        let mut info = POINTER_TOUCH_INFO::default(); info.pointerInfo.pointerType = PT_TOUCH; info.pointerInfo.pointerId = contact_id; info.pointerInfo.ptPixelLocation = POINT {x, y}; info.touchMask = 0;
        let flag = match phase { 0 => POINTER_FLAG_DOWN | POINTER_FLAG_INRANGE | POINTER_FLAG_INCONTACT, 1 => POINTER_FLAG_UPDATE | POINTER_FLAG_INRANGE | POINTER_FLAG_INCONTACT, 2 => POINTER_FLAG_UP, 3 => POINTER_FLAG_CANCELED, _ => return false };
        info.pointerInfo.pointerFlags = flag;
        let okay = unsafe { InjectTouchInput(std::slice::from_ref(&info)).is_ok() };
        if okay { if let Ok(mut active) = ACTIVE.lock() { if phase <= 1 && !active.contains(&contact_id) { active.push(contact_id); } if phase >= 2 { active.retain(|id| *id != contact_id); } } }
        okay
    }
    pub fn reset(ids: &[u32]) { if let Ok(mut active) = ACTIVE.lock() { active.retain(|id| !ids.contains(id)); } }
}

#[tauri::command]
fn nearcast_pointer_initialize(max_contacts: u32) -> bool {
    #[cfg(windows)] { return pointer::initialize(max_contacts.min(10).max(1)); }
    #[cfg(not(windows))] { let _ = max_contacts; false }
}

#[tauri::command]
fn nearcast_pointer_inject(contact_id: u32, phase: u8, x: i32, y: i32) -> bool {
    #[cfg(windows)] { return pointer::inject(contact_id, phase, x, y); }
    #[cfg(not(windows))] { let _ = (contact_id, phase, x, y); false }
}

#[tauri::command]
fn nearcast_pointer_reset(contact_ids: Vec<u32>) -> bool {
    #[cfg(windows)] { pointer::reset(&contact_ids); return true; }
    #[cfg(not(windows))] { let _ = contact_ids; false }
}

pub fn run() {
    tauri::Builder::default()
        .manage(MdnsState(Mutex::new(None)))
        .invoke_handler(tauri::generate_handler![nearcast_mdns_start, nearcast_mdns_stop, nearcast_pointer_initialize, nearcast_pointer_inject, nearcast_pointer_reset])
        .run(tauri::generate_context!())
        .expect("error while running NearCast Desktop TX");
}
