# Windows capture target and sharing outline

Branch: `codex/touchback-input-diagnostics`; base `142550f`.

## Behavior and ownership

Windows exposes a native screen/window picker when WGC is available. Its local
opaque selection IDs resolve to enumerated HMONITOR or HWND + process identity;
no receiver-provided handle, title matching or resolution guessing chooses the
input target. Windows.Graphics.Capture captures that exact native object. Actual
frame dimensions must match DWM extended bounds or GetWindowRect before window
input becomes ready. All geometry uses physical pixels with a scoped per-monitor
V2 DPI context; negative monitor origins are preserved.

The existing Launcher-compatible WebSocket/WebRTC session, H.264 sender reuse,
quality controls, preview, stop and leave flows remain in place. Binary BGRA
frames use bounded local Tauri IPC, WebGL channel swizzle/resize, and a manually
requested canvas video track. One frame request is outstanding, the WGC pool
contains two frames, and native source pixels are capped at 3840 * 2160. Smaller
sources are not enlarged; quality dimensions are aspect-preserving output limits.
Static images periodically request another canvas frame to retain live RTP.
This implementation performs GPU readback and memory copies; it is not zero-copy.
Display audio/microphone behavior is unchanged (current app requests audio:false).

A native layered, nonactivating, click-through ring follows the selected bounds.
Red means sharing. Green additionally requires the current capture revision,
typed stream activation, local authorization and exact native input owner ID.
Ordered local indicator updates cannot let an older red or green callback replace
a newer state. The overlay requests WDA_EXCLUDEFROMCAPTURE (Windows 10 2004+ for
full exclusion); test the target OS/build rather than assuming flag success is
proof of captured pixel exclusion.

A native watcher cancels held contacts when geometry/visibility/foreground changes,
independently of renderer cooperation. Cleanup failure retains the blocked owner.
Each native submission rechecks lease, revision, bounds and point hit target;
window input cannot be redirected to an overlapping unrelated window. Minimized,
closed or hidden targets cannot keep green. New geometry waits for matching new
pixels, withdraws the old source binding, confirms owned cleanup, and publishes a
new binding so RX can reopen without tearing down the media peer. Stop/exit
remove the ring and release the capture and its owned input. A worker timeout or
capture failure fences native input even if the renderer stops polling.

AXTP typed-input R2 framing, session handshake, input contract fingerprint and RX
payloads do not change. Native capture IDs and input owner/lease IDs stay local.
Windows still advertises typed Touch only. There is no Touch-to-Mouse conversion
or new elevation/UIAccess agent in this change. macOS/browser retain their
existing capture fallback and stricter mapping proof; native target/outline
support is Windows only.

## Lifecycle regression found during implementation

Stopping the last MTA capture worker invalidated cached WinRT activation factories
and crashed a subsequent capture in GraphicsCaptureSession::IsSupported. A
process-scoped CoIncrementMTAUsage reference now spans all probe/capture workers;
each worker still balances RoInitialize/RoUninitialize. The process reference is
released in Tauri's final RunEvent::Exit callback, not on each stop or after
run() (which terminates the process directly on desktop). See Microsoft's
[cached-factory explanation](https://devblogs.microsoft.com/oldnewthing/20211105-00/?p=105878)
and [CoIncrementMTAUsage contract](https://learn.microsoft.com/en-us/windows/win32/api/combaseapi/nf-combaseapi-coincrementmtausage).
Resize transition frames with ContentSize larger than their previous pooled
surface are discarded until matching pixels arrive, rather than closing video
or enabling input against stale pixels. Late target enumeration cannot reopen
a picker after leaving the receiver.
A pre-existing pinned-TLS test server could close after reading only the header
TLS record, leaving the separately sent request body unread and causing Windows
connection reset 10054. The fixture now consumes its complete two-byte request
body and flushes close_notify before closing; production pin verification and
HTTP parsing are unchanged.

## Verification and practical limits

Tests cover local capture cancellation/reselection ordering, stale identities,
frame bounds, source proof in a dual-monitor/scaled-output setup, owner-specific
ordered ring updates, immediate control fencing, and src/dist parity. Real Edge
exercises H.264 RTP, the actual production canvas/WebGL capture adapter and picker
with mocked native IPC, AXTP stream open/rebind, mapped points, foreground pause,
video survival across control faults, stop/restart and leave. Native IPC is mocked
in that browser test: it does not measure actual Tauri IPC/encoding throughput.

The explicit ignored Rust integration test creates only owned test windows,
captures their painted pixels, observes actual PT_TOUCH messages, and checks
move/resize/minimize/close cancellation, ring authorization/cleanup, primary and
negative-origin secondary monitor mapping, and ring exclusion in monitor pixels.
It temporarily brings fixture windows to the foreground and restores foreground
and cursor on normal completion. Run it separately with --ignored --exact, not
concurrently with other native-input tests. Native read/copy packet throughput
is printed separately from IPC/encoder/RX performance.

Actual user RX/hardware end-to-end acceptance, mixed-DPI display changes, rotation,
HDR/color fidelity, other Windows builds and sustained 4K performance require
manual testing. Secure desktop and elevated-window input remain subject to the
existing Windows permission boundary. Check source availability and native
receipt, not only RPC success. Verification logs and a test EXE are delivered in
the external `tx-capture-target-20261106` artifact folder; do not replace RX's
existing joint-test ZIP or another running TX/RX instance.
