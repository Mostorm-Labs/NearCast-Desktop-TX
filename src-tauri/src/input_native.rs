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
    mouse: crate::windows_mouse::State,
    possible_touch: Vec<TouchRecord>,
}
static OWNER: Mutex<Option<Owner>> = Mutex::new(None);
#[cfg(windows)]
static TOUCH_READY: Mutex<Option<bool>> = Mutex::new(None);

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
    Touch { records: Vec<TouchRecord> },
    Mouse(MouseAction),
}
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MouseAction {
    pub event_kind: u8,
    pub buttons: Option<u32>,
    pub modifiers: Option<u16>,
    pub x: Option<f64>,
    pub y: Option<f64>,
    pub wheel_unit: Option<u8>,
    pub wheel_phase: Option<u8>,
    pub wheel_x: Option<i32>,
    pub wheel_y: Option<i32>,
}
impl MouseAction {
    pub(crate) fn valid_shape(&self) -> bool {
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
        let mut types = vec!["mouse"];
        if ready {
            types.insert(0, "touch");
        }
        return json!({"inputTypes":types,"nativeTypes":types,"maxDataBytes":4096,"touch":{"maxContacts":10},"mouse":crate::windows_mouse::capabilities(),"nativeReady":!blocked,"cleanupBlocked":blocked,"ownerBusy":busy,"geometry":geometry});
    }
    #[cfg(target_os = "macos")]
    {
        return json!({"inputTypes":["mouse"],"nativeTypes":["mouse"],"maxDataBytes":4096,"mouse":{"buttonsMask":7,"modifierMask":0,"allowChords":false,"wheelUnits":[],"continuousScroll":false},"nativeReady":crate::macos_input::initialize()&&!blocked,"cleanupBlocked":blocked,"ownerBusy":busy,"geometry":geometry});
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    {
        json!({"inputTypes":[],"nativeTypes":[],"maxDataBytes":4096,"nativeReady":false,"cleanupBlocked":blocked,"ownerBusy":busy,"geometry":geometry})
    }
}

fn cleanup(owner: &mut Owner) -> Result<(), String> {
    #[cfg(windows)]
    {
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
        // Attempt both domains even if one reset fails; preserve ownership and
        // block the next owner until every held input has a confirmed release.
        let mouse_cleanup = crate::windows_mouse::reset(&mut owner.mouse);
        touch_cleanup?;
        mouse_cleanup?;
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
        && input_types.iter().all(|t| t == "touch" || t == "mouse")
        && (input_types.len() != 2 || input_types[0] != input_types[1])
        && if input_types.iter().any(|t| t == "touch") {
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
        mouse: Default::default(),
        possible_touch: Vec::new(),
    };
    if let Err(error) = cleanup(&mut owner) {
        owner.blocked = true;
        *guard = Some(owner);
        return json!({"status":"blocked","leaseId":lease,"error":error});
    }
    #[cfg(windows)]
    if owner.input_types.iter().any(|t| t == "touch") && !crate::pointer::initialize(max_contacts) {
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
        Action::Touch { records } => apply_touch(owner, &display, records),
        Action::Mouse(action) => {
            if !action.valid_shape() {
                return failure("rejected", "native_mouse_action_shape");
            }
            apply_mouse(owner, &display, action)
        }
    }
}
#[cfg(windows)]
fn apply_touch(owner: &mut Owner, display: &Display, records: Vec<TouchRecord>) -> Value {
    use std::collections::BTreeSet;
    if !owner.input_types.iter().any(|t| t == "touch")
        || records.is_empty()
        || records.len() > owner.max_contacts as usize
    {
        return failure("rejected", "native_touch_count/type");
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
fn apply_mouse(owner: &mut Owner, display: &Display, action: MouseAction) -> Value {
    let (kind, buttons, modifiers, x, y) = (
        action.event_kind,
        action.buttons.unwrap_or(0),
        action.modifiers.unwrap_or(0),
        action.x.unwrap_or(0.0),
        action.y.unwrap_or(0.0),
    );
    if owner.input_types != ["mouse"]
        || modifiers != 0
        || buttons & !7 != 0
        || buttons & (buttons.wrapping_sub(1)) != 0
    {
        return failure("rejected", "NOT_SUPPORTED native Mouse features");
    }
    if ![0, 1, 3, 4].contains(&kind) || (kind != 3 && kind != 4 && !display.contains(x, y)) {
        return failure("rejected", "native_mouse_action_invalid");
    }
    let mut submitted = 0;
    let result = match kind {
        0 => {
            if buttons != owner.mouse_buttons {
                return failure("rejected", "native_mouse_implicit_buttons");
            }
            crate::macos_input::move_at_point(x, y, 0)
        }
        1 => {
            if buttons == owner.mouse_buttons {
                return failure("rejected", "native_mouse_transition_missing");
            }
            if owner.mouse_buttons != 0 {
                if let Err(error) =
                    crate::macos_input::button_at_point(owner.mouse_buttons as u8, false, x, y, 0)
                {
                    owner.blocked = true;
                    return failure("unknown", error);
                }
                owner.mouse_buttons = 0;
                submitted += 1;
            }
            if buttons != 0 {
                match crate::macos_input::button_at_point(buttons as u8, true, x, y, 0) {
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
        3 => crate::macos_input::reset(),
        4 => Ok(()),
        _ => unreachable!(),
    };
    match result {
        Ok(()) => {
            if kind == 3 {
                owner.mouse_buttons = 0;
            }
            json!({"status":"submitted","submittedActions":submitted.max(1)})
        }
        Err(error) => {
            owner.blocked = true;
            json!({"status":if submitted>0 {"partial"}else{"unknown"},"submittedActions":submitted,"error":error})
        }
    }
}
#[cfg(windows)]
fn apply_mouse(owner: &mut Owner, display: &Display, action: MouseAction) -> Value {
    if !owner.input_types.iter().any(|t| t == "mouse") {
        return failure("rejected", "NOT_SUPPORTED native Mouse");
    }
    let result = crate::windows_mouse::apply(&mut owner.mouse, display, &action);
    if result["cleanupRequired"] == true {
        owner.blocked = true;
    }
    result
}
#[cfg(not(any(windows, target_os = "macos")))]
fn apply_mouse(_owner: &mut Owner, _display: &Display, _action: MouseAction) -> Value {
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
            mouse: Default::default(),
            possible_touch: vec![],
        });
        assert!(authorized(&mut owner, "two", "secret").is_err());
        assert!(authorized(&mut owner, "one", "wrong").is_err());
        owner.as_mut().unwrap().blocked = true;
        assert!(authorized(&mut owner, "one", "secret").is_err());
        assert_eq!(owner.as_ref().unwrap().id, "one");
    }
}
