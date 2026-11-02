use rustls::{client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier}, crypto::{ring, verify_tls12_signature, verify_tls13_signature}, pki_types::{CertificateDer, ServerName, UnixTime}, ClientConfig, ClientConnection, DigitallySignedStruct, SignatureScheme, StreamOwned};
use sha2::{Digest, Sha256};
use std::{io::{self, Read, Write}, net::{IpAddr, SocketAddr, TcpStream}, sync::Arc, time::{Duration, Instant}};

pub fn fingerprint(der: &[u8]) -> Result<String, String> {
    let (remaining, certificate) = x509_parser::parse_x509_certificate(der).map_err(|_| "Invalid receiver certificate")?;
    if !remaining.is_empty() { return Err("Invalid receiver certificate".into()); }
    Ok(format!("{:X}", Sha256::digest(certificate.public_key().raw)))
}

pub fn valid_pin(pin: &str) -> bool { pin.len() == 64 && pin.bytes().all(|c| c.is_ascii_digit() || (b'A'..=b'F').contains(&c)) }

#[derive(Debug)]
struct KeyVerifier { expected: Option<String> }
impl ServerCertVerifier for KeyVerifier {
    fn verify_server_cert(&self, cert: &CertificateDer<'_>, _: &[CertificateDer<'_>], _: &ServerName<'_>, _: &[u8], _: UnixTime) -> Result<ServerCertVerified, rustls::Error> {
        let pin = fingerprint(cert.as_ref()).map_err(rustls::Error::General)?;
        if self.expected.as_ref().is_some_and(|expected| *expected != pin) { return Err(rustls::Error::General("NEARCAST_KEY_MISMATCH: 接收端公钥已变化，已阻止请求；请重新现场核对指纹。".into())); }
        // Observe-only connections send no application data. Every HTTP connection
        // supplies an expected key; identity is the physically confirmed SPKI,
        // independent of CA, certificate renewal, SAN or current IP address.
        Ok(ServerCertVerified::assertion())
    }
    fn verify_tls12_signature(&self, message: &[u8], cert: &CertificateDer<'_>, signature: &DigitallySignedStruct) -> Result<HandshakeSignatureValid, rustls::Error> {
        verify_tls12_signature(message, cert, signature, &ring::default_provider().signature_verification_algorithms)
    }
    fn verify_tls13_signature(&self, message: &[u8], cert: &CertificateDer<'_>, signature: &DigitallySignedStruct) -> Result<HandshakeSignatureValid, rustls::Error> {
        verify_tls13_signature(message, cert, signature, &ring::default_provider().signature_verification_algorithms)
    }
    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> { ring::default_provider().signature_verification_algorithms.supported_schemes() }
}

struct BoundedTcp { stream: TcpStream, until: Instant }
impl BoundedTcp {
    fn remaining(&self) -> io::Result<Duration> {
        let left = self.until.saturating_duration_since(Instant::now());
        if left.is_zero() { Err(io::Error::new(io::ErrorKind::TimedOut, "Receiver HTTPS timed out")) } else { Ok(left) }
    }
}
impl Read for BoundedTcp { fn read(&mut self, bytes: &mut [u8]) -> io::Result<usize> { self.stream.set_read_timeout(Some(self.remaining()?))?; self.stream.read(bytes) } }
impl Write for BoundedTcp {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> { self.stream.set_write_timeout(Some(self.remaining()?))?; self.stream.write(bytes) }
    fn flush(&mut self) -> io::Result<()> { self.stream.flush() }
}

fn connect(url: &tauri::Url, expected: Option<&str>) -> Result<StreamOwned<ClientConnection, BoundedTcp>, String> {
    let host = url.host_str().ok_or("Missing receiver address")?.trim_matches(['[', ']']);
    let ip: IpAddr = host.parse().map_err(|_| "Receiver address must come from resolved DNS-SD A/AAAA records")?;
    if url.scheme() != "https" || !url.username().is_empty() || url.password().is_some() || url.query().is_some() || url.fragment().is_some() || !matches!(url.path(), "/nearcast/code-display" | "/nearcast/trust-display") || expected.is_some_and(|pin| !valid_pin(pin)) { return Err("Invalid pinned HTTPS endpoint or key".into()); }
    let config = ClientConfig::builder_with_provider(Arc::new(ring::default_provider())).with_safe_default_protocol_versions().map_err(|error| error.to_string())?.dangerous().with_custom_certificate_verifier(Arc::new(KeyVerifier {expected:expected.map(str::to_owned)})).with_no_client_auth();
    let mut connection = ClientConnection::new(Arc::new(config), ServerName::IpAddress(ip.into())).map_err(|error| error.to_string())?;
    let until = Instant::now() + Duration::from_secs(5);
    let stream = TcpStream::connect_timeout(&SocketAddr::new(ip, url.port_or_known_default().unwrap_or(443)), Duration::from_millis(1500)).map_err(|error| format!("无法连接接收端 HTTPS：{error}"))?;
    let mut socket = BoundedTcp {stream, until};
    while connection.is_handshaking() { connection.complete_io(&mut socket).map_err(|error| format!("接收端 TLS 验证失败：{error}"))?; }
    Ok(StreamOwned::new(connection, socket))
}

pub fn observe(url: &tauri::Url) -> Result<String, String> {
    let connection = connect(url, None)?;
    let cert = connection.conn.peer_certificates().and_then(|chain| chain.first()).ok_or("Receiver did not present a certificate")?;
    fingerprint(cert.as_ref())
}

pub fn post(url: &tauri::Url, body: &[u8], pin: &str) -> Result<Vec<u8>, String> {
    if body.len() > 1024 { return Err("Receiver request too large".into()); }
    // Finish certificate + proof-of-private-key verification before writing HTTP.
    let mut connection = connect(url, Some(pin))?;
    let ip: IpAddr = url.host_str().unwrap().trim_matches(['[', ']']).parse().map_err(|_| "Invalid receiver address")?;
    let authority = SocketAddr::new(ip, url.port_or_known_default().unwrap_or(443));
    let header = format!("POST {} HTTP/1.1\r\nHost: {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\nCache-Control: no-store\r\n\r\n", url.path(), authority, body.len());
    connection.write_all(header.as_bytes()).and_then(|_| connection.write_all(body)).and_then(|_| connection.flush()).map_err(|error| error.to_string())?;
    let mut raw = Vec::new();
    let (offset, length) = loop {
        let mut bytes = [0u8; 512];
        let size = connection.read(&mut bytes).map_err(|error| format!("Receiver HTTPS response failed: {error}"))?;
        if size == 0 { return Err("Incomplete receiver HTTPS headers".into()); }
        raw.extend_from_slice(&bytes[..size]);
        let mut headers = [httparse::EMPTY_HEADER; 32]; let mut response = httparse::Response::new(&mut headers);
        match response.parse(&raw).map_err(|_| "Invalid receiver HTTPS headers")? {
            httparse::Status::Partial => if raw.len() > 8192 { return Err("Receiver HTTPS headers too large".into()); },
            httparse::Status::Complete(offset) => {
                if offset > 8192 || response.code != Some(200) { return Err(format!("Receiver HTTPS status {}", response.code.unwrap_or(0))); }
                let mut length = None;
                for header in response.headers.iter() {
                    if header.name.eq_ignore_ascii_case("transfer-encoding") { return Err("Receiver must use a bounded Content-Length response".into()); }
                    if header.name.eq_ignore_ascii_case("content-length") {
                        if length.is_some() { return Err("Ambiguous receiver Content-Length".into()); }
                        length = Some(std::str::from_utf8(header.value).ok().and_then(|value| value.parse::<usize>().ok()).filter(|size| *size <= 4096).ok_or("Invalid receiver Content-Length")?);
                    }
                }
                break (offset, length.ok_or("Receiver response missing Content-Length")?);
            }
        }
    };
    if raw.len() > offset + length { return Err("Receiver response exceeds Content-Length".into()); }
    let received = raw.len();
    raw.resize(offset + length, 0);
    connection.read_exact(&mut raw[received..]).map_err(|error| format!("Incomplete receiver response: {error}"))?;
    Ok(raw[offset..].to_vec())
}

#[cfg(test)]
mod tests {
    use super::*;
    use rcgen::{CertificateParams, KeyPair};
    use rustls::{ServerConfig, ServerConnection, StreamOwned, pki_types::PrivatePkcs8KeyDer};
    use std::{io::{Read, Write}, net::TcpListener, sync::{Arc, atomic::{AtomicUsize, Ordering}}};

    fn certificate(key: &KeyPair, name: &str) -> Vec<u8> {
        CertificateParams::new(vec![name.into()]).unwrap().self_signed(key).unwrap().der().to_vec()
    }

    fn server(cert: Vec<u8>, key: &KeyPair) -> (tauri::Url, Arc<AtomicUsize>, std::thread::JoinHandle<()>) {
        let config = ServerConfig::builder().with_no_client_auth().with_single_cert(vec![cert.into()], PrivatePkcs8KeyDer::from(key.serialize_der()).into()).unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = tauri::Url::parse(&format!("https://{}/nearcast/trust-display", listener.local_addr().unwrap())).unwrap();
        let bytes = Arc::new(AtomicUsize::new(0)); let count = bytes.clone();
        let worker = std::thread::spawn(move || {
            let (stream, _) = listener.accept().unwrap();
            stream.set_read_timeout(Some(std::time::Duration::from_secs(3))).unwrap();
            let mut tls = StreamOwned::new(ServerConnection::new(Arc::new(config)).unwrap(), stream);
            let mut request = [0; 2048];
            if let Ok(size) = tls.read(&mut request) {
                count.store(size, Ordering::SeqCst);
                if size > 0 { let _ = tls.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}"); }
            }
        });
        (url, bytes, worker)
    }

    #[test]
    fn pin_is_full_spki_sha256_and_survives_certificate_reissue() {
        let key = KeyPair::generate().unwrap();
        let first = certificate(&key, "first.local"); let second = certificate(&key, "new-ip.local");
        assert_ne!(first, second);
        let pin = fingerprint(&first).unwrap();
        assert_eq!(pin.len(), 64); assert!(pin.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_lowercase()));
        let (_, parsed) = x509_parser::parse_x509_certificate(&first).unwrap();
        assert_eq!(pin, format!("{:X}", Sha256::digest(parsed.public_key().raw)));
        assert_eq!(pin, fingerprint(&second).unwrap());
        assert_ne!(pin, fingerprint(&certificate(&KeyPair::generate().unwrap(), "first.local")).unwrap());
        assert!(fingerprint(b"not a certificate").is_err());
    }

    #[test]
    fn observation_completes_tls_without_sending_http() {
        let key = KeyPair::generate().unwrap(); let cert = certificate(&key, "board.local");
        let pin = fingerprint(&cert).unwrap(); let (url, count, worker) = server(cert, &key);
        assert_eq!(observe(&url).unwrap(), pin);
        worker.join().unwrap(); assert_eq!(count.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn mismatch_is_rejected_before_any_http_bytes_but_same_key_reissue_is_allowed() {
        let key = KeyPair::generate().unwrap(); let pin = fingerprint(&certificate(&key, "old.local")).unwrap();
        let other = KeyPair::generate().unwrap();
        let (url, count, worker) = server(certificate(&other, "board.local"), &other);
        assert!(post(&url, b"{}", &pin).unwrap_err().contains("NEARCAST_KEY_MISMATCH"));
        worker.join().unwrap(); assert_eq!(count.load(Ordering::SeqCst), 0);
        let (url, count, worker) = server(certificate(&key, "new.local"), &key);
        assert_eq!(post(&url, b"{}", &pin).unwrap(), b"{}");
        worker.join().unwrap(); assert!(count.load(Ordering::SeqCst) > 0);
    }

    #[test]
    fn bounded_http_rejects_redirects_oversize_and_ambiguous_lengths() {
        fn response_server(response: &'static [u8]) -> (tauri::Url, String, std::thread::JoinHandle<()>) {
            let key = KeyPair::generate().unwrap(); let cert = certificate(&key, "board.local"); let pin = fingerprint(&cert).unwrap();
            let config = ServerConfig::builder().with_no_client_auth().with_single_cert(vec![cert.into()], PrivatePkcs8KeyDer::from(key.serialize_der()).into()).unwrap();
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let url = tauri::Url::parse(&format!("https://{}/nearcast/trust-display", listener.local_addr().unwrap())).unwrap();
            let worker = std::thread::spawn(move || {
                let (stream, _) = listener.accept().unwrap(); stream.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
                let mut tls = StreamOwned::new(ServerConnection::new(Arc::new(config)).unwrap(), stream);
                let mut request=Vec::new(); let mut byte=[0u8;1];
                while !request.ends_with(b"\r\n\r\n") && request.len()<2048 { if tls.read_exact(&mut byte).is_err() {return;} request.push(byte[0]); }
                let mut body=[0;2]; if tls.read_exact(&mut body).is_err() {return;}
                for part in response.chunks(7) { if tls.write_all(part).is_err() {break;} }
            });
            (url,pin,worker)
        }
        for response in [b"HTTP/1.1 302 Found\r\nLocation: https://example.invalid/\r\nContent-Length: 0\r\n\r\n".as_slice(),b"HTTP/1.1 200 OK\r\nContent-Length: 4097\r\n\r\n",b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nContent-Length: 2\r\n\r\n{}",b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\n"] {
            let (url,pin,worker)=response_server(response); assert!(post(&url,b"{}",&pin).is_err()); worker.join().unwrap();
        }
        let (url,pin,worker)=response_server(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n{}");
        assert_eq!(post(&url,b"{}",&pin).unwrap(),b"{}"); worker.join().unwrap();
    }
}
