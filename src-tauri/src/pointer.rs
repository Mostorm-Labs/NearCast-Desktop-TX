use std::sync::Mutex;
use windows::Win32::Foundation::POINT;
use windows::Win32::UI::Input::Pointer::{
    InitializeTouchInjection, InjectTouchInput, POINTER_FLAG_CANCELED, POINTER_FLAG_DOWN,
    POINTER_FLAG_INCONTACT, POINTER_FLAG_INRANGE, POINTER_FLAG_UP, POINTER_FLAG_UPDATE,
    POINTER_TOUCH_INFO, TOUCH_FEEDBACK_NONE,
};
use windows::Win32::UI::WindowsAndMessaging::PT_TOUCH;
static ACTIVE: Mutex<Vec<(u32, POINT)>> = Mutex::new(Vec::new());
#[cfg(test)]
static NOT_READY_FRAME: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
#[cfg(test)]
pub fn fail_next_frame_not_ready() {
    NOT_READY_FRAME.store(true, std::sync::atomic::Ordering::SeqCst);
}

#[derive(Clone, Copy)]
pub struct Record {
    pub contact_id: u32,
    pub phase: u8,
    pub x: i32,
    pub y: i32,
}

fn flags(phase: u8) -> Result<windows::Win32::UI::Input::Pointer::POINTER_FLAGS, String> {
    Ok(match phase {
        0 => POINTER_FLAG_DOWN | POINTER_FLAG_INRANGE | POINTER_FLAG_INCONTACT,
        1 => POINTER_FLAG_UPDATE | POINTER_FLAG_INRANGE | POINTER_FLAG_INCONTACT,
        2 => POINTER_FLAG_UP,
        3 => POINTER_FLAG_CANCELED | POINTER_FLAG_UP,
        _ => return Err("invalid_pointer_phase".into()),
    })
}

pub fn initialize(max: u32) -> bool {
    let okay = unsafe { InitializeTouchInjection(max, TOUCH_FEEDBACK_NONE).is_ok() };
    if okay {
        if let Ok(mut active) = ACTIVE.lock() {
            active.clear();
        }
    }
    okay
}

pub fn active_points() -> Vec<(u32, POINT)> {
    ACTIVE
        .lock()
        .map(|active| active.clone())
        .unwrap_or_default()
}
pub fn reset_all() -> Result<(), String> {
    reset(
        &active_points()
            .iter()
            .map(|(id, _)| *id)
            .collect::<Vec<_>>(),
    )
}
#[derive(Debug)]
pub struct InjectionError {
    pub code: Option<u32>,
    pub unchanged: bool,
    pub message: String,
}
impl std::fmt::Display for InjectionError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}
impl From<String> for InjectionError {
    fn from(message: String) -> Self {
        Self {
            code: None,
            unchanged: true,
            message,
        }
    }
}
impl From<&str> for InjectionError {
    fn from(message: &str) -> Self {
        message.to_string().into()
    }
}
fn submit_with(
    infos: &[POINTER_TOUCH_INFO],
    mut inject: impl FnMut(&[POINTER_TOUCH_INFO]) -> Result<(), u32>,
    mut wait: impl FnMut(),
) -> Result<(), InjectionError> {
    for attempt in 0..5 {
        match inject(infos) {
            Ok(()) => return Ok(()),
            Err(code) => {
                // ERROR_NOT_READY explicitly means the frame was not injected.
                // Retry exactly that frame, never advance the pointer lifecycle.
                if code == 21 && attempt < 4 {
                    wait();
                    continue;
                }
                return Err(InjectionError {
                    code: Some(code),
                    unchanged: code == 21,
                    message: format!("windows_inject_touch_input_failed:win32={code}"),
                });
            }
        }
    }
    unreachable!()
}
fn submit(infos: &[POINTER_TOUCH_INFO]) -> Result<(), InjectionError> {
    crate::input_execution::phase("inject_touch");
    #[cfg(test)]
    if NOT_READY_FRAME.swap(false, std::sync::atomic::Ordering::SeqCst) {
        return submit_with(infos, |_| Err(21), || {});
    }
    submit_with(
        infos,
        |infos| unsafe { InjectTouchInput(infos) }.map_err(|e| e.code().0 as u32 & 0xffff),
        || std::thread::sleep(std::time::Duration::from_millis(1)),
    )
}
fn cancellation_frames(
    current: &[(u32, POINT)],
    records: &[crate::input_native::TouchRecord],
) -> Vec<Vec<POINTER_TOUCH_INFO>> {
    let confirmed = current
        .iter()
        .map(|(id, p)| (*id, *p))
        .collect::<std::collections::BTreeMap<_, _>>();
    let mut possible = confirmed.clone();
    for record in records {
        possible.insert(
            record.contact_id,
            POINT {
                x: record.x,
                y: record.y,
            },
        );
    }
    let frame = |points: &std::collections::BTreeMap<u32, POINT>| {
        points
            .iter()
            .map(|(id, p)| {
                let mut info = POINTER_TOUCH_INFO::default();
                info.pointerInfo.pointerType = PT_TOUCH;
                info.pointerInfo.pointerId = *id;
                info.pointerInfo.ptPixelLocation = *p;
                info.pointerInfo.pointerFlags = POINTER_FLAG_CANCELED | POINTER_FLAG_UP;
                info
            })
            .collect::<Vec<_>>()
    };
    // Unknown failure may have moved confirmed points. Try both coordinate
    // snapshots, but never omit a possibly injected new contact to force a
    // successful response. Known ERROR_NOT_READY uses reset_all instead.
    let mut last = possible.clone();
    for (id, p) in confirmed {
        last.insert(id, p);
    }
    vec![frame(&last), frame(&possible)]
}
pub fn cancel_possible(records: &[crate::input_native::TouchRecord]) -> Result<(), String> {
    let current = active_points();
    let mut failure = None;
    for infos in cancellation_frames(&current, records) {
        if infos.is_empty() {
            return Ok(());
        }
        match submit(&infos) {
            Ok(()) => {
                ACTIVE
                    .lock()
                    .map_err(|_| "windows_pointer_state_poisoned".to_string())?
                    .clear();
                return Ok(());
            }
            Err(error) => failure = Some(error),
        }
    }
    Err(format!(
        "native_touch_uncertain_cleanup_failed:{}",
        failure.unwrap()
    ))
}

pub fn reset(ids: &[u32]) -> Result<(), String> {
    let contacts = match ACTIVE.lock() {
        Ok(active) => active
            .iter()
            .filter(|item| ids.contains(&item.0))
            .copied()
            .collect::<Vec<_>>(),
        Err(_) => return Err("windows_pointer_state_poisoned".into()),
    };
    if contacts.is_empty() {
        return Ok(());
    }
    let records = contacts
        .into_iter()
        .map(|(contact_id, point)| Record {
            contact_id,
            phase: 3,
            x: point.x,
            y: point.y,
        })
        .collect::<Vec<_>>();
    inject_batch(&records).map_err(|error| format!("native_touch_cleanup_failed:{error}"))
}

pub fn inject_batch(records: &[Record]) -> Result<(), InjectionError> {
    if records.is_empty() {
        return Ok(());
    }
    let current = ACTIVE
        .lock()
        .map_err(|_| "windows_pointer_state_poisoned".to_string())?
        .clone();
    let mut points = current
        .iter()
        .copied()
        .collect::<std::collections::BTreeMap<_, _>>();
    let mut phases = std::collections::BTreeMap::new();
    for record in records {
        let flag = flags(record.phase)?;
        let previous = points.get(&record.contact_id).copied();
        let point = match record.phase {
            0 => {
                if previous.is_some() {
                    return Err("pointer_contact_already_active".into());
                }
                POINT {
                    x: record.x,
                    y: record.y,
                }
            }
            1 => {
                if previous.is_none() {
                    return Err("pointer_contact_not_active".into());
                }
                POINT {
                    x: record.x,
                    y: record.y,
                }
            }
            2 | 3 => previous.ok_or("pointer_contact_not_active")?,
            _ => unreachable!(),
        };
        phases.insert(record.contact_id, (flag, point.x, point.y));
        // Keep terminal contacts in the frame so InjectTouchInput receives
        // their final coordinates together with every other active contact.
        // They are removed from ACTIVE only after the native call succeeds.
        points.insert(record.contact_id, point);
    }
    let mut infos = Vec::with_capacity(points.len());
    for (id, point) in points.iter() {
        let (pointer_flags, x, y) = phases.get(id).copied().unwrap_or((
            POINTER_FLAG_UPDATE | POINTER_FLAG_INRANGE | POINTER_FLAG_INCONTACT,
            point.x,
            point.y,
        ));
        let mut info = POINTER_TOUCH_INFO::default();
        info.pointerInfo.pointerType = PT_TOUCH;
        info.pointerInfo.pointerId = *id;
        info.pointerInfo.ptPixelLocation = POINT { x, y };
        info.touchMask = 0;
        info.pointerInfo.pointerFlags = pointer_flags;
        infos.push(info);
    }
    submit(&infos)?;
    let mut active = ACTIVE
        .lock()
        .map_err(|_| "windows_pointer_state_poisoned".to_string())?;
    for record in records {
        if record.phase >= 2 {
            points.remove(&record.contact_id);
        }
    }
    *active = points.into_iter().collect();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn transient_not_ready_retries_identical_frame_without_advancing_contacts() {
        let mut info = POINTER_TOUCH_INFO::default();
        info.pointerInfo.pointerId = 2;
        info.pointerInfo.ptPixelLocation = POINT { x: 201, y: 629 };
        let mut calls = 0;
        let mut waits = 0;
        submit_with(
            &[info],
            |frame| {
                calls += 1;
                assert_eq!(frame[0].pointerInfo.pointerId, 2);
                assert_eq!(frame[0].pointerInfo.ptPixelLocation.x, 201);
                if calls < 3 {
                    Err(21)
                } else {
                    Ok(())
                }
            },
            || waits += 1,
        )
        .unwrap();
        assert_eq!((calls, waits), (3, 2));
        let error = submit_with(&[info], |_| Err(21), || {}).unwrap_err();
        assert!(error.unchanged);
        assert_eq!(error.code, Some(21));
        let mut calls = 0;
        let error = submit_with(
            &[info],
            |_| {
                calls += 1;
                Err(5)
            },
            || {},
        )
        .unwrap_err();
        assert!(!error.unchanged);
        assert_eq!(calls, 1);
    }
    #[test]
    fn uncertain_cancel_keeps_new_contacts_but_uses_last_confirmed_coordinates_first() {
        let current = vec![(1, POINT { x: 220, y: 610 })];
        let pending = vec![
            crate::input_native::TouchRecord {
                contact_id: 1,
                phase: 1,
                x: 229,
                y: 620,
            },
            crate::input_native::TouchRecord {
                contact_id: 2,
                phase: 0,
                x: 201,
                y: 629,
            },
        ];
        let frames = cancellation_frames(&current, &pending);
        assert_eq!(frames[0].len(), 2);
        assert_eq!(frames[1].len(), 2);
        assert_eq!(frames[0][0].pointerInfo.ptPixelLocation.x, 220);
        assert_eq!(frames[1][0].pointerInfo.ptPixelLocation.x, 229);
        assert_eq!(frames[1][1].pointerInfo.pointerId, 2);
        assert_eq!(frames[1][1].pointerInfo.ptPixelLocation.x, 201);
    }
}
