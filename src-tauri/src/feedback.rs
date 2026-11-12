use serde_json::{json, Value};
use std::{
    io::{Cursor, Write},
    sync::atomic::{AtomicBool, Ordering},
    time::Duration,
};
const BASE: &str = "https://mosapi.auditoryworks.co/v1";
const MAX_ARCHIVE: usize = 4 * 1024 * 1024;
static SENDING: AtomicBool = AtomicBool::new(false);
fn product(os: &str) -> Result<u32, String> {
    match os {
        "windows" => Ok(646),
        "macos" => Ok(647),
        _ => Err("Feedback only supports Windows and macOS".into()),
    }
}
fn validate(email: &str, message: &str, consent: bool) -> Result<(), String> {
    if !consent {
        return Err("请先同意上传诊断数据。".into());
    }
    if email.len() > 254
        || email.contains(char::is_whitespace)
        || !email
            .split_once('@')
            .is_some_and(|(a, b)| !a.is_empty() && b.contains('.'))
    {
        return Err("请输入有效邮箱。".into());
    }
    if message.trim().is_empty() || message.chars().count() > 4000 {
        return Err("问题描述需为 1–4000 字。".into());
    }
    Ok(())
}
fn archive(report: &[u8]) -> Result<Vec<u8>, String> {
    if report.len() > MAX_ARCHIVE - 1024 {
        return Err("诊断超出上传大小限制。".into());
    }
    let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
    zip.start_file(
        "diagnostics.json",
        zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored),
    )
    .map_err(|e| e.to_string())?;
    zip.write_all(report).map_err(|e| e.to_string())?;
    Ok(zip.finish().map_err(|e| e.to_string())?.into_inner())
}
fn response_id(v: &Value) -> Option<u64> {
    v.get("id")
        .and_then(Value::as_u64)
        .filter(|id| *id > 0)
        .or_else(|| v.get("data").and_then(response_id))
        .or_else(|| {
            v.as_array()
                .and_then(|rows| rows.first())
                .and_then(response_id)
        })
}
fn payload(os: &str, email: &str, message: &str, file: u64) -> Result<Value, String> {
    let product = product(os)?;
    Ok(
        json!({"data":{"appVersion":format!("NearHub Cast {}.{}",env!("NEARCAST_LOGICAL_VERSION"),env!("NEARCAST_BUILD_NUMBER")),
        "client":{"name":"Unknown","email":email,"phone":"Unknown","location":"Unknown"},
        "equipment":{"category":"PC","manufacture":"Unknown","model":{"name":"Unknown"},"hardware":{"processor":std::env::consts::ARCH,"memory":"Unknown","storage":"Unknown"},
            "software":{"systemVersion":os,"systemType":os,"language":"Unknown","region":"Unknown"},"graphics":[],"displays":[]},
        "content":{"title":format!("NearHub Cast: {}",message.chars().take(50).collect::<String>()),"message":message,"attachments":[{"id":file}]},
        "application":{"connect":[{"id":2}]},"product":{"connect":[{"id":product}]},
        "timestamp":std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis().to_string()}}),
    )
}
fn multipart(bytes: &[u8], boundary: &str) -> Vec<u8> {
    let mut body=format!("--{boundary}\r\nContent-Disposition: form-data; name=\"fileInfo\"\r\n\r\n{{\"name\":\"nearhub-cast-diagnostics.zip\",\"folder\":\"diagnostic\"}}\r\n--{boundary}\r\nContent-Disposition: form-data; name=\"files\"; filename=\"blob\"\r\nContent-Type: application/octet-stream\r\n\r\n").into_bytes();
    body.extend_from_slice(bytes);
    body.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());
    body
}
async fn response(mut response: reqwest::Response) -> Result<Value, String> {
    let status = response.status();
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "反馈服务连接中断，请重试。")?
    {
        if bytes.len() + chunk.len() > 65536 {
            return Err("反馈服务响应过大。".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    if !status.is_success() {
        return Err(format!(
            "反馈服务返回 HTTP {}，请稍后重试。",
            status.as_u16()
        ));
    }
    serde_json::from_slice(&bytes).map_err(|_| "反馈服务未返回有效确认。".into())
}
async fn upload_to(
    client: &reqwest::Client,
    base: &str,
    report: Vec<u8>,
    email: &str,
    message: &str,
    os: &str,
) -> Result<Value, String> {
    let zip = archive(&report)?;
    let boundary = format!("NearHubCast{}", uuid()?);
    let file = response(
        client
            .post(format!("{base}/upload"))
            .header(
                "Content-Type",
                format!("multipart/form-data; boundary={boundary}"),
            )
            .body(multipart(&zip, &boundary))
            .send()
            .await
            .map_err(|_| "无法上传诊断，请检查网络。")?,
    )
    .await?;
    let id = response_id(&file).ok_or("上传服务没有返回诊断文件编号。")?;
    let data = payload(os, email, message, id)?;
    let result = response(
        client
            .post(format!("{base}/feedbacks"))
            .header("Content-Type", "application/json")
            .body(data.to_string())
            .send()
            .await
            .map_err(|_| "诊断已上传，但反馈记录未确认；请稍后重试。")?,
    )
    .await?;
    let id = response_id(&result).ok_or("反馈记录未确认，请稍后重试。")?;
    Ok(json!({"status":"submitted","id":id}))
}
fn uuid() -> Result<String, String> {
    let mut b = [0u8; 16];
    getrandom::fill(&mut b).map_err(|_| "无法初始化上传，请重试。".to_string())?;
    Ok(b.iter().map(|b| format!("{b:02x}")).collect())
}
pub async fn submit(email: String, message: String, consent: bool) -> Result<Value, String> {
    let email = email.trim();
    let message = message.trim();
    validate(email, message, consent)?;
    product(std::env::consts::OS)?;
    if SENDING.swap(true, Ordering::AcqRel) {
        return Err("反馈正在发送，请稍候。".into());
    }
    struct Done;
    impl Drop for Done {
        fn drop(&mut self) {
            SENDING.store(false, Ordering::Release);
        }
    }
    let _done = Done;
    let report = tauri::async_runtime::spawn_blocking(crate::diagnostics::feedback_report)
        .await
        .map_err(|e| e.to_string())??;
    let _ = rustls::crypto::ring::default_provider().install_default();
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(90))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| e.to_string())?;
    upload_to(&client, BASE, report, email, message, std::env::consts::OS).await
}
#[cfg(test)]
mod tests {
    use super::*;
    use std::{io::Read, net::TcpListener};
    fn mock(status: u16, count: usize) -> (String, std::thread::JoinHandle<Vec<Vec<u8>>>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = format!("http://{}", listener.local_addr().unwrap());
        let worker = std::thread::spawn(move || {
            let mut requests = Vec::new();
            for i in 0..count {
                let (mut socket, _) = listener.accept().unwrap();
                socket
                    .set_read_timeout(Some(Duration::from_secs(5)))
                    .unwrap();
                let mut request = Vec::new();
                let mut chunk = [0u8; 4096];
                loop {
                    let n = socket.read(&mut chunk).unwrap();
                    assert!(n > 0);
                    request.extend_from_slice(&chunk[..n]);
                    if let Some(end) = request.windows(4).position(|w| w == b"\r\n\r\n") {
                        let header = String::from_utf8_lossy(&request[..end]);
                        let length = header
                            .lines()
                            .find_map(|line| {
                                line.to_ascii_lowercase()
                                    .strip_prefix("content-length:")
                                    .map(|s| s.trim().parse::<usize>().unwrap())
                            })
                            .unwrap();
                        if request.len() >= end + 4 + length {
                            break;
                        }
                    }
                }
                requests.push(request);
                let body = if i == 0 {
                    "[{\"id\":42}]"
                } else {
                    "{\"data\":{\"id\":99}}"
                };
                write!(socket,"HTTP/1.1 {status} Test\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).unwrap();
            }
            requests
        });
        (address, worker)
    }
    #[test]
    fn upload_contract_confirms_both_requests_and_stops_after_http_failure() {
        let _ = rustls::crypto::ring::default_provider().install_default();
        let client = reqwest::Client::builder()
            .no_proxy()
            .timeout(Duration::from_secs(5))
            .build()
            .unwrap();
        let (base, worker) = mock(200, 2);
        let result = tauri::async_runtime::block_on(upload_to(
            &client,
            &base,
            b"{\"events\":[]}".to_vec(),
            "test@example.com",
            "Synthetic test",
            "windows",
        ))
        .unwrap();
        assert_eq!(result["id"], 99);
        let requests = worker.join().unwrap();
        let first = String::from_utf8_lossy(&requests[0]);
        assert!(first.starts_with("POST /upload "));
        assert!(first.contains("name=\"fileInfo\""));
        assert!(first.contains("\"folder\":\"diagnostic\""));
        assert!(first.contains("filename=\"blob\""));
        let start = requests[0]
            .windows(4)
            .position(|w| w == b"PK\x03\x04")
            .unwrap();
        let end = requests[0]
            .windows(4)
            .position(|w| w == b"PK\x05\x06")
            .unwrap()
            + 22;
        let mut archive = zip::ZipArchive::new(Cursor::new(&requests[0][start..end])).unwrap();
        let mut report = String::new();
        archive
            .by_name("diagnostics.json")
            .unwrap()
            .read_to_string(&mut report)
            .unwrap();
        assert_eq!(report, "{\"events\":[]}");
        let second = String::from_utf8_lossy(&requests[1]);
        assert!(second.starts_with("POST /feedbacks "));
        let body: Value = serde_json::from_str(second.split_once("\r\n\r\n").unwrap().1).unwrap();
        assert_eq!(body["data"]["product"]["connect"][0]["id"], 646);
        assert_eq!(body["data"]["content"]["attachments"][0]["id"], 42);
        let (base, worker) = mock(401, 1);
        let error = tauri::async_runtime::block_on(upload_to(
            &client,
            &base,
            b"{}".to_vec(),
            "test@example.com",
            "Synthetic test",
            "macos",
        ))
        .unwrap_err();
        assert!(error.contains("401"));
        assert_eq!(worker.join().unwrap().len(), 1);
    }
    #[test]
    fn consent_bounded_fields_product_and_archive_are_native_owned() {
        assert!(validate("a@b.co", "problem", true).is_ok());
        assert!(validate("a@b.co", "problem", false).is_err());
        assert!(validate("invalid", "problem", true).is_err());
        for (os, id) in [("windows", 646), ("macos", 647)] {
            let p = payload(os, "a@b.co", "problem", 42).unwrap();
            assert_eq!(p["data"]["product"]["connect"][0]["id"], id);
            assert_eq!(p["data"]["content"]["attachments"][0]["id"], 42);
        }
        let zip = archive(br#"{"events":[]}"#).unwrap();
        let mut reader = zip::ZipArchive::new(Cursor::new(zip)).unwrap();
        assert_eq!(reader.len(), 1);
        assert_eq!(reader.by_index(0).unwrap().name().unwrap(), "diagnostics.json");
        assert_eq!(response_id(&json!({"data":{"id":23}})), Some(23));
        assert!(response_id(&json!({"unknown":{"id":1}})).is_none());
        assert!(archive(&vec![0; MAX_ARCHIVE]).is_err());
    }
}
