// Product-owned local asset origin. Wry maps this registered scheme to
// http://cast.nearhub.localhost on Windows; there is no listening HTTP server.
pub const SCHEME: &str = "cast.nearhub";
#[derive(Default)]
pub struct LegacySettings(std::sync::Mutex<Option<String>>);

#[tauri::command]
pub fn nearcast_migrate_legacy_settings(window:tauri::WebviewWindow,preferences:Option<String>,state:tauri::State<'_,LegacySettings>)->Result<(),String>{
    let url=window.url().map_err(|e|e.to_string())?;
    if window.label()!="main"||url.as_str()!="http://tauri.localhost/settings-migration.html" {return Err("Invalid settings migration origin".into());}
    if let Some(value)=preferences {
        if value.len()>16384||!serde_json::from_str::<serde_json::Value>(&value).map(|v|v.is_object()).unwrap_or(false){return Err("Invalid legacy settings".into());}
        *state.0.lock().map_err(|_|"Settings migration lock failed")?=Some(value);
    }
    Ok(())
}

#[tauri::command]
pub fn nearcast_take_legacy_settings(window:tauri::WebviewWindow,state:tauri::State<'_,LegacySettings>)->Result<Option<String>,String>{
    let url=window.url().map_err(|e|e.to_string())?;
    if window.label()!="main"||url.origin().ascii_serialization()!="http://cast.nearhub.localhost" {return Err("Invalid settings destination".into());}
    Ok(state.0.lock().map_err(|_|"Settings migration lock failed")?.take())
}

pub fn response<R: tauri::Runtime>(
    context: tauri::UriSchemeContext<'_, R>,
    request: tauri::http::Request<Vec<u8>>,
) -> tauri::http::Response<Vec<u8>> {
    use tauri::http::{header, Method, Response, StatusCode};
    let fail = |status| Response::builder().status(status)
        .header(header::CONTENT_TYPE, "text/plain; charset=utf-8")
        .header("X-Content-Type-Options", "nosniff")
        .body(Vec::new()).unwrap();
    // Custom protocols are local IPC principals. Only serve our main window
    // and exact asset authority; do not turn this into an arbitrary proxy.
    if context.webview_label() != "main" || request.uri().host() != Some("localhost") ||
        request.uri().scheme_str() != Some(SCHEME) || request.uri().port_u16().is_some() {
        return fail(StatusCode::FORBIDDEN);
    }
    if request.method() != Method::GET && request.method() != Method::HEAD {
        return fail(StatusCode::METHOD_NOT_ALLOWED);
    }
    let path = request.uri().path().trim_start_matches('/');
    let path = if path.is_empty() { "index.html" } else { path };
    let Some(asset) = context.app_handle().asset_resolver().get_for_scheme(path.to_owned(), false) else {
        return fail(StatusCode::NOT_FOUND);
    };
    let mut builder = Response::builder().header(header::CONTENT_TYPE, asset.mime_type)
        .header(header::CACHE_CONTROL, "no-cache")
        .header("X-Content-Type-Options", "nosniff");
    if let Some(csp) = asset.csp_header { builder = builder.header(header::CONTENT_SECURITY_POLICY, csp); }
    builder.body(if request.method() == Method::HEAD { Vec::new() } else { asset.bytes }).unwrap()
}

pub fn register<R: tauri::Runtime>(builder: tauri::Builder<R>) -> tauri::Builder<R> {
    builder.manage(LegacySettings::default()).register_uri_scheme_protocol(SCHEME, response)
}

#[cfg(all(test, windows, feature = "webview-input-test"))]
mod tests;
