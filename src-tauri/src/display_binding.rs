use crate::input_geometry::{self, Display, Geometry};
use serde::Serialize;
use std::{
    sync::Mutex,
    time::{Duration, Instant},
};
#[cfg(windows)]
mod marker;
static ACTIVE: Mutex<Registry> = Mutex::new(Registry {
    challenge: None,
    binding: None,
});
struct Registry {
    challenge: Option<Challenge>,
    binding: Option<Binding>,
}
struct Challenge {
    id: String,
    source_id: String,
    geometry: Geometry,
    displays: Vec<MarkedDisplay>,
    started: Instant,
    #[cfg(windows)]
    overlay: marker::Overlay,
}
#[derive(Clone, Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct MarkedDisplay {
    #[serde(flatten)]
    display: Display,
    token: String,
}
#[derive(Clone)]
pub struct Binding {
    retired: bool,
    pub source_id: String,
    pub binding_id: String,
    pub native_id: String,
    pub layout_revision: String,
    pub revision: String,
    pub display: Display,
}
// Flattening Display would duplicate nativeId. Use explicit serialization at
// the command boundary below and keep the actual monitor identity private.
fn view(binding: &Binding) -> serde_json::Value {
    serde_json::json!({"sourceId":binding.source_id,"bindingId":binding.binding_id,"nativeId":binding.native_id,
        "layoutRevision":binding.layout_revision,"revision":binding.revision,
        "region":binding.display.region,"units":binding.display.units,"rotation":binding.display.rotation,
        "captureWidth":binding.display.capture_width,"captureHeight":binding.display.capture_height,"kind":"monitor"})
}
fn nonce() -> Result<String, String> {
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).map_err(|e| e.to_string())?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}
fn source(value: &str) -> Result<(), String> {
    if value.len() != 36 || !value.bytes().all(|b| b.is_ascii_hexdigit() || b == b'-') {
        Err("Invalid browser source ID".into())
    } else {
        Ok(())
    }
}
fn finish(challenge: Challenge) {
    #[cfg(windows)]
    challenge.overlay.stop();
    #[cfg(not(windows))]
    let _ = challenge;
}
pub fn begin(source_id: String) -> Result<serde_json::Value, String> {
    source(&source_id)?;
    let mut active = ACTIVE.lock().map_err(|_| "display_binding_poisoned")?;
    if let Some(old) = active.challenge.take() {
        finish(old);
    }
    if active.binding.is_some() {
        return Err("Previous display binding must be released".into());
    }
    let geometry = input_geometry::snapshot()?;
    if geometry.displays.is_empty() || geometry.displays.len() > 16 {
        return Err("Unsupported display count".into());
    }
    let displays: Vec<_> = geometry
        .displays
        .iter()
        .filter(|d| d.rotation == 0 && d.capture_width >= 320 && d.capture_height >= 240)
        .map(|display| {
            Ok(MarkedDisplay {
                display: display.clone(),
                token: nonce()?[..16].to_string(),
            })
        })
        .collect::<Result<_, String>>()?;
    if displays.is_empty() {
        return Err("No unrotated display available".into());
    }
    #[cfg(not(windows))]
    return Err("Display marker binding is only available on Windows".into());
    #[cfg(windows)]
    {
        let overlay = marker::Overlay::start(&displays)?;
        let id = nonce()?;
        let result = serde_json::json!({"challengeId":id,"timeoutMs":5000,"displays":displays});
        active.challenge = Some(Challenge {
            id,
            source_id,
            geometry,
            displays,
            started: Instant::now(),
            overlay,
        });
        Ok(result)
    }
}
pub fn confirm(
    source_id: String,
    challenge_id: String,
    token: String,
    corners: Vec<u8>,
    frame_width: u32,
    frame_height: u32,
) -> Result<serde_json::Value, String> {
    let mut active = ACTIVE.lock().map_err(|_| "display_binding_poisoned")?;
    let challenge = active
        .challenge
        .as_ref()
        .ok_or("Display challenge expired")?;
    if challenge.source_id != source_id
        || challenge.id != challenge_id
        || challenge.started.elapsed() > Duration::from_secs(5)
        || corners != [0, 1, 2, 3]
    {
        return Err("Invalid or expired display observation".into());
    }
    let display = challenge
        .displays
        .iter()
        .find(|d| d.token == token)
        .ok_or("Unknown display token")?
        .display
        .clone();
    validate_frame(&display, frame_width, frame_height)?;
    let latest = input_geometry::snapshot()?;
    if latest.revision != challenge.geometry.revision {
        return Err("Display layout changed during calibration".into());
    }
    let binding_id = nonce()?;
    let binding = Binding {
        retired: false,
        source_id,
        native_id: format!("screen-binding:{binding_id}"),
        revision: format!("{}:{binding_id}", latest.revision),
        binding_id,
        layout_revision: latest.revision,
        display,
    };
    if let Some(challenge) = active.challenge.take() {
        finish(challenge);
    }
    let result = view(&binding);
    active.binding = Some(binding);
    Ok(result)
}
fn validate_frame(display: &Display, width: u32, height: u32) -> Result<(), String> {
    if width == 0
        || height == 0
        || width > 16384
        || height > 16384
        || ((width as i64 * display.capture_height as i64)
            - (height as i64 * display.capture_width as i64))
            .abs()
            > 2 * display.capture_width.max(display.capture_height) as i64
    {
        Err("Captured frame does not match full display aspect ratio".into())
    } else {
        Ok(())
    }
}
pub fn cancel(source_id: String, challenge_id: String) -> Result<(), String> {
    let mut active = ACTIVE.lock().map_err(|_| "display_binding_poisoned")?;
    if active
        .challenge
        .as_ref()
        .is_some_and(|c| c.source_id == source_id && c.id == challenge_id)
    {
        finish(active.challenge.take().unwrap());
    }
    Ok(())
}
pub fn release(source_id: String) -> Result<(), String> {
    let native_id = {
        let mut active = ACTIVE.lock().map_err(|_| "display_binding_poisoned")?;
        if active
            .challenge
            .as_ref()
            .is_some_and(|c| c.source_id == source_id)
        {
            finish(active.challenge.take().unwrap());
        }
        if active
            .binding
            .as_ref()
            .is_some_and(|b| b.source_id == source_id)
        {
            active.binding.as_mut().map(|b| {
                b.retired = true;
                b.native_id.clone()
            })
        } else {
            None
        }
    };
    if let Some(id) = native_id {
        crate::input_native::release_binding(&id)?;
        let mut active = ACTIVE.lock().map_err(|_| "display_binding_poisoned")?;
        if active.binding.as_ref().is_some_and(|b| b.native_id == id) {
            active.binding = None;
        }
    }
    Ok(())
}
pub fn current(native_id: &str, revision: &str, geometry: &Geometry) -> Result<Display, String> {
    let active = ACTIVE.lock().map_err(|_| "display_binding_poisoned")?;
    let binding = active
        .binding
        .as_ref()
        .filter(|b| !b.retired && b.native_id == native_id && b.revision == revision)
        .ok_or("Browser display binding retired")?;
    if geometry.revision != binding.layout_revision
        || !geometry
            .displays
            .iter()
            .any(|d| d.native_id == binding.display.native_id)
    {
        return Err("Browser display layout changed".into());
    }
    let mut display = binding.display.clone();
    display.native_id = native_id.to_owned();
    Ok(display)
}
pub fn snapshot() -> Option<serde_json::Value> {
    ACTIVE
        .lock()
        .ok()
        .and_then(|active| active.binding.as_ref().filter(|b| !b.retired).map(view))
}
pub fn shutdown() {
    if let Ok(mut active) = ACTIVE.lock() {
        if let Some(challenge) = active.challenge.take() {
            finish(challenge);
        }
        active.binding = None;
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn validates_capture_aspect_and_coordinates_without_primary_assumption() {
        let display = Display {
            native_id: "secondary".into(),
            primary: false,
            units: "physical-pixels".into(),
            rotation: 0,
            region: input_geometry::Region {
                x: -1920.0,
                y: 0.0,
                width: 1920.0,
                height: 1080.0,
            },
            capture_width: 1920,
            capture_height: 1080,
        };
        validate_frame(&display, 1280, 720).unwrap();
        assert!(validate_frame(&display, 1280, 800).is_err());
        assert!(validate_frame(&display, 0, 0).is_err());
        assert!(display.contains(-1.0, 1079.0));
        assert!(!display.contains(0.0, 1079.0));
    }
    #[test]
    #[cfg(windows)]
    #[ignore = "briefly displays only owned calibration markers; samples their cell centers, no input injection"]
    fn actual_markers_match_physical_displays_bind_secondary_and_expire() {
        let id = "f6de1fe0-94d9-4bc1-95b7-fcbfa11e7581".to_string();
        let challenge = begin(id.clone()).unwrap();
        let challenge_id = challenge["challengeId"].as_str().unwrap().to_owned();
        let displays: Vec<MarkedDisplay> =
            serde_json::from_value(challenge["displays"].clone()).unwrap();
        marker::verify_visible(&displays).unwrap();
        let selected = displays
            .iter()
            .find(|d| !d.display.primary)
            .unwrap_or(&displays[0]);
        let binding = confirm(
            id.clone(),
            challenge_id,
            selected.token.clone(),
            vec![0, 1, 2, 3],
            selected.display.capture_width,
            selected.display.capture_height,
        )
        .unwrap();
        let geometry = input_geometry::snapshot().unwrap();
        let resolved = current(
            binding["nativeId"].as_str().unwrap(),
            binding["revision"].as_str().unwrap(),
            &geometry,
        )
        .unwrap();
        assert_eq!(resolved.region.x, selected.display.region.x);
        release("old-source".into()).unwrap();
        assert!(snapshot().is_some());
        release(id).unwrap();
        assert!(snapshot().is_none());
        assert!(current(
            binding["nativeId"].as_str().unwrap(),
            binding["revision"].as_str().unwrap(),
            &geometry
        )
        .is_err());
    }
}
