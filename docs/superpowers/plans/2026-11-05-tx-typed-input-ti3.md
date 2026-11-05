# TX typed-input TI-3 implementation

## Authority and fixed inputs

User-authorized continuation on `codex/touchback-input-diagnostics`, repository
`Mostorm-Labs/NearCast-Desktop-TX`, base `a8ba5173291d8388d5a9f384d022cc2fc7bbe78f`.
Integrate macOS `5eea952` while preserving Windows input and diagnostics.

AXTP source `48144141775da6c35e579d2498d88c0b0449ed61`, Runtime
`22a21721f6ccb7d48eb980c1a94ff309325e446f`, Axent
`21ba313b79cba13e9eb189860fed27a8493f35c4`.
Contract `0.18.0-dev.feac6fa2a4b9`, unpublished development snapshot SHA256
`feac6fa2a4b9c927708c077746166259ffeb7d5f06dc6972b29f1fc30954c2d0`.
Normative entry: AXTP `specs/48-input-stream.md`; shared RX implementation and
architecture documents define TI-3 platform, source binding, and cleanup duties.

## Required implementation

1. Integrate existing macOS permission/Mouse/Scroll code and keep both platforms'
   validated providers. Resolve conflicts by behavior, preserving src/dist parity.
2. Bind exact contract facts and official vectors. Replace legacy input framing
   with Standard Frame12 + STREAM16 + typed data + CRC16, including bounded
   fragment reassembly and rejection of bare STREAM/old TouchBatch.
3. Implement one bounded common InputEngine, with immutable authenticated source
   context, independent typed state, full Touch sample validation, native ownership,
   generation fencing, timeouts, late completion cleanup, and cleanup-blocked state.
4. Introduce typed native adapters and native GeometryMapper descriptors. Initial
   Windows output is native Touch; macOS explicitly rejects native Touch while
   preserving Mouse/Scroll code for future explicit policies. No automatic conversion.
   Unknown/unproven capture-to-desktop mapping disables reverse input, not video.
5. Implement server-side AXTP CONTROL/RPC APP_READY and authenticated product text
   source/target association on the existing ordered reliable WebCast control DC.
   RX is producer/client; TX is consumer/server. Exact media-associated context and
   sourceBindingId must exist before open; no binary BIND or invented AXTP methods.
6. Route open/close and stream state queries/events to the engine; allocate nonzero
   stream IDs without reuse within a session. Close success follows confirmed native
   release; late work, failed cleanup, or retired IDs cannot reopen old state.
7. Integrate UI diagnostics/readiness without old wire mode controls. Preserve trust,
   pairing, discovery, signaling, capture, video quality, preview, and stop/leave.
8. Sync dist, run required checks, coordinate shared fixtures with RX TI-2, then
   commit/push exact tested results and record known physical/platform limits.

## Verification and completion boundary

- TDD: official 25 valid-frame / 13 rejection traces, independent JS/C++ wire oracle;
  full Touch sampling, malformed/duplicate/missing contacts, ID reuse, stream/session
  fencing, queue bounds, timeouts, partial/unknown native result, cleanup failure.
- Common engine and provider tests, Windows positive native Touch path and explicit
  macOS unsupported-native-Touch path; typed interleaving never causes mode resets.
- Actual CONTROL/RPC handshake and source/target/open/close exchange with RX's provider
  fixture, including mismatched fingerprints, stale binding and late responses.
- Existing Node suite, locked Rust tests/check/build, src/dist equality, diff check,
  and Edge video regression. Native OS tests run explicitly in an owned test window.
- Windows code/build and fixture integration are required here. macOS compilation,
  signing, real Touch hardware/app receipt, mixed-DPI and additional capture targets
  are separately recorded hardware/hosted checks; no substitute test proves them.
- Terminal success: complete TX production migration, all applicable local checks and
  cross-process fixture pass, exact source delivery, truthful capabilities and limits.
  If RX fixture readiness is pending, continue all independent work and leave that
  dependency explicit. Missing semantic authority routes to the protocol/RX owner;
  do not invent replacement wire, silently fall back, or claim interoperability.

Continue through the full implementation and verification; intermediate codec or
merge checkpoints are not completion of TI-3. This plan does not authorize changes
to RX-owned files/processes or publication of the unpublished contract as a release.
