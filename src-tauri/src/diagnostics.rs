use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Manager};

const MAX_FILE_BYTES: u64 = 1024 * 1024;
const MAX_EXPORTS: usize = 5;
static STORE: Mutex<Option<Store>> = Mutex::new(None);
struct Store {
    directory: PathBuf,
}
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Event {
    Startup,
    Session,
    Media,
    FrontendError,
    Shutdown,
}
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Status {
    Idle,
    Connecting,
    Joined,
    Connected,
    Sharing,
    Error,
    Stopped,
}
#[derive(Debug, Deserialize, Serialize, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Metrics {
    frames_encoded: Option<u64>,
    frames_sent: Option<u64>,
    frames_per_second: Option<f64>,
    input_received: Option<u64>,
    input_submitted: Option<u64>,
    input_failed: Option<u64>,
    audio_frames: Option<u64>,
}
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Sample {
    event: Event,
    status: Status,
    #[serde(default)]
    metrics: Metrics,
}
fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u64::MAX as u128) as u64
}
impl Store {
    fn append(&self, sample: &Sample) -> Result<(), String> {
        let fps = sample.metrics.frames_per_second;
        if fps.is_some_and(|value| !value.is_finite() || !(0.0..=1000.0).contains(&value)) {
            return Err("Invalid diagnostic frame rate".into());
        }
        let mut row = serde_json::to_vec(&serde_json::json!({"timestampMs":now(),"sample":sample}))
            .map_err(|e| e.to_string())?;
        row.push(b'\n');
        fs::create_dir_all(&self.directory).map_err(|e| e.to_string())?;
        let path = self.directory.join("current.jsonl");
        if fs::metadata(&path).is_ok_and(|m| m.len() + row.len() as u64 > MAX_FILE_BYTES) {
            let oldest = self.directory.join("previous-2.jsonl");
            if oldest.exists() {
                fs::remove_file(&oldest).map_err(|e| e.to_string())?;
            }
            let previous = self.directory.join("previous-1.jsonl");
            if previous.exists() {
                fs::rename(&previous, oldest).map_err(|e| e.to_string())?;
            }
            fs::rename(&path, previous).map_err(|e| e.to_string())?;
        }
        let mut file = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
            .map_err(|e| e.to_string())?;
        file.write_all(&row).map_err(|e| e.to_string())
    }
    fn collect(&self) -> Result<Vec<serde_json::Value>, String> {
        let mut rows = Vec::new();
        for name in ["previous-2.jsonl", "previous-1.jsonl", "current.jsonl"] {
            if let Ok(file) = fs::File::open(self.directory.join(name)) {
                let mut text = String::new();
                file.take(MAX_FILE_BYTES + 1024)
                    .read_to_string(&mut text)
                    .map_err(|e| e.to_string())?;
                for line in text.lines() {
                    if let Ok(value) = serde_json::from_str(line) {
                        rows.push(value);
                    }
                }
            }
        }
        Ok(rows)
    }
}
pub fn initialize(app: &AppHandle) -> Result<(), String> {
    let directory = app.path().app_log_dir().map_err(|e| e.to_string())?;
    *STORE.lock().map_err(|_| "diagnostics lock poisoned")? = Some(Store { directory });
    record(Sample {
        event: Event::Startup,
        status: Status::Idle,
        metrics: Metrics::default(),
    })
}
// Only bounded enums and numerical counters are accepted. Never serialize
// pairing codes, SDP/ICE, keys, window titles, raw errors or capture content.
pub fn record(sample: Sample) -> Result<(), String> {
    STORE
        .lock()
        .map_err(|_| "diagnostics lock poisoned")?
        .as_ref()
        .ok_or("Diagnostics not initialized")?
        .append(&sample)
}
pub fn shutdown() {
    let _ = record(Sample {
        event: Event::Shutdown,
        status: Status::Stopped,
        metrics: Metrics::default(),
    });
}
fn trim_exports(directory: &Path) -> Result<(), String> {
    let mut files: Vec<_> = fs::read_dir(directory)
        .map_err(|e| e.to_string())?
        .filter_map(Result::ok)
        .filter(|entry| {
            entry
                .file_name()
                .to_string_lossy()
                .starts_with("nearcast-diagnostics-")
                && entry.path().extension().is_some_and(|ext| ext == "json")
        })
        .map(|entry| entry.path())
        .collect();
    files.sort();
    let remove = files.len().saturating_sub(MAX_EXPORTS - 1);
    for path in files.into_iter().take(remove) {
        fs::remove_file(path).map_err(|e| e.to_string())?;
    }
    Ok(())
}
pub fn export(app: &AppHandle) -> Result<String, String> {
    let guard = STORE.lock().map_err(|_| "diagnostics lock poisoned")?;
    let store = guard.as_ref().ok_or("Diagnostics not initialized")?;
    let rows = store.collect()?;
    let directory = app
        .path()
        .app_log_dir()
        .map_err(|e| e.to_string())?
        .join("exports");
    fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
    trim_exports(&directory)?;
    let path = directory.join(format!("nearcast-diagnostics-{}.json", now()));
    let report = serde_json::json!({"schemaVersion":1,"version":format!("{}.{}",env!("NEARCAST_LOGICAL_VERSION"),env!("NEARCAST_BUILD_NUMBER")),
        "platform":std::env::consts::OS,"arch":std::env::consts::ARCH,"videoBackend":"browser","events":rows});
    let bytes = serde_json::to_vec(&report).map_err(|e| e.to_string())?;
    fs::write(&path, bytes).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().into_owned())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn bounded_rotation_and_export_preserve_valid_records() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store {
            directory: dir.path().to_owned(),
        };
        let sample = Sample {
            event: Event::Media,
            status: Status::Sharing,
            metrics: Metrics::default(),
        };
        store.append(&sample).unwrap();
        fs::write(
            dir.path().join("current.jsonl"),
            vec![b' '; MAX_FILE_BYTES as usize],
        )
        .unwrap();
        store.append(&sample).unwrap();
        assert!(dir.path().join("previous-1.jsonl").exists());
        assert_eq!(store.collect().unwrap().len(), 1);
        for n in 0..8 {
            fs::write(
                dir.path().join(format!("nearcast-diagnostics-{n}.json")),
                "{}",
            )
            .unwrap();
        }
        trim_exports(dir.path()).unwrap();
        assert_eq!(
            fs::read_dir(dir.path())
                .unwrap()
                .filter_map(Result::ok)
                .filter(|e| e.path().extension().is_some_and(|v| v == "json"))
                .count(),
            4
        );
    }
    #[test]
    fn diagnostics_reject_unknown_or_sensitive_fields() {
        assert!(serde_json::from_value::<Sample>(
            serde_json::json!({"event":"media","status":"sharing","pairCode":"1234"})
        )
        .is_err());
        assert!(serde_json::from_value::<Sample>(
            serde_json::json!({"event":"media","status":"sharing","metrics":{"sdp":"private"}})
        )
        .is_err());
    }
}
