use crate::input_geometry::{self, Display};
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::Mutex;

struct Owner {
    id: String,
    source_binding_id: String,
    lease: String,
    revision: String,
    native_id: String,
    input_types: Vec<String>,
    max_contacts: u32,
    blocked: bool,
    mouse_buttons: u32,
    #[cfg(windows)]
    windows_mouse: crate::windows_mouse_model::State,
    possible_touch: Vec<TouchRecord>,
}
static OWNER: Mutex<Option<Owner>> = Mutex::new(None);
#[cfg(windows)]
static TOUCH_READY: Mutex<Option<bool>> = Mutex::new(None);

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct GestureFeedback {
    stage: String,
    x: f64,
    y: f64,
    progress: f64,
}
impl GestureFeedback {
    fn valid(&self, display: &Display) -> bool {
        [
            "holding",
            "armed",
            "dragging",
            "two-finger",
            "pinching",
            "scrolling",
            "right-wait",
            "right-ready",
            "released",
            "right-released",
        ]
        .contains(&self.stage.as_str())
            && self.progress.is_finite()
            && (0.0..=1.0).contains(&self.progress)
            && display.contains(self.x, self.y)
    }
}
pub fn feedback(owner_id: String, lease_id: String, feedback: Option<GestureFeedback>) -> Value {
    let mut guard = match OWNER.lock() {
        Ok(guard) => guard,
        Err(_) => return failure("rejected", "native_owner_lock_poisoned"),
    };
    let owner = match authorized(&mut guard, &owner_id, &lease_id) {
        Ok(owner) => owner,
        Err(error) => return failure("rejected", error),
    };
    if let Some(feedback) = feedback {
        let display = match input_geometry::current(&owner.revision, &owner.native_id) {
            Ok(display) => display,
            Err(error) => return failure("rejected", error),
        };
        if !feedback.valid(&display) {
            return failure("rejected", "invalid_gesture_feedback");
        }
        crate::gesture_halo::show(feedback.x, feedback.y, &feedback.stage, feedback.progress);
    } else {
        crate::gesture_halo::clear();
    }
    json!({"status":"displayed"})
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TouchRecord {
    pub contact_id: u32,
    pub phase: u8,
    pub x: i32,
    pub y: i32,
}
#[derive(Debug, Deserialize)]
#[serde(tag = "inputType", rename_all = "lowercase", deny_unknown_fields)]
pub enum Action {
    Zoom { steps: i32, x: f64, y: f64 },
    Touch { records: Vec<TouchRecord> },
    Mouse(MouseAction),
}
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MouseAction {
    event_kind: u8,
    buttons: Option<u32>,
    modifiers: Option<u16>,
    x: Option<f64>,
    y: Option<f64>,
    wheel_unit: Option<u8>,
    wheel_phase: Option<u8>,
    wheel_x: Option<i32>,
    wheel_y: Option<i32>,
}
impl MouseAction {
    fn valid_shape(&self) -> bool {
        let point = self.x.is_some() && self.y.is_some() && self.buttons.is_some();
        let no_point = self.x.is_none() && self.y.is_none() && self.buttons.is_none();
        let wheel = self.wheel_unit.is_some()
            && self.wheel_phase.is_some()
            && self.wheel_x.is_some()
            && self.wheel_y.is_some();
        let no_wheel = self.wheel_unit.is_none()
            && self.wheel_phase.is_none()
            && self.wheel_x.is_none()
            && self.wheel_y.is_none();
        match self.event_kind {
            0 | 1 => point && self.modifiers.is_some() && no_wheel,
            2 => point && self.modifiers.is_some() && wheel,
            3 => no_point && self.modifiers.is_none() && no_wheel,
            4 => no_point && self.modifiers.is_some() && no_wheel,
            _ => false,
        }
    }
}
#[derive(Clone, Copy)]
struct MouseWheel {
    unit: u8,
    phase: u8,
    x: i32,
    y: i32,
}
fn mouse_wheel(
    kind: u8,
    unit: Option<u8>,
    phase: Option<u8>,
    x: Option<i32>,
    y: Option<i32>,
) -> Result<Option<MouseWheel>, String> {
    if kind != 2 {
        return if unit.is_none() && phase.is_none() && x.is_none() && y.is_none() {
            Ok(None)
        } else {
            Err("unexpected_mouse_wheel_fields".into())
        };
    }
    let (unit, phase, x, y) = (
        unit.ok_or("missing_mouse_wheel_unit")?,
        phase.ok_or("missing_mouse_wheel_phase")?,
        x.ok_or("missing_mouse_wheel_x")?,
        y.ok_or("missing_mouse_wheel_y")?,
    );
    if unit > 1
        || (unit == 0 && (phase != 0 || (x == 0 && y == 0)))
        || (unit == 1 && (!(1..=4).contains(&phase) || (phase >= 3 && (x != 0 || y != 0))))
    {
        return Err("invalid_mouse_wheel".into());
    }
    Ok(Some(MouseWheel { unit, phase, x, y }))
}
fn failure(status: &str, error: impl ToString) -> Value {
    json!({"status":status,"error":error.to_string()})
}
fn token() -> Result<String, String> {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).map_err(|error| error.to_string())?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}
fn text(value: &str) -> bool {
    !value.is_empty() && value.len() <= 128 && !value.contains('\0')
}

pub fn probe() -> Value {
    let geometry = input_geometry::snapshot()
        .ok()
        .and_then(|g| serde_json::to_value(g).ok())
        .map(|mut g| {
            if let Some(binding) = crate::display_binding::snapshot() {
                g["browserBinding"] = binding;
            }
            g
        });
    // Keep the same lock through readiness initialization. A snapshot of
    // is_none() followed by an unlocked InitializeTouchInjection would race a
    // newly prepared owner and could erase its native contact state.
    let guard = match OWNER.lock() {
        Ok(guard) => guard,
        Err(_) => return failure("blocked", "native_owner_lock_poisoned"),
    };
    let blocked = guard.as_ref().is_some_and(|owner| owner.blocked);
    let busy = guard.is_some();
    #[cfg(windows)]
    {
        // Never reinitialize while an owner exists, especially after unknown
        // submission or failed cleanup. Probe cannot erase native ownership.
        let ready = TOUCH_READY
            .lock()
            .map(|mut ready| {
                if ready.is_none() && !busy {
                    *ready = Some(crate::pointer::initialize(10));
                }
                ready.unwrap_or(false)
            })
            .unwrap_or(false);
        let types = if ready {
            vec!["touch", "mouse"]
        } else {
            vec!["mouse"]
        };
        let mut caps = json!({"inputTypes":types,"nativeTypes":types,"maxDataBytes":4096,
            "mouse":{"buttonsMask":31,"modifierMask":15,"allowChords":true,"wheelUnits":["detent120","regionQ16_16"],"continuousScroll":true},
            "nativeReady":!blocked,"cleanupBlocked":blocked,"ownerBusy":busy,"geometry":geometry});
        if ready {
            caps["touch"] = json!({"maxContacts":10});
        }
        return caps;
    }
    #[cfg(target_os = "macos")]
    {
        return json!({"inputTypes":["mouse"],"nativeTypes":["mouse"],"zoom":{"browser":true},"maxDataBytes":4096,"mouse":{"buttonsMask":7,"modifierMask":15,"allowChords":false,"wheelUnits":["detent120","regionQ16_16"],"continuousScroll":true},"nativeReady":crate::macos_input::initialize()&&!blocked,"cleanupBlocked":blocked,"ownerBusy":busy,"geometry":geometry});
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    {
        json!({"inputTypes":[],"nativeTypes":[],"maxDataBytes":4096,"nativeReady":false,"cleanupBlocked":blocked,"ownerBusy":busy,"geometry":geometry})
    }
}

fn cleanup(owner: &mut Owner) -> Result<(), String> {
    crate::gesture_halo::clear();
    #[cfg(windows)]
    {
        let mouse_cleanup = crate::windows_mouse::reset(&mut owner.windows_mouse);
        let touch_cleanup = if owner.possible_touch.is_empty() {
            if !crate::pointer::reset_all() {
                Err("native_touch_cleanup_unconfirmed".to_string())
            } else {
                Ok(())
            }
        } else {
            crate::pointer::cancel_possible(&owner.possible_touch)
                .map(|()| owner.possible_touch.clear())
        };
        mouse_cleanup?;
        touch_cleanup?;
    }
    #[cfg(target_os = "macos")]
    {
        crate::macos_input::reset()?;
    }
    owner.mouse_buttons = 0;
    owner.blocked = false;
    Ok(())
}
pub fn prepare(
    owner_id: String,
    source_binding_id: String,
    geometry_revision: String,
    native_id: String,
    input_types: Vec<String>,
    max_contacts: u32,
) -> Value {
    if !text(&owner_id)
        || !text(&source_binding_id)
        || !text(&geometry_revision)
        || !text(&native_id)
    {
        return failure("rejected", "INVALID_ARGUMENT native owner/binding");
    }
    #[cfg(windows)]
    let supported = !input_types.is_empty()
        && input_types.len() <= 2
        && input_types
            .iter()
            .all(|kind| kind == "touch" || kind == "mouse")
        && (input_types.len() != 2 || input_types[0] != input_types[1])
        && if input_types.iter().any(|kind| kind == "touch") {
            (1..=10).contains(&max_contacts)
        } else {
            max_contacts == 0
        };
    #[cfg(target_os = "macos")]
    let supported = input_types == ["mouse"] && max_contacts == 0;
    #[cfg(not(any(windows, target_os = "macos")))]
    let supported = false;
    if !supported {
        return failure("rejected", "NOT_SUPPORTED native input types");
    }
    let mut guard = match OWNER.lock() {
        Ok(owner) => owner,
        Err(_) => return failure("blocked", "native_owner_lock_poisoned"),
    };
    // Revalidate under the owner lock. A concurrent binding release marks the
    // binding retired before waiting for this lock, so it cannot finish cleanup
    // and then leave a newly prepared owner pointing at the retired source.
    if let Err(error) = input_geometry::current(&geometry_revision, &native_id) {
        return failure("rejected", error);
    }
    if let Some(owner) = guard.as_ref() {
        if owner.id == owner_id
            && owner.source_binding_id == source_binding_id
            && owner.revision == geometry_revision
            && owner.native_id == native_id
            && owner.input_types == input_types
            && owner.max_contacts == max_contacts
            && !owner.blocked
        {
            return json!({"status":"ready","leaseId":owner.lease});
        }
        return failure("rejected", "BUSY native owner/cleanup pending");
    }
    let lease = match token() {
        Ok(token) => token,
        Err(error) => return failure("rejected", error),
    };
    let mut owner = Owner {
        id: owner_id,
        source_binding_id,
        lease: lease.clone(),
        revision: geometry_revision,
        native_id,
        input_types,
        max_contacts,
        blocked: false,
        mouse_buttons: 0,
        #[cfg(windows)]
        windows_mouse: crate::windows_mouse_model::State::default(),
        possible_touch: Vec::new(),
    };
    if let Err(error) = cleanup(&mut owner) {
        owner.blocked = true;
        *guard = Some(owner);
        return json!({"status":"blocked","leaseId":lease,"error":error});
    }
    #[cfg(windows)]
    if owner.input_types.iter().any(|kind| kind == "touch")
        && !crate::pointer::initialize(max_contacts)
    {
        return failure("rejected", "native_touch_initialization_failed");
    }
    #[cfg(target_os = "macos")]
    if !crate::macos_input::initialize() {
        return failure("rejected", "native_accessibility_permission_required");
    }
    *guard = Some(owner);
    json!({"status":"ready","leaseId":lease})
}
fn authorized<'a>(
    owner: &'a mut Option<Owner>,
    id: &str,
    lease: &str,
) -> Result<&'a mut Owner, String> {
    let owner = owner.as_mut().ok_or("native_owner_missing")?;
    if owner.id != id || owner.lease != lease {
        return Err("native_owner_lease_mismatch".into());
    }
    if owner.blocked {
        return Err("native_cleanup_pending".into());
    }
    Ok(owner)
}
pub fn apply(
    owner_id: String,
    lease_id: String,
    geometry_revision: String,
    action: Action,
) -> Value {
    let mut guard = match OWNER.lock() {
        Ok(owner) => owner,
        Err(_) => return failure("blocked", "native_owner_lock_poisoned"),
    };
    let owner = match authorized(&mut guard, &owner_id, &lease_id) {
        Ok(owner) => owner,
        Err(error) => return failure("rejected", error),
    };
    if owner.revision != geometry_revision {
        return failure("rejected", "native_geometry_revision_mismatch");
    }
    let display = match input_geometry::current(&owner.revision, &owner.native_id) {
        Ok(display) => display,
        Err(error) => return failure("rejected", error),
    };
    match action {
        Action::Zoom { steps, x, y } => {
            #[cfg(target_os = "macos")]
            {
                if owner.input_types != ["mouse"]
                    || owner.mouse_buttons != 0
                    || !display.contains(x, y)
                {
                    return failure("rejected", "invalid_browser_zoom_owner/point");
                }
                return match crate::macos_input::browser_zoom(steps) {
                    Ok(()) => {
                        json!({"status":"submitted","submittedActions":steps.abs()*2,"inputType":"zoom","nativeApi":"CGEventPost","shortcut":"Command+Plus/Minus"})
                    }
                    Err(error) => failure("rejected", error),
                };
            }
            #[cfg(not(target_os = "macos"))]
            {
                let _ = (steps, x, y);
                failure("rejected", "NOT_SUPPORTED browser zoom shortcut")
            }
        }
        Action::Touch { records } => apply_touch(owner, &display, records),
        Action::Mouse(a) => {
            if !a.valid_shape() {
                return failure("rejected", "native_mouse_action_shape");
            }
            match mouse_wheel(
                a.event_kind,
                a.wheel_unit,
                a.wheel_phase,
                a.wheel_x,
                a.wheel_y,
            ) {
                Ok(wheel) => apply_mouse(
                    owner,
                    &display,
                    a.event_kind,
                    a.buttons.unwrap_or(0),
                    a.modifiers.unwrap_or(0),
                    a.x.unwrap_or(0.0),
                    a.y.unwrap_or(0.0),
                    wheel,
                ),
                Err(error) => failure("rejected", error),
            }
        }
    }
}
#[cfg(windows)]
fn apply_touch(owner: &mut Owner, display: &Display, records: Vec<TouchRecord>) -> Value {
    use std::collections::BTreeSet;
    if !owner.input_types.iter().any(|kind| kind == "touch")
        || records.is_empty()
        || records.len() > owner.max_contacts as usize
    {
        return failure("rejected", "native_touch_count/type");
    }
    if owner.windows_mouse.buttons != 0
        || owner.windows_mouse.owned_modifiers != 0
        || owner.windows_mouse.scroll.is_some()
    {
        return failure("rejected", "overlapping_touch_mouse_output");
    }
    let ids = records
        .iter()
        .map(|record| record.contact_id)
        .collect::<BTreeSet<_>>();
    if ids.len() != records.len()
        || records.iter().any(|record| {
            record.contact_id == 0
                || record.contact_id > owner.max_contacts
                || record.phase > 3
                || !display.contains(record.x as f64, record.y as f64)
        })
    {
        return failure("rejected", "native_touch_record_invalid");
    }
    let current = crate::pointer::active_points();
    if current.iter().any(|(id, _)| !ids.contains(id)) {
        return failure("rejected", "native_touch_sample_incomplete");
    }
    if records.iter().any(|record| {
        let active = current.iter().any(|(id, _)| *id == record.contact_id);
        if record.phase == 0 {
            active
        } else {
            !active
        }
    }) {
        return failure("rejected", "native_touch_lifecycle_invalid");
    }
    let needs_update = records.iter().any(|record| {
        record.phase == 2
            && current.iter().any(|(id, point)| {
                *id == record.contact_id && (point.x != record.x || point.y != record.y)
            })
    });
    let mut submitted = 0;
    let convert = |records: &[TouchRecord]| {
        records
            .iter()
            .map(|record| crate::pointer::Record {
                contact_id: record.contact_id,
                phase: record.phase,
                x: record.x,
                y: record.y,
            })
            .collect::<Vec<_>>()
    };
    if needs_update {
        let preparation = records
            .iter()
            .map(|record| {
                let mut record = record.clone();
                if record.phase >= 2 {
                    if record.phase == 3 {
                        if let Some((_, point)) =
                            current.iter().find(|(id, _)| *id == record.contact_id)
                        {
                            record.x = point.x;
                            record.y = point.y;
                        }
                    }
                    record.phase = 1;
                }
                record
            })
            .collect::<Vec<_>>();
        if let Err(error) = crate::pointer::inject_batch(&convert(&preparation)) {
            owner.blocked = true;
            owner.possible_touch = preparation;
            return json!({"status":"unknown","submittedActions":0,"error":error});
        }
        submitted = 1;
    }
    let final_records = records
        .iter()
        .cloned()
        .map(|mut record| {
            if needs_update && record.phase == 0 {
                record.phase = 1;
            }
            record
        })
        .collect::<Vec<_>>();
    if let Err(error) = crate::pointer::inject_batch(&convert(&final_records)) {
        owner.blocked = true;
        owner.possible_touch = records;
        return json!({"status":if submitted>0{"partial"}else{"unknown"},"submittedActions":submitted,"error":error});
    }
    json!({"status":"submitted","submittedActions":submitted+1,"submittedRecords":records.len(),"inputType":"touch","nativeApi":"InjectTouchInput","pointerType":"PT_TOUCH"})
}
#[cfg(not(windows))]
fn apply_touch(_owner: &mut Owner, _display: &Display, _records: Vec<TouchRecord>) -> Value {
    failure("rejected", "NOT_SUPPORTED native Touch")
}

#[cfg(target_os = "macos")]
fn apply_mouse(
    owner: &mut Owner,
    display: &Display,
    kind: u8,
    buttons: u32,
    modifiers: u16,
    x: f64,
    y: f64,
    wheel: Option<MouseWheel>,
) -> Value {
    if owner.input_types != ["mouse"]
        || modifiers & !15 != 0
        || buttons & !7 != 0
        || buttons & (buttons.wrapping_sub(1)) != 0
    {
        return failure("rejected", "NOT_SUPPORTED native Mouse features");
    }
    if ![0, 1, 2, 3, 4].contains(&kind) || (kind != 3 && kind != 4 && !display.contains(x, y)) {
        return failure("rejected", "native_mouse_action_invalid");
    }
    let mut submitted = 0;
    let result = match kind {
        0 => {
            if buttons != owner.mouse_buttons {
                return failure("rejected", "native_mouse_implicit_buttons");
            }
            crate::macos_input::move_at_point(x, y, modifiers)
        }
        1 => {
            if buttons == owner.mouse_buttons {
                return failure("rejected", "native_mouse_transition_missing");
            }
            if owner.mouse_buttons != 0 {
                if let Err(error) = crate::macos_input::button_at_point(
                    owner.mouse_buttons as u8,
                    false,
                    x,
                    y,
                    modifiers,
                ) {
                    owner.blocked = true;
                    return failure("unknown", error);
                }
                owner.mouse_buttons = 0;
                submitted += 1;
            }
            if buttons != 0 {
                match crate::macos_input::button_at_point(buttons as u8, true, x, y, modifiers) {
                    Ok(()) => {
                        owner.mouse_buttons = buttons;
                        submitted += 1;
                        Ok(())
                    }
                    Err(error) => Err(error),
                }
            } else {
                Ok(())
            }
        }
        2 => {
            if buttons != owner.mouse_buttons {
                return failure("rejected", "native_mouse_implicit_buttons");
            }
            let Some(wheel) = wheel else {
                return failure("rejected", "native_mouse_wheel_missing");
            };
            crate::macos_input::scroll_at_point(
                x,
                y,
                wheel.x,
                wheel.y,
                wheel.unit,
                wheel.phase,
                display.region.width,
                display.region.height,
                modifiers,
            )
        }
        3 => crate::macos_input::reset(),
        4 => Ok(()),
        _ => unreachable!(),
    };
    match result {
        Ok(()) => {
            if kind == 3 {
                owner.mouse_buttons = 0;
            }
            json!({"status":"submitted","submittedActions":submitted.max(1),"inputType":"mouse","nativeApi":"CGEventPost","eventKind":kind})
        }
        Err(error) => {
            owner.blocked = true;
            json!({"status":if submitted>0 {"partial"}else{"unknown"},"submittedActions":submitted,"error":error})
        }
    }
}
#[cfg(windows)]
fn apply_mouse(
    owner: &mut Owner,
    display: &Display,
    kind: u8,
    buttons: u32,
    modifiers: u16,
    x: f64,
    y: f64,
    wheel: Option<MouseWheel>,
) -> Value {
    if !owner.input_types.iter().any(|kind| kind == "mouse") {
        return failure("rejected", "NOT_SUPPORTED native Mouse");
    }
    if kind != 3 && kind != 4 && !display.contains(x, y) {
        return failure("rejected", "native_mouse_action_invalid");
    }
    if !crate::pointer::active_points().is_empty() || !owner.possible_touch.is_empty() {
        return failure("rejected", "overlapping_touch_mouse_output");
    }
    let action = crate::windows_mouse_model::Action {
        kind,
        buttons,
        modifiers,
        x,
        y,
        wheel: wheel.map(|w| crate::windows_mouse_model::Wheel {
            unit: w.unit,
            phase: w.phase,
            x: w.x,
            y: w.y,
        }),
    };
    match crate::windows_mouse::apply(&mut owner.windows_mouse, action, display) {
        Ok(submitted) => {
            owner.mouse_buttons = owner.windows_mouse.buttons;
            json!({"status":"submitted","submittedActions":submitted,"inputType":"mouse","nativeApi":"SendInput","eventKind":kind})
        }
        Err(error) => {
            owner.blocked = true;
            json!({"status":if error.submitted>0{"partial"}else{"unknown"},"submittedActions":error.submitted,"error":error.error})
        }
    }
}
#[cfg(not(any(windows, target_os = "macos")))]
fn apply_mouse(
    _owner: &mut Owner,
    _display: &Display,
    _kind: u8,
    _buttons: u32,
    _modifiers: u16,
    _x: f64,
    _y: f64,
    _wheel: Option<MouseWheel>,
) -> Value {
    failure("rejected", "NOT_SUPPORTED typed native Mouse")
}

pub fn release(owner_id: String, lease_id: Option<String>) -> Value {
    let mut guard = match OWNER.lock() {
        Ok(owner) => owner,
        Err(_) => return failure("blocked", "native_owner_lock_poisoned"),
    };
    let Some(owner) = guard.as_mut() else {
        return json!({"status":"released"});
    };
    // A newer owner can only exist after this old owner was fully released.
    if owner.id != owner_id {
        return json!({"status":"released","alreadyReleased":true});
    }
    if lease_id.as_ref().is_some_and(|lease| *lease != owner.lease) {
        return failure("blocked", "native_owner_lease_mismatch");
    }
    match cleanup(owner) {
        Ok(()) => {
            *guard = None;
            json!({"status":"released"})
        }
        Err(error) => {
            owner.blocked = true;
            failure("blocked", error)
        }
    }
}
pub fn release_binding(native_id: &str) -> Result<(), String> {
    let mut guard = OWNER.lock().map_err(|_| "native_owner_lock_poisoned")?;
    if let Some(owner) = guard.as_mut().filter(|owner| owner.native_id == native_id) {
        if let Err(error) = cleanup(owner) {
            owner.blocked = true;
            return Err(error);
        }
        *guard = None;
    }
    Ok(())
}
pub fn shutdown() {
    crate::gesture_halo::clear();
    if let Ok(mut guard) = OWNER.lock() {
        if let Some(owner) = guard.as_mut() {
            match cleanup(owner) {
                Ok(()) => *guard = None,
                Err(error) => {
                    owner.blocked = true;
                    eprintln!("native_input_shutdown_cleanup_pending: {error}");
                }
            }
        }
    }
}
pub fn ensure_released_for_update() -> Result<(), String> {
    shutdown();
    if OWNER
        .lock()
        .map_err(|_| "native_owner_lock_poisoned")?
        .is_some()
    {
        Err("native_input_cleanup_pending".into())
    } else {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(windows)]
    #[test]
    fn windows_advertises_native_mouse_wheel_and_modifiers_alongside_touch() {
        let caps = probe();
        assert!(
            caps["inputTypes"]
                .as_array()
                .unwrap()
                .iter()
                .any(|value| value == "mouse"),
            "{caps}"
        );
        assert_eq!(caps["mouse"]["buttonsMask"], 31);
        assert_eq!(caps["mouse"]["allowChords"], true);
        assert_eq!(caps["mouse"]["modifierMask"], 15);
        assert_eq!(caps["mouse"]["continuousScroll"], true);
        assert_eq!(
            caps["mouse"]["wheelUnits"],
            json!(["detent120", "regionQ16_16"])
        );
    }
    #[test]
    fn halo_feedback_is_bounded_to_display_and_known_phases() {
        let display = Display {
            native_id: "one".into(),
            primary: true,
            units: "points".into(),
            rotation: 0,
            region: input_geometry::Region {
                x: 0.0,
                y: 0.0,
                width: 1000.0,
                height: 800.0,
            },
            capture_width: 2000,
            capture_height: 1600,
        };
        let feedback = |stage: &str, x, progress| GestureFeedback {
            stage: stage.into(),
            x,
            y: 100.0,
            progress,
        };
        assert!(feedback("armed", 500.0, 1.0).valid(&display));
        for stage in ["right-wait", "right-ready", "released", "right-released"] {
            assert!(feedback(stage, 500.0, 0.5).valid(&display));
        }
        assert!(!feedback("unknown", 500.0, 1.0).valid(&display));
        assert!(!feedback("armed", 1000.0, 1.0).valid(&display));
        assert!(!feedback("armed", f64::NAN, 1.0).valid(&display));
        assert!(!feedback("holding", 500.0, 1.1).valid(&display));
    }
    #[test]
    fn typed_mouse_wheel_fields_reach_native_with_exact_units_and_terminal_rules() {
        let action: Action = serde_json::from_value(
            json!({"inputType":"mouse","eventKind":2,"buttons":0,"modifiers":0,"x":10.0,"y":20.0,
            "wheelUnit":1,"wheelPhase":1,"wheelX":0,"wheelY":-4096}),
        )
        .unwrap();
        match action {
            Action::Mouse(a) => {
                assert!(a.valid_shape());
                let wheel = mouse_wheel(2, a.wheel_unit, a.wheel_phase, a.wheel_x, a.wheel_y)
                    .unwrap()
                    .unwrap();
                assert_eq!(
                    (wheel.unit, wheel.phase, wheel.x, wheel.y),
                    (1, 1, 0, -4096)
                );
            }
            _ => panic!("expected Mouse"),
        }
        assert!(mouse_wheel(2, Some(1), Some(3), Some(0), Some(1)).is_err());
        assert!(mouse_wheel(2, Some(0), Some(1), Some(0), Some(120)).is_err());
        assert!(mouse_wheel(2, Some(0), Some(0), Some(0), Some(0)).is_err());
        assert!(mouse_wheel(2, None, None, None, None).is_err());
        assert!(mouse_wheel(0, Some(1), Some(1), Some(0), Some(1)).is_err());
        assert!(mouse_wheel(0, None, None, None, None).unwrap().is_none());
        assert!(mouse_wheel(2, Some(0), Some(0), Some(0), Some(120)).is_ok());
        for value in [
            json!({"eventKind":0}),
            json!({"eventKind":3,"x":0}),
            json!({"eventKind":4,"modifiers":0,"buttons":0}),
        ] {
            let a: MouseAction = serde_json::from_value(value).unwrap();
            assert!(!a.valid_shape());
        }
    }
    #[test]
    fn native_owner_mismatch_and_blocked_state_cannot_be_bypassed() {
        let mut owner = Some(Owner {
            id: "one".into(),
            source_binding_id: "source".into(),
            lease: "secret".into(),
            revision: "r1".into(),
            native_id: "display".into(),
            input_types: vec!["touch".into()],
            max_contacts: 10,
            blocked: false,
            mouse_buttons: 0,
            #[cfg(windows)]
            windows_mouse: crate::windows_mouse_model::State::default(),
            possible_touch: vec![],
        });
        assert!(authorized(&mut owner, "two", "secret").is_err());
        assert!(authorized(&mut owner, "one", "wrong").is_err());
        owner.as_mut().unwrap().blocked = true;
        assert!(authorized(&mut owner, "one", "secret").is_err());
        assert_eq!(owner.as_ref().unwrap().id, "one");
    }
}
