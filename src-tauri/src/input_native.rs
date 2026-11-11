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
    Touch {
        records: Vec<TouchRecord>,
    },
    Mouse {
        #[serde(rename = "eventKind")]
        event_kind: u8,
        #[serde(default)]
        buttons: u32,
        #[serde(default)]
        modifiers: u16,
        #[serde(default)]
        x: f64,
        #[serde(default)]
        y: f64,
        #[serde(rename="wheelUnit")]
        wheel_unit: Option<u8>,
        #[serde(rename="wheelPhase")]
        wheel_phase: Option<u8>,
        #[serde(rename="wheelX")]
        wheel_x: Option<i32>,
        #[serde(rename="wheelY")]
        wheel_y: Option<i32>,
    },
}
#[derive(Clone, Copy)]
struct MouseWheel {unit:u8,phase:u8,x:i32,y:i32}
fn mouse_wheel(kind:u8,unit:Option<u8>,phase:Option<u8>,x:Option<i32>,y:Option<i32>)->Result<Option<MouseWheel>,String>{
    if kind!=2 {
        return if unit.is_none()&&phase.is_none()&&x.is_none()&&y.is_none(){Ok(None)}else{Err("unexpected_mouse_wheel_fields".into())};
    }
    let (unit,phase,x,y)=(unit.ok_or("missing_mouse_wheel_unit")?,phase.ok_or("missing_mouse_wheel_phase")?,x.ok_or("missing_mouse_wheel_x")?,y.ok_or("missing_mouse_wheel_y")?);
    if unit>1 || (unit==0&&(phase!=0||(x==0&&y==0))) || (unit==1&&(!(1..=4).contains(&phase)||(phase>=3&&(x!=0||y!=0)))) {return Err("invalid_mouse_wheel".into());}
    Ok(Some(MouseWheel{unit,phase,x,y}))
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
    let geometry = input_geometry::snapshot().ok().and_then(|g|serde_json::to_value(g).ok()).map(|mut g|{
        if let Some(binding)=crate::display_binding::snapshot(){g["browserBinding"]=binding;}
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
        return json!({"inputTypes":["touch"],"nativeTypes":["touch"],"maxDataBytes":4096,"touch":{"maxContacts":10},"nativeReady":ready&&!blocked,"cleanupBlocked":blocked,"ownerBusy":busy,"geometry":geometry});
    }
    #[cfg(target_os = "macos")]
    {
        return json!({"inputTypes":["mouse"],"nativeTypes":["mouse"],"maxDataBytes":4096,"mouse":{"buttonsMask":7,"modifierMask":15,"allowChords":false,"wheelUnits":["detent120","regionQ16_16"],"continuousScroll":true},"nativeReady":crate::macos_input::initialize()&&!blocked,"cleanupBlocked":blocked,"ownerBusy":busy,"geometry":geometry});
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    {
        json!({"inputTypes":[],"nativeTypes":[],"maxDataBytes":4096,"nativeReady":false,"cleanupBlocked":blocked,"ownerBusy":busy,"geometry":geometry})
    }
}

fn cleanup(owner: &mut Owner) -> Result<(), String> {
    #[cfg(windows)]
    {
        if owner.possible_touch.is_empty() {
            if !crate::pointer::reset_all() {
                return Err("native_touch_cleanup_unconfirmed".into());
            }
        } else {
            crate::pointer::cancel_possible(&owner.possible_touch)?;
            owner.possible_touch.clear();
        }
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
    let supported = input_types == ["touch"] && max_contacts >= 1 && max_contacts <= 10;
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
        possible_touch: Vec::new(),
    };
    if let Err(error) = cleanup(&mut owner) {
        owner.blocked = true;
        *guard = Some(owner);
        return json!({"status":"blocked","leaseId":lease,"error":error});
    }
    #[cfg(windows)]
    if !crate::pointer::initialize(max_contacts) {
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
        Action::Mouse {
            event_kind,
            buttons,
            modifiers,
            x,
            y,
            wheel_unit,wheel_phase,wheel_x,wheel_y,
        } => match mouse_wheel(event_kind,wheel_unit,wheel_phase,wheel_x,wheel_y){
            Ok(wheel)=>apply_mouse(owner, &display, event_kind, buttons, modifiers, x, y,wheel),
            Err(error)=>failure("rejected",error),
        },
    }
}
#[cfg(windows)]
fn apply_touch(owner: &mut Owner, display: &Display, records: Vec<TouchRecord>) -> Value {
    use std::collections::BTreeSet;
    if owner.input_types != ["touch"]
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
                if let Err(error) =
                    crate::macos_input::button_at_point(owner.mouse_buttons as u8, false, x, y, modifiers)
                {
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
            if buttons!=owner.mouse_buttons{return failure("rejected","native_mouse_implicit_buttons");}
            let Some(wheel)=wheel else{return failure("rejected","native_mouse_wheel_missing");};
            crate::macos_input::scroll_at_point(x,y,wheel.x,wheel.y,wheel.unit,wheel.phase,display.region.width,display.region.height,modifiers)
        },
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
#[cfg(not(target_os = "macos"))]
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
pub fn release_binding(native_id:&str)->Result<(),String>{
    let mut guard=OWNER.lock().map_err(|_|"native_owner_lock_poisoned")?;
    if let Some(owner)=guard.as_mut().filter(|owner|owner.native_id==native_id){
        if let Err(error)=cleanup(owner){owner.blocked=true;return Err(error);}
        *guard=None;
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
    fn typed_mouse_wheel_fields_reach_native_with_exact_units_and_terminal_rules() {
        let action:Action=serde_json::from_value(json!({"inputType":"mouse","eventKind":2,"buttons":0,"modifiers":0,"x":10.0,"y":20.0,
            "wheelUnit":1,"wheelPhase":1,"wheelX":0,"wheelY":-4096})).unwrap();
        match action {Action::Mouse {wheel_unit,wheel_phase,wheel_x,wheel_y,..}=>{
            let wheel=mouse_wheel(2,wheel_unit,wheel_phase,wheel_x,wheel_y).unwrap().unwrap();
            assert_eq!((wheel.unit,wheel.phase,wheel.x,wheel.y),(1,1,0,-4096));
        },_=>panic!("expected Mouse")}
        assert!(mouse_wheel(2,Some(1),Some(3),Some(0),Some(1)).is_err());
        assert!(mouse_wheel(2,Some(0),Some(1),Some(0),Some(120)).is_err());
        assert!(mouse_wheel(2,Some(0),Some(0),Some(0),Some(0)).is_err());
        assert!(mouse_wheel(2,None,None,None,None).is_err());
        assert!(mouse_wheel(0,Some(1),Some(1),Some(0),Some(1)).is_err());
        assert!(mouse_wheel(0,None,None,None,None).unwrap().is_none());
        assert!(mouse_wheel(2,Some(0),Some(0),Some(0),Some(120)).is_ok());
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
            possible_touch: vec![],
        });
        assert!(authorized(&mut owner, "two", "secret").is_err());
        assert!(authorized(&mut owner, "one", "wrong").is_err());
        owner.as_mut().unwrap().blocked = true;
        assert!(authorized(&mut owner, "one", "secret").is_err());
        assert_eq!(owner.as_ref().unwrap().id, "one");
    }
}
