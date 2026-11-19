// A session-scoped worker owns native audio. Modern macOS uses Core Audio
// taps, avoiding replayd entirely; ScreenCaptureKit is a legacy fallback.
// Closing another replayd client is insufficient to restore WebKit's picker.
use std::{
    collections::VecDeque,
    io::{self, Read, Write},
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc, Condvar, Mutex,
    },
    thread,
    time::{Duration, Instant},
};

const WORKER_ARG: &str = "--nearcast-system-audio-worker";
const MAX_FRAME: usize = 20_480;
const MAX_PENDING: usize = 4;
const READY: u8 = 0;
const PCM: u8 = 1;
const ERROR: u8 = 2;
static STOP_REQUESTED: AtomicBool = AtomicBool::new(false);

// Do not expose the app's recording grant through a general command-line
// recorder. Only the same bundled executable may launch an audio worker.
fn is_host_process(pid: i32) -> bool {
    use std::os::unix::ffi::OsStrExt;
    #[link(name = "proc")]
    extern "C" {
        fn proc_pidpath(pid: i32, buffer: *mut u8, size: u32) -> i32;
    }
    let mut path = [0u8; 4096];
    if unsafe { proc_pidpath(pid, path.as_mut_ptr(), path.len() as u32) } <= 0 {
        return false;
    }
    let count = path.iter().position(|b| *b == 0).unwrap_or(path.len());
    std::env::current_exe()
        .map(|exe| exe.as_os_str().as_bytes() == &path[..count])
        .unwrap_or(false)
}
fn write_frame(output: &mut impl Write, kind: u8, bytes: &[u8]) -> io::Result<()> {
    if bytes.len() > MAX_FRAME {
        return Err(io::ErrorKind::InvalidData.into());
    }
    output.write_all(&[kind])?;
    output.write_all(&(bytes.len() as u32).to_be_bytes())?;
    output.write_all(bytes)?;
    output.flush()
}
fn read_frame(input: &mut impl Read) -> io::Result<(u8, Vec<u8>)> {
    let mut header = [0; 5];
    input.read_exact(&mut header)?;
    let size = u32::from_be_bytes(header[1..].try_into().unwrap()) as usize;
    if size > MAX_FRAME
        || !matches!(header[0], READY | PCM | ERROR)
        || header[0] == READY && size != 0
        || header[0] == ERROR && size > 512
    {
        return Err(io::ErrorKind::InvalidData.into());
    }
    let mut bytes = vec![0; size];
    input.read_exact(&mut bytes)?;
    Ok((header[0], bytes))
}
#[derive(Default)]
struct Pending {
    packets: VecDeque<Vec<u8>>,
    error: Option<String>,
    stopped: bool,
}
#[derive(Default)]
struct State {
    pending: Mutex<Pending>,
    changed: Condvar,
}
impl State {
    fn read(&self) -> Result<Vec<u8>, String> {
        let pending = self
            .pending
            .lock()
            .map_err(|_| "native_audio_queue_poisoned")?;
        let (mut pending, _) = self
            .changed
            .wait_timeout_while(pending, Duration::from_secs(2), |p| {
                p.packets.is_empty() && p.error.is_none() && !p.stopped
            })
            .map_err(|_| "native_audio_queue_poisoned")?;
        if pending.stopped {
            return Err("native_audio_retired".into());
        }
        if let Some(error) = &pending.error {
            return Err(error.clone());
        }
        pending
            .packets
            .pop_front()
            .ok_or_else(|| "macos_audio_worker_read_timeout".into())
    }
    fn fail(&self, error: String) {
        if let Ok(mut pending) = self.pending.lock() {
            if !pending.stopped {
                pending.error = Some(error);
            }
            self.changed.notify_all();
        }
    }
}
fn receive(mut input: impl Read, state: Arc<State>, startup: mpsc::SyncSender<Result<(), String>>) {
    let ready = match read_frame(&mut input) {
        Ok((READY, _)) => Ok(()),
        Ok((ERROR, error)) => Err(String::from_utf8_lossy(&error).into_owned()),
        _ => Err("macos_audio_worker_start_failed".into()),
    };
    let success = ready.is_ok();
    if startup.send(ready).is_err() || !success {
        return;
    }
    loop {
        match read_frame(&mut input) {
            Ok((PCM, packet)) => {
                let Ok(mut pending) = state.pending.lock() else {
                    return;
                };
                if pending.stopped {
                    return;
                }
                // Keep sequence numbers intact so Web Audio detects dropped
                // packets and resets instead of replaying stale audio.
                if pending.packets.len() == MAX_PENDING {
                    pending.packets.pop_front();
                }
                pending.packets.push_back(packet);
                state.changed.notify_all();
            }
            Ok((ERROR, error)) => {
                state.fail(String::from_utf8_lossy(&error).into_owned());
                return;
            }
            _ => {
                state.fail("macos_audio_worker_ended".into());
                return;
            }
        }
    }
}
struct Worker {
    child: Child,
    state: Arc<State>,
    reaped: bool,
}
impl Worker {
    fn launch(command: &mut Command, timeout: Duration) -> Result<Self, String> {
        let mut child = command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|_| "macos_audio_worker_spawn_failed")?;
        let output = child
            .stdout
            .take()
            .ok_or("macos_audio_worker_pipe_failed")?;
        let state = Arc::new(State::default());
        let reader = state.clone();
        let (send, ready) = mpsc::sync_channel(1);
        let mut worker = Self {
            child,
            state,
            reaped: false,
        };
        if thread::Builder::new()
            .name("macos-audio-reader".into())
            .spawn(move || receive(output, reader, send))
            .is_err()
        {
            return Err("macos_audio_worker_reader_failed".into());
        }
        match ready.recv_timeout(timeout) {
            Ok(Ok(())) => Ok(worker),
            result => {
                let error = match result {
                    Ok(Err(error)) => error,
                    _ => "macos_audio_worker_start_timeout".into(),
                };
                worker.retire(Duration::from_millis(100))?;
                Err(error)
            }
        }
    }
    fn retire(&mut self, timeout: Duration) -> Result<(), String> {
        if self.reaped {
            return Ok(());
        }
        if let Ok(mut pending) = self.state.pending.lock() {
            pending.stopped = true;
            pending.packets.clear();
            self.state.changed.notify_all();
        }
        // EOF requests cleanup and also handles an unexpectedly dead host.
        drop(self.child.stdin.take());
        let until = Instant::now() + timeout;
        loop {
            match self.child.try_wait() {
                Ok(Some(_)) => {
                    self.reaped = true;
                    return Ok(());
                }
                Ok(None) if Instant::now() < until => thread::sleep(Duration::from_millis(10)),
                _ => break,
            }
        }
        // Even a hung framework stop must not retain the replayd connection.
        let _ = self.child.kill();
        self.child
            .wait()
            .map_err(|_| "macos_audio_worker_cleanup_failed")?;
        self.reaped = true;
        Ok(())
    }
}
impl Drop for Worker {
    fn drop(&mut self) {
        let _ = self.retire(Duration::from_millis(100));
    }
}
struct Controller {
    id: String,
    worker: Worker,
}
static ACTIVE: Mutex<Option<Controller>> = Mutex::new(None);
fn format(pid: u32) -> serde_json::Value {
    extern "C" {
        fn nearcast_core_audio_available() -> u8;
    }
    let source = if unsafe { nearcast_core_audio_available() } != 0 {
        "coreaudio-tap"
    } else {
        "screencapturekit"
    };
    serde_json::json!({"source":source,"scope":"system-excluding-self",
        "sampleRate":super::RATE,"channels":super::CHANNELS,"workerProcessId":pid})
}
pub fn start(id: &str) -> Result<serde_json::Value, String> {
    let mut active = ACTIVE.lock().map_err(|_| "native_audio_state_poisoned")?;
    if let Some(owner) = active.as_ref() {
        if owner.id == id {
            let pending = owner
                .worker
                .state
                .pending
                .lock()
                .map_err(|_| "native_audio_queue_poisoned")?;
            if let Some(error) = &pending.error {
                return Err(error.clone());
            }
            if !pending.stopped {
                return Ok(format(owner.worker.child.id()));
            }
        }
        return Err("native_audio_cleanup_required".into());
    }
    let executable =
        std::env::current_exe().map_err(|_| "macos_audio_worker_executable_missing")?;
    let worker = Worker::launch(
        Command::new(executable).arg(WORKER_ARG).arg(id),
        Duration::from_secs(15),
    )?;
    let response = format(worker.child.id());
    *active = Some(Controller {
        id: id.into(),
        worker,
    });
    Ok(response)
}
pub fn read(id: &str) -> Result<Vec<u8>, String> {
    let state = ACTIVE
        .lock()
        .map_err(|_| "native_audio_state_poisoned")?
        .as_ref()
        .filter(|owner| owner.id == id)
        .map(|owner| owner.worker.state.clone())
        .ok_or("native_audio_not_active")?;
    state.read()
}
pub fn stop(id: &str) -> Result<(), String> {
    let mut active = ACTIVE.lock().map_err(|_| "native_audio_state_poisoned")?;
    if let Some(owner) = active.as_mut().filter(|owner| owner.id == id) {
        owner.worker.retire(Duration::from_secs(4))?;
        *active = None;
    }
    Ok(())
}
pub fn shutdown() {
    if let Ok(mut active) = ACTIVE.lock() {
        if let Some(mut owner) = active.take() {
            let _ = owner.worker.retire(Duration::from_secs(4));
        }
    }
}

// Called before Tauri/WKWebView initialization. The same signed executable
// runs an audio-only worker, with no window, picker or network connection.
pub fn run_worker_if_requested() {
    let args: Vec<_> = std::env::args().collect();
    if args.get(1).map(String::as_str) != Some(WORKER_ARG) {
        return;
    }
    extern "C" {
        fn getppid() -> i32;
    }
    if !is_host_process(unsafe { getppid() })
        || args.len() != 3
        || args[2].len() != 36
        || !args[2].bytes().all(|b| b.is_ascii_hexdigit() || b == b'-')
    {
        std::process::exit(2);
    }
    let id = args[2].clone();
    thread::spawn(|| {
        let mut stop = [0];
        let _ = io::stdin().read(&mut stop);
        STOP_REQUESTED.store(true, Ordering::Release);
        super::macos_capture::shutdown();
        std::process::exit(0);
    });
    thread::spawn(move || {
        let mut output = io::stdout().lock();
        match super::macos_capture::start(&id) {
            Ok(_) => {
                if write_frame(&mut output, READY, &[]).is_err() {
                    std::process::exit(1);
                }
            }
            Err(error) => {
                let stopping = STOP_REQUESTED.load(Ordering::Acquire);
                if !stopping {
                    let _ = write_frame(&mut output, ERROR, error.as_bytes());
                }
                super::macos_capture::shutdown();
                std::process::exit(if stopping { 0 } else { 1 });
            }
        }
        loop {
            match super::macos_capture::read(&id) {
                Ok(packet) => {
                    if write_frame(&mut output, PCM, &packet).is_ok() {
                        continue;
                    }
                    // Closing the host's pipe is a normal end of the lease.
                    super::macos_capture::shutdown();
                    std::process::exit(0);
                }
                Err(error) => {
                    let stopping = STOP_REQUESTED.load(Ordering::Acquire);
                    if !stopping {
                        let _ = write_frame(&mut output, ERROR, error.as_bytes());
                    }
                    super::macos_capture::shutdown();
                    std::process::exit(if stopping { 0 } else { 1 });
                }
            }
        }
    });
    extern "C" {
        fn nearcast_macos_audio_worker_run_loop();
    }
    unsafe {
        nearcast_macos_audio_worker_run_loop();
    }
    std::process::exit(1);
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn framed_transport_rejects_oversize_unknown_and_truncated_packets() {
        for bytes in [
            &[1, 255, 255, 255, 255][..],
            &[3, 0, 0, 0, 0],
            &[0, 0, 0, 0, 1, 0],
            &[1, 0, 0, 0, 2, 0],
        ] {
            assert!(read_frame(&mut io::Cursor::new(bytes)).is_err());
        }
        let mut wire = Vec::new();
        write_frame(&mut wire, PCM, b"known-pcm").unwrap();
        assert_eq!(wire, b"\x01\x00\x00\x00\x09known-pcm");
        assert_eq!(
            read_frame(&mut io::Cursor::new(wire)).unwrap(),
            (PCM, b"known-pcm".to_vec())
        );
    }
    fn fixture(script: &str) -> Command {
        let mut command = Command::new("/bin/sh");
        command.args(["-c", script]);
        command
    }
    #[test]
    fn real_worker_pipe_delivers_pcm_and_stop_reaps_the_process() {
        let mut worker = Worker::launch(
            &mut fixture(
                "printf '\\000\\000\\000\\000\\000\\001\\000\\000\\000\\003pcm'; cat >/dev/null",
            ),
            Duration::from_secs(5),
        )
        .unwrap();
        assert_ne!(worker.child.id(), std::process::id());
        assert_eq!(worker.state.read().unwrap(), b"pcm");
        worker.retire(Duration::from_secs(1)).unwrap();
        assert!(worker.child.try_wait().unwrap().is_some());
        assert_eq!(worker.state.read().unwrap_err(), "native_audio_retired");
    }
    #[test]
    fn startup_error_and_hung_stop_cannot_leave_an_audio_worker_alive() {
        let error = Worker::launch(
            &mut fixture("printf '\\002\\000\\000\\000\\037macos_audio_permission_required'"),
            Duration::from_secs(5),
        )
        .err()
        .unwrap();
        assert_eq!(error, "macos_audio_permission_required");
        let mut worker = Worker::launch(
            &mut fixture("printf '\\000\\000\\000\\000\\000'; exec /bin/sleep 30"),
            Duration::from_secs(5),
        )
        .unwrap();
        worker.retire(Duration::from_millis(20)).unwrap();
        assert!(worker.child.try_wait().unwrap().is_some());
    }
    #[test]
    fn a_full_consumer_queue_stays_bounded_and_reports_worker_failure() {
        let state = Arc::new(State::default());
        let (tx, ready) = mpsc::sync_channel(1);
        let mut bytes = Vec::new();
        write_frame(&mut bytes, READY, &[]).unwrap();
        for i in 0..20 {
            write_frame(&mut bytes, PCM, &[i]).unwrap();
        }
        write_frame(&mut bytes, ERROR, b"fixture-failure").unwrap();
        receive(io::Cursor::new(bytes), state.clone(), tx);
        assert!(ready.recv().unwrap().is_ok());
        let pending = state.pending.lock().unwrap();
        assert_eq!(pending.packets.len(), 4);
        assert_eq!(pending.packets.front().unwrap(), &[16]);
        assert_eq!(pending.error.as_deref(), Some("fixture-failure"));
    }
}
