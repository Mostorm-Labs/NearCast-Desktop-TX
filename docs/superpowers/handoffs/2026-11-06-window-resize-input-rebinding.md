# Window resize: pending RX/TX input rebinding

The user confirmed that the new capture readback build improved window video, but reducing a shared window's size left reverse input unusable. This report concerns changing dimensions, not merely minimizing the window.

## Expected behavior

A geometry change must immediately fence old input coordinates and release owned contacts. After a fresh frame establishes the new region, a new source binding and input stream should restore control while video remains active. The previous stream ID/sequence/contact state cannot be reused. Minimizing or losing foreground may legitimately pause window input; it should be re-established after the source is valid again.

## Current code evidence

TX src/webcast/input-control-adapter.mjs captureGeometryChanged invalidates its old source, closes/releases its engine ownership and refreshes source proof. Native capture independently fences stale geometry through the watcher. These protections must remain.

RX src/webcast/WebCastInputPeer.cpp Source rejects a changed geometryRevision while streamId or pendingCommandId exists. ApplySource also calls WebCastTouchbackRouter::SetSource, which rejects a different or unavailable source while a stream/pending command exists. Failure invokes WebCastUnifiedHost's input fault callback and closes the control DataChannel. Thus normal geometry invalidation currently can become a terminal input-channel fault rather than a coordinated rebinding transition. TX source-advertisement ordering also needs to be reviewed with the RX lifecycle; this is a cross-end gap, not an assertion that only one side is wrong.

A stream.stateChanged closed event is not an input.closeStream response: the current RX router retains the old stream identity until explicit close completion. Merely delaying the TX source advertisement or removing the RX check is insufficient to establish the required lifecycle safely.

This is static code-path evidence matching the reported symptom; no new fault-time trace was collected for this resize incident. The Edge integration uses a cooperative simulated RX that opens on a new source binding. Its rebind pass does not establish compatibility with the strict current native RX.

## Temporary recovery

Keep the shared window visible and foreground when testing input. Use the TX Rebuild input connection action, then explicitly enable Touchback again on RX if necessary. This recreates only the input DataChannel and should retain media. If native cleanup is pending, explicitly retry cleanup first; do not bypass the owner fence.

## Remaining implementation and acceptance

Coordinate normal source invalidation, cleanup confirmation and old input.closeStream completion; retain only the latest new descriptor during resize; after geometry stabilizes, open a fresh stream if the user still requests control. Handle invalidation during opening/closing, repeated resizes, minimized/foreground recovery, held contacts and cleanup failure. Do not carry old coordinates/stream sequence state into the new binding.

Validate with the actual RX across browser-window resize, rapid drag-resize, move, minimize/restore, foreground loss/return and in-flight Touch. Require unchanged video delivery, fresh sourceBindingId/streamId, correct new pixel mapping, zero stuck contacts and green only after new native ownership is confirmed.

No resize-recovery implementation or RX modification is included in the current TX commit. The commit records the verified capture, picker, queue, diagnostics and stale-readback improvements and this known remaining limitation.
