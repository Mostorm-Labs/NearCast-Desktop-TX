# Monitor reselection retains the existing Touchback request

Base: 798795a4988f593f25c348148dda5e5400993cab, codex/touchback-input-diagnostics.

The user confirmed the operation is Stop sharing, then select the other monitor and start sharing again, on the same receiver/control connection. This work addresses that path. It does not revise the native window coordinate implementation.

## Reproduction and boundary

Before the fix, setCaptureTrack(null) published CAPTURE_CHANGED, then refreshSource published CAPTURE_UNAVAILABLE. The paired RX SourceMayResume allowlist accepts CAPTURE_CHANGED but not CAPTURE_UNAVAILABLE. Its immediate source observation clears touchbackRequests on the latter, even if a later source is available. The TX checkbox remains on, so the two ends disagree about the pending request.

The RX evidence is immutable commit cd598cddd8a4b0bd821e8c3709322f00a322a1a8, src/casting/UnifiedCastHost.cpp, SourceMayResume and HandleWebCastControl/UpdateUi. That commit was fetched/read without changing the RX checkout. No RX code was modified.

A new sender regression failed with the exact two-reason trace. A new full-page Edge/WebRTC regression, using the paired RX's resume-reason contract, also failed with canceledInputReasons=[CAPTURE_UNAVAILABLE]. This establishes a TX source-state defect, rather than requiring another receiver enable after every monitor choice.

## Change

The adapter retains captureSeen only within its current control session. After a track was shared, an empty/ended track is a resumable CAPTURE_CHANGED while local permission remains enabled. Initial absence still reports CAPTURE_UNAVAILABLE. Explicit local Off retains LOCAL_INPUT_DISABLED, and fencing resets the capture history. RX permission, explicit RX Off, transport/target retirement and initial authorization are not replaced by this flag.

Both explicit stopping and track-ended events use the same handover path. setCaptureTrack waits for invalidation/cleanup before probing and publishing a new binding. Source binding IDs, native capture IDs, geometry proof and stream IDs are renewed; old contacts are released and old track events cannot clear a newer source. TX continues to wait for an authenticated RX openStream; it does not open or enable input on the receiver's behalf.

src and dist adapters are synchronized. The app has a normal paused-sharing message for CAPTURE_CHANGED and removes the obsolete single-primary-display guidance from the generic mapping error. There are no AXTP framing, fingerprint, CRC/ACK, input-type, native injection, privilege or dependency changes.

## Verification

- Node: 151 passed, including main -> negative-origin secondary -> main, different physical resolutions with scaled video, stream/binding renewal, held-input cleanup, ended/stale tracks, Off, delayed cleanup and control-session fencing.
- Real Edge/WebRTC full page: stop/reselect main -> left secondary -> main while the original input checkbox and simulated RX request stay enabled. New stream IDs, mapped bottom-right endpoints (1919,1079), (-1,1079), (1919,1079), resumed RTP, one input transport and one video transceiver all pass. Native IPC/RX are simulated; actual SDP/ICE/DTLS/SCTP/RTP are used.
- The browser fixture now models both monitor targets as monitors with a correct 16:9 output, and models native capture as waiting for its first frame. Its earlier prematurely-ready/shared-object behavior caused transient double-open observations; those failure logs are retained, and the final test uses the real native readiness boundary.
- Existing browser fallback integration passes. Locked Rust unit suite: 40 passed, six explicit OS/LAN fixtures ignored. The owned native window/dual-monitor fixture was also explicitly run and passed real capture, physical origins and native Touch on both displays. Locked cargo check and diff checks passed.
- Release/build identity and logs are recorded in tx-monitor-reselection-20261106. Actual user RX switching and physical mixed-DPI acceptance remain manual; the Edge policy test is not a claim of end-to-end native RX acceptance.

Keep the TX allow-input switch and the RX request on, then stop sharing and select the other physical monitor. Control should rebind after the new source is ready without another Enable. Explicit Off must remain Off. If it does not recover, retain diagnostics before reconnecting, especially disabledReason, controlChannelReady, sourceReady, streamId and capture.region.
