use std::{sync::{mpsc,Mutex},time::Duration};

#[tauri::command]
fn local_origin_report(report:serde_json::Value,state:tauri::State<'_,Mutex<mpsc::Sender<serde_json::Value>>>){
    let _=state.lock().unwrap().send(report);
}

#[test]
#[ignore="creates a hidden isolated WebView2 to verify the branded origin, IPC and legacy settings"]
fn branded_origin_preserves_ipc_capture_and_settings(){
    let (sent,received)=mpsc::channel::<serde_json::Value>();
    let mut context=tauri::generate_context!();context.config_mut().app.windows.clear();
    let mut profile=[0u8;16];getrandom::fill(&mut profile).unwrap();
    let profile=std::env::temp_dir().join(format!("nearhub-origin-{:x}",u128::from_le_bytes(profile)));
    let app=tauri::Builder::default().any_thread().manage(Mutex::new(sent)).manage(super::LegacySettings::default())
        .register_uri_scheme_protocol(super::SCHEME,|ctx,request|{
            if request.uri().host()==Some("localhost")&&request.uri().path()=="/index.html"{
                return tauri::http::Response::builder().header("content-type","text/html; charset=utf-8").body(br#"<!doctype html><body><script type="module">
                const report=value=>__TAURI__.core.invoke('local_origin_report',{report:value});
                try{
                  const {migrateLegacyPreferences}=await import('/local-origin.mjs');
                  await migrateLegacyPreferences();
                  const {loadPreferences}=await import('/settings.mjs');
                  const worker=new Worker(URL.createObjectURL(new Blob(['onmessage=()=>postMessage("ok")'],{type:'text/javascript'})));
                  await new Promise((resolve,reject)=>{worker.onmessage=resolve;worker.onerror=reject;worker.postMessage('go');});worker.terminate();
                  const audio=new AudioContext();
                  await audio.audioWorklet.addModule(URL.createObjectURL(new Blob(['registerProcessor("fixture",class extends AudioWorkletProcessor{process(){return true;}})'],{type:'text/javascript'})));await audio.close();
                  const preference=loadPreferences();
                  await report({origin:location.origin,secure:isSecureContext,capture:typeof navigator.mediaDevices?.getDisplayMedia,video:preference.video.resolution,audio:preference.systemAudio,stored:localStorage.getItem('nearhub-cast-settings-v1')});
                }catch(error){await report({error:String(error)});}
                </script>"#.to_vec()).unwrap();
            }
            super::response(ctx,request)
        })
        .invoke_handler(tauri::generate_handler![local_origin_report,super::nearcast_migrate_legacy_settings,super::nearcast_take_legacy_settings])
        .setup(move|app|{
            tauri::WebviewWindowBuilder::new(app,"main",tauri::WebviewUrl::App("origin-seed.html".into()))
                .visible(false).data_directory(profile.clone())
                .on_web_resource_request(|request,response|{
                    if request.uri().path()=="/origin-seed.html"{
                        *response.body_mut()=std::borrow::Cow::Borrowed(br#"<!doctype html><script>
                        localStorage.setItem('nearhub-cast-settings-v1',JSON.stringify({video:{resolution:'1920x1080',bitrateMode:'dynamic',bitrateKbps:8000},systemAudio:false,inputEnabled:false}));
                        location.replace('http://tauri.localhost/settings-migration.html');
                        </script>"#);
                        response.headers_mut().insert("content-type","text/html; charset=utf-8".parse().unwrap());
                    }
                }).build()?;
            let handle=app.handle().clone();
            std::thread::spawn(move||{std::thread::sleep(Duration::from_secs(18));handle.exit(0);});
            Ok(())
        }).build(context).unwrap();
    let handle=app.handle().clone();
    let (done,result)=mpsc::channel();
    std::thread::spawn(move||{let report=received.recv_timeout(Duration::from_secs(16));let _=done.send(report);handle.exit(0);});
    app.run_return(|_,_|{});
    let report=result.recv_timeout(Duration::from_secs(2)).unwrap().unwrap();
    assert_eq!(report["origin"],"http://cast.nearhub.localhost","{report}");
    assert_eq!(report["secure"],true,"{report}");
    assert_eq!(report["capture"],"function","{report}");
    assert_eq!(report["video"],"1920x1080","{report}");
    assert_eq!(report["audio"],false,"{report}");
    println!("PASS: branded local origin, native IPC, module/worker/audio worklet, secure capture API and legacy settings migration");
}
