// Session-scoped WASAPI loopback. All COM interfaces stay on one MTA worker.
// The IPC carries bounded float PCM, never pointers or audio device handles.
use std::collections::VecDeque;

const RATE: u32 = 48_000;
const CHANNELS: usize = 2;
const MAX_QUEUED_FRAMES: usize = 9_600;
const MAX_PACKET_FRAMES: usize = 1_920;

#[derive(Default)]
struct PcmQueue {
    samples: VecDeque<f32>,
    sequence: u64,
    discontinuities: u64,
    error: Option<String>,
    stopped: bool,
}
impl PcmQueue {
    fn push(&mut self, samples: &[f32], discontinuity: bool) {
        if discontinuity {
            self.samples.clear();
            self.discontinuities += 1;
        }
        self.samples.extend(samples.iter().copied().map(|s| {
            if s.is_finite() {
                s.clamp(-1.0, 1.0)
            } else {
                0.0
            }
        }));
        let limit = MAX_QUEUED_FRAMES * CHANNELS;
        if self.samples.len() > limit {
            let excess = self.samples.len() - limit;
            self.samples.drain(..excess);
            self.discontinuities += 1;
        }
    }
    fn packet(&mut self, id: &str) -> Result<Vec<u8>, String> {
        if let Some(error) = &self.error {
            return Err(error.clone());
        }
        if self.stopped {
            return Err("native_audio_retired".into());
        }
        let count = self.samples.len().min(MAX_PACKET_FRAMES * CHANNELS) / CHANNELS * CHANNELS;
        self.sequence += 1;
        let metadata = serde_json::to_vec(&serde_json::json!({
            "captureId": id, "format": "f32le", "sampleRate": RATE, "channels": CHANNELS,
            "frames": count / CHANNELS, "sequence": self.sequence, "discontinuities": self.discontinuities
        })).map_err(|e| e.to_string())?;
        let mut bytes = Vec::with_capacity(4 + metadata.len() + count * 4);
        bytes.extend_from_slice(&(metadata.len() as u32).to_be_bytes());
        bytes.extend(metadata);
        for sample in self.samples.drain(..count) {
            bytes.extend_from_slice(&sample.to_le_bytes());
        }
        Ok(bytes)
    }
}

#[cfg(windows)]
pub use platform::*;
#[cfg(windows)]
mod platform {
    use super::*;
    use std::sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc, Condvar, Mutex,
    };
    use std::time::{Duration, Instant};
    use windows::Win32::{Media::Audio::*, System::Com::*};

    struct State {
        id: String,
        queue: Mutex<PcmQueue>,
        changed: Condvar,
        stop: AtomicBool,
    }
    struct Controller {
        state: Arc<State>,
        done: mpsc::Receiver<()>,
    }
    static ACTIVE: Mutex<Option<Controller>> = Mutex::new(None);
    fn error(e: windows::core::Error) -> String {
        format!("WASAPI 0x{:08X}: {}", e.code().0 as u32, e.message())
    }

    struct Apartment;
    impl Apartment {
        fn new() -> Result<Self, String> {
            unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) }
                .ok()
                .map_err(error)?;
            Ok(Self)
        }
    }
    impl Drop for Apartment {
        fn drop(&mut self) {
            unsafe {
                CoUninitialize();
            }
        }
    }

    struct Loopback {
        capture: IAudioCaptureClient,
        client: IAudioClient,
        _device: IMMDevice,
        _apartment: Apartment,
    }
    fn format() -> WAVEFORMATEX {
        WAVEFORMATEX {
            wFormatTag: 3,
            nChannels: CHANNELS as u16,
            nSamplesPerSec: RATE,
            nAvgBytesPerSec: RATE * CHANNELS as u32 * 4,
            nBlockAlign: CHANNELS as u16 * 4,
            wBitsPerSample: 32,
            cbSize: 0,
        }
    }
    impl Loopback {
        fn new() -> Result<Self, String> {
            let apartment = Apartment::new()?;
            let enumerator: IMMDeviceEnumerator =
                unsafe { CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL) }
                    .map_err(error)?;
            // Render endpoint loopback only: never eCapture (microphone).
            let device =
                unsafe { enumerator.GetDefaultAudioEndpoint(eRender, eConsole) }.map_err(error)?;
            let client: IAudioClient =
                unsafe { device.Activate(CLSCTX_ALL, None) }.map_err(error)?;
            unsafe {
                client.Initialize(
                    AUDCLNT_SHAREMODE_SHARED,
                    AUDCLNT_STREAMFLAGS_LOOPBACK
                        | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM
                        | AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY,
                    1_000_000,
                    0,
                    &format(),
                    None,
                )
            }
            .map_err(error)?;
            let capture: IAudioCaptureClient = unsafe { client.GetService() }.map_err(error)?;
            unsafe { client.Start() }.map_err(error)?;
            Ok(Self {
                capture,
                client,
                _device: device,
                _apartment: apartment,
            })
        }
        fn drain(&self, state: &State) -> Result<bool, String> {
            let mut any = false;
            // Bound each tick even if the device keeps returning packets.
            for _ in 0..64 {
                if unsafe { self.capture.GetNextPacketSize() }.map_err(error)? == 0 {
                    break;
                }
                let mut data = std::ptr::null_mut();
                let mut frames = 0;
                let mut flags = 0;
                unsafe {
                    self.capture
                        .GetBuffer(&mut data, &mut frames, &mut flags, None, None)
                }
                .map_err(error)?;
                // ReleaseBuffer must happen even when validation or allocation fails.
                let copied = (|| -> Result<Vec<f32>, String> {
                    if frames as usize > RATE as usize {
                        return Err("native_audio_packet_budget".into());
                    }
                    let count = frames as usize * CHANNELS;
                    if count == 0 || flags & AUDCLNT_BUFFERFLAGS_SILENT.0 as u32 != 0 {
                        return Ok(vec![0.0; count]);
                    }
                    if data.is_null() {
                        return Err("native_audio_null_buffer".into());
                    }
                    let bytes = unsafe { std::slice::from_raw_parts(data, count * 4) };
                    Ok(bytes
                        .chunks_exact(4)
                        .map(|b| f32::from_le_bytes(b.try_into().unwrap()))
                        .collect())
                })();
                unsafe { self.capture.ReleaseBuffer(frames) }.map_err(error)?;
                let samples = copied?;
                let mut queue = state
                    .queue
                    .lock()
                    .map_err(|_| "native_audio_queue_poisoned")?;
                queue.push(
                    &samples,
                    flags & AUDCLNT_BUFFERFLAGS_DATA_DISCONTINUITY.0 as u32 != 0,
                );
                drop(queue);
                state.changed.notify_all();
                any = true;
            }
            Ok(any)
        }
    }
    impl Drop for Loopback {
        fn drop(&mut self) {
            let _ = unsafe { self.client.Stop() };
        }
    }

    // The caller owns an opaque session ID, independently of the video backend.
    pub fn start(id: &str) -> Result<serde_json::Value, String> {
        let mut active = ACTIVE.lock().map_err(|_| "native_audio_state_poisoned")?;
        if let Some(controller) = active.as_ref() {
            if controller.state.id == id && !controller.state.stop.load(Ordering::Acquire) {
                let queue = controller
                    .state
                    .queue
                    .lock()
                    .map_err(|_| "native_audio_queue_poisoned")?;
                if let Some(error) = &queue.error {
                    return Err(error.clone());
                }
                return Ok(
                    serde_json::json!({"source":"wasapi-loopback","sampleRate":RATE,"channels":CHANNELS}),
                );
            }
            return Err("native_audio_cleanup_required".into());
        }
        let state = Arc::new(State {
            id: id.into(),
            queue: Mutex::new(PcmQueue::default()),
            changed: Condvar::new(),
            stop: AtomicBool::new(false),
        });
        let worker = state.clone();
        let (ready, started) = mpsc::sync_channel(1);
        let (done, finished) = mpsc::sync_channel(1);
        std::thread::spawn(move || {
            let run = (|| -> Result<(), String> {
                let source = Loopback::new()?;
                if ready.send(Ok(())).is_err() {
                    return Ok(());
                }
                let mut last_packet = Instant::now();
                while !worker.stop.load(Ordering::Acquire) {
                    if source.drain(&worker)? {
                        last_packet = Instant::now();
                    } else if last_packet.elapsed() >= Duration::from_millis(20) {
                        // A silent output device need not produce WASAPI packets.
                        // Keep the WebRTC audio clock alive with bounded silence.
                        worker
                            .queue
                            .lock()
                            .map_err(|_| "native_audio_queue_poisoned")?
                            .push(&[0.0; 960 * CHANNELS], false);
                        worker.changed.notify_all();
                        last_packet = Instant::now();
                    }
                    std::thread::sleep(Duration::from_millis(5));
                }
                Ok(())
            })();
            if let Err(failure) = run {
                let _ = ready.send(Err(failure.clone()));
                if let Ok(mut queue) = worker.queue.lock() {
                    queue.error = Some(failure);
                }
            }
            if let Ok(mut queue) = worker.queue.lock() {
                queue.stopped = true;
            }
            worker.changed.notify_all();
            let _ = done.send(());
        });
        *active = Some(Controller {
            state: state.clone(),
            done: finished,
        });
        match started.recv_timeout(Duration::from_secs(3)) {
            Ok(Ok(())) => Ok(
                serde_json::json!({"source":"wasapi-loopback","sampleRate":RATE,"channels":CHANNELS}),
            ),
            result => {
                state.stop.store(true, Ordering::Release);
                let failure = match result {
                    Ok(Err(e)) => e,
                    _ => "native_audio_start_timeout".into(),
                };
                if active
                    .as_ref()
                    .unwrap()
                    .done
                    .recv_timeout(Duration::from_secs(1))
                    .is_ok()
                {
                    *active = None;
                }
                Err(failure)
            }
        }
    }
    pub fn read(id: &str) -> Result<Vec<u8>, String> {
        let state = ACTIVE
            .lock()
            .map_err(|_| "native_audio_state_poisoned")?
            .as_ref()
            .filter(|c| c.state.id == id)
            .map(|c| c.state.clone())
            .ok_or("native_audio_not_active")?;
        let queue = state
            .queue
            .lock()
            .map_err(|_| "native_audio_queue_poisoned")?;
        let (mut queue, _) = state
            .changed
            .wait_timeout_while(queue, Duration::from_millis(40), |q| {
                q.samples.len() < 960 * CHANNELS && q.error.is_none() && !q.stopped
            })
            .map_err(|_| "native_audio_queue_poisoned")?;
        queue.packet(id)
    }
    pub fn stop(id: &str) -> Result<(), String> {
        let mut active = ACTIVE.lock().map_err(|_| "native_audio_state_poisoned")?;
        if let Some(controller) = active.as_ref().filter(|c| c.state.id == id) {
            controller.state.stop.store(true, Ordering::Release);
            // Do not erase a new controller on a late stop for an old capture.
            controller
                .done
                .recv_timeout(Duration::from_secs(1))
                .map_err(|_| "native_audio_stop_timeout")?;
            *active = None;
        }
        Ok(())
    }
    pub fn shutdown() {
        let id = ACTIVE
            .lock()
            .ok()
            .and_then(|active| active.as_ref().map(|c| c.state.id.clone()));
        if let Some(id) = id {
            let _ = stop(&id);
        }
    }

    #[cfg(test)]
    mod live_tests {
        use super::*;
        #[test]
        #[ignore = "plays a quiet one-second owned tone on the default render device and captures only loopback PCM"]
        fn wasapi_loopback_captures_rendered_tone_and_releases_on_stop() {
            start("audio-fixture").unwrap();
            struct Cleanup;
            impl Drop for Cleanup {
                fn drop(&mut self) {
                    let _ = stop("audio-fixture");
                }
            }
            let _cleanup = Cleanup;
            assert!(read("foreign-capture").is_err());
            stop("foreign-capture").unwrap();
            let renderer = std::thread::spawn(|| -> Result<(), String> {
                let _apartment = Apartment::new()?;
                let enumerator: IMMDeviceEnumerator =
                    unsafe { CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL) }
                        .map_err(error)?;
                let device = unsafe { enumerator.GetDefaultAudioEndpoint(eRender, eConsole) }
                    .map_err(error)?;
                let client: IAudioClient =
                    unsafe { device.Activate(CLSCTX_ALL, None) }.map_err(error)?;
                unsafe {
                    client.Initialize(
                        AUDCLNT_SHAREMODE_SHARED,
                        AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM
                            | AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY,
                        1_000_000,
                        0,
                        &format(),
                        None,
                    )
                }
                .map_err(error)?;
                let render: IAudioRenderClient = unsafe { client.GetService() }.map_err(error)?;
                let capacity = unsafe { client.GetBufferSize() }.map_err(error)?;
                unsafe { client.Start() }.map_err(error)?;
                let result = (|| -> Result<(), String> {
                    let until = Instant::now() + Duration::from_secs(1);
                    let mut position = 0;
                    while Instant::now() < until {
                        let free =
                            capacity - unsafe { client.GetCurrentPadding() }.map_err(error)?;
                        if free > 0 {
                            let bytes = unsafe { render.GetBuffer(free) }.map_err(error)?;
                            let output = unsafe {
                                std::slice::from_raw_parts_mut(
                                    bytes as *mut f32,
                                    free as usize * CHANNELS,
                                )
                            };
                            for frame in output.chunks_exact_mut(2) {
                                let value = 0.03
                                    * (position as f32 * 2.0 * std::f32::consts::PI * 440.0
                                        / RATE as f32)
                                        .sin();
                                frame.fill(value);
                                position += 1;
                            }
                            unsafe { render.ReleaseBuffer(free, 0) }.map_err(error)?;
                        }
                        std::thread::sleep(Duration::from_millis(5));
                    }
                    Ok(())
                })();
                unsafe { client.Stop() }.map_err(error)?;
                result
            });
            let mut samples = Vec::new();
            let mut peak = 0.0f32;
            let until = Instant::now() + Duration::from_millis(1300);
            while Instant::now() < until {
                let bytes = read("audio-fixture").unwrap();
                let len = u32::from_be_bytes(bytes[..4].try_into().unwrap()) as usize;
                for b in bytes[4 + len..].chunks_exact(4) {
                    let value = f32::from_le_bytes(b.try_into().unwrap());
                    peak = peak.max(value.abs());
                    samples.extend_from_slice(b);
                }
            }
            renderer.join().unwrap().unwrap();
            assert!(peak > 0.0001, "loopback captured only silence: {peak}");
            if let Some(path) = std::env::var_os("NEARCAST_AUDIO_PCM_FIXTURE") {
                std::fs::write(path, &samples).unwrap();
            }
            stop("audio-fixture").unwrap();
            assert!(read("audio-fixture").is_err());
            start("audio-restart").unwrap();
            stop("audio-fixture").unwrap();
            assert!(!read("audio-restart").unwrap().is_empty());
            stop("audio-restart").unwrap();
            println!(
                "WASAPI fixture: peak={peak}, stereoFrames={}",
                samples.len() / 8
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn pcm_queue_is_bounded_and_discontinuity_flushes_old_samples() {
        let mut queue = PcmQueue::default();
        queue.push(&vec![0.25; 24_000], false);
        assert_eq!(queue.samples.len(), 19_200);
        assert_eq!(queue.discontinuities, 1);
        queue.push(&[f32::NAN, 2.0, -2.0, -0.5], true);
        assert_eq!(
            queue.samples.iter().copied().collect::<Vec<_>>(),
            vec![0.0, 1.0, -1.0, -0.5]
        );
        let bytes = queue.packet("capture-1").unwrap();
        let len = u32::from_be_bytes(bytes[..4].try_into().unwrap()) as usize;
        let meta: serde_json::Value = serde_json::from_slice(&bytes[4..4 + len]).unwrap();
        assert_eq!(meta["frames"], 2);
        assert_eq!(meta["sampleRate"], 48000);
        assert_eq!(meta["captureId"], "capture-1");
        assert_eq!(meta["discontinuities"], 2);
        assert_eq!(&bytes[4 + len..8 + len], &[0, 0, 0, 0]);
    }
    #[test]
    fn stopped_or_failed_audio_cannot_emit_valid_pcm() {
        let mut queue = PcmQueue::default();
        queue.stopped = true;
        assert!(queue.packet("id").is_err());
        queue.error = Some("WASAPI 0x88890004".into());
        assert_eq!(queue.packet("id").unwrap_err(), "WASAPI 0x88890004");
    }
}
