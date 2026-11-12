// Opt-in fixture: click only our isolated WebView2 window, never the user's TX.
use std::{
    sync::{mpsc, Arc, Mutex},
    time::{Duration, Instant},
};
#[derive(Clone)]
struct Report(Arc<Mutex<mpsc::Sender<String>>>);
#[tauri::command]
fn input_fixture_report(kind: String, report: tauri::State<'_, Report>) {
    let _ = report.0.lock().unwrap().send(kind);
}

#[test]
#[ignore = "creates an isolated WebView2 target and injects Mouse only inside it"]
fn own_webview_click_feedback_and_close_keep_the_ui_pumping() {
    let (sent, received) = mpsc::channel();
    let worker_report = sent.clone();
    let (finished, result) = mpsc::channel();
    let mut context = tauri::generate_context!();
    context.config_mut().app.windows.clear();
    let app=tauri::Builder::default().any_thread().manage(Report(Arc::new(Mutex::new(sent))))
        .invoke_handler(tauri::generate_handler![input_fixture_report,crate::nearcast_input_feedback,crate::nearcast_input_execution_status,crate::window_controls::nearcast_window_action])
        .setup(move|app|{
            let window=tauri::WebviewWindowBuilder::new(app,"main",tauri::WebviewUrl::App("index.html".into()))
                .title("NearCast isolated input regression").inner_size(500.0,340.0)
                .on_web_resource_request(|request,response|{
                    if request.uri().path()=="/"||request.uri().path()=="/index.html"{
                        *response.body_mut()=std::borrow::Cow::Borrowed(br#"<!doctype html><html><body style="margin:0;background:#244;color:white;height:100vh;display:grid;place-items:center"><button style="width:260px;height:180px">Owned Mouse target</button><script>
                        const invoke=(kind)=>__TAURI__.core.invoke('input_fixture_report',{kind});
                        addEventListener('mousedown',()=>{invoke('down');if(globalThis.fixtureLease)__TAURI__.core.invoke('nearcast_input_feedback',{ownerId:'webview-test',leaseId:fixtureLease,feedback:null}).then(()=>invoke('feedback'));});
                        addEventListener('mouseup',()=>invoke('up'));
                        addEventListener('DOMContentLoaded',()=>invoke('ready'));globalThis.fixtureHeartbeat=()=>invoke('heartbeat');
                        </script></body></html>"#);
                        response.headers_mut().insert("content-type","text/html; charset=utf-8".parse().unwrap());
                    }
                }).build()?;
            let handle=app.handle().clone();
            let close_target=<tauri::WebviewWindow as AsRef<tauri::Webview>>::as_ref(&window).window();
            let close_report=worker_report.clone();
            window.on_window_event(move|event|match event{
                tauri::WindowEvent::CloseRequested{api,..}=>{api.prevent_close();crate::close_after_input_cleanup(close_target.clone());},
                tauri::WindowEvent::Destroyed=>{let _=close_report.send("destroyed".into());},
                _=>{},
            });
            std::thread::spawn(move||{
                let outcome=std::panic::catch_unwind(std::panic::AssertUnwindSafe(||{
                    let deadline=Instant::now()+Duration::from_secs(15);
                    while received.recv_timeout(Duration::from_secs(2)).unwrap()!="ready"{assert!(Instant::now()<deadline);}
                    use windows::Win32::{Foundation::POINT,UI::WindowsAndMessaging::*};
                    let hwnd=windows::Win32::Foundation::HWND(window.hwnd().unwrap().0);
                    let previous=unsafe{GetForegroundWindow()};let mut cursor=POINT::default();unsafe{GetCursorPos(&mut cursor).unwrap();}
                    let source="16ba5c80-b340-4e90-afc1-6bbdca13bcd7".to_string();
                    struct Guard{previous:windows::Win32::Foundation::HWND,cursor:POINT,source:String}
                    impl Drop for Guard{fn drop(&mut self){let _=crate::input_native::release("webview-test".into(),None);let _=crate::display_binding::release(self.source.clone());unsafe{let _=SetCursorPos(self.cursor.x,self.cursor.y);let _=SetForegroundWindow(self.previous);}}}
                    let _guard=Guard{previous,cursor,source:source.clone()};
                    let challenge=crate::display_binding::begin(source.clone()).unwrap();
                    let mut point=POINT{x:250,y:180};unsafe{windows::Win32::Graphics::Gdi::ClientToScreen(hwnd,&mut point).ok().unwrap();}
                    let marker=challenge["displays"].as_array().unwrap().iter().find(|d|{
                        let r=&d["region"];(point.x as f64)>=r["x"].as_f64().unwrap()&&(point.x as f64)<r["x"].as_f64().unwrap()+r["width"].as_f64().unwrap()
                    }).unwrap();
                    let binding=crate::display_binding::confirm(source,challenge["challengeId"].as_str().unwrap().into(),marker["token"].as_str().unwrap().into(),vec![0,1,2,3],marker["captureWidth"].as_u64().unwrap()as u32,marker["captureHeight"].as_u64().unwrap()as u32).unwrap();
                    let prepared=crate::input_native::prepare("webview-test".into(),"fixture".into(),binding["revision"].as_str().unwrap().into(),binding["nativeId"].as_str().unwrap().into(),vec!["mouse".into()],0);assert_eq!(prepared["status"],"ready");
                    let lease=prepared["leaseId"].as_str().unwrap().to_owned();window.eval(format!("globalThis.fixtureLease={};",serde_json::to_string(&lease).unwrap())).unwrap();
                    let (lock_ready,locked)=mpsc::channel();let (unlock,release)=mpsc::channel();
                    let lock_thread=std::thread::spawn(move||crate::input_native::hold_fixture_owner(lock_ready,release));
                    locked.recv_timeout(Duration::from_secs(1)).unwrap();
                    window.eval("__TAURI__.core.invoke('nearcast_input_feedback',{ownerId:'webview-test',leaseId:fixtureLease,feedback:null}).then(()=>__TAURI__.core.invoke('input_fixture_report',{kind:'contended-feedback'}));setTimeout(()=>fixtureHeartbeat(),10);").unwrap();
                    let tick=Instant::now();let mut heartbeat=false;
                    while tick.elapsed()<Duration::from_millis(600){if received.recv_timeout(Duration::from_millis(50)).ok().as_deref()==Some("heartbeat"){heartbeat=true;break;}}
                    unlock.send(()).unwrap();lock_thread.join().unwrap();assert!(heartbeat,"input feedback blocked the WebView UI while input owner was busy");
                    window.set_focus().unwrap();std::thread::sleep(Duration::from_millis(200));
                    assert_eq!(unsafe{GetForegroundWindow()},hwnd);assert_eq!(unsafe{GetAncestor(WindowFromPoint(point),GA_ROOT)},hwnd);
                    for (kind,buttons) in [(0,0),(1,1),(1,0)]{
                        let action=serde_json::from_value(serde_json::json!({"inputType":"mouse","eventKind":kind,"buttons":buttons,"modifiers":0,"x":point.x,"y":point.y})).unwrap();
                        let started=Instant::now();let revision=binding["revision"].as_str().unwrap().to_owned();let copy=lease.clone();
                        let result=tauri::async_runtime::block_on(crate::native_input_task(move||crate::input_native::apply("webview-test".into(),copy,revision,action))).unwrap();
                        assert_eq!(result["status"],"submitted","{result}");assert!(started.elapsed()<Duration::from_secs(2));std::thread::sleep(Duration::from_millis(100));
                    }
                    let mut events=vec![];let until=Instant::now()+Duration::from_secs(3);
                    while Instant::now()<until{if let Ok(event)=received.recv_timeout(Duration::from_millis(100)){events.push(event);}if ["down","up","feedback"].iter().all(|v|events.iter().any(|s|s==v)){break;}}
                    assert!(["down","up","feedback"].iter().all(|v|events.iter().any(|s|s==v)),"{events:?}");
                    // Non-client title-bar input enters a different Windows
                    // move loop than the WebView's client-area button above.
                    let mut bounds=windows::Win32::Foundation::RECT::default();unsafe{GetWindowRect(hwnd,&mut bounds).unwrap();}
                    let title=POINT{x:bounds.left+220,y:bounds.top+15};
                    let packed=((title.y as u32)<<16)|(title.x as u32&0xffff);
                    assert_eq!(unsafe{SendMessageW(hwnd,WM_NCHITTEST,Some(windows::Win32::Foundation::WPARAM(0)),Some(windows::Win32::Foundation::LPARAM(packed as isize)))}.0,HTCAPTION as isize);
                    for (kind,buttons) in [(0,0),(1,1),(1,0)]{
                        let action=serde_json::from_value(serde_json::json!({"inputType":"mouse","eventKind":kind,"buttons":buttons,"modifiers":0,"x":title.x,"y":title.y})).unwrap();
                        let revision=binding["revision"].as_str().unwrap().to_owned();let lease=lease.clone();
                        let result=tauri::async_runtime::block_on(crate::native_input_task(move||crate::input_native::apply("webview-test".into(),lease,revision,action))).unwrap();
                        assert_eq!(result["status"],"submitted","{result}");std::thread::sleep(Duration::from_millis(80));
                    }
                    window.eval("fixtureHeartbeat()").unwrap();
                    let until=Instant::now()+Duration::from_secs(2);let mut title_heartbeat=false;
                    while Instant::now()<until{if received.recv_timeout(Duration::from_millis(50)).ok().as_deref()==Some("heartbeat"){title_heartbeat=true;break;}}
                    assert!(title_heartbeat,"title-bar click left WebView UI blocked");
                    // Exercise the custom button's real async native IPC path.
                    for kind in ["toggleMaximize","toggleMaximize","move","minimize","hide","show"] {
                        let action=if kind=="move"{serde_json::json!({"kind":kind,"x":bounds.left,"y":bounds.top})}else{serde_json::json!({"kind":kind})};
                        window.eval(format!("__TAURI__.core.invoke('nearcast_window_action',{{action:{action}}}).then(()=>__TAURI__.core.invoke('input_fixture_report',{{kind:'window-action'}}));")).unwrap();
                        let until=Instant::now()+Duration::from_secs(3);let mut complete=false;
                        while Instant::now()<until{if received.recv_timeout(Duration::from_millis(50)).ok().as_deref()==Some("window-action"){complete=true;break;}}
                        assert!(complete,"custom window command {kind} blocked its WebView reply");
                    }
                    window.unminimize().unwrap();
                    let (lock_ready,locked)=mpsc::channel();let (unlock,release)=mpsc::channel();
                    let lock_thread=std::thread::spawn(move||crate::input_native::hold_fixture_owner(lock_ready,release));
                    locked.recv_timeout(Duration::from_secs(1)).unwrap();
                    window.close().unwrap();
                    std::thread::sleep(Duration::from_millis(60));window.eval("fixtureHeartbeat()").unwrap();
                    let until=Instant::now()+Duration::from_millis(600);let mut close_heartbeat=false;
                    while Instant::now()<until{if received.recv_timeout(Duration::from_millis(50)).ok().as_deref()==Some("heartbeat"){close_heartbeat=true;break;}}
                    unlock.send(()).unwrap();lock_thread.join().unwrap();assert!(close_heartbeat,"window close blocked the UI on a busy input owner");
                    let until=Instant::now()+Duration::from_secs(2);let mut destroyed=false;
                    while Instant::now()<until{if received.recv_timeout(Duration::from_millis(50)).ok().as_deref()==Some("destroyed"){destroyed=true;break;}}
                    assert!(destroyed,"window did not close after owned input cleanup");
                }));
                let _=finished.send(outcome.is_ok());let _=worker_report.send("finished".into());handle.exit(0);
            });Ok(())
        }).build(context).unwrap();
    app.run_return(|_, event| {if let tauri::RunEvent::ExitRequested{api,code,..}=event{if code.is_none(){api.prevent_exit();}}});
    assert_eq!(result.recv_timeout(Duration::from_secs(2)).unwrap(), true);
}
