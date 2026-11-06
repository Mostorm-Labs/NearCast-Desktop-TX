# Native capture target, geometry and sharing border

Continue `codex/touchback-input-diagnostics` from `142550f`. Implement the user
approved Windows scope: multiple monitors may remain enabled; share one selected
monitor or one visible foreground window; only that target receives input. Red
border means sharing, green means the typed input stream and native owner are
ready. Stop removes the border. Loss of geometry, target or authorization fences
input and withdraws green immediately. No AXTP wire changes or Touch/Mouse policy
conversion are introduced.

Windows getDisplayMedia does not provide a trusted HWND/HMONITOR association.
Use a local native target picker and Windows Graphics Capture bound to that exact
native object. Transfer bounded latest BGRA frames via binary local IPC into a
canvas MediaStream; reuse the existing H.264 WebRTC sender, signaling, quality,
preview and stop/leave lifecycle. Maintain at most one pending frame request and
discard late capture generations. Measure actual frame throughput before delivery.
Browser and macOS retain their existing capture fallback and truthful capability
checks; do not claim native macOS target/border support from Windows tests.

Native capture identity is a local opaque lease, never a receiver-provided HWND.
Window lifetime and process identity, actual captured bounds, frame dimensions,
physical pixels, display topology and geometry revision must agree. Minimized,
destroyed, moved/resized or non-foreground windows cannot continue old input.
Rebinding waits for owned cleanup, publishes a new source binding and permits RX
to reopen. Native injection checks the current capture lease and window hit target.

The border is a native transparent, non-activating, click-through overlay. Exclude
it from capture where supported and verify the actual capture path. Its green
state is checked against the native owner and current capture geometry. The UI
checkbox alone never turns it green. Overlay callbacks cannot outlive their
capture; display/window changes and cleanup failure cannot leave a stale green.

Verification: test-first common capture lifecycle/geometry tests, existing typed
input and media regressions, native owned-window WGC pixel and bounds fixture,
native overlay click-through/colors/cleanup and two-monitor mapping, locked Rust
tests/check/build, Node suite, src/dist parity, independent C++ framed peer and
Edge RTP regression. Record API success separately from actual app receipt. Keep
all temporary OS input inside owned test windows. Do not stop or replace running
user TX/RX processes, change display settings, or alter RX-owned files.
