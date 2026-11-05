# NearCast sender Touchback mode switching design

> Historical design. The runtime protocol and capability declarations below are superseded by [TI-3 typed input](../handoffs/2026-11-06-tx-typed-input-ti3.md). Native implementation history remains useful; do not implement the old BIND/epoch/single-mode protocol.

## Intent

The Tauri sender must continue to provide the complete Launcher-compatible WebCast
screen-sharing flow while adapting its reverse-control sender to the published AXTP
contract. Users need to test both receiver input interpretations from the sender UI:
`touch` for contact lifecycle input and `mouse` for button, drag, wheel, and modifier
input. The mode is selected in the connected casting view and negotiated through the
existing authenticated WebRTC control DataChannel. Screen sharing must also request and
send captured system/webpage audio when the platform's display picker offers it; the
current UI explicitly passes `audio: false`, which prevents an audio track from ever
reaching WebRTC.

## Goals

- Preserve pairing, receiver trust, discovery, WebSocket signaling, WebRTC offer/answer/
  ICE handling, display capture, video quality controls, local preview, audio capture,
  stop sharing, and leave.
- Request display audio with the capture operation, add the returned audio track to the
  existing WebRTC sender, prefer Opus for the audio transceiver, and keep video-only
  capture working when the platform returns no audio track.
- Advertise and negotiate canonical `input.stream` with `format=touch-batch-v1`,
  `supportedModes=[touch, mouse]`, and an explicit preferred/required mode.
- Let the user select Touch or Mouse while connected, with visible capability and stream
  state so tests can tell whether the requested mode is active or unavailable.
- Apply the AXTP lifecycle for mode changes: fence normal input, send ordered/idempotent
  reset, close the old stream, open a new epoch, and accept only the new stream/token
  binding.
- Preserve the canonical 16-byte big-endian STREAM header, one `seqId` per packet,
  `streamId`, `epoch`, canvas/geometry tokens, CRC, and no ordinary application ACK.
- Keep Windows Pointer Injection and macOS input bridges behind the existing platform
  input interface; a mode negotiation failure must not stop screen sharing.
- Add deterministic tests for request payloads, mode selection, lifecycle ordering,
  stale fencing, capability fallback/rejection, and UI asset wiring.

## Non-goals

- Replacing or rewriting the Launcher-compatible WebRTC/signaling implementation.
- Mixing microphone capture into screen audio; this change only requests display/system
  audio from `getDisplayMedia`.
- Adding a second WebCast binary format or changing the AXTP TouchBatch wire layout.
- Implementing receiver-side gesture policy, NA20 relay logic, or NT10 HID conversion.
- Making AirPlay expose or carry reverse control.
- Granting additional Windows privileges or changing the existing macOS permission model.

## Constraints

- AXTP source of truth is the `codex/nearcast-touchback-axtp` branch at commit
  `e986dcfd80ddd3361b922541ba01357d2c457735`.
- `input.openStream` requires target identity/generation, stream kind, format, supported
  modes, canvas/geometry revisions and tokens, and an idempotency command ID. The sender
  must pass fields available from the receiver state and reject incomplete active-stream
  results instead of inventing fencing values.
- `preferredMode=mouse` with `modeRequirement=required` must produce an explicit
  unsupported/unavailable state when the receiver cannot accept mouse. Preferred mode
  may fall back only when the receiver reports that it selected another supported mode.
- A mode change is not complete when the RPC is merely accepted. The UI reports active
  only after the receiver returns an accepted stream binding or an equivalent
  `cast.touchbackChanged` active event.
- Source modules under `src/` are mirrored into `dist/` because the Tauri page imports
  the bundled files directly. Every source change must be copied to its corresponding
  distribution asset.
- The existing Node test command is `node --test tests/*.test.mjs`; Cargo validation uses
  the configured local stable toolchain.

## Approaches considered

### 1. Protocol strategy layer in the existing sender (chosen)

Keep one `LauncherCompatibleWebCastSender` and one `WebCastTouchbackSender`, add a small
mode/stream strategy that owns capability parsing, open/close/reset sequencing, and the
selected mode. The UI only changes the strategy configuration. This preserves the
Launcher flow and centralizes epoch/token fencing.

### 2. Separate TouchSender and MouseSender implementations

This makes each mode appear self-contained, but duplicates binding, reset, sequence,
disconnect, and diagnostics logic. Fixes would need to be kept in sync and could let one
mode regress while the other works.

### 3. Add a mode field to the existing binary batch

This is a small local change but violates AXTP negotiation and framing. The receiver
would not have a valid `input.openStream` contract and could reject or misinterpret the
packet, so it cannot support interoperability testing.

## Selected design

### Control-plane strategy

Add a sender-side `TouchbackModeController` (name may be refined during implementation)
around the existing Launcher-compatible sender. It maintains:

```text
requestedMode: touch | mouse
modeRequirement: preferred | required
supportedModes: [touch, mouse]
capabilities: input.stream descriptor or unavailable
stream: {streamId, epoch, acceptedMode, canvasToken, geometryToken, revision}
state: unavailable | negotiating | active | switching | closing | error
```

The controller uses the existing JSON request/response helper for:

- `cast.getControlCapabilities` before opening a stream;
- `cast.getTouchbackState` to show receiver state and current mode;
- `cast.setTouchbackEnabled` when the sender UI explicitly enables/disables the
  controller gate;
- `cast.setTouchbackMode` to request Touch or Mouse and preferred/required semantics;
- `input.openStream` and `input.closeStream` for the data stream lifecycle.

The existing receiver-to-sender binary handler remains responsible for decoding and
validating data packets. Its modern path must continue to increment the packet sequence
once per packet and reject old stream IDs, epochs, tokens, and sequence gaps. Reset and
close control frames remain ordered and idempotent; no reset ACK is generated for AXTP.

### Open and switch sequence

Initial open is:

```text
connected → query capabilities/state → set mode → input.openStream → active
```

The open request includes `streamKind=touchback`, `format=touch-batch-v1`, both supported
modes, the selected preferred mode, the selected requirement, target generation fields
when supplied by the receiver, canvas/geometry revisions and numeric tokens, limits, and
a unique command ID. The result is accepted only when `streamId`, `epoch`, accepted mode,
format, tokens, and revision are valid.

Mode switching is:

```text
active → switching → fence input → reset old epoch → close old stream
        → set new mode → open new stream → active(new mode)
```

If any step fails, the controller releases local input state, reports `unavailable` with
the receiver error, and leaves the WebCast media connection and screen sharing intact.
The UI can retry without reconnecting. A stale response from an earlier command cannot
replace the current binding.

### UI

Extend the existing casting panel with:

- a Touchback section showing receiver capability, local native-input readiness, current
  mode, stream epoch/ID, and the last negotiation error;
- a mode selector with `触控 Touch` and `鼠标 Mouse`;
- a requirement selector with `优先 Preferred` and `必须 Required`, defaulting to
  Touch + Preferred;
- an `Enable reverse control` switch and an `Apply` action;
- disabled/loading states while switching and a clear unavailable message when the
  receiver rejects the requested mode.

The share button, preview, video-quality controls, leave button, and all existing pairing
and discovery behavior remain present and functional. Changing the reverse-control mode
does not stop or renegotiate the media tracks.

The share action requests `{video: <selected constraints>, audio: true}`. Browser/Tauri
platforms may return a video-only stream; that is a valid result and must still start a
video share. When an audio track is returned, it is added/reused as the single audio
sender and the offer is renegotiated over the existing signaling path. On capture stop,
both audio and video tracks are stopped and both senders are cleared. Audio codec
selection filters the transceiver to `audio/opus`; a missing Opus capability is reported
as a media negotiation error and cleans up the partial capture without closing the
control channel.

### Platform behavior

The strategy layer is platform-neutral. On Windows it continues to send validated Touch
records to Pointer Injection; on macOS it continues to use the existing mouse bridge for
the records the receiver negotiated. Native readiness and receiver stream activity stay
separate in diagnostics. If a platform cannot execute the accepted mode, the sender
reports native input unavailable and releases active state while keeping WebCast alive.

## Verification

- Unit tests cover capability parsing, Touch/Mouse request construction, preferred versus
  required rejection, open result validation, switch ordering, stale response fencing,
  reset/close behavior, no ordinary ACK, and display audio capture/track lifecycle.
- Existing codec/session, Launcher sender, WebRTC client, discovery, trust, and platform
  tests remain green.
- Asset tests confirm every changed `src` module is mirrored in `dist` and the mode
  controls are present in `dist/index.html` and wired by `dist/app.mjs`.
- Run `node --test tests/*.test.mjs`, `cargo check --locked`, and `git diff --check`.
- Manually launch the Windows debug app, connect to a receiver, start screen sharing,
  switch Touch → Mouse → Touch, and verify that the media preview stays active while the
  displayed stream mode/epoch changes. Repeat the UI smoke test on macOS 13+ where
  available.

## Builder decisions left open

- Exact DOM IDs, controller class name, and the local command-ID generator are
  implementation details.
- If a receiver omits optional target-generation or revision fields, the implementation
  must follow the existing sender's compatibility behavior and surface an unavailable
  state when a required fence cannot be proven.
- Native mouse handling on Windows and macOS remains the responsibility of the existing
  platform sink; this change does not invent a second injection API.
