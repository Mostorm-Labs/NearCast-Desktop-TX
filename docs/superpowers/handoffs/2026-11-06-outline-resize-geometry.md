# Resize outline and unclipped window capture geometry

Historical intermediate experiment. The caption-frame candidate described below was removed after real Chrome pixel tests disproved its origin. The final implementation, current verification and test artifact are documented in 2026-11-06-chrome-capture-layout-recovery.md. Keep this earlier evidence to explain why dimension-only candidate matching was rejected; it is not the current geometry authority.

Base: f9529d16928dd404d364c964a3284d7f5ad06c26 on codex/touchback-input-diagnostics.

The user's RX retained Requested intent but reported unavailable capture geometry. TX diagnostics showed capture_window_pixels_do_not_match_native_bounds, live 948x885 readback and a retained 1920x1040 pixel region. This proves failed geometry association, not failed Touch delivery: the stream received Touch and native cleanup completed. It does not identify the user's current raw HWND bounds; the Release build had no Console.

Two independent regressions failed before their fixes: the native outline stayed visible at the previous pixel rectangle before new resized frames were requested, and the sender classified a pixel/native-bounds mismatch as NATIVE_GEOMETRY_UNAVAILABLE instead of the recoverable CAPTURE_GEOMETRY_CHANGED.

A focused owned-window fixture additionally reproduced permanent failure after maximizing: GetWindowRect was (-8,-8)-(1928,1048), DWM visible bounds were (0,0)-(1920,1040), and repeated WGC frames were 1922x1049. A painted client marker independently proved their physical origin was (-1,-8). This is an additional confirmed capture case, not a claim that the user's browser has exactly those dimensions.

The window resolver still accepts exact DWM/full-window matches first. For captioned resizable windows it also derives the non-client surface from current DPI-aware sizing-frame, padded-border and visible-border system metrics. That candidate must match both WGC dimensions exactly; arbitrary size tolerance, stretching and guessed centering are not accepted. Input leases, PID identity, foreground, revision, hit target and native cleanup checks remain in place. Windows/Chrome themes with other geometry remain unavailable unless a candidate matches.

The native sharing outline now uses current visible target bounds, independently of the pixel mapping. It hides on unproven geometry instead of drawing Info's retained diagnostic rectangle. It returns after geometry is valid; maximized frame pixels can extend outside the work area while the outline follows the visible window. Touch circles remain in physical coordinates relative to that same overlay. No AXTP framing, dependency pin, RX logic or permission settings changed.

Each capture packet's existing nativeCapture diagnostics now includes nativeRegion, so the standard UI can compare current native visible bounds with readbackWidth/readbackHeight and the proven region without a Console. This native-only observation is excluded from the advertised capture descriptor.

Validation on this Windows host:

- npm test: 149 passed. Locked Rust suite: 41 passed, five explicit OS/LAN fixtures ignored. Locked cargo check passed.
- Focused owned-window test passed resize without frame requests, outline hide/return, maximize/restore, pixel-proven global origins, current DWM outline placement and overlay destruction. It failed on the old stale outline and the unsupported maximized geometry before implementation.
- Existing full native owned-window/dual-monitor fixture passed actual PT_TOUCH receipt/reset, held-contact cleanup, native pixel updates and outline/circle capture exclusion on both primary and negative-origin displays.
- Two earlier runs of that broad fixture failed at existing circle-count/color assertions; logs were retained. The focused geometry test avoids those unrelated desktop-color assertions. The final broad native run passed unchanged.
- Real Edge/WebRTC integration with simulated native IPC/RX passed geometry rebinding, video continuity, feedback and input-channel recovery. It does not prove real RX acceptance.
- Physical high-DPI and the user's actual Chrome/RX reproduction still require manual validation. The 150% negative-origin frame case is a model test, not an OS DPI-change test. Original user TX/RX sessions were not stopped for these fixtures.

API references used to distinguish visible/non-client geometry:

- https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-getwindowrect
- https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-getsystemmetrics
- https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-getsystemmetricsfordpi
- https://learn.microsoft.com/en-us/windows/win32/api/dwmapi/ne-dwmapi-dwmwindowattribute
