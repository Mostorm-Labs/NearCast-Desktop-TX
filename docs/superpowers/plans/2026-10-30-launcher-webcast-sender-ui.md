# Launcher-Compatible WebCast Sender UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the placeholder Tauri page with a minimal Launcher-compatible WebCast sender UI that accepts a pairing code, establishes WebSocket/WebRTC signaling, starts screen capture, and attaches the existing Touchback control channel.

**Architecture:** Keep the existing protocol and Touchback modules. Add a browser-native signaling/WebRTC facade with dependency injection so the UI can run in Tauri and tests can use fakes. The page is plain HTML/CSS/ES modules to avoid introducing Vue/Electron dependencies; it delegates connection and capture behavior to the facade and exposes explicit connect, start share, and stop actions.

**Tech Stack:** Tauri 2, browser WebRTC (`RTCPeerConnection`, `RTCDataChannel`, `getDisplayMedia`), WebSocket, ES modules, Node test runner.

**Spec:** User request: implement方案1 using Launcher WebCast sender flow and connect the WebRTC screen-sharing interface.

## Global Constraints

- Reuse the existing Launcher-compatible WebCast and Touchback sender modules.
- Do not add mouse fallback or invent a new WebCast wire protocol.
- Pairing code is required before signaling.
- Screen capture is requested only after the user presses the share button.
- Disconnect/stop fences Touchback and closes WebRTC/WebSocket resources.

## Review Focus

- Empty or malformed pairing input keeps the UI idle and shows an actionable error.
- WebSocket signaling messages are JSON and route offer/answer/ICE through the WebRTC controller.
- DataChannel open attaches to the existing Touchback sender without replacing the WebRTC control channel.
- Screen capture permission denial returns the UI to connected state and releases partial resources.
- Stop/disconnect closes resources and fences active touch contacts.

---

### Task 1: Sender WebRTC/signaling facade

**Files:**
- Create: `src/webcast/launcher-webcast-client.mjs`
- Test: `tests/webcast-client.test.mjs`

**Interfaces:**
- Produces `LauncherWebCastClient({WebSocketImpl, RTCPeerConnectionImpl, mediaDevices, endpoint})` with `connect(pairCode)`, `startScreenShare()`, `stop()`, `snapshot()`, and event callbacks.
- Callback events: `status`, `error`, `control-channel`, `stream`.

- [ ] Write tests for pairing validation, offer signaling, answer/ICE routing, media capture, and stop cleanup.
- [ ] Run the focused test and confirm it fails because the module is missing.
- [ ] Implement the smallest client matching Launcher sender flow: WebSocket pair-code handshake, sender PeerConnection/data channel, offer/answer/ICE handling, `getDisplayMedia`, and cleanup.
- [ ] Run focused and full tests.

### Task 2: Tauri sender page

**Files:**
- Modify: `dist/index.html`
- Create: `dist/app.mjs`
- Create: `dist/styles.css`

**Interfaces:**
- Page invokes `LauncherWebCastClient` and existing `WebCastTouchbackSender` through Tauri `invoke`.
- UI actions: connect/disconnect and start/stop sharing.

- [ ] Add accessible pairing form, status area, share controls, and local preview.
- [ ] Wire button state to client status and surface errors.
- [ ] Attach the Touchback control channel and forward binary messages to `WebCastTouchbackSender`.
- [ ] Run the Tauri app and verify the window renders the sender UI.

### Task 3: Build and regression verification

**Files:**
- Modify: `README.md`

- [ ] Document launcher-compatible sender flow and local run command.
- [ ] Run Node tests, `git diff --check`, and `cargo check --manifest-path src-tauri/Cargo.toml` with the configured proxy.
- [ ] Launch the debug executable and verify it remains responsive with the new page.
