# Input queue pressure regression

Continue `codex/touchback-input-diagnostics` from the uncommitted native-capture
and picker changes based on `142550f`. The user's failure was reproduced in the
running TX diagnostics: TIMEOUT: Input queue age, 52 received / 6 submitted,
queuePeak 46, lastNativeMs 171.6, cleanupMs 20.9. The monitor capture remained
inputReady with unchanged geometry and no cleanup pending. This is input backlog,
not evidence of lost capture mapping or the separately investigated Win32 timing
candidate. The current user process and RX were not restarted by this change.

InputEngine now validates and advances a separate ingress InputState for every
wire packet before reducing the native queue. A sequence gap, backwards cursor,
invalid contact lifecycle or negotiated-limit violation cannot disappear inside
coalescing. Only an unsubmitted pure-motion snapshot can be superseded by a newer
complete snapshot; Down/Up/Cancel snapshots themselves remain barriers. A later
full Touch snapshot may replace an older queued pure Move, including when the
new snapshot contains a terminal or newly added contact: the newer complete
snapshot and its lifecycle records are retained intact. No per-contact partial
coalescing, wire sequence rewriting, extra ACK or RX protocol change is added.
Mouse Move combines only when buttons and modifiers remain identical. Injection
commits the retained snapshot's validated state, separately from ingress state.
The 250 ms age bound and queue byte/record/sample limits remain enforced.

Windows native probe/prepare/apply/release now execute in spawn_blocking instead
of the Tauri UI thread. Existing owner/lease and native-operation ordering remain
in force. macOS handlers retain their previous threading behavior. Results expose
nativeDurationMs, and diagnostics separate lastNativeExecutionMs from the existing
round-trip lastNativeMs; coalescedSamples, receivedSeqId/submittedSeqId and queue
wait metrics make further transport/renderer delays visible. Queue-age faults
have an explicit UI message and still release held input before recovery.

Regression evidence: model 52 frames behind a slow native call; malformed queued
sequence; Down/Up/Cancel barriers; full multi-contact addition/termination; Mouse
button/modifier barriers; unmergeable queue overflow and stale-input age fencing.
The Edge integration sends continuous input for five seconds with a simulated
170 ms native round trip while decoding H.264 video. The explicit owned-window
Windows integration submits through the actual async Tauri command function,
observes PT_TOUCH receipt including moved Up, and retains dual-monitor/outline
exclusion/cleanup checks. This proves the worker/backend path, not an actual
user-WebView IPC latency improvement measurement. The new build needs sustained
user RX acceptance and inspection of the new latency counters.

An independent current C++ FramedClient probe also simulated 600858 ms with 120
stream.getState requests plus heartbeats without a session failure. Native input
in that probe was a deterministic provider, not hardware. RX read-only review
confirmed source withdrawal/geometry changes currently fence its input DC; that
separate RX rebind behavior was not changed for this monitor-backlog failure.
