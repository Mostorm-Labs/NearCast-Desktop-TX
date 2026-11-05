# NearCast Touchback + display audio implementation handoff

## Handoff objective

Continue implementation in a new session from `main` so the Tauri WebCast sender
supports the published AXTP Touchback `touch`/`mouse` modes through the UI and sends
display or webpage audio when the platform's screen picker provides an audio track.
Screen sharing, pairing, discovery, trust, WebRTC signaling, and existing Windows/macOS
input bridges must remain intact.

## Current repository state

- Repository: `Mostorm-Labs/NearCast-Desktop-TX`
- Current branch: `main`
- HEAD baseline: `16d6265` (`fix: wait for receiver touchback stream open`)
- Design spec: `docs/superpowers/specs/2026-11-04-nearcast-touchback-mode-switch-design.md`
- The design spec was committed in `2671fcc` and is the source of truth for the mode-switch UI and AXTP lifecycle.
- Working tree contains an uncommitted sender compatibility change and its tests. Preserve it, review it, and commit it with the next implementation slice:
  - `src/webcast/launcher-compatible-sender.mjs`
  - `tests/axtp-touchback-codec.test.mjs`

## Already implemented in the working tree

`LauncherCompatibleWebCastSender` now recognizes receiver-owned `axtp-control`
requests. It accepts `input.openStream` only after a matching BIND, validates stream ID,
epoch, canvas token, geometry token, accepted mode, format, and revision, and replies with
the original request `id` and `method`. It also handles `input.closeStream`, returns an
error response for stale or unsupported requests, and retains the old `{method,result}`
response compatibility path. AXTP reset remains ordered and idempotent with no reset ACK.

The focused tests currently pass:

```text
node --test tests/axtp-touchback-codec.test.mjs tests/webcast-client.test.mjs
38 passed, 0 failed
```

## Audio bug to fix in this handoff

Root cause is confirmed in `dist/app.mjs`: the share button calls
`client.startScreenShare({video: true, audio: false})`. The client itself already loops
over every returned track and selects `audio/opus`, but it can never receive an audio
track while the UI requests `audio: false`.

Required implementation:

1. Change the share action in `dist/app.mjs` to request `audio: true`.
2. Keep `src/webcast/launcher-webcast-client.mjs` and `dist/webcast/launcher-webcast-client.mjs`
   aligned. The public default may remain conservative, but the actual Tauri share path
   must explicitly request display audio.
3. Preserve video-only success: Windows/macOS/browser pickers may return no audio track.
   A video-only stream must still attach and renegotiate successfully.
4. When an audio track is returned, attach exactly one audio sender, prefer the
   `audio/opus` codec, and renegotiate over the existing signaling/DataChannel path.
5. On stop, stop both audio and video tracks and clear both sender tracks. If Opus is not
   available, report a media negotiation error and clean up the partial capture without
   closing the control channel.

Add or update deterministic tests in `tests/webcast-client.test.mjs` for:

- `getDisplayMedia` receiving `{video: ..., audio: true}` from the real share path;
- a returned video+audio stream producing one video sender and one audio sender;
- a returned video-only stream continuing to work;
- stop stopping both tracks and replacing both sender tracks with `null`;
- missing Opus capability cleaning up capture while the session remains connected.

Update any asset wiring test so the changed `src` and `dist` modules stay mirrored.

## Remaining AXTP/UI implementation

Implement the strategy described in the spec around the existing
`LauncherCompatibleWebCastSender` and `WebCastTouchbackSender`; do not create separate
Touch and Mouse protocol implementations. The controller should expose:

```text
requestedMode: touch | mouse
modeRequirement: preferred | required
state: unavailable | negotiating | active | switching | closing | error
stream: {streamId, epoch, acceptedMode, canvasToken, geometryToken, revision}
```

Initial lifecycle:

```text
connected → getControlCapabilities/getTouchbackState → setTouchbackMode
           → input.openStream → active
```

Mode switch lifecycle:

```text
active → switching → fence → ordered reset old epoch → close old stream
        → set new mode → open new stream → active(new mode)
```

Preferred mode may fall back only when the receiver reports the selected fallback.
Required mode rejection must become a visible unavailable/error state. A failed mode
change must release local input state while leaving the WebCast media connection and
screen share alive. Do not mark active merely because an RPC was accepted; wait for the
validated stream binding or active `cast.touchbackChanged` event.

Extend the casting panel in `dist/index.html` and wire it in `dist/app.mjs` with:

- capability/native readiness/current mode/stream ID+epoch/error status;
- Touch/Mouse selector;
- Preferred/Required selector (default Touch + Preferred);
- enable switch and Apply button;
- loading, disabled, and unavailable states.

Preserve share, preview, quality, stop, leave, pairing, discovery, and trust controls.
Changing reverse-control mode must not renegotiate or stop media tracks.

## Protocol invariants

- AXTP source of truth: branch `codex/nearcast-touchback-axtp`, commit
  `e986dcfd80ddd3361b922541ba01357d2c457735`.
- Binary packet: 16-byte big-endian STREAM header plus canonical touch-batch-v1 payload.
- One `seqId` per packet; validate stream ID, epoch, canvas token, geometry token, CRC,
  and sequence ordering.
- No ordinary application ACK and no AXTP reset ACK.
- Reset and close are ordered and idempotent.
- `input.openStream` request must include `streamKind=touchback`,
  `format=touch-batch-v1`, both supported modes, preferred/required selection, available
  target generation fields, revisions/tokens, limits, and a unique command ID.

## Verification before handoff completion

Run:

```powershell
node --test tests/*.test.mjs
cargo check --locked --manifest-path src-tauri/Cargo.toml
git diff --check
```

Also verify that every changed `src` module is mirrored under `dist`, and manually smoke
test on Windows 10/11: connect, start screen share with webpage audio, stop/restart,
switch Touch → Mouse → Touch, and confirm the preview/media stays active while the
displayed mode/epoch changes. Repeat on macOS 13+ when hardware is available.

## Suggested first commit in the next session

```text
feat: add touchback mode controller and display audio capture
```

Before committing, include the current sender request-response changes and their tests,
then push the implementation branch as requested by the user.
