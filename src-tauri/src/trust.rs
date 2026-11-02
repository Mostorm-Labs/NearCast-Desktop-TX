use crate::pinned_tls;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{collections::BTreeMap, fs, io::{Read, Write}, path::PathBuf, time::{Duration, Instant, SystemTime, UNIX_EPOCH}};

fn valid_id(value: &str) -> bool { !value.trim().is_empty() && value.len() <= 128 && !value.chars().any(char::is_control) }
pub fn nonce() -> Result<String, String> {
    let mut bytes = [0u8; 24]; getrandom::fill(&mut bytes).map_err(|_| "Unable to create trust confirmation ID")?;
    Ok(bytes.iter().map(|byte| format!("{byte:02X}")).collect())
}
pub fn trust_request(device_id: &str, request_id: &str) -> Result<Value, String> {
    if !valid_id(device_id) || !valid_id(request_id) { return Err("Invalid trust-display identity".into()); }
    Ok(json!({"type":"nearcast.trust_display.request","version":1,"deviceId":device_id,"requestId":request_id}))
}
pub fn trust_response(bytes: &[u8], request_id: &str) -> Result<String, String> {
    if bytes.len() > 4096 { return Err("Trust-display response too large".into()); }
    let value: Value = serde_json::from_slice(bytes).map_err(|_| "Invalid trust-display response")?;
    if value.as_object().map_or(true, |object| object.len() != 4) || value["type"] != "nearcast.trust_display.result" || value["version"].as_u64() != Some(1) || value["requestId"].as_str() != Some(request_id) || !matches!(value["status"].as_str(), Some("shown" | "unavailable" | "rate_limited" | "not_supported")) { return Err("Invalid trust-display response".into()); }
    Ok(value["status"].as_str().unwrap().to_owned())
}

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct StoreDocument { version: u32, devices: BTreeMap<String, String> }
pub struct TrustStore { path: PathBuf, document: StoreDocument }
impl TrustStore {
    pub fn load(path: PathBuf) -> Result<Self, String> {
        let document = match fs::File::open(&path) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => StoreDocument {version:1, devices:BTreeMap::new()},
            Err(_) => return Err("无法读取设备信任，请检查应用数据目录。".into()),
            Ok(file) => {
                let mut bytes = Vec::new(); file.take(262145).read_to_end(&mut bytes).map_err(|_| "无法读取设备信任。")?;
                if bytes.len() > 262144 { return Err("设备信任文件过大。".into()); }
                let document: StoreDocument = serde_json::from_slice(&bytes).map_err(|_| "设备信任文件损坏，请检查应用数据目录；仍可现场输入配对码。")?;
                if document.version != 1 || document.devices.len() > 512 || document.devices.iter().any(|(id, pin)| !valid_id(id) || !pinned_tls::valid_pin(pin)) { return Err("Invalid device trust store".into()); }
                document
            }
        };
        Ok(Self {path, document})
    }
    pub fn pin(&self, device_id: &str) -> Option<&str> { self.document.devices.get(device_id).map(String::as_str) }
    pub fn require_pin(&self, device_id: &str) -> Result<&str, String> { self.pin(device_id).ok_or_else(|| "NEARCAST_TRUST_REQUIRED: 请先现场核对并信任设备指纹。".into()) }
    pub fn save(&mut self, device_id: &str, pin: &str) -> Result<(), String> {
        if !valid_id(device_id) || !pinned_tls::valid_pin(pin) || (self.document.devices.len() >= 512 && !self.document.devices.contains_key(device_id)) { return Err("Invalid device trust".into()); }
        let mut next = self.document.clone(); next.devices.insert(device_id.to_owned(), pin.to_owned()); self.persist(next)
    }
    pub fn revoke(&mut self, device_id: &str) -> Result<(), String> { let mut next = self.document.clone(); next.devices.remove(device_id); self.persist(next) }
    fn persist(&mut self, document: StoreDocument) -> Result<(), String> {
        let parent = self.path.parent().ok_or("Invalid trust store directory")?;
        fs::create_dir_all(parent).map_err(|_| "无法保存设备信任，请检查应用数据目录。")?;
        let mut temp = tempfile::NamedTempFile::new_in(parent).map_err(|_| "无法保存设备信任。")?;
        let bytes = serde_json::to_vec(&document).map_err(|_| "Invalid trust store")?;
        temp.write_all(&bytes).and_then(|_| temp.as_file().sync_all()).map_err(|_| "无法保存设备信任。")?;
        temp.persist(&self.path).map_err(|_| "无法保存设备信任。")?;
        self.document = document; Ok(())
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all="camelCase")]
pub struct CandidateView { pub candidate_id: String, pub device_id: String, pub fingerprint: String, pub previous_fingerprint: Option<String>, pub expires_at: u64 }
struct Candidate { view: CandidateView, instance: String, until: Instant }
#[derive(Default)]
pub struct TrustManager { generation: u64, candidate: Option<Candidate> }
impl TrustManager {
    pub fn begin(&mut self) -> u64 { self.generation = self.generation.wrapping_add(1); self.candidate = None; self.generation }
    pub fn cancel(&mut self) { self.begin(); }
    pub fn current(&self, generation: u64) -> bool { self.generation == generation }
    pub fn finish(&mut self, generation: u64, device_id: &str, instance: &str, pin: String, path: PathBuf, now: Instant) -> Result<CandidateView, String> {
        if !self.current(generation) || !valid_id(device_id) || !pinned_tls::valid_pin(&pin) { return Err("Trust confirmation cancelled".into()); }
        let previous = TrustStore::load(path)?.pin(device_id).map(str::to_owned);
        let view = CandidateView {candidate_id:nonce()?,device_id:device_id.into(),fingerprint:pin,previous_fingerprint:previous,expires_at:SystemTime::now().duration_since(UNIX_EPOCH).map_err(|_| "Invalid system time")?.as_millis() as u64 + 60000};
        self.candidate = Some(Candidate {view:view.clone(),instance:instance.into(),until:now + Duration::from_secs(60)});
        Ok(view)
    }
    pub fn candidate_instance(&self, device_id: &str, candidate_id: &str) -> Result<String, String> {
        let candidate = self.candidate.as_ref().ok_or("Trust confirmation cancelled")?;
        if candidate.view.device_id != device_id || candidate.view.candidate_id != candidate_id { return Err("Trust confirmation does not match the selected receiver".into()); }
        Ok(candidate.instance.clone())
    }
    pub fn confirm(&mut self, device_id: &str, candidate_id: &str, pin: &str, path: PathBuf, now: Instant) -> Result<(), String> {
        self.candidate_instance(device_id, candidate_id)?;
        let candidate = self.candidate.as_ref().unwrap();
        if candidate.until <= now || candidate.view.fingerprint != pin { return Err("指纹核对已过期或不匹配，请重新显示指纹。".into()); }
        TrustStore::load(path)?.save(device_id, pin)?;
        self.cancel(); Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn pin() -> String { "A1".repeat(32) }

    #[test]
    fn fixed_trust_request_has_no_reason_or_secret_fields() {
        let request = trust_request("Board-ID", "req-1").unwrap();
        assert_eq!(request, json!({"type":"nearcast.trust_display.request","version":1,"deviceId":"Board-ID","requestId":"req-1"}));
        assert!(trust_request("", "req-1").is_err());
        assert!(trust_request("board", &"x".repeat(129)).is_err());
        let response = br#"{"type":"nearcast.trust_display.result","version":1,"requestId":"req-1","status":"shown"}"#;
        assert_eq!(trust_response(response, "req-1").unwrap(), "shown");
        assert!(trust_response(response, "other").is_err());
        assert!(trust_response(br#"{"type":"nearcast.trust_display.result","version":1,"requestId":"req-1","status":"shown","fingerprint":"untrusted"}"#, "req-1").is_err());
    }

    #[test]
    fn store_persists_exact_device_ids_and_revoke_without_implicit_trust() {
        let dir = tempfile::tempdir().unwrap(); let path = dir.path().join("trust.json");
        let mut store = TrustStore::load(path.clone()).unwrap();
        assert!(store.pin("Board-ID").is_none());
        store.save("Board-ID", &pin()).unwrap();
        let mut store = TrustStore::load(path).unwrap();
        assert_eq!(store.pin("Board-ID"), Some(pin().as_str()));
        assert!(store.pin("board-id").is_none());
        store.revoke("Board-ID").unwrap();
        assert!(TrustStore::load(dir.path().join("trust.json")).unwrap().pin("Board-ID").is_none());
        std::fs::write(dir.path().join("trust.json"), b"corrupt").unwrap();
        assert!(TrustStore::load(dir.path().join("trust.json")).is_err());
    }

    #[test]
    fn code_display_requires_a_saved_pin_even_when_the_network_is_reachable() {
        let dir = tempfile::tempdir().unwrap();
        let store = TrustStore::load(dir.path().join("trust.json")).unwrap();
        assert!(store.require_pin("Board-ID").unwrap_err().contains("NEARCAST_TRUST_REQUIRED"));
    }

    #[test]
    fn failed_persistence_does_not_confirm_or_replace_in_memory_trust() {
        let dir = tempfile::tempdir().unwrap(); let path = dir.path().join("trust.json");
        let mut store=TrustStore::load(path.clone()).unwrap(); store.save("Board-ID",&pin()).unwrap();
        std::fs::remove_file(&path).unwrap(); std::fs::create_dir(&path).unwrap();
        assert!(store.save("Board-ID",&"B2".repeat(32)).is_err());
        assert_eq!(store.pin("Board-ID"),Some(pin().as_str()));
        assert!(store.revoke("Board-ID").is_err());
        assert_eq!(store.pin("Board-ID"),Some(pin().as_str()));
    }

    #[test]
    fn candidate_requires_exact_explicit_confirmation_and_expires_or_cancels() {
        let dir = tempfile::tempdir().unwrap(); let mut manager = TrustManager::default(); let path = dir.path().join("trust.json");
        let ticket = manager.begin();
        let candidate = manager.finish(ticket, "Board-ID", "instance", pin(), path.clone(), Instant::now()).unwrap();
        assert!(TrustStore::load(path.clone()).unwrap().pin("Board-ID").is_none());
        assert!(manager.confirm("other", &candidate.candidate_id, &pin(), path.clone(), Instant::now()).is_err());
        assert!(manager.confirm("Board-ID", &candidate.candidate_id, &"B2".repeat(32), path.clone(), Instant::now()).is_err());
        manager.confirm("Board-ID", &candidate.candidate_id, &pin(), path.clone(), Instant::now()).unwrap();
        assert_eq!(TrustStore::load(path.clone()).unwrap().pin("Board-ID"), Some(pin().as_str()));
        assert!(manager.confirm("Board-ID", &candidate.candidate_id, &pin(), path.clone(), Instant::now()).is_err());
        let ticket = manager.begin(); let candidate = manager.finish(ticket, "Board-ID", "instance", pin(), path.clone(), Instant::now()).unwrap();
        assert!(manager.confirm("Board-ID", &candidate.candidate_id, &pin(), path.clone(), Instant::now() + Duration::from_secs(61)).is_err());
        let ticket = manager.begin(); manager.cancel();
        assert!(manager.finish(ticket, "Board-ID", "instance", pin(), path, Instant::now()).is_err());
    }
}
