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
#[derive(Debug,Default,Deserialize,Serialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
pub struct ScrollTotals {
    samples:u64,positive_x:u64,negative_x:u64,positive_y:u64,negative_y:u64,
}
#[derive(Debug,Deserialize,Serialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
pub struct ScrollStages {received:ScrollTotals,submitted:ScrollTotals}
#[derive(Deserialize,Serialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
pub struct ScrollMetrics {
    scope_started_at:u64,streams:u64,touch_received:u64,touch_submitted:u64,
    wheel_bridge_ms:f64,wheel_native_ms:f64,wheel_max_bridge_ms:f64,wheel_max_native_ms:f64,
    detent120:ScrollStages,
    #[serde(rename="regionQ16_16")]
    region_q16_16:ScrollStages,
    #[serde(default,skip_serializing_if="Option::is_none")]
    native_wheel:Option<crate::wheel_diagnostics::WheelTotals>,
}
impl ScrollMetrics {
    fn valid(&self)->bool{[self.wheel_bridge_ms,self.wheel_native_ms,self.wheel_max_bridge_ms,self.wheel_max_native_ms]
        .iter().all(|n|n.is_finite()&&*n>=0.0&&*n<=1e12)}
}
#[derive(Deserialize,Serialize)]
#[serde(rename_all="lowercase")]
enum QualityReason {None,Cpu,Bandwidth,Other}
#[derive(Deserialize,Serialize)]
#[serde(rename_all="lowercase")]
enum VideoCodec {H264,Vp8,Vp9,Av1,H265,Unknown}
#[derive(Deserialize,Serialize)]
#[serde(rename_all="lowercase")]
enum CaptureSurface {Monitor,Window,Browser,Unknown}
#[derive(Deserialize,Serialize)]
#[serde(rename_all="lowercase")]
enum TrackState {Live,Ended}
#[derive(Deserialize,Serialize)]
#[serde(rename_all="lowercase")]
enum PageVisibility {Visible,Hidden}
#[derive(Deserialize,Serialize,Default)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
pub struct VideoMetrics {
    frame_width:Option<f64>,frame_height:Option<f64>,source_width:Option<f64>,source_height:Option<f64>,
    source_frames:Option<f64>,source_frames_per_second:Option<f64>,source_interval_fps:Option<f64>,
    interval_ms:Option<f64>,encoded_interval_fps:Option<f64>,sent_interval_fps:Option<f64>,encode_ms_per_frame:Option<f64>,
    send_kbps:Option<f64>,bytes_sent:Option<f64>,target_bitrate:Option<f64>,available_outgoing_bitrate:Option<f64>,
    round_trip_time_ms:Option<f64>,fraction_lost:Option<f64>,retransmitted_packets_sent:Option<f64>,nack_count:Option<f64>,pli_count:Option<f64>,
    total_encode_time:Option<f64>,quality_cpu_seconds:Option<f64>,quality_bandwidth_seconds:Option<f64>,
    quality_none_seconds:Option<f64>,quality_other_seconds:Option<f64>,
    capture_width:Option<f64>,capture_height:Option<f64>,capture_frame_rate:Option<f64>,window_sampled_at:Option<f64>,
    packets_lost:Option<i64>,quality_limitation_reason:Option<QualityReason>,codec:Option<VideoCodec>,
    power_efficient_encoder:Option<bool>,capture_surface:Option<CaptureSurface>,capture_track_state:Option<TrackState>,
    capture_muted:Option<bool>,page_visibility:Option<PageVisibility>,window_minimized:Option<bool>,window_visible:Option<bool>,
}
impl VideoMetrics {
    fn valid(&self)->bool {
        [self.frame_width,self.frame_height,self.source_width,self.source_height,self.source_frames,self.source_frames_per_second,
            self.source_interval_fps,self.interval_ms,self.encoded_interval_fps,self.sent_interval_fps,self.encode_ms_per_frame,
            self.send_kbps,self.bytes_sent,self.target_bitrate,self.available_outgoing_bitrate,self.round_trip_time_ms,self.fraction_lost,
            self.retransmitted_packets_sent,self.nack_count,self.pli_count,self.total_encode_time,self.quality_cpu_seconds,
            self.quality_bandwidth_seconds,self.quality_none_seconds,self.quality_other_seconds,self.capture_width,self.capture_height,
            self.capture_frame_rate,self.window_sampled_at].into_iter().flatten().all(|n|n.is_finite()&&(0.0..=1e15).contains(&n))
    }
}
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Sample {
    event: Event,
    status: Status,
    #[serde(default)]
    metrics: Metrics,
    #[serde(default,skip_serializing_if="Option::is_none")]
    scroll:Option<ScrollMetrics>,
    #[serde(default,skip_serializing_if="Option::is_none")]
    video:Option<VideoMetrics>,
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
        if sample.scroll.as_ref().is_some_and(|s|!s.valid()){return Err("Invalid scroll diagnostic timing".into());}
        if sample.video.as_ref().is_some_and(|v|!v.valid()){return Err("Invalid video diagnostic counters".into());}
        let fps = sample.metrics.frames_per_second;
        if fps.is_some_and(|value| !value.is_finite() || !(0.0..=1000.0).contains(&value)) {
            return Err("Invalid diagnostic frame rate".into());
        }
        let mut row = serde_json::to_vec(&serde_json::json!({"timestampMs":now(),"processId":std::process::id(),"sample":sample}))
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
        scroll:None,
        video:None,
    })
}
// Only bounded enums and numerical counters are accepted. Never serialize
// pairing codes, SDP/ICE, keys, window titles, raw errors or capture content.
pub fn record(mut sample: Sample) -> Result<(), String> {
    #[cfg(windows)]
    if let Some(scroll)=sample.scroll.as_mut(){scroll.native_wheel=Some(crate::wheel_diagnostics::snapshot());}
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
        scroll:None,
        video:None,
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
        "platform":std::env::consts::OS,"arch":std::env::consts::ARCH,"processId":std::process::id(),"videoBackend":"browser","events":rows});
    let bytes = serde_json::to_vec(&report).map_err(|e| e.to_string())?;
    fs::write(&path, bytes).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().into_owned())
}
pub fn feedback_report() -> Result<Vec<u8>, String> {
    let guard = STORE.lock().map_err(|_| "diagnostics lock poisoned")?;
    let rows = guard
        .as_ref()
        .ok_or("Diagnostics not initialized")?
        .collect()?;
    serde_json::to_vec(&serde_json::json!({"schemaVersion":1,"product":"NearHub Cast","version":format!("{}.{}",env!("NEARCAST_LOGICAL_VERSION"),env!("NEARCAST_BUILD_NUMBER")),
        "platform":std::env::consts::OS,"arch":std::env::consts::ARCH,"processId":std::process::id(),"videoBackend":"browser","events":rows})).map_err(|e|e.to_string())
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
            scroll:None,
            video:None,
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
    #[test]
    fn scroll_diagnostic_shape_matches_frontend_and_persists_totals(){
        let bucket=serde_json::json!({"samples":2,"positiveX":0,"negativeX":0,"positiveY":120,"negativeY":240});
        let value=serde_json::json!({"event":"media","status":"sharing","metrics":{},"scroll":{
            "scopeStartedAt":123,"streams":1,"touchReceived":0,"touchSubmitted":0,"wheelBridgeMs":12.0,"wheelNativeMs":2.0,
            "wheelMaxBridgeMs":12.0,"wheelMaxNativeMs":2.0,"detent120":{"received":bucket,"submitted":bucket},
            "regionQ16_16":{"received":bucket,"submitted":bucket}}});
        let sample:Sample=serde_json::from_value(value.clone()).unwrap();
        let dir=tempfile::tempdir().unwrap();let store=Store{directory:dir.path().to_owned()};store.append(&sample).unwrap();
        assert_eq!(store.collect().unwrap()[0]["sample"]["scroll"]["detent120"]["submitted"]["negativeY"],240);
        let mut bad=value;bad["scroll"]["windowTitle"]=serde_json::json!("private");assert!(serde_json::from_value::<Sample>(bad).is_err());
    }
    #[test]
    fn video_diagnostics_persist_only_bounded_counters_and_enums(){
        let value=serde_json::json!({"event":"media","status":"sharing","video":{
            "captureWidth":1920,"captureHeight":1080,"captureFrameRate":60,"sourceIntervalFps":30,"encodedIntervalFps":7,
            "encodeMsPerFrame":100,"qualityLimitationReason":"cpu","codec":"h264","packetsLost":-1,
            "powerEfficientEncoder":false,"windowMinimized":true,"windowVisible":true,"pageVisibility":"hidden"}});
        let sample:Sample=serde_json::from_value(value.clone()).unwrap();
        let dir=tempfile::tempdir().unwrap();let store=Store{directory:dir.path().to_owned()};store.append(&sample).unwrap();
        assert_eq!(store.collect().unwrap()[0]["sample"]["video"]["qualityLimitationReason"],"cpu");
        let mut bad=value.clone();bad["video"]["candidateAddress"]=serde_json::json!("private");assert!(serde_json::from_value::<Sample>(bad).is_err());
        let mut bad=value;bad["video"]["qualityLimitationReason"]=serde_json::json!("unbounded");assert!(serde_json::from_value::<Sample>(bad).is_err());
        let bad=Sample{video:Some(VideoMetrics{send_kbps:Some(-1.0),..Default::default()}),..sample};assert!(store.append(&bad).is_err());
    }
}
