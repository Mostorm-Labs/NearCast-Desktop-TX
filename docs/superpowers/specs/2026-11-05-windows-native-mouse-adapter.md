# Windows native Mouse adapter

> Historical design. The runtime protocol and capability declarations below are superseded by [TI-3 typed input](../handoffs/2026-11-06-tx-typed-input-ti3.md). Native implementation history remains useful; do not implement the old BIND/epoch/single-mode protocol.

## Scope and responsibility

The sender implements Windows native input and cleanup. The receiver owns gesture
interpretation and must send explicit Touch or Mouse semantics. Long press, tap,
drag thresholds, multi-finger gestures, right-click policy, and scroll gestures
must not be implemented in the sender.

An AXTP stream's negotiated `acceptedMode` selects the native input path. The sender
does not infer a mode from button fields, and does not convert zero-button Touch
DOWN records into left clicks. Touch continues through `InjectTouchInput`; Mouse
uses `SendInput`. Both preserve the existing canonical framing, token/epoch fences,
CRC, and lack of ordinary application ACKs.

## Protocol dependency

The current RX at `d7e3721` negotiates Mouse but still produces Touch contact records
with zero buttons/modifiers/wheel/flags. Its gesture-to-Mouse producer is incomplete.
These records are not valid explicit Mouse DOWN records and are rejected by this
adapter. A successful mode negotiation does not prove working end-to-end Mouse.

AXTP baseline `e986dcfd80ddd3361b922541ba01357d2c457735` specifies record layout,
but does not freeze Mouse button/modifier bit assignments, hover/contact lifecycle,
wheel units/direction, or flags. RX and TX must consume an adopted shared profile
and semantic golden vectors before claiming protocol interoperability. The native
IPC assumptions below are implementation details, not an AXTP protocol amendment.
Do not use codec round-trip samples as semantic oracles.

The RX owner prepares the explicit Mouse producer and gesture policy. The AXTP
protocol owner adopts the shared record profile through its protocol maintenance
workflow. TX then maps the adopted profile onto its native input model. Existing
historical Touch verification evidence is unchanged by this feature.

## Native interface

Tauri exposes only these fixed commands; no arbitrary window, process, executable,
or network target is accepted:

| Command | Behavior |
| --- | --- |
| `nearcast_windows_mouse_initialize` | Release any previously owned state and initialize the native adapter. |
| `nearcast_windows_mouse_inject` | Validate a bounded batch, then insert its explicit Mouse events. |
| `nearcast_windows_mouse_reset` | Release injected buttons and owned modifier keys. Safe when already idle. |

Current native IPC model (subject to mapping from the adopted wire profile):

- Normalized coordinates `0..65535` address the primary monitor directly, avoiding
  conversion through WebView CSS pixels. Other capture targets need a negotiated
  display/region mapping.
- Single buttons `1/2/4` mean left/right/middle. DOWN requires a nonzero explicit
  button; drag MOVE repeats the held button. Hover MOVE has no active contact and
  zero buttons. UP/CANCEL releases the tracked button and permits a zero button
  field. Contact IDs need not be zero, but must match during an active press.
- Modifier bits `1/2/4/8` mean Shift/Ctrl/Alt/Windows in this native IPC model.
  Already-held local modifier keys are borrowed, not owned, and are not released
  by remote reset. General keyboard input is not exposed.
- Signed wheel delta is passed to Win32 without scaling. Win32 uses 120 per notch;
  this does not establish AXTP's wire unit. Horizontal wheel and nonzero
  `recordFlags` are unsupported. Unknown button/modifier bits are rejected.
- At most 1024 records are accepted per native call. The full batch is validated
  before any native input. Combined button presses and multiple active contacts
  are rejected by the current single-pointer model.

## Ordering, cleanup, and errors

One Windows queue owns Touch and Mouse. Reset and mode changes invalidate queued
old work immediately, wait for in-flight native calls, then release state before
new input. Stream switching retains `reset -> closeStream -> openStream` and waits
for native mode activation. Mouse negotiates one contact; Touch retains up to ten.
Only successfully initialized native modes are advertised.

The native model checkpoints state after every generated event. If `SendInput`
inserts only a prefix, ownership of the inserted keys/buttons is retained for
cleanup. Failed reset keeps input blocked until cleanup succeeds. Reset occurs on
protocol reset/close, fencing/disconnect, mode changes, and native window close.

Errors include `windows_mouse_send_input_failed:win32=<code>:sent=<n>/<total>` and
remain visible in `lastInjectionFailure`. A zero Win32 error does not imply
success. `SendInput` is subject to UIPI, and its return value cannot specifically
identify UIPI blocking; see [Microsoft SendInput documentation](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-sendinput).
This work adds no elevation or UIAccess agent.

## Verification

Node tests cover mode routing, hover/contact accounting, reset-close-open, stale
frames, queued work, error propagation, independent native capabilities, and
blocking after failed cleanup. Rust tests cover record validation, exact event
mapping, partial insertion, and release of owned state. Zero-button Touch DOWN
must remain an explicit negative test.

The optional native test creates its own temporary foreground window and checks
actual mouse button/wheel messages, Ctrl-click, and reset after a held button and
Ctrl. It restores cursor position and focus afterward. Ordinary Cargo tests do
not generate OS input. Run this explicit test only on an interactive desktop:

```powershell
cargo test --locked --manifest-path src-tauri/Cargo.toml --lib native_mouse_events_and_reset_reach_an_owned_window -- --ignored --nocapture
```

This native test does not substitute for RX gesture tests or a real Touch-to-Mouse
session. End-to-end acceptance additionally requires an adopted Mouse profile,
the matching RX producer, and Touch -> Mouse -> Touch while video remains active.
