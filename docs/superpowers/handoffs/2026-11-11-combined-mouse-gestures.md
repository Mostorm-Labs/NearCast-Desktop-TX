# Combined touch-to-mouse gestures

This implementation extends the explicit output-policy work committed and pushed
as `5d17fcc36c93a93953d951c200dc638076e3721d`. It adds an opt-in `mouse-gestures`
Touch policy. The existing native / separate drag / separate scroll policies
remain selectable. Wire input remains typed Touch; all native operations retain
the authenticated engine's immutable source, geometry, owner and lease.

## Interaction

- Tap: left click on Up; no initial left Down.
- Early motion: anchored continuous Mouse wheel scrolling.
- Stationary hold: default 300 ms, UI adjustable 150–1000 ms; arms dragging
  without pressing. Motion after arming emits left Down at the anchor, then
  button-held Mouse moves. Up/Cancel releases. Holding alone never right-clicks.
- Two-finger tap: exactly one right click after both contacts end within 350 ms
  of the second Down, without exceeding the movement threshold. Both contacts
  must overlap. Replacement contacts, translation, cancellation and pinching do
  not trigger a right click. Adding a finger during a drag/scroll ends that
  action and consumes the remaining group.
- Pinch: proportional distance changes generate bounded steps. A pinch consumes
  the group, so the last remaining finger cannot turn into scrolling or a click.
  The default pure recognizer disables zoom; the Mac UI proposes the explicit
  browser shortcut strategy when available. Applying the configuration is required.

## Portable module

`src/touchback/touch-mouse-gestures.mjs` is a pure state machine accepting complete
validated contact samples, a region, explicit monotonic time, and settings. It
returns Mouse actions or a local `zoom` action, plus bounded visual feedback.
`tick(time)` changes only feedback/arming and performs no OS action. A receiver
port should use local acquisition time and logical display coordinates, normalize
the returned Mouse positions for the existing codec, and suppress duplicate
compatibility mouse events. Do not run the same gesture conversion at both ends.
`zoom` is a local adapter action, not an invented AXTP type.

## macOS realization

The native Mouse lease executes browser zoom using Command+Equals/Minus keyboard
events, with Command scoped to the event flags and no persistent modifier Down.
This targets the foreground app, so first click the webpage; it is not native
pinch and cannot promise arbitrary application zoom. Explicit Ctrl-wheel remains
an alternative, with a UI warning that Mac accessibility may treat it as screen
zoom. Disabling pinch emits no zoom and no right click.

The native halo is an AppKit nonactivating, transparent, click-through panel.
Holding uses a cyan progress arc; armed is a green double ring; dragging blue;
two-finger purple double ring; pinching orange. No repeated text notifications.
Feedback validates current owner+lease and display bounds; native cleanup clears
it, and a 500 ms expiry hides it if refresh stops. It uses current main-display
point mapping, matching the existing Mac single-primary-display limitation.

## Windows follow-up

Pure gesture logic and typed conversion can be merged and run through Node tests
on Windows. Windows currently advertises native Touch only: typed native Mouse,
wheel/modifier output and halo rendering still need Windows implementations and
hardware acceptance. Do not claim this commit alone enables Windows Mouse input.
Pinch can map to Ctrl+wheel using existing Mouse modifier/wheel fields after the
backend is implemented. Keep native Touch available for full multitouch apps.

## Verification

Node tests cover tap, scroll end displacement, adjustable hold, drag locking,
two-finger right click, pinch suppression, disabled feedback, finger overlap and
replacement, owned cleanup and capabilities. Rust tests cover zoom step bounds,
halo stages/display bounds, and existing native cleanup. macOS signed debug app
build passes. On 2026-11-11 the operator confirmed that all requested combined
gestures and halo feedback work with `nearcast-500q`, including hold-to-drag,
two-finger right-click and browser pinch mapping. This is operator-confirmed
physical acceptance; no independent native event trace was recorded. Exact
tested artifact hashes and test totals are in
`docs/verification/2026-11-11-combined-mouse-gestures.json`.
