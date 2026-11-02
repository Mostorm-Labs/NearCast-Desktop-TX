# NearCast sender code-display contract adjustment

**Goal:** Consume the receiver contract in NearCast `codex/touchback-webcast`, preserving the approved Launcher sender UI and manual four-character pairing flow.

**Architecture:** Only `_nearcast._tcp.local.` identifies NearCast. `webcast`, `code-display-v1`, and `touchback-v1` gate independent capabilities. Code-display is an HTTPS POST to `/nearcast/code-display`, separate from WebSocket join and Touchback authorization. Tauri uses a bounded native WinHTTP request to avoid WebView CORS restrictions, retaining Windows certificate validation.

**Contract:** Receiver `docs/superpowers/specs/2026-10-30-nearcast-webcast-mdns-code-display-design.md` and `src/webcast/LocalWebCastDiscovery.{h,cpp}`. Request fields: type, version=1, deviceId, requestId, reason (64 UTF-8 bytes maximum). Body <=1024 bytes. Response fields: type, version=1, requestId, status; status is shown/unavailable/rate_limited/not_supported. Never consume or expose a code from discovery or display responses.

**Review focus:** AirPlay advertising NearCast tokens; NearCast without webcast; expired selection; stale HTTP/socket/channel callbacks after selection/disconnect; untrusted local TLS certificates. Keep existing dirty files and work in place because this adjusts that unfinished implementation.

- [x] Add failing tests for capability separation, private discovery fields, secure endpoints, HTTPS display transport/status projection, no signaling fallback, timeout/cancellation, and stale peer callbacks.
- [x] Implement capability normalization and bounded code-display lifecycle; mirror runtime modules to dist (preserving the packaged discovery import).
- [x] Add native fixed-path WinHTTP command with TLS validation, disabled redirects/proxy, finite timeout, bounded response, status-only projection. Wire device selection/UI to it; fence Touchback on session end.
- [x] Run full Node suite, Rust tests/build, diff check, review changes, launch EXE and report measured size plus actual integration limitations.

## Verification and decisions

- Node full suite: 44/44. Rust cargo test: 2/2 plus binary/doc targets. Final asset rebuild and diff check succeeded. EXE 13,835,776 bytes (13.84 MB / 13.19 MiB), PID 460, responsive window `NearCast Desktop TX`. SHA256: `1FA78DE3957C64F4ACAA695ED0099EB5160DAD1A623191A77A9FA701EDADCAD4`.
- Real Edge browser smoke (with synthetic Tauri discovery/HTTP boundary, not a live receiver): rendered the sender page, NearCast selectable / AirPlay disabled, fixed HTTPS command and reason, no automatic code fill or WebSocket during discovery, manual pairing still uses Launcher endpoint, invalid-code recovery, zero page JavaScript errors.
- Browser test caught and verified fixes for the packaged discovery import 404 and CSS overriding the hidden casting panel.
- Decision: retain Launcher signaling endpoint when selecting a discovery record. The receiver advertises its local control endpoint while cloud code remains authoritative when cloud is healthy. Automatic local/cloud signaling selection needs an explicit receiver contract; `?ws=` remains the local-room override.
- Native Windows UI inspection unavailable: Computer Use pipe missing. Remote WebView debugging launch rejected by automatic approval policy; used normal browser smoke instead, without bypassing policy.
- Independent review was attempted but the reviewer tool received an empty payload; performed direct source/runtime review. No claim of independent review or live receiver interoperability.
- Existing async Touchback frame serialization/native pointer cancellation limitations are outside this discovery/display request adjustment and still require dedicated end-to-end coverage.

## Discovery review fixes (2026-10-31)

Authorized fixes: preserve native certificate error strings in UI; avoid false device disappearance at TXT ttl=60; bind HTTPS target to the resolved DNS-SD service rather than TXT authority.

- [x] Reproduce Tauri string rejection dropping the certificate hint, add regression, fix src/dist. Node 45/45 and browser failure-path smoke pass. Explicit device trust/enrollment/revocation remains absent; no TLS bypass or automatic mDNS trust.
- [x] Add JS/Rust regressions for native snapshot renewal past 60 seconds, actual native removal, stop/start, and arbitrary TXT endpoint rejection/override by SRV target.
- [x] Native owns active records and emits snapshots every 15 seconds with 45-second bridge leases. mdns-sd owns DNS refresh, goodbye and DNS TTL expiry; a native removal immediately clears snapshots, and a stopped native worker cannot indefinitely renew UI leases.
- [x] HTTPS bridge accepts selected service instance and looks it up in native active discovery. Use only its SRV port and resolved addresses/hostname; probe bounded resolved addresses for connectivity without weakening TLS verification. TXT never supplies a new destination.
- [x] Run full tests, live mDNS fixture over 60 seconds plus unregister, browser smoke, build EXE and report remaining TLS trust gap.

The historical Windows-root TLS approach above is superseded by the explicitly authorized on-site SPKI pin flow in `2026-10-31-device-trust.md`; see README for the current contract.
