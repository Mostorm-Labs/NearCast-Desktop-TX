# Local Windows Touch feedback circles

Base commit: ec4a8e87c97e1d8fb2902944cea043d15f7a5ac2, codex/touchback-input-diagnostics.

The sender now has a default-on Show touch positions checkbox in the Windows native-capture controls. Amber circles mean Touch passed the current stream, sequence, cursor and contact-lifecycle checks and entered the input queue. Green means the matching latest sample was confirmed submitted by the native provider. Green is not proof the target application handled it. Up/Cancel remain visible for about 700 ms, then expire; movement follows mapped physical coordinates, including negative monitor origins. This does not display arbitrary malformed or unauthorized network packets; existing wire counters remain the way to diagnose those.

InputEngine emits optional observational callbacks after ingress validation and after confirmed native submission. Observer exceptions are isolated from input, release and protocol state. Source/channel loss clears feedback, with old engine callbacks fenced by generation. Mouse has no Touch visualization or conversion.

TouchFeedback maintains at most 32 local markers. A 32 ms flush interval, one in-flight IPC and one latest pending scene bound overhead independently of the input queue. Older native completions cannot move a marker backwards or mark a newer unsubmitted position green. Terminal lifetimes use the original receive time. The app toggle clears the scene and does not inject, reset or close input. The browser timer defaults are wrappers, because a bare Window.setTimeout invoked as a class method has an illegal receiver; real Edge integration caught that error.

The native command accepts only a bounded scene for the current capture ID/revision and native input owner, and checks all points against the current physical capture region. The native Scene rejects malformed/duplicate/oversize points, drops old serials and clears on geometry/readiness loss. It retains no packet payloads or image data.

The existing sharing-outline window renders the circles. It remains topmost, no-activate, layered and input-transparent; WS_DISABLED also ensures WindowFromPoint cannot return it. Region geometry contains only the sharing border and marker annuli, with DPI-scaled 24-48 px radii. The same WDA_EXCLUDEFROMCAPTURE setting excludes both outline and Touch circles. A scene is not enabled if capture exclusion could not be established. Window/source stop destroys the overlay. macOS and non-native capture do not expose this Windows-only switch.

No AXTP/wire framing, CRC, receiver logic, Win32 injection behavior, privileges, microphone/audio handling or window-resize rebinding recovery was changed. The known native RX recovery limitation remains separate.

Verification:

- TDD engine callback test failed before the feature and passed after implementation. It checks mapped coordinates, received before native completion, submitted after confirmation, clear on close, partial-result absence of green and observer-error isolation.
- TDD JS visual-service tests failed without the module and pass for negative coordinates, old completions, long IPC coalescing, disable/clear, source replacement and IPC failure isolation.
- TDD native model tests failed with an empty model, then passed for bounded atomic input, stale serial fencing, terminal expiry and irreversible geometry/readiness clearing.
- Edge UI integration failed without the switch and then exposed the timer-receiver bug. After the fix it passes actual Touch-to-visual IPC, matching physical points, confirmed-green status, toggle clearing without additional injection, media continuity and existing capture/input regressions. SDP/ICE/DTLS/SCTP/H264 are real; native IPC is simulated in that test.
- The explicit owned-window/dual-monitor OS fixture passes visible amber/green pixel color, terminal expiry, circle-stroke WindowFromPoint penetration, real PT_TOUCH receipt/reset, native capture geometry/repaint and circle exclusion from both primary and negative-origin monitor pixels.
- Screen-readback APIs intentionally scrub display-affinity content. For the owned fixture's color assertion only, the test briefly removes affinity from that fixture's own overlay, reads pixels strictly within the owned painted source, then restores exclusion before WGC exclusion checks. Production never removes affinity. One unrelated foreground-change run and an overly short 180 ms test pulse initially failed; the final test is serialized and uses the actual 700 ms terminal lifetime.
- npm test: 147 passed. cargo test --locked: 40 passed, four explicit OS/LAN fixtures ignored; the owned-window fixture above was also run separately.
- Locked cargo check/build passed; final artifact and manifest are in tx-touch-circles-20261106. User's original TX/RX were not stopped or reconfigured.

The actual user receiver/browser session should be checked with the new EXE, especially multi-touch and high-DPI monitors. Official API contracts:
https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-windowfrompoint
https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-setwindowdisplayaffinity
