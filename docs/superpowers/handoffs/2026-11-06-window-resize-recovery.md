# Paired window geometry recovery

TX base: `e413389c3d83f7a2958be75f95e735053fde4419`.
Work branch: `codex/window-resize-touchback-recovery`.
RX base: `d842081`, existing `codex/touchback-rx-joint-debug` checkout.

## Evidence and diagnosis

The user supplied an RX screenshot with permission Allowed, request Requested,
input inactive and the obsolete original-resolution-display guidance. The
session had already ended, so there is no fault-time TX JSON establishing which
geometry check failed in that incident.

Independent failures were reproduced before changing implementation: the TX
producer notified new geometry with old canvas-track dimensions, all native
readiness failures became NATIVE_GEOMETRY_UNAVAILABLE, and the real RX Host
cleared the user's requested intent on a recoverable source change. A real Edge
probe confirmed that canvas-track getSettings still reports the old dimensions
immediately after resizing, then catches up after frame consumption.

## Implementation

TX reports output dimensions from its owned renderer and notifies the changed
source after drawing/requesting the corresponding frame. Native capture identity,
revision, readiness and aspect checks remain intact. Foreground loss, minimized
windows and waiting-for-frame transitions now retain distinct diagnostic reasons.
The e413389 amber/green contact feedback implementation is unchanged.

RX retains intent across allowlisted temporary capture transitions. It stops
capture, confirms release of the previous native owner and negotiates a fresh
stream before accepting new Down lifecycles. A late successful prepare is closed;
a retired prepare rejection remains retryable only when cleanup is confirmed.
Permission withdrawal, explicit Off, retired targets and transport loss cancel
recovery. An immediate private owner observation preserves revocations even if a
later valid source advertisement is drained in the same Poll. No AXTP method,
field, generated input or dependency pin changed.

## Verification

- TX Node: 149 passed. Rust: 40 passed, four opt-in OS/LAN fixtures ignored.
- Real Edge/WebRTC with native IPC fixture: actual 320x240 to 400x200 output,
  fresh input context, new physical endpoint (899,299), foreground pause/recovery,
  preserved contact feedback and continuing RTP passed.
- Locked TX Release build passed. The original actual-user capture incident and
  end-to-end physical Touch remain manual acceptance work.
- RX regressions exercise the real product Host, local consent UI, WebRTC and an
  independent R2 endpoint: held-contact cleanup, automatic source recovery,
  late open success/rejection, queued denial/restoration, explicit Off and
  input-channel loss. Final outcomes are in the paired evidence manifest.
- Initial fixture failures are retained: Win32 rejected fixture pointer ID 10
  with error 87, so the new lifecycle reuses released ID 1; an attempted UIA
  regrant after Escape could not find the settings button, so channel-loss
  coverage uses a separate fresh owned Host session with real initial consent.

Evidence: `NearCast-TX-RX/results/window-resize-recovery-e413389` on the RX machine.
Use the new paired artifacts, leave Enable on, resize a foreground shared window,
then verify fresh Touch at the new geometry, visible feedback, no stuck contacts
and continuing video. Minimize/foreground loss may pause input; restoring a valid
window should recover without an extra Enable. Explicit Off must stay Off.

Final RX Windows suite: 102/102 passed (556.52 s). Clean recursive checkout, locked protocol archive, dependency boundary and diff checks passed. RX code commit: cd598cddd8a4b0bd821e8c3709322f00a322a1a8. The new RX was started after validation; final hashes and paired source identities are in the shared manifest.
