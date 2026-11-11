use std::sync::{atomic::{AtomicBool, Ordering}, Arc, Mutex};
use mdns_sd::{ServiceDaemon, ServiceEvent};
use tauri::{AppHandle, Emitter, Manager, State};
mod code_display;
mod discovery;
mod pinned_tls;
mod trust;
mod input_geometry;
mod update;
mod diagnostics;
mod display_binding;
#[cfg(any(windows,test))]
mod native_audio;
mod input_native;
#[cfg(any(windows, test))]
mod windows_mouse_model;
#[cfg(windows)]
mod windows_mouse;
mod gesture_halo;
#[cfg(all(test,windows))]
mod input_native_tests;
#[cfg(all(test,windows))]
mod input_dispatch_tests;
mod macos_permissions;
#[cfg(target_os = "macos")]
mod macos_input;
#[cfg(any(target_os = "macos", test))]
mod macos_input_model;
use discovery::{DiscoveryCache, SERVICE_TYPES, SNAPSHOT_INTERVAL, BRIDGE_LEASE_MS};

struct MdnsRuntime {
    daemon: ServiceDaemon,
    active: Arc<Mutex<DiscoveryCache>>,
    stop: Arc<AtomicBool>,
}

struct MdnsState(Mutex<Option<MdnsRuntime>>);
#[derive(Default)]
struct TrustState(Arc<Mutex<trust::TrustManager>>);

fn trust_path(app: &AppHandle) -> Result<std::path::PathBuf, String> { app.path().app_data_dir().map(|path| path.join("trusted-devices-v1.json")).map_err(|_| "Unable to locate device trust directory".into()) }
fn native_target(state: &MdnsState, instance: &str, device_id: &str, trust_display: bool) -> Result<discovery::ResolvedTarget, String> {
    let runtime = state.0.lock().map_err(|_| "mDNS state poisoned")?;
    let active = runtime.as_ref().ok_or("Discovery is stopped; scan again")?.active.lock().map_err(|_| "mDNS cache poisoned")?;
    if trust_display { active.trust_display_target(instance, device_id) } else { active.code_display_target(instance, device_id) }
}

#[tauri::command]
fn nearcast_trust_status(app: AppHandle, device_id: String, trust: State<'_, TrustState>) -> Result<serde_json::Value, String> {
    let _guard = trust.0.lock().map_err(|_| "Trust state poisoned")?;
    let store = trust::TrustStore::load(trust_path(&app)?)?;
    Ok(serde_json::json!({"deviceId":device_id,"fingerprint":store.pin(&device_id),"trusted":store.pin(&device_id).is_some()}))
}

#[tauri::command]
async fn nearcast_trust_prepare(app: AppHandle, instance: String, device_id: String, state: State<'_, MdnsState>, trust: State<'_, TrustState>) -> Result<trust::CandidateView, String> {
    let target = native_target(&state, &instance, &device_id, true)?;
    let generation = trust.0.lock().map_err(|_| "Trust state poisoned")?.begin();
    let request_id = trust::nonce()?;
    let request = trust::trust_request(&device_id, &request_id)?;
    let bytes = serde_json::to_vec(&request).map_err(|_| "Invalid trust-display request")?;
    let display = tauri::async_runtime::spawn_blocking(move || {
        let mut url = target.reachable_url(std::time::Duration::from_millis(1800))?;
        url.set_path("/nearcast/trust-display");
        let fingerprint = pinned_tls::observe(&url)?;
        let response = pinned_tls::post(&url, &bytes, &fingerprint)?;
        let status = trust::trust_response(&response, &request_id)?;
        if status != "shown" { return Err(format!("接收端无法显示核对指纹：{status}；请稍后重试。")); }
        Ok(fingerprint)
    }).await.map_err(|_| "Trust-display task failed")??;
    native_target(&state, &instance, &device_id, true)?;
    trust.0.lock().map_err(|_| "Trust state poisoned")?.finish(generation, &device_id, &instance, display, trust_path(&app)?, std::time::Instant::now())
}

#[tauri::command]
fn nearcast_trust_confirm(app: AppHandle, device_id: String, candidate_id: String, fingerprint: String, state: State<'_, MdnsState>, trust: State<'_, TrustState>) -> Result<(), String> {
    let mut manager = trust.0.lock().map_err(|_| "Trust state poisoned")?;
    let instance = manager.candidate_instance(&device_id, &candidate_id)?;
    native_target(&state, &instance, &device_id, true)?;
    manager.confirm(&device_id, &candidate_id, &fingerprint, trust_path(&app)?, std::time::Instant::now())
}

#[tauri::command]
fn nearcast_trust_cancel(trust: State<'_, TrustState>) -> Result<(), String> { trust.0.lock().map_err(|_| "Trust state poisoned")?.cancel(); Ok(()) }

#[tauri::command]
fn nearcast_trust_revoke(app: AppHandle, device_id: String, trust: State<'_, TrustState>) -> Result<(), String> {
    let mut manager = trust.0.lock().map_err(|_| "Trust state poisoned")?;
    trust::TrustStore::load(trust_path(&app)?)?.revoke(&device_id)?;
    manager.cancel(); Ok(())
}

fn emit_mdns_snapshot(app: &AppHandle, active: &Arc<Mutex<DiscoveryCache>>, service_type: &str) {
    if let Ok(cache) = active.lock() {
        let _ = app.emit("nearcast://mdns-snapshot", serde_json::json!({"service_type":service_type,"lease_ms":BRIDGE_LEASE_MS,"services":cache.snapshot(service_type)}));
    }
}

fn spawn_mdns_browser(app: &AppHandle, receiver: mdns_sd::Receiver<ServiceEvent>, service_type: &'static str, active: Arc<Mutex<DiscoveryCache>>, stop: Arc<AtomicBool>) {
    let app = app.clone();
    std::thread::spawn(move || {
        for event in receiver.iter() {
            if stop.load(Ordering::Relaxed) { break; }
            let changed = active.lock().map(|mut cache| cache.apply(event)).unwrap_or(false);
            if changed { emit_mdns_snapshot(&app, &active, service_type); }
        }
        if !stop.load(Ordering::Relaxed) {
            if let Ok(mut cache) = active.lock() { cache.remove_type(service_type); }
            emit_mdns_snapshot(&app, &active, service_type);
        }
    });
}

fn spawn_mdns_snapshot(app: &AppHandle, active: Arc<Mutex<DiscoveryCache>>, stop: Arc<AtomicBool>) {
    let app = app.clone();
    std::thread::spawn(move || {
        while !stop.load(Ordering::Relaxed) {
            std::thread::sleep(SNAPSHOT_INTERVAL);
            if stop.load(Ordering::Relaxed) { break; }
            for service_type in SERVICE_TYPES { emit_mdns_snapshot(&app, &active, service_type); }
        }
    });
}

#[tauri::command]
fn nearcast_mdns_start(app: AppHandle, state: State<'_, MdnsState>) -> Result<(), String> {
    if let Some(runtime) = state.0.lock().map_err(|_| "mDNS state poisoned".to_string())?.take() { runtime.stop.store(true, Ordering::Relaxed); let _ = runtime.daemon.shutdown(); }
    let daemon = ServiceDaemon::new().map_err(|error| error.to_string())?;
    let active = Arc::new(Mutex::new(DiscoveryCache::default()));
    let stop = Arc::new(AtomicBool::new(false));
    for service_type in SERVICE_TYPES {
        let receiver = match daemon.browse(service_type) { Ok(receiver) => receiver, Err(error) => { stop.store(true, Ordering::Relaxed); let _ = daemon.shutdown(); return Err(error.to_string()); } };
        spawn_mdns_browser(&app, receiver, service_type, active.clone(), stop.clone());
    }
    spawn_mdns_snapshot(&app, active.clone(), stop.clone());
    *state.0.lock().map_err(|_| "mDNS state poisoned".to_string())? = Some(MdnsRuntime {daemon, active, stop});
    Ok(())
}

#[tauri::command]
fn nearcast_mdns_stop(state: State<'_, MdnsState>) -> Result<(), String> {
    if let Some(runtime) = state.0.lock().map_err(|_| "mDNS state poisoned".to_string())?.take() { runtime.stop.store(true, Ordering::Relaxed); if let Ok(mut active) = runtime.active.lock() { active.clear(); } let _ = runtime.daemon.shutdown(); }
    Ok(())
}

#[tauri::command]
async fn nearcast_code_display(app: AppHandle, instance: String, request: serde_json::Value, state: State<'_, MdnsState>, trust: State<'_, TrustState>) -> Result<serde_json::Value, String> {
    let target = native_target(&state, &instance, request["deviceId"].as_str().unwrap_or(""), false)?;
    let pin = {
        let _guard = trust.0.lock().map_err(|_| "Trust state poisoned")?;
        trust::TrustStore::load(trust_path(&app)?)?.require_pin(request["deviceId"].as_str().unwrap_or(""))?.to_owned()
    };
    let trust_manager = trust.0.clone();
    let path = trust_path(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let url = target.reachable_url(std::time::Duration::from_millis(1800))?;
        // Recheck immediately before TLS/HTTP under the same lock as revoke and
        // confirmation. Once revoke returns no queued request can use an old pin.
        let _guard = trust_manager.lock().map_err(|_| "Trust state poisoned")?;
        if trust::TrustStore::load(path)?.require_pin(request["deviceId"].as_str().unwrap_or(""))? != pin { return Err("NEARCAST_TRUST_REQUIRED: 设备信任已更新，请重新选择接收端。".into()); }
        code_display::post(url.as_str(), &request, &pin)
    }).await.map_err(|_| "code-display task failed".to_string())?
}

#[cfg(windows)]
mod pointer {
    use windows::Win32::UI::Input::Pointer::{InitializeTouchInjection, InjectTouchInput, POINTER_TOUCH_INFO, TOUCH_FEEDBACK_NONE, POINTER_FLAG_INCONTACT, POINTER_FLAG_INRANGE, POINTER_FLAG_DOWN, POINTER_FLAG_UPDATE, POINTER_FLAG_UP, POINTER_FLAG_CANCELED};
    use windows::Win32::UI::WindowsAndMessaging::PT_TOUCH;
    use windows::Win32::Foundation::POINT;
    use std::sync::Mutex;
    static ACTIVE: Mutex<Vec<(u32, POINT)>> = Mutex::new(Vec::new());

    #[derive(Clone, Copy)]
    pub struct Record { pub contact_id: u32, pub phase: u8, pub x: i32, pub y: i32 }

    fn flags(phase: u8) -> Result<windows::Win32::UI::Input::Pointer::POINTER_FLAGS, String> {
        Ok(match phase { 0 => POINTER_FLAG_DOWN | POINTER_FLAG_INRANGE | POINTER_FLAG_INCONTACT, 1 => POINTER_FLAG_UPDATE | POINTER_FLAG_INRANGE | POINTER_FLAG_INCONTACT, 2 => POINTER_FLAG_UP, 3 => POINTER_FLAG_CANCELED | POINTER_FLAG_UP, _ => return Err("invalid_pointer_phase".into()) })
    }

    pub fn initialize(max: u32) -> bool {
        let okay = unsafe { InitializeTouchInjection(max, TOUCH_FEEDBACK_NONE).is_ok() };
        if okay { if let Ok(mut active) = ACTIVE.lock() { active.clear(); } }
        okay
    }

    pub fn active_points() -> Vec<(u32,POINT)> { ACTIVE.lock().map(|active|active.clone()).unwrap_or_default() }
    pub fn reset_all() -> bool { reset(&active_points().iter().map(|(id,_)|*id).collect::<Vec<_>>()) }
    pub fn cancel_possible(records: &[crate::input_native::TouchRecord]) -> Result<(),String> {
        let infos=records.iter().map(|record|{let mut info=POINTER_TOUCH_INFO::default();info.pointerInfo.pointerType=PT_TOUCH;info.pointerInfo.pointerId=record.contact_id;info.pointerInfo.ptPixelLocation=POINT{x:record.x,y:record.y};info.pointerInfo.pointerFlags=POINTER_FLAG_CANCELED|POINTER_FLAG_UP;info}).collect::<Vec<_>>();
        unsafe{InjectTouchInput(&infos)}.map_err(|error|format!("native_touch_uncertain_cleanup_failed:0x{:08X}",error.code().0 as u32))?;
        ACTIVE.lock().map_err(|_|"windows_pointer_state_poisoned".to_string())?.clear();Ok(())
    }

    pub fn reset(ids: &[u32]) -> bool {
        let contacts = match ACTIVE.lock() { Ok(active) => active.iter().filter(|item| ids.contains(&item.0)).copied().collect::<Vec<_>>(), Err(_) => return false };
        if contacts.is_empty() { return true; }
        let records = contacts.into_iter().map(|(contact_id, point)| Record {contact_id, phase: 3, x: point.x, y: point.y}).collect::<Vec<_>>();
        inject_batch(&records).is_ok()
    }

    pub fn inject_batch(records: &[Record]) -> Result<(), String> {
        if records.is_empty() { return Ok(()); }
        let current = ACTIVE.lock().map_err(|_| "windows_pointer_state_poisoned".to_string())?.clone();
        let mut points = current.iter().copied().collect::<std::collections::BTreeMap<_, _>>();
        let mut phases = std::collections::BTreeMap::new();
        for record in records {
            let flag = flags(record.phase)?;
            let previous = points.get(&record.contact_id).copied();
            let point = match record.phase {
                0 => { if previous.is_some() { return Err("pointer_contact_already_active".into()); } POINT {x: record.x, y: record.y} },
                1 => { if previous.is_none() { return Err("pointer_contact_not_active".into()); } POINT {x: record.x, y: record.y} },
                2 | 3 => previous.ok_or("pointer_contact_not_active")?,
                _ => unreachable!(),
            };
            phases.insert(record.contact_id, (flag, point.x, point.y));
            // Keep terminal contacts in the frame so InjectTouchInput receives
            // their final coordinates together with every other active contact.
            // They are removed from ACTIVE only after the native call succeeds.
            points.insert(record.contact_id, point);
        }
        let mut infos = Vec::with_capacity(points.len());
        for (id, point) in points.iter() {
            let (pointer_flags, x, y) = phases.get(id).copied().unwrap_or((POINTER_FLAG_UPDATE | POINTER_FLAG_INRANGE | POINTER_FLAG_INCONTACT, point.x, point.y));
            let mut info = POINTER_TOUCH_INFO::default(); info.pointerInfo.pointerType = PT_TOUCH; info.pointerInfo.pointerId = *id; info.pointerInfo.ptPixelLocation = POINT {x, y}; info.touchMask = 0; info.pointerInfo.pointerFlags = pointer_flags; infos.push(info);
        }
        if let Err(error) = unsafe { InjectTouchInput(&infos) } { return Err(format!("windows_inject_touch_input_failed:0x{:08X}", error.code().0 as u32)); }
        let mut active = ACTIVE.lock().map_err(|_| "windows_pointer_state_poisoned".to_string())?;
        for record in records { if record.phase >= 2 { points.remove(&record.contact_id); } }
        *active = points.into_iter().collect();
        Ok(())
    }
}

#[tauri::command]
fn nearcast_macos_permissions() -> Result<serde_json::Value, String> {
    macos_permissions::status()
}

#[tauri::command]
async fn nearcast_macos_permission_settings(permission: macos_permissions::Permission) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || macos_permissions::open_settings(permission))
        .await.map_err(|_| "Permission settings task failed".to_string())?
}

#[tauri::command]
async fn nearcast_update_initialize(app: AppHandle, state: State<'_, update::State>) -> Result<serde_json::Value, String> {
    update::initialize(app, &state).await
}

#[tauri::command]
async fn nearcast_update_check(app: AppHandle, state: State<'_, update::State>) -> Result<serde_json::Value, String> {
    update::check(app, &state).await
}

#[tauri::command]
async fn nearcast_update_download(app: AppHandle, state: State<'_, update::State>) -> Result<serde_json::Value, String> {
    update::download(app, &state).await
}

#[tauri::command]
async fn nearcast_update_install(app: AppHandle, state: State<'_, update::State>) -> Result<serde_json::Value, String> {
    update::install(app, &state).await
}

#[tauri::command]
fn nearcast_platform_info() -> serde_json::Value {
    #[cfg(target_os = "windows")]
    { return serde_json::json!({"os":"windows","webview":"WebView2","screenCapture":true,"nativeCapture":false,"captureBackend":"browser","systemAudio":true,"screenCapturePermission":"not_required","touchback":true,"inputControl":"windows-pointer","multiTouch":true,"accessibilityPermission":"not_required"}); }
    #[cfg(target_os = "macos")]
    { return serde_json::json!({"os":"macos","webview":"WKWebView","screenCapture":true,"screenCapturePermission":"required","touchback":true,"inputControl":"macos-mouse","multiTouch":false,"accessibilityPermission":"required"}); }
    #[cfg(target_os = "linux")]
    { return serde_json::json!({"os":"linux","webview":"WebKitGTK","screenCapture":true,"screenCapturePermission":"required","touchback":false,"inputControl":"none","multiTouch":false,"accessibilityPermission":"not_required"}); }
    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    { serde_json::json!({"os":"unknown","webview":"unknown","screenCapture":false,"screenCapturePermission":"required","touchback":false,"inputControl":"none","multiTouch":false,"accessibilityPermission":"not_required"}) }
}

// Keep blocking Win32 input and geometry calls off the WebView/UI thread.
// Owner/lease serialization remains inside input_native and the JS engine.
#[cfg(windows)]
async fn native_input_task(task: impl FnOnce() -> serde_json::Value + Send + 'static) -> Result<serde_json::Value,String> {
    tauri::async_runtime::spawn_blocking(move || {
        let started=std::time::Instant::now();
        let mut result=task();
        result["nativeDurationMs"]=serde_json::json!(started.elapsed().as_secs_f64()*1000.0);
        result
    }).await.map_err(|error|error.to_string())
}
#[cfg(windows)]
#[tauri::command]
async fn nearcast_input_probe()->Result<serde_json::Value,String>{native_input_task(input_native::probe).await}
#[cfg(windows)]
#[tauri::command]
async fn nearcast_input_prepare(owner_id:String,source_binding_id:String,geometry_revision:String,native_id:String,input_types:Vec<String>,max_contacts:u32)->Result<serde_json::Value,String>{native_input_task(move||input_native::prepare(owner_id,source_binding_id,geometry_revision,native_id,input_types,max_contacts)).await}
#[cfg(windows)]
#[tauri::command]
async fn nearcast_input_apply(owner_id:String,lease_id:String,geometry_revision:String,action:input_native::Action)->Result<serde_json::Value,String>{native_input_task(move||input_native::apply(owner_id,lease_id,geometry_revision,action)).await}
#[cfg(windows)]
#[tauri::command]
async fn nearcast_input_release(owner_id:String,lease_id:Option<String>)->Result<serde_json::Value,String>{native_input_task(move||input_native::release(owner_id,lease_id)).await}

#[cfg(not(windows))]
#[tauri::command]
fn nearcast_input_probe()->serde_json::Value{input_native::probe()}
#[cfg(not(windows))]
#[tauri::command]
fn nearcast_input_prepare(owner_id:String,source_binding_id:String,geometry_revision:String,native_id:String,input_types:Vec<String>,max_contacts:u32)->serde_json::Value{input_native::prepare(owner_id,source_binding_id,geometry_revision,native_id,input_types,max_contacts)}
#[cfg(not(windows))]
#[tauri::command]
fn nearcast_input_apply(owner_id:String,lease_id:String,geometry_revision:String,action:input_native::Action)->serde_json::Value{input_native::apply(owner_id,lease_id,geometry_revision,action)}
#[cfg(not(windows))]
#[tauri::command]
fn nearcast_input_release(owner_id:String,lease_id:Option<String>)->serde_json::Value{input_native::release(owner_id,lease_id)}

#[tauri::command]
fn nearcast_input_feedback(owner_id:String,lease_id:String,feedback:Option<input_native::GestureFeedback>)->serde_json::Value{
    input_native::feedback(owner_id,lease_id,feedback)
}

#[tauri::command]
async fn nearcast_system_audio_start(capture_id:String)->Result<serde_json::Value,String>{
    #[cfg(windows)] {
        if capture_id.len()!=36 || !capture_id.bytes().all(|b| b.is_ascii_hexdigit()||b==b'-') {return Err("invalid_audio_owner".into());}
        return tauri::async_runtime::spawn_blocking(move||native_audio::start(&capture_id)).await.map_err(|e|e.to_string())?;
    }
    #[cfg(not(windows))] {let _=capture_id;Err("native_audio_not_supported".into())}
}
#[tauri::command]
async fn nearcast_audio_read(capture_id:String)->Result<tauri::ipc::Response,String>{
    #[cfg(windows)] {return tauri::async_runtime::spawn_blocking(move||native_audio::read(&capture_id).map(tauri::ipc::Response::new)).await.map_err(|e|e.to_string())?;}
    #[cfg(not(windows))] {let _=capture_id;Err("native_audio_not_supported".into())}
}
#[tauri::command]
async fn nearcast_audio_stop(capture_id:String)->Result<(),String>{
    #[cfg(windows)] {return tauri::async_runtime::spawn_blocking(move||native_audio::stop(&capture_id)).await.map_err(|e|e.to_string())?;}
    #[cfg(not(windows))] {let _=capture_id;Ok(())}
}
#[tauri::command]
async fn nearcast_diagnostics_record(sample:diagnostics::Sample)->Result<(),String>{
    tauri::async_runtime::spawn_blocking(move||diagnostics::record(sample)).await.map_err(|e|e.to_string())?
}
#[tauri::command]
async fn nearcast_diagnostics_export(app:AppHandle)->Result<String,String>{
    tauri::async_runtime::spawn_blocking(move||diagnostics::export(&app)).await.map_err(|e|e.to_string())?
}

#[tauri::command]
async fn nearcast_display_binding_begin(source_id:String)->Result<serde_json::Value,String>{
    tauri::async_runtime::spawn_blocking(move||display_binding::begin(source_id)).await.map_err(|e|e.to_string())?
}
#[tauri::command]
async fn nearcast_display_binding_confirm(source_id:String,challenge_id:String,token:String,corners:Vec<u8>,frame_width:u32,frame_height:u32)->Result<serde_json::Value,String>{
    tauri::async_runtime::spawn_blocking(move||display_binding::confirm(source_id,challenge_id,token,corners,frame_width,frame_height)).await.map_err(|e|e.to_string())?
}
#[tauri::command]
async fn nearcast_display_binding_cancel(source_id:String,challenge_id:String)->Result<(),String>{
    tauri::async_runtime::spawn_blocking(move||display_binding::cancel(source_id,challenge_id)).await.map_err(|e|e.to_string())?
}
#[tauri::command]
async fn nearcast_display_binding_release(source_id:String)->Result<(),String>{
    tauri::async_runtime::spawn_blocking(move||display_binding::release(source_id)).await.map_err(|e|e.to_string())?
}
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().pubkey(include_str!("../update.pub").trim()).build())
        .manage(update::State::default())
        .manage(MdnsState(Mutex::new(None)))
        .manage(TrustState::default())
        .setup(|app| { let _=diagnostics::initialize(app.handle());Ok(()) })
        .on_window_event(|_, event| {
            if matches!(event,tauri::WindowEvent::CloseRequested{..}|tauri::WindowEvent::Destroyed){input_native::shutdown();display_binding::shutdown();#[cfg(windows)] native_audio::shutdown();}
            #[cfg(target_os = "macos")]
            if matches!(event, tauri::WindowEvent::Destroyed) { let _ = macos_input::reset(); }
            #[cfg(not(target_os = "macos"))]
            let _ = event;
        })
        .invoke_handler(tauri::generate_handler![nearcast_mdns_start, nearcast_mdns_stop, nearcast_code_display, nearcast_trust_status, nearcast_trust_prepare, nearcast_trust_confirm, nearcast_trust_cancel, nearcast_trust_revoke, nearcast_input_probe, nearcast_input_prepare, nearcast_input_apply, nearcast_input_release, nearcast_input_feedback, nearcast_system_audio_start, nearcast_audio_read, nearcast_audio_stop, nearcast_macos_permissions, nearcast_macos_permission_settings, nearcast_platform_info, nearcast_display_binding_begin, nearcast_display_binding_confirm, nearcast_display_binding_cancel, nearcast_display_binding_release, nearcast_diagnostics_record, nearcast_diagnostics_export, nearcast_update_initialize, nearcast_update_check, nearcast_update_download, nearcast_update_install])
        .build(tauri::generate_context!())
        .expect("error while building NearCast Desktop TX")
        .run(|_, event| {
            if matches!(event, tauri::RunEvent::Exit) {
                diagnostics::shutdown();
                input_native::shutdown();
                display_binding::shutdown();
                #[cfg(windows)] native_audio::shutdown();
            }
        });
}
