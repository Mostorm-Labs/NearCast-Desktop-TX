# Window capture stale readback fix

Branch: codex/touchback-input-diagnostics. Base HEAD: 142550fcd2db95d3216706b1084f5541e9f4cd35.
Worktree: C:/Users/Chado/.codex/worktrees/f815/NearCast-Desktop-TX-latest.
This change preserves the existing uncommitted capture-target/outline, picker previews, input queue and typed Touch diagnostics work.

## Evidence and conclusion

The user reported a shared browser window showing only the first image on RX while Touch continued to work. TX LOCAL PREVIEW also appeared frozen. The earlier duplicate capture.frames=983 paste was corrected by the user: the live counter was advancing, so it was not evidence of a stopped acquisition loop.

A temporary user-run probe then measured uploads=180, requests=180, previewFrames=180, trackState=live, muted=false, but sampled changes=0 and lastHash=2844771921. This locates the observed repeated-image symptom upstream of Canvas video production; the temporary probe samples only the blue byte, so it is not proof of full-frame byte equality. It also does not prove an RX codec/network failure. The production probe now samples RGB, not only blue.

Native copy inspection found a concrete reproducible stale-readback defect. The old implementation allocated its staging texture once from the first WGC backing surface descriptor, then called CopyResource for subsequent frames without checking that their resource dimensions still matched. WGC ContentSize and backing surface size can differ during a frame-pool resize transition. CopyResource requires matching resource dimensions and returns no HRESULT; an invalid copy can leave the previous staging pixels intact while Map succeeds and frameId advances.

A real D3D test reproduced exactly that behavior: with visible content fixed at 4x4, source surfaces 8x8 -> 4x4 caused old output to remain [17,34,51,255] instead of the new [170,187,204,255]. The same test passes after the fix, including a later 12x6 backing surface. The initial local reproduction used the hardware device; the default regression uses WARP so Windows CI does not require a physical GPU. A real WGC owned-window fixture also observed content 686x453 in a 700x460 backing surface, confirming that these sizes must not be assumed equal. That fixture now repaints its source and checks changed pixel colors, not just increasing frame counts.

This proves and repairs the native copying defect. The user's exact live browser session still needs the new executable for final acceptance; its old runtime does not expose backing-surface dimensions, so we cannot retroactively prove which surface transition it encountered.

## Implementation

- Readback staging is sized to the validated content rectangle.
- CopySubresourceRegion copies only that rectangle, with explicit bounds, single-plane BGRA8/non-MSAA validation and recreation when staging content dimensions change. The existing undersized transition-surface discard remains.
- CPU row-pitch handling, target identity, geometry revision and reverse-input boundary are unchanged.
- Native packet metadata includes nativeCapture.sourceTimestamp100ns, surfaceWidth/Height, readbackWidth/Height and copyStrategy=content-region for the last successful readback.
- Capture diagnostics include lastFrameId, sampledPixelHash, sampledPixelChanges and nativeCapture. RGB sampling is bounded to about 4096 pixels/frame. It stores no image and never faults a static source merely because the digest is unchanged.
- Source and dist native-capture modules match. No media codec, background-rendering flags, AXTP/RX wire, audio or privilege changes were made.

Microsoft contracts:
https://learn.microsoft.com/en-us/windows/win32/api/d3d11/nf-d3d11-id3d11devicecontext-copyresource
https://learn.microsoft.com/en-us/windows/win32/api/d3d11/nf-d3d11-id3d11devicecontext-copysubresourceregion

## Verification

- TDD D3D regression: old copy path FAILED with previous-frame bytes; content-region copy PASSED.
- TDD capture-diagnostic regression: missing lastFrameId/counters FAILED; implementation PASSED, including a green-only pixel change.
- Native metadata fixture: missing metadata FAILED; implementation PASSED.
- Owned-window/dual-monitor fixture passed: real WGC pixel geometry and updated repaint color, timestamp/surface metadata, exact Touch receipt/reset, moves/resizes/minimize/close and outline exclusion.
- The thumbnail portion of the OS fixture now runs on a fresh MTA worker, matching the production blocking worker. The fixture UI thread could already be STA and initially failed with RPC_E_CHANGED_MODE; this was a fixture invocation issue, not a production thumbnail change.
- npm test: 141 passed.
- cargo test --locked: 38 passed, 4 explicitly ignored OS/LAN fixtures. The owned-window fixture above was additionally run explicitly.
- Edge native-boundary integration passed with real SDP/ICE/DTLS/SCTP/H264 and simulated native IPC: picker selection, stop/reselect, input queue coalescing, geometry rebind, foreground input pause while media stays live and malformed-input isolation.
- Locked cargo check/build and whitespace checks are recorded in the artifact manifest/logs.

The current elevated user TX was not stopped or reconfigured. The preceding isolated WebView2 occlusion prototype could not launch because of a loader entrypoint error and supplied no runtime evidence; its sources were moved out of the repository. The decisive evidence for this change is the user pixel probe plus the independent D3D/native WGC tests described above.

## Manual acceptance

Use the new tx-window-readback-fix-20261106 executable, reselect the same browser window and visibly scroll/change its contents. Require LOCAL PREVIEW and RX to update together. In capture diagnostics, frames, lastFrameId and nativeCapture.sourceTimestamp100ns should advance; sampledPixelChanges should advance when sampled picture content changes. A static page is valid and need not change its digest. The temporary old probe can be removed with __nearcastFrameProbe.stop(), or it disappears when the old app exits. Foreground-only window input safety still applies independently of video acquisition.
