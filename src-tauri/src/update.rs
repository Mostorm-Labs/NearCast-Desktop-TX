use base64::{engine::general_purpose::STANDARD, Engine};
use minisign_verify::{PublicKey, Signature};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::{Read, Write},
    path::PathBuf,
    time::Duration,
};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_updater::UpdaterExt;
use tokio::sync::Mutex;

const KEY: &str = include_str!("../update.pub");
const META_LIMIT: usize = 2 * 1024 * 1024;
const PACKAGE_LIMIT: u64 = 512 * 1024 * 1024;
const BASE: &str = "https://mosapi.auditoryworks.co/v1/updates/product/";
// Fixed at build time: production clients cannot be switched by an IPC URL.
const CHANNEL: &str = env!("NEARCAST_UPDATE_CHANNEL");

#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub struct Version(pub [u64; 4]);
impl Version {
    pub fn parse(text: &str) -> Result<Self, String> {
        let text = text.trim().strip_prefix('v').unwrap_or(text.trim());
        let parts: Vec<_> = text.split('.').collect();
        if !(3..=4).contains(&parts.len()) {
            return Err("Invalid TX version".into());
        }
        let mut values = [0; 4];
        for (i, part) in parts.iter().enumerate() {
            if part.is_empty()
                || !part.bytes().all(|c| c.is_ascii_digit())
                || part.len() > 1 && part.starts_with('0')
            {
                return Err("Invalid TX version".into());
            }
            values[i] = part.parse().map_err(|_| "TX version component overflow")?;
        }
        Ok(Self(values))
    }
    fn text(self) -> String {
        let v = self.0;
        format!("{}.{}.{}.{}", v[0], v[1], v[2], v[3])
    }
    fn semver(self) -> String {
        let v = self.0;
        format!("{}.{}.{}+{}", v[0], v[1], v[2], v[3])
    }
}

fn current() -> Version {
    Version::parse(&format!(
        "{}.{}",
        env!("NEARCAST_LOGICAL_VERSION"),
        env!("NEARCAST_BUILD_NUMBER")
    ))
    .expect("validated build version")
}
fn platform() -> &'static str {
    if cfg!(windows) {
        "windows"
    } else if cfg!(target_os = "macos") {
        "macos"
    } else {
        "unsupported"
    }
}
fn arch() -> &'static str {
    std::env::consts::ARCH
}
fn slug(os: &str) -> Result<&'static str, String> {
    match os {
        "windows" => Ok("nearcast-tx-windows"),
        "macos" => Ok("nearcast-tx-macos"),
        _ => Err("TX updates only support Windows and macOS".into()),
    }
}
fn format() -> &'static str {
    if cfg!(windows) {
        match tauri::utils::platform::bundle_type() {
            Some(tauri::utils::config::BundleType::Msi) => "msi",
            _ => "nsis",
        }
    } else {
        "app"
    }
}
fn attrs(v: &Value) -> &Value {
    v.get("attributes").unwrap_or(v)
}
fn list(v: &Value) -> Vec<&Value> {
    if let Some(a) = v.as_array() {
        a.iter().collect()
    } else if let Some(a) = v.get("data").or_else(|| v.get("updates")) {
        list(a)
    } else {
        Vec::new()
    }
}
fn string(v: &Value, key: &str) -> String {
    v.get(key).and_then(Value::as_str).unwrap_or("").to_owned()
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct FileRef {
    name: String,
    url: String,
}
fn file_ref(v: &Value) -> Option<FileRef> {
    let v = attrs(v);
    let v = attrs(
        v.get("file")
            .and_then(|f| f.get("data"))
            .or_else(|| v.get("file"))
            .unwrap_or(v),
    );
    let url = string(v, "url");
    let name = string(v, "name");
    if name.is_empty() || https(&url).is_err() {
        None
    } else {
        Some(FileRef { name, url })
    }
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Asset {
    platform: String,
    arch: String,
    format: String,
    name: String,
    url: String,
    size: u64,
    sha256: String,
    signature: String,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Manifest {
    schema_version: u32,
    version: String,
    logical_version: String,
    build: u64,
    platform: String,
    product_slug: String,
    channel: String,
    notes: String,
    assets: Vec<Asset>,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Candidate {
    manifest: Manifest,
    // Keep the exact signed bytes, rather than reserializing JSON for verification.
    manifest_text: String,
    manifest_signature: String,
    asset: Asset,
}
#[derive(Default)]
pub struct State {
    pub inner: Mutex<Runtime>,
}
#[derive(Default)]
pub struct Runtime {
    candidate: Option<Candidate>,
    ready: bool,
}

fn https(text: &str) -> Result<tauri::Url, String> {
    let url = tauri::Url::parse(text).map_err(|_| "Invalid update URL")?;
    if url.scheme() != "https"
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err("Updates require HTTPS".into());
    }
    Ok(url)
}
fn client() -> Result<reqwest::Client, String> {
    let _ = rustls::crypto::ring::default_provider().install_default();
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(120))
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            if attempt.previous().len() >= 5 || attempt.url().scheme() != "https" {
                attempt.stop()
            } else {
                attempt.follow()
            }
        }))
        .build()
        .map_err(|e| e.to_string())
}
async fn metadata(client: &reqwest::Client, url: &str, limit: usize) -> Result<Vec<u8>, String> {
    https(url)?;
    let mut response = client
        .get(url)
        .timeout(Duration::from_secs(20))
        .send()
        .await
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?;
    if response.content_length().is_some_and(|n| n > limit as u64) {
        return Err("Update metadata too large".into());
    }
    let mut result = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|e| e.to_string())? {
        if result.len() + chunk.len() > limit {
            return Err("Update metadata too large".into());
        }
        result.extend_from_slice(&chunk);
    }
    Ok(result)
}
fn decode(text: &str) -> Result<String, String> {
    String::from_utf8(STANDARD.decode(text.trim()).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())
}
fn verify(bytes: &[u8], signature: &str) -> Result<(), String> {
    let key = PublicKey::decode(&decode(KEY)?).map_err(|e| e.to_string())?;
    let signature = Signature::decode(&decode(signature)?).map_err(|e| e.to_string())?;
    key.verify(bytes, &signature, true)
        .map_err(|e| format!("Update signature rejected: {e}"))
}
fn validate_manifest(
    text: &str,
    signature: &str,
    expected: Version,
    os: &str,
    cpu: &str,
    installer: &str,
) -> Result<(Manifest, Asset), String> {
    verify(text.as_bytes(), signature)?;
    let manifest: Manifest = serde_json::from_str(text).map_err(|e| e.to_string())?;
    let v = Version::parse(&manifest.version)?;
    if manifest.schema_version != 1
        || v != expected
        || manifest.build != v.0[3]
        || manifest.logical_version != format!("{}.{}.{}", v.0[0], v.0[1], v.0[2])
        || manifest.platform != os
        || manifest.product_slug != slug(os)?
        || manifest.channel != CHANNEL
    {
        return Err("Signed update manifest does not match product/version/channel".into());
    }
    let asset = manifest
        .assets
        .iter()
        .find(|a| a.platform == os && a.arch == cpu && a.format == installer)
        .cloned()
        .ok_or("No matching update for this architecture and installation format")?;
    let suffix = match installer {
        "nsis" => "-setup.exe",
        "msi" => ".msi",
        "app" => ".app.tar.gz",
        _ => return Err("Unsupported updater format".into()),
    };
    if !asset.name.ends_with(suffix)
        || asset.name.contains(['/', '\\', ':'])
        || !asset.name.contains(&v.text())
        || asset.size == 0
        || asset.size > PACKAGE_LIMIT
        || asset.sha256.len() != 64
        || !asset.sha256.bytes().all(|c| c.is_ascii_hexdigit())
        || asset.signature.len() > 16384
    {
        return Err("Invalid signed update asset".into());
    }
    https(&asset.url)?;
    Ok((manifest, asset))
}
fn cache(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_cache_dir()
        .map(|p| p.join("updates-v1"))
        .map_err(|e| e.to_string())
}
fn view(runtime: &Runtime) -> Value {
    json!({"status":if runtime.ready{"ready"}else if runtime.candidate.is_some(){"available"}else{"current"},
        "currentVersion":current().text(),"channel":CHANNEL,"update":runtime.candidate.as_ref().map(|c|json!({"version":c.manifest.version,"notes":c.manifest.notes,"size":c.asset.size}))})
}
fn verify_package(candidate: &Candidate, bytes: &[u8]) -> Result<(), String> {
    if bytes.len() as u64 != candidate.asset.size
        || format!("{:x}", Sha256::digest(bytes)) != candidate.asset.sha256.to_lowercase()
    {
        return Err("Update package hash/length mismatch".into());
    }
    verify(bytes, &candidate.asset.signature)
}
fn read_package(root: &std::path::Path, candidate: &Candidate) -> Result<Vec<u8>, String> {
    let mut file = fs::File::open(root.join("package.bin")).map_err(|e| e.to_string())?;
    if file.metadata().map_err(|e| e.to_string())?.len() != candidate.asset.size {
        return Err("Update cache has changed".into());
    }
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes).map_err(|e| e.to_string())?;
    verify_package(candidate, &bytes)?;
    Ok(bytes)
}
fn atomic_write(root: &std::path::Path, name: &str, bytes: &[u8]) -> Result<(), String> {
    fs::create_dir_all(root).map_err(|e| e.to_string())?;
    let mut file = tempfile::NamedTempFile::new_in(root).map_err(|e| e.to_string())?;
    file.write_all(bytes)
        .and_then(|_| file.as_file().sync_all())
        .map_err(|e| e.to_string())?;
    file.persist(root.join(name)).map_err(|e| e.to_string())?;
    Ok(())
}
pub async fn initialize(app: AppHandle, state: &State) -> Result<Value, String> {
    let mut runtime = state.inner.lock().await;
    let root = cache(&app)?;
    let path = root.join("candidate.json");
    if let Ok(file) = fs::File::open(path) {
        let mut bytes = Vec::new();
        file.take(META_LIMIT as u64 + 1)
            .read_to_end(&mut bytes)
            .map_err(|e| e.to_string())?;
        if bytes.len() <= META_LIMIT {
            if let Ok(cached) = serde_json::from_slice::<Candidate>(&bytes) {
                if let Ok(v) = Version::parse(&cached.manifest.version) {
                    if v > current() {
                        if let Ok((manifest, mut asset)) = validate_manifest(
                            &cached.manifest_text,
                            &cached.manifest_signature,
                            v,
                            platform(),
                            arch(),
                            format(),
                        ) {
                            if https(&cached.asset.url).is_ok() {
                                asset.url = cached.asset.url.clone();
                            }
                            let candidate = Candidate {
                                manifest,
                                asset,
                                ..cached
                            };
                            runtime.ready = read_package(&root, &candidate).is_ok();
                            runtime.candidate = Some(candidate);
                        }
                    }
                }
            }
        }
    }
    Ok(view(&runtime))
}
async fn find_candidate(client: &reqwest::Client, os: &str, cpu: &str, installer: &str, after: Version) -> Result<Option<Candidate>, String> {
    let slug = slug(os)?;
    let mut url = tauri::Url::parse(&format!("{BASE}{slug}")).unwrap();
    url.query_pairs_mut().extend_pairs([
        ("fields[0]", "version"),
        ("fields[1]", "state"),
        ("fields[2]", "type"),
        ("populate[otaFiles][populate][0]", "file"),
        ("populate[descriptions][populate][0]", "*"),
        ("limit", "1000"),
        ("filters[state][$eq]", CHANNEL),
    ]);
    let payload: Value =
        serde_json::from_slice(&metadata(&client, url.as_str(), META_LIMIT).await?)
            .map_err(|e| e.to_string())?;
    let mut records: Vec<(Version, Vec<FileRef>)> = list(&payload)
        .iter()
        .filter_map(|row| {
            let row = attrs(row);
            let v = Version::parse(&string(row, "version")).ok()?;
            if string(row, "state") != CHANNEL || v <= after {
                return None;
            }
            let files = list(row.get("otaFiles")?)
                .iter()
                .filter_map(|f| file_ref(f))
                .collect();
            Some((v, files))
        })
        .collect();
    records.sort_by(|a, b| b.0.cmp(&a.0));
    let mut last_error = None;
    for (v, files) in records {
        let result = async {
            let name = format!("NearCast-Desktop-TX-{}-{os}-manifest.json", v.text());
            let file = files
                .iter()
                .find(|f| f.name == name)
                .ok_or("Update is missing a platform manifest")?;
            let sig = files
                .iter()
                .find(|f| f.name == format!("{name}.sig"))
                .ok_or("Update is missing a manifest signature")?;
            let text = String::from_utf8(metadata(&client, &file.url, META_LIMIT).await?)
                .map_err(|e| e.to_string())?;
            let signature = String::from_utf8(metadata(&client, &sig.url, 16384).await?)
                .map_err(|e| e.to_string())?;
            let (manifest, mut asset) =
                validate_manifest(&text, &signature, v, os, cpu, installer)?;
            // Mosapi rewrites storage URLs. Hash, size, filename and signature
            // stay bound by the signed manifest; only resolve the transport URL.
            asset.url = files
                .iter()
                .find(|f| f.name == asset.name)
                .ok_or("Update package is absent from otaFiles")?
                .url
                .clone();
            Ok::<_, String>(Candidate {
                manifest,
                asset,
                manifest_text: text,
                manifest_signature: signature,
            })
        }
        .await;
        match result {
            Ok(candidate) => return Ok(Some(candidate)),
            Err(e) => last_error = Some(e),
        }
    }
    if let Some(e) = last_error { return Err(e); }
    Ok(None)
}
pub async fn check(app: AppHandle, state: &State) -> Result<Value, String> {
    let mut runtime = state.inner.lock().await;
    if let Some(candidate) = find_candidate(&client()?, platform(), arch(), format(), current()).await? {
        let root = cache(&app)?;
        runtime.ready = read_package(&root, &candidate).is_ok();
        atomic_write(&root, "candidate.json", &serde_json::to_vec(&candidate).map_err(|e| e.to_string())?)?;
        runtime.candidate = Some(candidate);
    }
    // Keep a verified cached update usable while the network/feed has no entry.
    Ok(view(&runtime))
}
pub async fn download(app: AppHandle, state: &State) -> Result<Value, String> {
    let mut runtime = state.inner.lock().await;
    let candidate = runtime.candidate.clone().ok_or("No checked TX update")?;
    let root = cache(&app)?;
    if read_package(&root, &candidate).is_ok() {
        runtime.ready = true;
        return Ok(view(&runtime));
    }
    https(&candidate.asset.url)?;
    let mut response = client()?
        .get(&candidate.asset.url)
        .send()
        .await
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?;
    if response
        .content_length()
        .is_some_and(|n| n != candidate.asset.size)
    {
        return Err("Update Content-Length mismatch".into());
    }
    fs::create_dir_all(&root).map_err(|e| e.to_string())?;
    let mut temporary = tempfile::NamedTempFile::new_in(&root).map_err(|e| e.to_string())?;
    let mut received = 0u64;
    let mut last = std::time::Instant::now() - Duration::from_secs(1);
    while let Some(chunk) = response.chunk().await.map_err(|e| e.to_string())? {
        received += chunk.len() as u64;
        if received > candidate.asset.size || received > PACKAGE_LIMIT {
            return Err("Update exceeds signed size".into());
        }
        temporary.write_all(&chunk).map_err(|e| e.to_string())?;
        if last.elapsed() > Duration::from_millis(250) {
            let _ = app.emit(
                "nearcast://update-progress",
                json!({"received":received,"total":candidate.asset.size}),
            );
            last = std::time::Instant::now();
        }
    }
    temporary.as_file().sync_all().map_err(|e| e.to_string())?;
    let bytes = fs::read(temporary.path()).map_err(|e| e.to_string())?;
    verify_package(&candidate, &bytes)?;
    temporary
        .persist(root.join("package.bin"))
        .map_err(|e| e.to_string())?;
    atomic_write(
        &root,
        "candidate.json",
        &serde_json::to_vec(&candidate).map_err(|e| e.to_string())?,
    )?;
    runtime.ready = true;
    Ok(view(&runtime))
}
pub async fn install(app: AppHandle, state: &State) -> Result<Value, String> {
    let runtime = state.inner.lock().await;
    let cached = runtime.candidate.as_ref().ok_or("No checked TX update")?;
    let expected = Version::parse(&cached.manifest.version)?;
    if expected <= current() {
        return Err("TX update is not newer".into());
    }
    let (manifest, asset) = validate_manifest(
        &cached.manifest_text,
        &cached.manifest_signature,
        expected,
        platform(),
        arch(),
        format(),
    )?;
    let candidate = Candidate {
        manifest,
        asset,
        ..cached.clone()
    };
    let bytes = read_package(&cache(&app)?, &candidate)?;
    let updater = app
        .updater_builder()
        .pubkey(KEY.trim())
        .endpoints(vec![tauri::Url::parse(BASE).unwrap()])
        .map_err(|e| e.to_string())?
        // Mosapi + signed manifest have already compared the full version.
        .version_comparator(|_, _| true)
        .build()
        .map_err(|e| e.to_string())?;
    let update=updater.restore_update(json!({"version":expected.semver(),"url":candidate.asset.url,"signature":candidate.asset.signature,"notes":candidate.manifest.notes})).map_err(|e|e.to_string())?.ok_or("Update rejected")?;
    // This also binds the artifact signature's trusted version comment.
    update.verify(&bytes).map_err(|e| e.to_string())?;
    tauri::async_runtime::spawn_blocking(|| {
        crate::input_native::ensure_released_for_update()?;
        crate::display_binding::shutdown();
        #[cfg(windows)] crate::native_audio::shutdown();
        Ok::<_, String>(())
    })
    .await
    .map_err(|e| e.to_string())??;
    tauri::async_runtime::spawn_blocking(move || update.install(bytes))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())?;
    #[cfg(target_os = "macos")]
    app.restart();
    #[allow(unreachable_code)]
    Ok(json!({"status":"installing"}))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    #[ignore = "downloads signed Windows assets from public Mosapi without installing"]
    fn live_mosapi_signed_windows_update() {
        assert_eq!(std::env::var("NEARCAST_LIVE_UPDATE_TEST").as_deref(), Ok("1"));
        assert_eq!(CHANNEL, "alpha");
        tauri::async_runtime::block_on(async {
            let client = client().unwrap();
            for installer in ["nsis", "msi"] {
                let candidate = find_candidate(&client, "windows", "x86_64", installer, Version([0,0,0,0])).await.unwrap().expect("published Windows alpha update");
                let package = metadata(&client, &candidate.asset.url, PACKAGE_LIMIT as usize).await.unwrap();
                verify_package(&candidate, &package).unwrap();
                let root = tempfile::tempdir().unwrap();
                atomic_write(root.path(), "package.bin", &package).unwrap();
                read_package(root.path(), &candidate).unwrap();
                println!("Verified online {} {}: {} bytes", installer, candidate.manifest.version, package.len());
            }
        });
    }
    #[test]
    fn versions_compare_all_four_components() {
        assert!(Version::parse("0.1.0.12").unwrap() > Version::parse("0.1.0.9").unwrap());
        assert!(Version::parse("0.1.101.2").unwrap() > Version::parse("0.1.99.20").unwrap());
        assert!(Version::parse("1.0.0.1").unwrap() > Version::parse("0.99.99.999").unwrap());
        assert_eq!(Version::parse("v1.2.3.4").unwrap().semver(), "1.2.3+4");
        for bad in ["1.2", "1.2.3.bad", "1.2.3.4.5", "1.2.03.4", "1.2.-3.4"] {
            assert!(Version::parse(bad).is_err(), "{bad}");
        }
    }
    #[test]
    fn parses_real_mosapi_wrapping() {
        let payload = json!({"data":[{"attributes":{"version":"v1.2.3.4","state":"release","otaFiles":[{"file":{"data":{"attributes":{"url":"https://mostorage.auditoryworks.co/a.exe","name":"a.exe"}}}}]}}]});
        let row = attrs(list(&payload)[0]);
        let file = file_ref(list(&row["otaFiles"])[0]).unwrap();
        assert_eq!(file.name, "a.exe");
        assert_eq!(slug("windows").unwrap(), "nearcast-tx-windows");
        assert_eq!(slug("macos").unwrap(), "nearcast-tx-macos");
        assert!(slug("android").is_err());
    }
    #[test]
    fn rejects_unverified_metadata_and_insecure_urls() {
        assert!(validate_manifest(
            "{}",
            "bad",
            Version([1, 2, 3, 4]),
            "windows",
            "x86_64",
            "nsis"
        )
        .is_err());
        assert!(https("http://example.test/a").is_err());
        assert!(https("https://user:secret@example.test/a").is_err());
    }
    #[test]
    fn signed_manifest_binds_product_architecture_version_and_package() {
        let text = include_str!("../../tests/fixtures/update/manifest.json");
        let signature = include_str!("../../tests/fixtures/update/manifest.json.sig");
        let (manifest, asset) = validate_manifest(
            text,
            signature,
            Version([0, 2, 0, 37]),
            "windows",
            "x86_64",
            "nsis",
        )
        .unwrap();
        let candidate = Candidate {
            manifest,
            asset,
            manifest_text: text.into(),
            manifest_signature: signature.into(),
        };
        let package = include_bytes!("../../tests/fixtures/update/package.bin");
        verify_package(&candidate, package).unwrap();
        assert!(validate_manifest(
            text,
            signature,
            Version([0, 2, 0, 38]),
            "windows",
            "x86_64",
            "nsis"
        )
        .is_err());
        assert!(validate_manifest(
            text,
            signature,
            Version([0, 2, 0, 37]),
            "macos",
            "aarch64",
            "app"
        )
        .is_err());
        assert!(validate_manifest(
            text,
            signature,
            Version([0, 2, 0, 37]),
            "windows",
            "aarch64",
            "nsis"
        )
        .is_err());
        assert!(validate_manifest(
            &text.replace("Fixture", "Modified"),
            signature,
            Version([0, 2, 0, 37]),
            "windows",
            "x86_64",
            "nsis"
        )
        .is_err());
        assert!(verify_package(&candidate, b"tampered cached installer").is_err());
        let root = tempfile::tempdir().unwrap();
        atomic_write(root.path(), "package.bin", package).unwrap();
        read_package(root.path(), &candidate).unwrap();
        fs::write(root.path().join("package.bin"), b"changed").unwrap();
        assert!(read_package(root.path(), &candidate).is_err());
    }
}
