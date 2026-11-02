use serde_json::{json, Value};

fn validate_request(url: &str, request: &Value) -> Result<tauri::Url, String> {
    let parsed = tauri::Url::parse(url).map_err(|_| "Invalid code-display HTTPS endpoint")?;
    if parsed.scheme() != "https" || parsed.host_str().is_none() || !parsed.username().is_empty() || parsed.password().is_some() || parsed.query().is_some() || parsed.fragment().is_some() || parsed.path() != "/nearcast/code-display" {
        return Err("Code-display requires the fixed HTTPS endpoint without credentials or query".into());
    }
    let object = request.as_object().ok_or("Invalid code-display request")?;
    let fields = ["type", "version", "deviceId", "requestId", "reason"];
    if object.len() != fields.len() || object.keys().any(|key| !fields.contains(&key.as_str())) || request["type"] != "nearcast.code_display.request" || request["version"].as_u64() != Some(1) {
        return Err("Invalid code-display request".into());
    }
    for (key, limit) in [("deviceId", 128), ("requestId", 128), ("reason", 64)] {
        let value = request[key].as_str().ok_or("Invalid code-display request field")?;
        if value.trim().is_empty() || value.len() > limit { return Err("Invalid code-display request field".into()); }
    }
    if serde_json::to_vec(request).map_err(|_| "Invalid code-display request")?.len() > 1024 { return Err("Code-display request too large".into()); }
    Ok(parsed)
}

fn project_response(bytes: &[u8], request_id: &str) -> Result<Value, String> {
    if bytes.len() > 4096 { return Err("Code-display response too large".into()); }
    let value: Value = serde_json::from_slice(bytes).map_err(|_| "Invalid code-display response")?;
    if value["type"] != "nearcast.code_display.result" || value["version"].as_u64() != Some(1) || value["requestId"].as_str() != Some(request_id) || !matches!(value["status"].as_str(), Some("shown" | "unavailable" | "rate_limited" | "not_supported")) {
        return Err("Invalid code-display response".into());
    }
    Ok(json!({"type":"nearcast.code_display.result","version":1,"requestId":request_id,"status":value["status"]}))
}

pub fn post(url: &str, request: &Value, pin: &str) -> Result<Value, String> {
    let parsed = validate_request(url, request)?;
    let body = serde_json::to_vec(request).map_err(|_| "Invalid code-display request")?;
    let response = crate::pinned_tls::post(&parsed, &body, pin)?;
    project_response(&response, request["requestId"].as_str().unwrap())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn request_enforces_fixed_https_route_and_receiver_contract() {
        let request = json!({"type":"nearcast.code_display.request","version":1,"deviceId":"board","requestId":"req-1","reason":"sender-device-selected"});
        assert!(validate_request("https://board.local:8443/nearcast/code-display", &request).is_ok());
        for url in ["http://board.local/nearcast/code-display", "https://board.local/other", "https://user:pass@board.local/nearcast/code-display", "https://board.local/nearcast/code-display?pairCode=1234"] {
            assert!(validate_request(url, &request).is_err());
        }
        for (key, value) in [("deviceId", json!("")), ("reason", json!("中".repeat(22))), ("version", json!(2)), ("pairCode", json!("1234"))] {
            let mut invalid = request.clone(); invalid[key] = value;
            assert!(validate_request("https://board.local/nearcast/code-display", &invalid).is_err());
        }
    }

    #[test]
    fn response_correlates_request_and_projects_only_public_status() {
        let response = br#"{"type":"nearcast.code_display.result","version":1,"requestId":"req-1","status":"shown","pairCode":"private"}"#;
        assert_eq!(project_response(response, "req-1").unwrap(), json!({"type":"nearcast.code_display.result","version":1,"requestId":"req-1","status":"shown"}));
        assert!(project_response(response, "other-request").is_err());
        for status in ["shown", "unavailable", "rate_limited", "not_supported"] {
            let response = serde_json::to_vec(&json!({"type":"nearcast.code_display.result","version":1,"requestId":"req-1","status":status})).unwrap();
            assert_eq!(project_response(&response, "req-1").unwrap()["status"], status);
        }
        assert!(project_response(&vec![b' ';4097], "req-1").is_err());
    }
}
