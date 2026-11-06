# Chrome capture layout recovery

Base f9529d16928dd404d364c964a3284d7f5ad06c26, branch codex/touchback-input-diagnostics. Includes the local uncommitted outline/diagnostic work. This supersedes the intermediate caption-frame candidate in 2026-11-06-outline-resize-geometry.md.

## Evidence

The user's diagnostic has a live AXTP channel, zero active native contacts/owners and a closed input stream. The failure is CAPTURE_GEOMETRY_CHANGED / capture_window_pixels_do_not_match_native_bounds. Native visible bounds are 948x869, but WGC readback is 948x885. RX retains Requested intent and correctly waits for a usable source.

A new opt-in test starts a separate Chrome profile and local owned HTML page. Its five-pixel colored marker is found in actual WGC frames, projected through the advertised physical region and checked against desktop pixels at the marker's top/left edges. Standard BUTTON windows were insufficient evidence for Chromium's custom non-client layout.

Before the final fix, an existing normal-window session produced a maximized 1922x1049 frame whose inferred (-1,-8) origin did not match Chrome's desktop pixels. Starting a fresh capture in that same maximized state produced 1920x1040 with correct (0,0) origin. Reusing that session on restore produced 948x894 for a 948x878 native window, reproducing the user's exact 16-pixel surplus pattern. Those failures are retained in the artifact logs. They show that only resizing the frame pool retains stale WGC non-client crop state.

## Final behavior

- CaptureLayout observes the selected HWND/PID's current DPI, maximized state, physical client insets relative to the full window, and relevant non-client styles. Position and ordinary client size are deliberately excluded: those continue through the existing geometry/pool-resize path.
- Native input proof fails immediately while current layout differs from the capture's observed layout. Old geometry is never accepted by a size tolerance or synthesized border formula. The previous caption_frame_rect fallback and its model test were removed; exact DWM/full-window pixel matching remains.
- On layout change, the first native frame response has no pixels and advertises invalid geometry before the backend generation changes. Existing JS handling fences the old engine/queue and sends unavailable source state. A newer pending layout supersedes the previous one.
- On the next matching request, confirmed native cleanup is required, then the old WGC session/pool are closed and a fresh item/device/pool/session is created for the same selected target. The capture ID and frontend MediaStream remain intact. A new captureGeneration participates in geometryRevision, so the source and input stream negotiate a fresh context. A new frame must pass exact geometry proof before input can be enabled.
- nativeCapture diagnostics expose captureGeneration, captureLayout and nativeRegion. These observations are native-only; AXTP framing, generated input types, fingerprint, CRC/ACK policy, dependencies, RX behavior and privileges are unchanged.
- Sharing outlines use the current visible native bounds. Unproven geometry hides the old outline, and source/owner changes clear Touch feedback. Cleanup errors retain the existing fail-closed behavior and cannot be bypassed by reconstruction.

## Verification and scope

The isolated real Chrome test runs an initial 948x869 visible window and four rounds of maximize, restore, movement and resizing (13 proven frames). Each validates actual physical marker edges. An owned Touch is held before maximize; native cleanup must remove the old owner/contacts, and a fresh Touch Down/Up must submit successfully after all transitions. Capture ID remains unchanged. Additional assertions require the unavailable packet to precede backend-generation change; the old implementation failed that assertion before two-phase reconstruction was added.

The Chrome fixture never opens the user's profile. It closes only its own browser window/process and restores the previous foreground window. One early fixture asserted readiness before the normal transition had finished and was corrected to wait for stable proof. One desktop-color run failed while DWM composition was pending; the final color comparison explicitly flushes the compositor. Initial failures and subsequent outputs remain in the local artifact directory.

The final verification record is the artifact manifest and logs in tx-chrome-resize-recovery-20261106. Node has 149 tests; the locked Rust unit suite has 40 regular tests and six opt-in OS/LAN fixtures. The Chrome, sharing-outline and full native window/dual-monitor fixtures are run explicitly, separately from that suite. Edge/WebRTC uses simulated native IPC/RX and does not replace these OS tests.

The actual user's Chrome/RX session and physical mixed-DPI displays still require manual acceptance. Native layout/DPI observation is implemented; only this host's physical DPI was exercised. Ordinary input remains Touch, via InjectTouchInput/PT_TOUCH. No running user TX/RX was restarted for the isolated tests.
