# TX typed input TI-3

This is the current integration contract. Earlier BIND/TouchBatch/epoch and
single-mode documents are historical and do not describe this runtime.

## Fixed authority

| Input | Commit / value |
|---|---|
| AXTP | `48144141775da6c35e579d2498d88c0b0449ed61` |
| C++ Runtime | `22a21721f6ccb7d48eb980c1a94ff309325e446f` |
| Axent TI-1 base | `21ba313b79cba13e9eb189860fed27a8493f35c4` |
| Contract | `0.18.0-dev.feac6fa2a4b9`, **published=false** |
| Fingerprint | `feac6fa2a4b9c927708c077746166259ffeb7d5f06dc6972b29f1fc30954c2d0` |
| Official corpus SHA256 | `f4ec706d34353b2532f84f3cd9a228145671d7c9345258293a9bff0b6d637645` |

`scripts/sync-axtp-typed-input.mjs <axtp-repo> <runtime-repo>` reads exact git
objects, generates browser wire/session constants and copies the official corpus.
It does not fetch, switch upstream checkouts, or publish the development contract.

## Production boundaries

RX is producer/client and TX consumer/server on one ordered, reliable `control`
DataChannel authenticated by the existing WebCast peer. CONTROL OPEN/ACCEPT and
Hello/Identify/Identified establish APP_READY. RPC uses the standard JSON encoding
and `{sid,op,d}` envelope. Input is Standard Frame12 + STREAM16 + typed input data
+ CRC16. Fragmentation is bounded; bare STREAM, private text RPC, binary BIND,
TouchBatch headers, wire epoch/tokens and CRC32 input are retired.

Authenticated product text messages `nearcast-input-target` / `nearcast-input-source`
associate the RX target with a fresh TX-owned sourceBindingId. The exact shared
schema/example is `tests/fixtures/typed-input-webcast.json`. This descriptor carries
software capability even while unavailable. Native owner IDs and leases never
leave the local process boundary. Source availability requires local opt-in,
APP_READY, RX target, live capture, native readiness and proven capture geometry.

The engine separately validates Touch and Mouse; default output policy is `native`.
One Touch packet is one complete sampling, including stationary active contacts
and terminal records. Mouse packets contain explicit Mouse semantics. No automatic
Touch-to-Mouse conversion is reachable from the production entry point.

Windows TI-3 exposes native Touch (10 contacts). The earlier Windows Mouse backend
is retained and tested, but is **not advertised as typed Mouse support** until its
typed feature mapping is implemented. macOS exposes basic native Mouse: three
buttons, no chords/modifiers/wheel. Native Touch is rejected on macOS. Prior Mac
gesture/scroll policy material remains in source/tests for a future explicit
policy; the old selection UI and unowned native command bridge are removed.

## Ownership and recovery

InputEngine owns one immutable authenticated context and serial native operation
chain. Queues have sample/record/byte/age limits. Session, source, capture, geometry,
permission and local-gate changes fence old work. Timeouts do not erase the actual
in-flight operation or permit a new native owner. Partial/unknown native results
release only this owner; native cleanup uncertainty remains `cleanup_blocked`.

`input.closeStream` succeeds only after native release confirmation. Failures use
`d.status={ok:false,code:15,msg:"UNAVAILABLE",details:{cleanupPending:true,...}}`
without result. Failed prepare with pending cleanup uses the same details. It
does not grant the RX a stream ID. The RX then waits for TX local recovery; it must
not invent a close ID. Stream IDs are nonzero and never reused within an
authenticated input session. Ordinary input has no application ACK.

For a known ID, the RX may explicitly retry close. For an unknown-ID failed open,
click TX **重试释放输入**, wait for cleanup to confirm, then **重建反控连接**. This
retires the old input session on the same media peer; the RX explicitly enables
again. Do not rebuild while cleanup is pending as a substitute for releasing it.
The native global owner guard survives DataChannel replacement. RTP and the peer
connection continue during input faults and control-channel recovery.

## Geometry and current limitations

The initial proof is deliberately limited to exactly one active primary monitor,
rotation 0, full monitor capture at original native pixel dimensions. Windows
regions use physical pixels from a per-monitor DPI context; macOS input uses
CoreGraphics desktop points with separate capture pixel dimensions. No CSS screen
dimensions, labels, or guessed monitor association authorize input. Choose Auto
resolution or the display's original resolution. Window capture, multiple active
monitors, unknown capture facts and rotated displays disable input while video
continues. Additional monitor/region mapping is follow-up work.

This host reports two 1920x1080 monitors. The explicit
`input_native_tests::typed_native_touch_and_owned_cleanup_reach_our_window` run
failed its single-monitor prerequisite **before creating a window or injecting**.
It is an opt-in ignored OS test; it must run on a supported single-monitor setup.
This result is not a physical Touch pass. macOS compilation/signing and real
hardware/application receipt have not been performed on this Windows host.

## Reproducible verification

```powershell
npm test
cargo +stable test --locked --manifest-path src-tauri/Cargo.toml
cargo +stable check --locked --manifest-path src-tauri/Cargo.toml
cargo +stable build --locked --manifest-path src-tauri/Cargo.toml
git diff --check
# Independent Axent C++ FramedClient helper supplied by RX:
$env:AXENT_FRAMED_PROBE='<RX build>\Release\framed_client_probe.exe'
$env:TYPED_INPUT_EVIDENCE='<artifact directory>\tx-typed-input-axent.json'
node tests/typed-input-axent.integration.mjs
# Existing Playwright installation can be selected with PLAYWRIGHT_MODULE.
node tests/webcast-browser.integration.mjs
```

The independent helper SHA256 used here is
`5dbe03803521018da58a22cd6ec18f7ca1d5dce95f4a346387cd33f3c38ceb00`.
Its FramedClient additions are RX-owned work after the TI-1 base; the executable
hash identifies the exact tested binary. The wire trace covers handshake, source
association, open, single and fragmented two-contact samples, no ordinary ACK,
UNAVAILABLE cleanup details, explicit close retry and new stream ID. The native
provider in this cross-process test is deterministic and does not inject OS input.

The Edge fixture runs real SDP/ICE/DTLS/SCTP/H.264 RTP with canvas capture and a
local signaling fixture. It checks cancellation, stop/reselect with one video
transceiver, malformed input closing only the DC, continued decoded video,
explicit DC recovery and leave. Decoder statistics avoid viewport-dependent
render callbacks. Neither fixture substitutes for the actual OS screen picker or
end-to-end physical Touch on the real RX.

Recorded on 2026-11-06: `npm test` **122 passed**; locked Windows Rust tests
**32 passed, 3 opt-in tests ignored**; locked Windows check/build passed; exact
contract regeneration and src/dist parity passed. Independent C++ exchange passed
five samples including fragmented two-contact groups and blocked-close retry.
Edge regression passed malformed-input isolation and three successive control
channels on the same media peer. `git diff --check` passed. The explicit native
Touch prerequisite failure described above remains an unresolved host limitation.
