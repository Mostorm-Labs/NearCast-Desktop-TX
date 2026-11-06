# Windows capture target previews

Branch: codex/touchback-input-diagnostics. Base: 142550fcd2db95d3216706b1084f5541e9f4cd35.
This continues the existing uncommitted native capture, input queue and Touch diagnostics work.

## Behavior

The share chooser now separates screens and windows into tabs, with real local thumbnail cards, names, an explicit selected state and a separate confirmation button. Changing source kind clears the selection. Whole-card clicks and grid arrow/Home/End navigation work, including fewer targets than grid columns. Long titles are truncated visually with the full title available as a tooltip. Default 960x640 and narrow 520x640 layouts keep confirmation visible.

Thumbnails are snapshots per chooser opening, loaded for visible cards and cached until closing. Failed previews show an unavailable placeholder without disabling target selection. Closing disconnects observation, drops queued work and revokes blob URLs; late responses cannot populate a replacement chooser.

## Native boundary

nearcast_capture_thumbnail accepts only an opaque enumerated targetId and returns a raw BMP response. WGC captures the exact HMONITOR/HWND, preserving window identity even when its desktop position is occluded. It does not call target.activate, install the active capture controller, acquire an input owner or create the red/green sharing outline. No thumbnail bytes are sent to RX or saved by the app. Windows may show its own normal capture indicator during acquisition.

Both JS and native code bound concurrent thumbnail reads to two. Native sessions are scoped and dropped on success/error, with a 1.2-second first-frame polling deadline. Source pixels retain the existing 4K-area limit; BMP output is top-down opaque BGRA, aspect-preserving, at most 320x180 and 230454 bytes, without upscaling. Minimized, closed or protected targets may lack a usable preview. In-flight native work finishes its bounded read after a chooser closes; queued work is discarded.

Selecting a thumbnail still passes the exact opaque targetId into the existing native capture path. Geometry binding, Touch injection, red/green outline, video quality, stop/reselect and leave behavior retain their existing contracts. No AXTP, RX or audio changes are required. macOS keeps the existing system picker.

## Verification

TDD red observations: preview loader missing; Rust fitting/encoding helpers missing; browser chooser lacking decoded thumbnails; grid navigation producing a negative index when two cards occupy three columns. Each was followed by a passing check after implementation.

- npm test: 140 passed, zero failures.
- cargo +stable test --locked: 37 passed, 4 explicitly ignored OS/LAN fixtures.
- Explicit ignored owned-window native capture fixture: passed. Preview BMP quadrant pixels match the owned window, foreground is unchanged, and there is no active capture/input owner. The same fixture verifies monitor previews on the primary and left negative-origin display, then actual capture, outline exclusion and PT_TOUCH injection/cleanup.
- Edge integration with native IPC fixtures: passed. Real SDP/ICE/DTLS/SCTP/H264 continues across stop/reselect, geometry rebind and input faults. Picker coverage includes image decode, lazy hidden-tab loading, preview failure selection, duplicate titles, pointer/keyboard selection, reopen cancellation and narrow layout. A mocked IPC response is not evidence of native pixels; the independent native fixture supplies that evidence.
- Edge fallback capture integration: passed.
- cargo +stable check --locked and cargo +stable build --locked: passed.
- git diff --check and new text-file trailing whitespace check: passed.

No actual user TX or RX process was launched, stopped or reconfigured. Full user-selected application/RX acceptance remains a manual check. The isolated Debug EXE and browser screenshot are in the tx-preview-picker-20261106 artifact folder. No commit or push was requested for this task.
