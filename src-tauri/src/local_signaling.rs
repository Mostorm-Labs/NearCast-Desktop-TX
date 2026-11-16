// Native WSS owner for LAN signaling. Only messages cross IPC; captured media
// remains on the browser's WebRTC peer. TLS identity is the saved receiver key.
use std::{collections::HashMap,io,net::{IpAddr,SocketAddr,TcpStream},sync::{Arc,Mutex,atomic::{AtomicBool,Ordering},mpsc},time::{Duration,Instant}};
use rustls::{ClientConfig,ClientConnection,StreamOwned,pki_types::ServerName};
use serde::Serialize;
use tauri::{Emitter,Manager};
use tungstenite::{client::IntoClientRequest,protocol::WebSocketConfig,Message};

const MAX_MESSAGE:usize=1024*1024;
#[derive(Serialize,Clone)]
#[serde(tag="kind",rename_all="lowercase")]
enum SignalEvent {Open{connection_id:String},Message{connection_id:String,data:String},Close{connection_id:String},Error{connection_id:String,code:&'static str}}
struct Entry {device_id:String,stop:Arc<AtomicBool>,send:mpsc::SyncSender<String>}
#[derive(Default)]
pub struct State(Mutex<HashMap<String,Entry>>);
impl State {
    pub fn stop_all(&self){if let Ok(mut entries)=self.0.lock(){for(_,entry)in entries.drain(){entry.stop.store(true,Ordering::Release);}}}
    pub fn revoke(&self,id:&str){if let Ok(mut entries)=self.0.lock(){entries.retain(|_,entry|{if entry.device_id==id{entry.stop.store(true,Ordering::Release);false}else{true}});}}
}
fn valid_id(id:&str)->bool{!id.is_empty()&&id.len()<=128&&id.bytes().all(|c|c.is_ascii_alphanumeric()||c==b'-')}
fn io_retry(error:&tungstenite::Error)->bool{matches!(error,tungstenite::Error::Io(e) if matches!(e.kind(),io::ErrorKind::WouldBlock|io::ErrorKind::TimedOut))}
fn run(url:tauri::Url,pin:String,stop:Arc<AtomicBool>,receiver:mpsc::Receiver<String>,mut emit:impl FnMut(&str,Option<String>))->Result<(),String>{
    let ip:IpAddr=url.host_str().ok_or("address")?.trim_matches(['[',']']).parse().map_err(|_|"address")?;
    let mut stream=TcpStream::connect_timeout(&SocketAddr::new(ip,url.port().ok_or("port")?),Duration::from_millis(1500)).map_err(|_|"connect")?;
    stream.set_read_timeout(Some(Duration::from_millis(200))).map_err(|_|"socket")?;
    stream.set_write_timeout(Some(Duration::from_millis(200))).map_err(|_|"socket")?;
    let config=ClientConfig::builder_with_provider(Arc::new(rustls::crypto::ring::default_provider())).with_safe_default_protocol_versions().map_err(|_|"tls")?.dangerous()
        .with_custom_certificate_verifier(Arc::new(crate::pinned_tls::KeyVerifier{expected:Some(pin)})).with_no_client_auth();
    let mut tls=ClientConnection::new(Arc::new(config),ServerName::IpAddress(ip.into())).map_err(|_|"tls")?;
    let deadline=Instant::now()+Duration::from_secs(5);
    while tls.is_handshaking(){if stop.load(Ordering::Acquire)||Instant::now()>=deadline{return Err("cancelled".into());}
        match tls.complete_io(&mut stream){Ok(_)=>{},Err(e)if matches!(e.kind(),io::ErrorKind::TimedOut|io::ErrorKind::WouldBlock)=>{},Err(_)=>return Err("tls_identity".into())}}
    if stop.load(Ordering::Acquire){return Ok(());}
    let mut request=url.as_str().into_client_request().map_err(|_|"request")?;
    let mut origin=url.clone();origin.set_scheme("https").map_err(|_|"origin")?;origin.set_path("");origin.set_query(None);
    request.headers_mut().insert("Origin",origin.origin().ascii_serialization().parse().map_err(|_|"origin")?);
    let config=WebSocketConfig::default().max_message_size(Some(MAX_MESSAGE)).max_frame_size(Some(MAX_MESSAGE)).max_write_buffer_size(2*MAX_MESSAGE);
    let mut handshake=tungstenite::client::client_with_config(request,StreamOwned::new(tls,stream),Some(config));
    let mut socket=loop{match handshake{Ok((socket,_))=>break socket,Err(tungstenite::HandshakeError::Interrupted(mid))=>{
        if stop.load(Ordering::Acquire)||Instant::now()>=deadline{return Err("cancelled".into());}handshake=mid.handshake();
    },Err(_)=>return Err("upgrade".into())}};
    socket.get_mut().sock.set_nonblocking(true).map_err(|_|"socket")?;
    if stop.load(Ordering::Acquire){return Ok(());}
    emit("open",None);
    while !stop.load(Ordering::Acquire){
        for _ in 0..16{match receiver.try_recv(){Ok(text)=>match socket.send(Message::Text(text.into())){Ok(())=>{},Err(e)if io_retry(&e)=>{},Err(_)=>return Err("write".into())},Err(mpsc::TryRecvError::Empty)=>break,Err(_)=>return Ok(())}}
        match socket.flush(){Ok(())=>{},Err(e)if io_retry(&e)=>{},Err(_)=>return Err("write".into())}
        match socket.read(){Ok(Message::Text(text))=>emit("message",Some(text.to_string())),Ok(Message::Close(_))=>return Ok(()),Ok(Message::Binary(_))=>return Err("binary".into()),Ok(_)=>{},Err(e)if io_retry(&e)=>{},Err(tungstenite::Error::ConnectionClosed|tungstenite::Error::AlreadyClosed)=>return Ok(()),Err(_)=>return Err("read".into())}
        std::thread::sleep(Duration::from_millis(5));
    }
    let _=socket.close(None);Ok(())
}

#[test]
#[ignore="requires an explicitly provided independent RX fixture endpoint and public pin"]
fn actual_rx_fixture_accepts_native_signaling_headers(){
    let Ok(endpoint)=std::env::var("NEARCAST_LOCAL_SIGNAL_FIXTURE_URL")else{panic!("Set independent RX fixture URL");};
    let pin=std::env::var("NEARCAST_LOCAL_SIGNAL_FIXTURE_PIN").unwrap();let stop=Arc::new(AtomicBool::new(false));let(_tx,rx)=mpsc::sync_channel(2);let mut connected=false;
    run(tauri::Url::parse(&endpoint).unwrap(),pin,stop.clone(),rx,|_,data|{if data.is_some_and(|value|serde_json::from_str::<serde_json::Value>(&value).is_ok_and(|v|v["type"]=="connected")){connected=true;stop.store(true,Ordering::Release);}}).unwrap();
    assert!(connected);
}

#[tauri::command]
pub async fn nearcast_local_signal_open(app:tauri::AppHandle,window:tauri::Window,connection_id:String,instance:String,device_id:String,runtime_instance_id:String,
    discovery:tauri::State<'_,crate::MdnsState>,trust:tauri::State<'_,crate::TrustState>,state:tauri::State<'_,State>)->Result<(),String>{
    if window.label()!="main"||!valid_id(&connection_id)||!valid_id(&runtime_instance_id){return Err("Invalid local signaling owner".into());}
    let target={let runtime=discovery.0.lock().map_err(|_|"discovery")?;let cache=runtime.as_ref().ok_or("Discovery stopped")?.active.lock().map_err(|_|"discovery")?;
        cache.local_signal_target(&instance,&device_id,&runtime_instance_id)?};
    let _trust=trust.0.lock().map_err(|_|"trust")?;
    let pin=crate::trust::TrustStore::load(crate::trust_path(&app)?)?.require_pin(&device_id)?.to_owned();
    let stop=Arc::new(AtomicBool::new(false));let (send,receive)=mpsc::sync_channel(64);
    {let mut entries=state.0.lock().map_err(|_|"signaling")?;if entries.len()>=4||entries.contains_key(&connection_id){return Err("Local signaling owner limit".into());}
        entries.insert(connection_id.clone(),Entry{device_id,stop:stop.clone(),send});}
    std::thread::spawn(move||{
        let result=(||{let mut url=target.reachable_url(Duration::from_millis(1800))?;url.set_scheme("wss").map_err(|_|"scheme")?;url.set_path("/");url.set_query(Some(&format!("role=sender&runtime={runtime_instance_id}")));
            run(url,pin,stop.clone(),receive,|kind,data|{let event=if kind=="open"{SignalEvent::Open{connection_id:connection_id.clone()}}else{SignalEvent::Message{connection_id:connection_id.clone(),data:data.unwrap_or_default()}};let _=window.emit("nearcast://local-signal",event);})})();
        if result.is_err()&&!stop.load(Ordering::Acquire){let _=window.emit("nearcast://local-signal",SignalEvent::Error{connection_id:connection_id.clone(),code:"local_signal_failed"});}
        let _=window.emit("nearcast://local-signal",SignalEvent::Close{connection_id:connection_id.clone()});
        if let Ok(mut entries)=app.state::<State>().0.lock(){if entries.get(&connection_id).is_some_and(|entry|Arc::ptr_eq(&entry.stop,&stop)){entries.remove(&connection_id);}}
    });Ok(())
}
#[tauri::command]
pub fn nearcast_local_signal_send(window:tauri::Window,connection_id:String,data:String,state:tauri::State<'_,State>)->Result<(),String>{
    if window.label()!="main"||data.len()>MAX_MESSAGE{return Err("Invalid signaling message".into());}
    state.0.lock().map_err(|_|"signaling")?.get(&connection_id).ok_or("Signaling owner closed")?.send.try_send(data).map_err(|_|"Signaling queue full".into())
}
#[tauri::command]
pub fn nearcast_local_signal_close(window:tauri::Window,connection_id:String,state:tauri::State<'_,State>)->Result<(),String>{
    if window.label()!="main"{return Err("Invalid signaling window".into());}
    if let Some(entry)=state.0.lock().map_err(|_|"signaling")?.remove(&connection_id){entry.stop.store(true,Ordering::Release);}Ok(())
}

#[cfg(test)]
mod tests{
    use super::*;
    use rustls::{ServerConfig,ServerConnection,pki_types::PrivatePkcs8KeyDer};
    use std::net::TcpListener;
    fn server()->(tauri::Url,String,std::thread::JoinHandle<bool>){
        let key=rcgen::KeyPair::generate().unwrap();let cert=rcgen::CertificateParams::new(vec!["localhost".into()]).unwrap().self_signed(&key).unwrap();
        let pin=crate::pinned_tls::fingerprint(cert.der()).unwrap();
        let config=ServerConfig::builder_with_provider(Arc::new(rustls::crypto::ring::default_provider())).with_safe_default_protocol_versions().unwrap()
            .with_no_client_auth().with_single_cert(vec![cert.der().clone()],PrivatePkcs8KeyDer::from(key.serialize_der()).into()).unwrap();
        let listener=TcpListener::bind("127.0.0.1:0").unwrap();let url=tauri::Url::parse(&format!("wss://{}/?role=sender&runtime=runtime-1",listener.local_addr().unwrap())).unwrap();
        let worker=std::thread::spawn(move||{
            let(stream,_)=listener.accept().unwrap();stream.set_read_timeout(Some(Duration::from_secs(3))).unwrap();stream.set_write_timeout(Some(Duration::from_secs(3))).unwrap();
            let tls=StreamOwned::new(ServerConnection::new(Arc::new(config)).unwrap(),stream);
            let result=tungstenite::accept_hdr(tls,|request:&tungstenite::handshake::server::Request,response:tungstenite::handshake::server::Response|{
                assert_eq!(request.uri().query(),Some("role=sender&runtime=runtime-1"));
                assert!(request.headers()["origin"].to_str().unwrap().starts_with("https://127.0.0.1:"));Ok(response)
            });
            if let Ok(mut socket)=result{let data=socket.read().unwrap();assert_eq!(data.into_text().unwrap(),"offer");socket.send(Message::Text("answer".into())).unwrap();
                // Wait for the client's close after the received answer.
                let _=socket.read();true
            }else{false}
        });(url,pin,worker)
    }
    #[test]
    fn actual_pinned_wss_exchanges_text_and_cancels_without_global_certificate_trust(){
        let(url,pin,worker)=server();let stop=Arc::new(AtomicBool::new(false));let(tx,rx)=mpsc::sync_channel(4);tx.send("offer".into()).unwrap();let mut events=vec![];
        run(url,pin,stop.clone(),rx,|kind,data|{events.push((kind.to_owned(),data.clone()));if data.as_deref()==Some("answer"){stop.store(true,Ordering::Release);}}).unwrap();
        assert_eq!(events,vec![("open".into(),None),("message".into(),Some("answer".into()))]);assert!(worker.join().unwrap());
    }
    #[test]
    fn wrong_pin_never_opens_websocket_or_transmits_signaling(){
        let(url,_,worker)=server();let(_tx,rx)=mpsc::sync_channel(4);let mut opened=false;
        assert!(run(url,"A".repeat(64),Arc::new(AtomicBool::new(false)),rx,|_,_|opened=true).is_err());assert!(!opened);assert!(!worker.join().unwrap());
    }
}
