# NearCast device trust implementation plan

> **For agentic workers:** Execute inline with superpowers:executing-plans, testing each task before implementing it.

**Goal:** The on-site user compares the receiver's full SHA256(DER SPKI) fingerprint once and explicitly saves trust per exact deviceId.

**Architecture:** Observe the TLS public key without sending HTTP, then use a TLS verifier that checks that exact key before a fixed trust-display POST. A short-lived native candidate is confirmed explicitly in the sender UI. Code-display requires the persisted key and rejects rotation; mDNS supplies addresses and capabilities only.

**Tech Stack:** Existing Tauri/JavaScript; rustls with ring, x509-parser, SHA-256; native JSON trust file in the app data directory.

**Spec:** Receiver conversation 01a18b97-ea9b-7c70-b2cd-d876732ee098: user chose on-site fingerprint confirmation on 2026-10-31; sender task and exact protocol delegated after that confirmation.

## Global constraints

- Preserve Launcher pairing/WebRTC and manual four-character entry. Trust never authorizes pairing or Touchback.
- Register/browse only `_nearcast._tcp.local.` for NearCast; AirPlay remains display-only.
- `trust-display-v1` gates bootstrap; POST `/nearcast/trust-display` has exactly type/version/deviceId/requestId, version 1, no reason.
- Trust response has only type/version/requestId/status. Allowed statuses: shown/unavailable/rate_limited/not_supported. Fingerprint comes from TLS, never response/TXT.
- Before confirmation allow only TLS observation and the fixed trust-display request pinned to the observed key. Never send code-display before a saved pin exists.
- SHA256(DER SPKI), full uppercase 64 hex; keyed by exact deviceId. Reissued certificates with same key remain trusted; different keys require explicit on-site re-confirmation. Provide revoke.
- HTTP bounds: request <=1KiB, response <=4KiB; no proxy, redirects, cookies, ambient authentication; bounded network time.

## Review focus

- Key changes between observation and request: no application bytes to the changed key.
- Reissued certificate for same key: retained trust despite SAN/IP/certificate changes.
- Expired/cancelled candidate, switched/offline receiver or late callbacks: no implicit persistence or code-display.
- Corrupt/unwritable trust store: fail closed without disabling manual Launcher pairing.
- Spoofed TXT identity/fingerprint/capability: never establishes trust; native lookup validates instance and exact deviceId.

## Tasks

- [x] 1. Write failing Rust tests for SPKI pins, fixed trust protocol and store lifecycle; replace WinHTTP with pre-HTTP rustls verification, handshake-only observation, bounded HTTP and real TLS fixtures proving key mismatch sends no HTTP.
- [x] 2. Write failing Rust tests for candidate expiry, explicit confirmation/revoke and discovery trust capability; wire native prepare/confirm/status/revoke commands and require saved pins in code-display.
- [x] 3. Write failing JS tests for UI trust state/cancellation; add fingerprint comparison dialog, saved trust/revoke, key-change recovery, preserve manual pairing; sync source and dist and snapshot fixtures.
- [x] 4. Run all JS/Rust suites, browser UI smoke, Release build and launch; update README, report true integration limits and fresh EXE size to the receiver conversation/user.

## Execution ledger

- User authorization verified by reading original receiver messages, including explicit cross-conversation coordination and the first-trust choice. No additional approval needed for the agreed workflow.
- Ruling: continue in the existing dirty sender checkout to preserve all in-progress UI/discovery work; do not commit or move unrelated changes.
- Ruling: rustls replaces WinHTTP for these fixed operations because custom certificate verification must finish before HTTP data is written. Pinned device trust intentionally permits self-signed certificates and changing IP/SAN, with normal TLS handshake signature verification.

- Tasks 1-3 complete: Rust regressions first failed on missing implementation, then passed; JavaScript first-selection/retry races reproduced and fixed. Full suites: 56 JS passes; 17 Rust passes with live test excluded. Separate real LAN test: five snapshots across 66 seconds, unregister removes device, 67.16 seconds total.
- Browser Edge smoke: snapshot discovery, disabled AirPlay, full fingerprint display, confirmation before code, key mismatch/retry/cancel, manual Launcher join/failed-code recovery and empty snapshot removal pass with synthetic Tauri IPC. No actual native UI/receiver WebRTC claim.
- Read-only independent review found no blocking issue and ran 24 targeted JS tests; reviewer could not run Rust due to PATH. Primary ran Rust suite above.
- Final direct review found missing Tauri core event listener ACL; added only allow-listen/allow-unlisten for main window. Code-display rechecks saved trust under the confirmation/revocation lock before TLS/HTTP; revoke waits for an already in-flight fixed request, bounded by the network deadline.
- Ruling: retain existing Launcher local-WSS certificate behavior; saved native SPKI applies only to fixed trust/code HTTPS operations, not WebView2 WSS. This boundary is documented; local fallback WebRTC still needs normal WSS trust and end-to-end acceptance.
