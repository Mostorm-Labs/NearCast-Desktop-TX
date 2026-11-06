# Window resize Touchback recovery implementation plan

> Execute inline using the systematic-debugging and test-driven-development workflows.

**Goal:** Keep the user's enabled intent through temporary window geometry/readiness changes, release the old stream, and open a fresh stream automatically once geometry is valid.

**Base:** TX `e413389c3d83f7a2958be75f95e735053fde4419`, branch `codex/window-resize-touchback-recovery`; RX `d842081` on the existing verification branch. Retain the upstream Touch feedback implementation.

**Architecture:** TX publishes a source only after its owned canvas output and native capture geometry agree. Native readiness reasons remain distinguishable. RX preserves intent only for recoverable capture transitions, fences capture immediately, confirms old native cleanup, then negotiates a new stream on the existing input session. Explicit Off, authorization loss, retired targets and transport faults must not auto-enable input.

## Task: coordinated capture recovery

- [x] Reproduce old canvas settings during a real Edge resize and add a native-capture producer regression for notification/output ordering.
- [x] Add TX readiness-reason tests and RX real Host/WebRTC regressions for automatic recovery, late open completion, held contacts and Off during recovery.
- [x] Keep output dimensions truthful to the owned renderer and publish changed geometry after rendering/requesting the frame. Preserve native identity, revision, aspect and readiness checks.
- [x] Preserve distinct TX foreground/minimized/waiting-frame diagnostics instead of the legacy full-monitor guidance.
- [x] Retain RX intent only across recoverable source changes; close/cleanup confirmation remains mandatory, failures remain blocked, and late operations cannot undo Off.
- [x] Update the shared RX/console guidance and verify user-visible paused versus active state.
- [x] Run affected Windows/native and Node/browser tests, dependency boundaries, diff checks and clean recursive RX checkout validation. Record baseline native capture failures honestly.
- [x] Build distinct TX/RX test artifacts and restart RX only when idle, retaining all protocol and generated-input pins.

## Review focus

Repeated resize, resize during open/close, failed native release, stale source advertisements, explicit cancellation, permission withdrawal, media continuity and fresh contact lifecycles. No AXTP field/ID changes or input-type conversion.
