# Windows / macOS Compatibility Implementation Plan

**Goal:** Prepare the existing Launcher-compatible sender for Windows 10/11 and macOS 13+, retaining pairing, discovery and browser WebRTC.

**Architecture:** Keep capture in `getDisplayMedia` and transport in the current WebCast client. Query native platform capabilities, handle permission errors separately from connection errors, and package on each native build host. On macOS the screen-only sender uses WebKit's default media UI instead of Wry's camera/microphone delegate, plus an explicit system Screen Recording permission action. No WebKit private API is used.

**Spec:** `docs/superpowers/specs/2026-10-30-cross-platform-support-design.md`

## Constraints

- Windows 10/11, macOS 13.0+; Intel and Apple Silicon macOS artifacts.
- No new WebCast protocol or native WebRTC stack; manual pairing and user-initiated capture stay intact.
- macOS uses the CoreGraphics mouse sink and must not initialize Windows Pointer Injection.
- Preserve existing uncommitted work in the supplied workspace; no merge, push or publication.
- Hosted macOS 13 runners are retired. Build with deployment target 13.0 on currently available Intel/ARM hosts; oldest-OS runtime verification remains a separate hardware check.

## Tasks

- [x] Add platform capability normalization, native command and UI labels; verify Node tests and Windows cargo check.
- [ ] Complete macOS default capture-picker setup, permission command/button, and LAN privacy declarations. Test permission/result states and native platform data; macOS execution requires Mac hardware.
- [ ] Configure Windows NSIS/MSI + WebView2 bootstrapper and macOS app/dmg builds on native runners, including Rust tests and retained build artifacts.
- [ ] Sync packaged modules, run full Node/Rust checks, rebuild Windows release, inspect launch, and update README with actual verification limits.

## Review focus

- Missing media APIs must not prevent LAN discovery/UI startup.
- Permission denial/cancellation must preserve the paired connection and allow retry.
- macOS must skip Windows Pointer Injection even when a receiver advertises touchback-v1.
- Installer bundle lists must be native to their host; CI must not use retired runner labels.
- A minimum deployment target/build success is not evidence of macOS 13 or Windows 10 runtime success.

## Progress

Existing work was retained in place. Local verification so far: Node 62/62, cargo check success, Rust 17 passed / 1 live LAN test ignored, Windows release compiled. macOS native/build validation and CI execution are pending; no macOS support claim is made from these Windows results.
