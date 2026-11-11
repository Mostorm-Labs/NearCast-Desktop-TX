// Nonblocking diagnostic view of a serialized native input call. No owner IDs,
// leases, coordinates or OS handles cross this observability boundary.
use serde_json::{json, Value};
use std::{
    sync::{
        atomic::{AtomicU64, Ordering},
        Mutex,
    },
    time::Instant,
};
struct Execution {
    id: u64,
    kind: &'static str,
    phase: &'static str,
    started: Instant,
    thread_id: u32,
    complete: bool,
    finished_ms: Option<f64>,
    phase_started: Instant,
    slowest_phase: &'static str,
    slowest_phase_ms: f64,
}
static NEXT: AtomicU64 = AtomicU64::new(0);
static CURRENT: Mutex<Option<Execution>> = Mutex::new(None);
static SLOW_CALL: Mutex<Option<Value>> = Mutex::new(None);
thread_local! {static CALL:std::cell::Cell<u64>=const{std::cell::Cell::new(0)};}
pub struct Guard;
pub fn start(kind: &'static str) -> Guard {
    let id = NEXT.fetch_add(1, Ordering::Relaxed) + 1;
    CALL.with(|call| call.set(id));
    if let Ok(mut current) = CURRENT.lock() {
        *current = Some(Execution {
            id,
            kind,
            phase: "started",
            started: Instant::now(),
            thread_id: unsafe { windows::Win32::System::Threading::GetCurrentThreadId() },
            complete: false,
            finished_ms: None,
            phase_started: Instant::now(),
            slowest_phase: "started",
            slowest_phase_ms: 0.0,
        });
    }
    Guard
}
pub fn phase(value: &'static str) {
    CALL.with(|call| {
        if let Ok(mut current) = CURRENT.lock() {
            if let Some(current) = current.as_mut().filter(|c| c.id == call.get()) {
                let elapsed = current.phase_started.elapsed().as_secs_f64() * 1000.0;
                if elapsed > current.slowest_phase_ms {
                    current.slowest_phase = current.phase;
                    current.slowest_phase_ms = elapsed;
                }
                current.phase = value;
                current.phase_started = Instant::now();
            }
        }
    });
}
impl Drop for Guard {
    fn drop(&mut self) {
        CALL.with(|call| {
            if let Ok(mut current) = CURRENT.lock() {
                if let Some(current) = current.as_mut().filter(|c| c.id == call.get()) {
                    current.complete = true;
                    current.finished_ms = Some(current.started.elapsed().as_secs_f64() * 1000.0);
                    let elapsed = current.phase_started.elapsed().as_secs_f64() * 1000.0;
                    if elapsed > current.slowest_phase_ms {
                        current.slowest_phase = current.phase;
                        current.slowest_phase_ms = elapsed;
                    }
                    if current.finished_ms.unwrap_or(0.0)>=250.0{
                        if let Ok(mut slow)=SLOW_CALL.try_lock(){*slow=Some(json!({"kind":current.kind,"elapsedMs":current.finished_ms,"slowestPhase":current.slowest_phase,"slowestPhaseMs":current.slowest_phase_ms,"threadId":current.thread_id}));}
                    }
                }
            }
            call.set(0);
        });
    }
}
pub fn snapshot() -> Value {
    let mut result=match CURRENT.try_lock(){Ok(current)=>current.as_ref().map(|c|json!({"kind":c.kind,"phase":c.phase,"elapsedMs":c.finished_ms.unwrap_or_else(||c.started.elapsed().as_secs_f64()*1000.0),
        "phaseElapsedMs":if c.complete{0.0}else{c.phase_started.elapsed().as_secs_f64()*1000.0},"slowestPhase":c.slowest_phase,"slowestPhaseMs":c.slowest_phase_ms,
        "threadId":c.thread_id,"complete":c.complete})).unwrap_or(Value::Null),Err(_)=>json!({"phase":"diagnostic_busy"})};
    if result.is_object() {
        if let Ok(slow) = SLOW_CALL.try_lock() {
            if let Some(slow) = slow.as_ref() {
                result["lastSlowCall"] = slow.clone();
            }
        }
    }
    result
}
#[cfg(test)]
mod tests {
    #[test]
    fn execution_snapshot_never_waits_for_native_input() {
        let call = super::start("apply");
        super::phase("send_input");
        let d = super::snapshot();
        assert_eq!(d["phase"], "send_input");
        assert_eq!(d["complete"], false);
        drop(call);
        assert_eq!(super::snapshot()["complete"], true);
    }
}
