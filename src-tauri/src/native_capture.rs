#[cfg(windows)]
pub use platform::*;

#[cfg(windows)]
mod platform {
    use crate::capture_target::{self, Rect, Target};
    use serde::Serialize;
    use sha2::{Digest, Sha256};
    use std::sync::{
        atomic::{AtomicBool, Ordering},
        mpsc::{self, SyncSender},
        Arc, Mutex,
    };
    use std::time::{Duration, Instant};
    use windows::{
        core::Interface,
        Graphics::{
            Capture::*,
            DirectX::{Direct3D11::IDirect3DDevice, DirectXPixelFormat},
        },
        Win32::{
            Foundation::HMODULE,
            Graphics::{Direct3D::D3D_DRIVER_TYPE_HARDWARE, Direct3D11::*, Dxgi::IDXGIDevice},
            System::WinRT::{
                Direct3D11::{CreateDirect3D11DeviceFromDXGIDevice, IDirect3DDxgiInterfaceAccess},
                Graphics::Capture::IGraphicsCaptureItemInterop,
                RoInitialize, RoUninitialize, RO_INIT_MULTITHREADED,
            },
        },
    };
    const MAX_PIXELS: usize = 3840 * 2160;
    // WinRT activation factories are cached by windows-rs. Keep the process MTA
    // alive across probe/capture workers so cached factories never outlive COM.
    static MTA: Mutex<Option<usize>> = Mutex::new(None);
    fn keep_mta() -> Result<(), String> {
        let mut cookie = MTA.lock().map_err(|_| "capture_mta_poisoned")?;
        if cookie.is_none() {
            *cookie = Some(
                unsafe { windows::Win32::System::Com::CoIncrementMTAUsage() }
                    .map_err(text_error)?
                    .0 as usize,
            );
        }
        Ok(())
    }
    pub fn shutdown_runtime() {
        shutdown();
        if let Ok(mut cookie) = MTA.lock() {
            if let Some(cookie) = cookie.take() {
                let _ = unsafe {
                    windows::Win32::System::Com::CoDecrementMTAUsage(
                        windows::Win32::System::Com::CO_MTA_USAGE_COOKIE(cookie as *mut _),
                    )
                };
            }
        }
    }
    pub fn supported() -> bool {
        static SUPPORTED: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
        *SUPPORTED.get_or_init(|| {
            std::thread::spawn(|| {
                let Ok(_apartment) = Apartment::new() else {
                    return false;
                };
                GraphicsCaptureSession::IsSupported().unwrap_or(false)
            })
            .join()
            .unwrap_or(false)
        })
    }
    #[derive(Clone, Debug, Serialize)]
    #[serde(rename_all = "camelCase")]
    pub struct Info {
        pub capture_id: String,
        pub native_id: String,
        pub kind: String,
        pub revision: String,
        pub units: &'static str,
        pub rotation: i32,
        pub region: crate::input_geometry::Region,
        pub capture_width: u32,
        pub capture_height: u32,
        pub input_ready: bool,
        pub disabled_reason: Option<String>,
        #[serde(skip)]
        pub native_region: Option<Rect>,
    }
    struct Observed {
        size: (i32, i32),
        frame_size: Option<(i32, i32)>,
        rect: Rect,
        last_frame: Option<Instant>,
        closed: Arc<AtomicBool>,
        layout: Option<capture_target::CaptureLayout>,
        capture_generation: u64,
    }
    enum Request {
        Frame(SyncSender<Result<Vec<u8>, String>>),
        Stop(SyncSender<()>),
    }
    struct Controller {
        id: String,
        target: Target,
        observed: Arc<Mutex<Observed>>,
        tx: SyncSender<Request>,
    }
    static ACTIVE: Mutex<Option<Controller>> = Mutex::new(None);
    fn text_error(e: impl std::fmt::Display) -> String {
        format!("native_capture: {e}")
    }
    struct Apartment;
    impl Apartment {
        fn new() -> Result<Self, String> {
            keep_mta()?;
            unsafe { RoInitialize(RO_INIT_MULTITHREADED) }.map_err(text_error)?;
            Ok(Self)
        }
    }
    impl Drop for Apartment {
        fn drop(&mut self) {
            unsafe {
                RoUninitialize();
            }
        }
    }
    pub fn fail(id: &str) {
        if let Ok(active) = ACTIVE.lock() {
            if let Some(c) = active.as_ref().filter(|c| c.id == id) {
                if let Ok(observed) = c.observed.lock() {
                    observed.closed.store(true, Ordering::Release);
                }
            }
        }
        let _ = crate::input_native::release_capture(&format!("capture:{id}"));
    }
    fn info(id: &str, target: &Target, observed: &Observed) -> Info {
        let current = if observed.closed.load(Ordering::Acquire) {
            Err("capture_target_closed".into())
        } else {
            target.bounds(Some(observed.size))
        };
        let (rect, mut reason) = match current {
            Ok(rect) => (rect, None),
            Err(reason) => (observed.rect, Some(reason)),
        };
        if reason.is_none() && !target.input_ready() {
            reason = Some("capture_window_not_foreground".into());
        }
        if reason.is_none() && target.capture_layout().ok().as_ref() != Some(&observed.layout) {
            reason = Some("capture_window_geometry_changed".into());
        }
        if reason.is_none()
            && (observed.last_frame.is_none() || observed.frame_size != Some(observed.size))
        {
            reason = Some("capture_waiting_for_frame".into());
        }
        let revision = format!(
            "{:x}",
            Sha256::digest(format!("{id}:{:?}:{:?}:{}:{:?}", rect, observed.size, observed.capture_generation, observed.layout).as_bytes())
        );
        Info {
            capture_id: id.into(),
            native_id: format!("capture:{id}"),
            kind: target.kind().into(),
            revision,
            units: "physical-pixels",
            rotation: 0,
            region: crate::input_geometry::Region {
                x: rect.x as f64,
                y: rect.y as f64,
                width: rect.width as f64,
                height: rect.height as f64,
            },
            capture_width: observed.size.0.max(0) as u32,
            capture_height: observed.size.1.max(0) as u32,
            input_ready: reason.is_none(),
            disabled_reason: reason,
            native_region: if observed.closed.load(Ordering::Acquire) { None } else { target.bounds(None).ok() },
        }
    }
    pub fn snapshot() -> Option<Info> {
        let active = ACTIVE.lock().ok()?;
        let controller = active.as_ref()?;
        let observed = controller.observed.lock().ok()?;
        Some(info(&controller.id, &controller.target, &observed))
    }
    pub fn current(id: &str, revision: &str) -> Result<Info, String> {
        let state = snapshot().ok_or("capture_not_active")?;
        if state.native_id != id || state.revision != revision || !state.input_ready {
            return Err(state
                .disabled_reason
                .unwrap_or("capture_geometry_changed".into()));
        }
        Ok(state)
    }
    pub fn hit_target(id: &str, x: i32, y: i32) -> bool {
        ACTIVE
            .lock()
            .ok()
            .and_then(|active| {
                active
                    .as_ref()
                    .map(|c| format!("capture:{}", c.id) == id && c.target.hit_target(x, y))
            })
            .unwrap_or(false)
    }
    fn nonce() -> Result<String, String> {
        let mut bytes = [0; 16];
        getrandom::fill(&mut bytes).map_err(text_error)?;
        Ok(bytes.iter().map(|v| format!("{v:02x}")).collect())
    }
    pub fn thumbnail(target_id: &str) -> Result<Vec<u8>, String> {
        use std::sync::atomic::AtomicUsize;
        static PREVIEWS: AtomicUsize = AtomicUsize::new(0);
        PREVIEWS
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |active| {
                if active < 2 {
                    Some(active + 1)
                } else {
                    None
                }
            })
            .map_err(|_| "capture_preview_busy")?;
        struct Permit;
        impl Drop for Permit {
            fn drop(&mut self) {
                PREVIEWS.fetch_sub(1, Ordering::AcqRel);
            }
        }
        let _permit = Permit;
        if ACTIVE
            .lock()
            .map_err(|_| "capture_state_poisoned")?
            .is_some()
        {
            return Err("capture_preview_requires_picker".into());
        }
        let target = capture_target::resolve(target_id)?;
        target.bounds(None)?;
        let _apartment = Apartment::new()?;
        let mut capture = GpuCapture::new(&target, Arc::new(AtomicBool::new(false)))?;
        let until = Instant::now() + Duration::from_millis(1200);
        while Instant::now() < until {
            let pixels = capture.read()?;
            if !pixels.is_empty() {
                target.bounds(Some((capture.size.Width, capture.size.Height)))?;
                return crate::capture_thumbnail::encode_bgra_bmp(
                    &pixels,
                    capture.size.Width,
                    capture.size.Height,
                );
            }
        }
        Err("capture_preview_frame_timeout".into())
    }

    pub fn start(target_id: &str) -> Result<Info, String> {
        if crate::input_native::is_owned() {
            return Err("native_input_cleanup_required_before_capture_change".into());
        }
        let target = capture_target::resolve(target_id)?;
        let mut active = ACTIVE.lock().map_err(|_| "capture_state_poisoned")?;
        if active.is_some() {
            return Err("capture_already_active".into());
        }
        target.activate();
        let rect = target.bounds(None)?;
        let id = nonce()?;
        let observed = Arc::new(Mutex::new(Observed {
            size: (rect.width, rect.height),
            frame_size: None,
            rect,
            last_frame: None,
            closed: Arc::new(AtomicBool::new(false)),
            layout: target.capture_layout()?,
            capture_generation: 1,
        }));
        let (tx, rx) = mpsc::sync_channel(2);
        let (ready_tx, ready_rx) = mpsc::sync_channel(1);
        let worker_target = target.clone();
        let worker_id = id.clone();
        let worker_observed = observed.clone();
        std::thread::spawn(move || {
            let closed = worker_observed.lock().unwrap().closed.clone();
            let apartment = Apartment::new();
            let result = apartment
                .as_ref()
                .map_err(Clone::clone)
                .and_then(|_| GpuCapture::new(&worker_target, closed));
            match result {
                Err(error) => {
                    let _ = ready_tx.send(Err(error));
                }
                Ok(mut capture) => {
                    if let Ok(mut obs) = worker_observed.lock() {
                        obs.size = (capture.size.Width, capture.size.Height);
                        if let Ok(rect) = worker_target.bounds(Some(obs.size)) {
                            obs.rect = rect;
                        }
                    }
                    if ready_tx.send(Ok(())).is_ok() {
                        let mut sequence = 0u64;
                        let mut pending_layout = None;
                        while let Ok(request) = rx.recv_timeout(Duration::from_secs(10)) {
                            match request {
                                Request::Stop(done) => {
                                    drop(capture);
                                    let _ = done.send(());
                                    return;
                                }
                                Request::Frame(reply) => {
                                    let result = (|| {
                                        let pixels = if let Ok(layout) = worker_target.capture_layout() {
                                            let changed = {
                                                let mut obs = worker_observed.lock().map_err(|_| "capture_observation_poisoned")?;
                                                let changed = obs.layout != layout;
                                                if changed { obs.frame_size = None; }
                                                changed
                                            };
                                            if changed && pending_layout.as_ref() != Some(&layout) {
                                                // Return the invalid source before expensive WGC
                                                // reconstruction so JS can fence queued old input.
                                                pending_layout = Some(layout);
                                                Vec::new()
                                            } else {
                                                if changed {
                                                    crate::input_native::release_stale_capture(&format!("capture:{worker_id}"), "", false)?;
                                                    capture.restart(&worker_target)?;
                                                    let mut obs = worker_observed.lock().map_err(|_| "capture_observation_poisoned")?;
                                                    obs.layout = layout;
                                                    obs.capture_generation += 1;
                                                    obs.size = (capture.size.Width, capture.size.Height);
                                                    obs.frame_size = None;
                                                }
                                                pending_layout = None;
                                                capture.read()?
                                            }
                                        } else { capture.read()? };
                                        let geometry = {
                                            let mut obs = worker_observed.lock().map_err(|_| "capture_observation_poisoned")?;
                                            obs.size = (capture.size.Width, capture.size.Height);
                                            if let Ok(rect) = worker_target.bounds(Some(obs.size)) { obs.rect = rect; }
                                            if !pixels.is_empty() {
                                                obs.last_frame = Some(Instant::now());
                                                obs.frame_size = Some(obs.size);
                                                sequence += 1;
                                            }
                                            info(&worker_id, &worker_target, &obs)
                                        };
                                        let (width,height) = if pixels.is_empty() {(0,0)} else {(capture.size.Width,capture.size.Height)};
                                        let mut diagnostics = capture.last_readback.clone().unwrap_or_else(|| serde_json::json!({}));
                                        diagnostics["nativeRegion"] = serde_json::to_value(geometry.native_region).map_err(text_error)?;
                                        {
                                            let obs = worker_observed.lock().map_err(|_| "capture_observation_poisoned")?;
                                            diagnostics["captureGeneration"] = serde_json::json!(obs.capture_generation);
                                            diagnostics["captureLayout"] = serde_json::to_value(&obs.layout).map_err(text_error)?;
                                        }
                                        let metadata = serde_json::to_vec(&serde_json::json!({
                                            "captureId":worker_id, "pixelFormat":"BGRA8", "frameId":sequence,
                                            "width":width, "height":height, "geometry":geometry,
                                            "nativeCapture":diagnostics,
                                            "indicator":crate::capture_indicator::status(&worker_id)
                                        })).map_err(text_error)?;
                                        let mut packet = Vec::with_capacity(4 + metadata.len() + pixels.len());
                                        packet.extend_from_slice(&(metadata.len() as u32).to_be_bytes());
                                        packet.extend_from_slice(&metadata);
                                        packet.extend_from_slice(&pixels);
                                        Ok(packet)
                                    })();
                                    let failed = result.is_err();
                                    let _ = reply.send(result);
                                    if failed {
                                        break;
                                    }
                                }
                            }
                        }
                    }
                }
            }
            if let Ok(obs) = worker_observed.lock() {
                obs.closed.store(true, Ordering::Release);
            }
            let _ = crate::input_native::release_capture(&format!("capture:{worker_id}"));
        });
        ready_rx
            .recv_timeout(Duration::from_secs(5))
            .map_err(text_error)??;
        let result = {
            let observed = observed
                .lock()
                .map_err(|_| "capture_observation_poisoned")?;
            info(&id, &target, &observed)
        };
        *active = Some(Controller {
            id: id.clone(),
            target,
            observed,
            tx,
        });
        drop(active);
        if let Err(error) = crate::capture_indicator::start(&id) {
            let _ = stop(&id);
            return Err(error);
        }
        Ok(result)
    }
    pub fn frame(id: &str) -> Result<Vec<u8>, String> {
        let tx = {
            let active = ACTIVE.lock().map_err(|_| "capture_state_poisoned")?;
            let c = active
                .as_ref()
                .filter(|c| c.id == id)
                .ok_or("capture_retired")?;
            c.tx.clone()
        };
        let (reply, receive) = mpsc::sync_channel(1);
        tx.try_send(Request::Frame(reply)).map_err(text_error)?;
        receive
            .recv_timeout(Duration::from_secs(2))
            .map_err(text_error)?
    }
    pub fn stop(id: &str) -> Result<(), String> {
        let border = crate::capture_indicator::stop(id);
        let cleanup = crate::input_native::release_capture(&format!("capture:{id}"));
        let controller = {
            let mut active = ACTIVE.lock().map_err(|_| "capture_state_poisoned")?;
            if active.as_ref().is_none_or(|c| c.id != id) {
                border?;
                return cleanup;
            }
            active.take().unwrap()
        };
        let (done, wait) = mpsc::sync_channel(1);
        if controller.tx.try_send(Request::Stop(done)).is_ok() {
            wait.recv_timeout(Duration::from_secs(2))
                .map_err(text_error)?;
        }
        border?;
        cleanup
    }
    pub fn indicator(
        id: &str,
        revision: &str,
        active: bool,
        owner_id: Option<&str>,
        sequence: u32,
    ) -> Result<(), String> {
        if active {
            let capture = current(&format!("capture:{id}"), revision)?;
            if !crate::input_native::capture_ready(
                &capture.native_id,
                revision,
                owner_id.unwrap_or(""),
            ) {
                return Err("capture_input_owner_not_ready".into());
            }
        }
        crate::capture_indicator::set(id, revision, active, owner_id.unwrap_or(""), sequence)
    }
    pub fn shutdown() {
        if let Some(id) = snapshot().map(|info| info.capture_id) {
            let _ = stop(&id);
        }
    }

    struct GpuCapture {
        device: ID3D11Device,
        context: ID3D11DeviceContext,
        winrt: IDirect3DDevice,
        pool: Direct3D11CaptureFramePool,
        session: GraphicsCaptureSession,
        size: windows::Graphics::SizeInt32,
        staging: Option<ID3D11Texture2D>,
        item: GraphicsCaptureItem,
        closed: Arc<AtomicBool>,
        closed_token: i64,
        last_readback: Option<serde_json::Value>,
    }
    impl GpuCapture {
        fn restart(&mut self, target: &Target) -> Result<(), String> {
            // Recreating only the frame pool retains WGC's original non-client
            // crop. Chrome changes that crop on maximize/restore. Release the
            // old session before creating a fresh item, pool and session.
            self.session.Close().map_err(text_error)?;
            self.pool.Close().map_err(text_error)?;
            *self = Self::new(target, self.closed.clone())?;
            Ok(())
        }
        fn new(target: &Target, closed: Arc<AtomicBool>) -> Result<Self, String> {
            if !GraphicsCaptureSession::IsSupported().map_err(text_error)? {
                return Err("windows_graphics_capture_not_supported".into());
            }
            let mut device = None;
            let mut context = None;
            unsafe {
                D3D11CreateDevice(
                    None,
                    D3D_DRIVER_TYPE_HARDWARE,
                    HMODULE::default(),
                    D3D11_CREATE_DEVICE_BGRA_SUPPORT,
                    None,
                    D3D11_SDK_VERSION,
                    Some(&mut device),
                    None,
                    Some(&mut context),
                )
            }
            .map_err(text_error)?;
            let device = device.ok_or("capture_d3d_device_missing")?;
            let context = context.ok_or("capture_d3d_context_missing")?;
            let dxgi: IDXGIDevice = device.cast().map_err(text_error)?;
            let winrt: IDirect3DDevice = unsafe { CreateDirect3D11DeviceFromDXGIDevice(&dxgi) }
                .map_err(text_error)?
                .cast()
                .map_err(text_error)?;
            let interop: IGraphicsCaptureItemInterop =
                windows::core::factory::<GraphicsCaptureItem, IGraphicsCaptureItemInterop>()
                    .map_err(text_error)?;
            let item: GraphicsCaptureItem = match target {
                Target::Monitor { handle, .. } => unsafe {
                    interop.CreateForMonitor(windows::Win32::Graphics::Gdi::HMONITOR(
                        *handle as *mut _,
                    ))
                },
                Target::Window { handle, .. } => unsafe {
                    interop.CreateForWindow(windows::Win32::Foundation::HWND(*handle as *mut _))
                },
            }
            .map_err(text_error)?;
            let handler_closed = closed.clone();
            let closed_token = item
                .Closed(&windows::Foundation::TypedEventHandler::<
                    GraphicsCaptureItem,
                    windows::core::IInspectable,
                >::new(move |_, _| {
                    handler_closed.store(true, Ordering::Release);
                    Ok(())
                }))
                .map_err(text_error)?;
            let size = item.Size().map_err(text_error)?;
            valid_size(size.Width, size.Height)?;
            let pool = Direct3D11CaptureFramePool::CreateFreeThreaded(
                &winrt,
                DirectXPixelFormat::B8G8R8A8UIntNormalized,
                2,
                size,
            )
            .map_err(text_error)?;
            let session = pool.CreateCaptureSession(&item).map_err(text_error)?;
            session.StartCapture().map_err(text_error)?;
            Ok(Self {
                device,
                context,
                winrt,
                pool,
                session,
                size,
                staging: None,
                item,
                closed,
                closed_token,
                last_readback: None,
            })
        }
        fn read(&mut self) -> Result<Vec<u8>, String> {
            let until = Instant::now() + Duration::from_millis(160);
            let frame = loop {
                if self.closed.load(Ordering::Acquire) {
                    return Err("capture_target_closed".into());
                }
                if let Ok(frame) = self.pool.TryGetNextFrame() {
                    break frame;
                }
                if Instant::now() >= until {
                    return Ok(Vec::new());
                }
                std::thread::sleep(Duration::from_millis(4));
            };
            let size = frame.ContentSize().map_err(text_error)?;
            if size.Width <= 0 || size.Height <= 0 {
                let _ = frame.Close();
                return Ok(Vec::new());
            }
            if size != self.size {
                let _ = frame.Close();
                valid_size(size.Width, size.Height)?;
                self.size = size;
                self.staging = None;
                self.pool
                    .Recreate(
                        &self.winrt,
                        DirectXPixelFormat::B8G8R8A8UIntNormalized,
                        2,
                        size,
                    )
                    .map_err(text_error)?;
                return Ok(Vec::new());
            }
            let result = self.copy(&frame);
            let _ = frame.Close();
            result
        }
        fn copy(&mut self, frame: &Direct3D11CaptureFrame) -> Result<Vec<u8>, String> {
            let size = frame.ContentSize().map_err(text_error)?;
            valid_size(size.Width, size.Height)?;

            let access: IDirect3DDxgiInterfaceAccess = frame
                .Surface()
                .map_err(text_error)?
                .cast()
                .map_err(text_error)?;
            let texture: ID3D11Texture2D = unsafe { access.GetInterface() }.map_err(text_error)?;
            let pixels = super::copy_texture(
                &self.device,
                &self.context,
                &mut self.staging,
                &texture,
                size.Width,
                size.Height,
            )?;
            if !pixels.is_empty() {
                let mut desc = D3D11_TEXTURE2D_DESC::default();
                unsafe {
                    texture.GetDesc(&mut desc);
                }
                self.last_readback = Some(serde_json::json!({
                    "sourceTimestamp100ns":frame.SystemRelativeTime().ok().map(|time|time.Duration),
                    "surfaceWidth":desc.Width,"surfaceHeight":desc.Height,
                    "readbackWidth":size.Width,"readbackHeight":size.Height,
                    "copyStrategy":"content-region"
                }));
            }
            Ok(pixels)
        }
    }
    impl Drop for GpuCapture {
        fn drop(&mut self) {
            let _ = self.item.RemoveClosed(self.closed_token);
            let _ = self.session.Close();
            let _ = self.pool.Close();
        }
    }
    fn valid_size(w: i32, h: i32) -> Result<(), String> {
        if w <= 0
            || h <= 0
            || (w as usize)
                .checked_mul(h as usize)
                .is_none_or(|p| p > MAX_PIXELS)
        {
            Err("capture_resolution_exceeds_4k_budget".into())
        } else {
            Ok(())
        }
    }
}

#[cfg(not(windows))]
pub fn shutdown() {}

#[cfg(not(windows))]
pub fn shutdown_runtime() {}

#[cfg(windows)]
fn copy_texture(
    device: &windows::Win32::Graphics::Direct3D11::ID3D11Device,
    context: &windows::Win32::Graphics::Direct3D11::ID3D11DeviceContext,
    staging_texture: &mut Option<windows::Win32::Graphics::Direct3D11::ID3D11Texture2D>,
    texture: &windows::Win32::Graphics::Direct3D11::ID3D11Texture2D,
    width: i32,
    height: i32,
) -> Result<Vec<u8>, String> {
    use windows::Win32::Graphics::Direct3D11::*;
    let text_error = |error: windows::core::Error| format!("native_capture: {error}");
    let mut desc = D3D11_TEXTURE2D_DESC::default();
    unsafe {
        texture.GetDesc(&mut desc);
    }
    if desc.Width < width as u32 || desc.Height < height as u32 {
        // WGC can queue a transition frame whose ContentSize already
        // changed while its pool surface still has the previous size.
        // Discard it; never publish mismatched pixels as a new binding.
        return Ok(Vec::new());
    }
    use windows::Win32::Graphics::Dxgi::Common::{DXGI_FORMAT_B8G8R8A8_UNORM, DXGI_SAMPLE_DESC};
    if desc.Format != DXGI_FORMAT_B8G8R8A8_UNORM
        || desc.MipLevels != 1
        || desc.ArraySize != 1
        || desc.SampleDesc.Count != 1
    {
        return Err("capture_unsupported_surface_format".into());
    }
    let compatible = staging_texture.as_ref().is_some_and(|texture| {
        let mut current = D3D11_TEXTURE2D_DESC::default();
        unsafe {
            texture.GetDesc(&mut current);
        }
        current.Width == width as u32
            && current.Height == height as u32
            && current.Format == desc.Format
    });
    if !compatible {
        let readback = D3D11_TEXTURE2D_DESC {
            Width: width as u32,
            Height: height as u32,
            MipLevels: 1,
            ArraySize: 1,
            Format: desc.Format,
            SampleDesc: DXGI_SAMPLE_DESC {
                Count: 1,
                Quality: 0,
            },
            Usage: D3D11_USAGE_STAGING,
            CPUAccessFlags: D3D11_CPU_ACCESS_READ.0 as u32,
            ..Default::default()
        };
        let mut staging = None;
        unsafe { device.CreateTexture2D(&readback, None, Some(&mut staging)) }
            .map_err(text_error)?;
        *staging_texture = staging;
    }
    let staging = staging_texture.as_ref().ok_or("capture_staging_missing")?;
    // Pool backing surfaces can change size while ContentSize stays fixed.
    // CopyResource silently leaves stale pixels when their dimensions differ.
    // Copy only the validated content rectangle into a content-sized staging surface.
    let region = D3D11_BOX {
        left: 0,
        top: 0,
        front: 0,
        right: width as u32,
        bottom: height as u32,
        back: 1,
    };
    unsafe {
        context.CopySubresourceRegion(staging, 0, 0, 0, 0, texture, 0, Some(&region));
    }
    let mut mapped = D3D11_MAPPED_SUBRESOURCE::default();
    unsafe { context.Map(staging, 0, D3D11_MAP_READ, 0, Some(&mut mapped)) }.map_err(text_error)?;
    let width = width as usize;
    let height = height as usize;
    if mapped.pData.is_null() || (mapped.RowPitch as usize) < width * 4 {
        unsafe {
            context.Unmap(staging, 0);
        }
        return Err("capture_invalid_mapped_surface".into());
    }
    let mut bytes = vec![0; width * height * 4];
    for y in 0..height {
        unsafe {
            std::ptr::copy_nonoverlapping(
                (mapped.pData as *const u8).add(y * mapped.RowPitch as usize),
                bytes.as_mut_ptr().add(y * width * 4),
                width * 4,
            );
        }
    }
    unsafe {
        context.Unmap(staging, 0);
    }
    Ok(bytes)
}

#[cfg(all(test, windows))]
#[path = "capture_readback_tests.rs"]
mod readback_tests;
