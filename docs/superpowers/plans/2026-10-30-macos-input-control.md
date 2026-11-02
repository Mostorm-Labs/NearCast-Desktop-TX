# macOS Mouse Control Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add macOS 13+ mouse, button, drag and modifier injection while preserving the Launcher-compatible Touchback wire protocol. Keyboard and wheel require a versioned protocol extension because current records contain no keycode or wheel delta.

**Architecture:** Keep `LauncherCompatibleWebCastSender` and `WebCastTouchbackSender` unchanged at the protocol boundary. Select a platform input sink after the native platform capability is known. Windows keeps Pointer Injection; macOS uses a Rust CoreGraphics bridge guarded by the Accessibility permission and a single active pointer contact. The current frame has no key-code field, so keyboard injection is deferred until a versioned key-event extension exists.

**Tech Stack:** Tauri 2, Rust FFI to macOS ApplicationServices/CoreGraphics, existing ES module Touchback pipeline, Node test runner.

**Spec:** `docs/superpowers/specs/2026-10-30-macos-input-control-design.md`

## Global Constraints

- macOS 13+ only for the new native branch; Windows 10/11 behavior remains unchanged.
- No virtual HID/DriverKit extension and no mouse fallback for multi-contact records.
- No changes to Touchback header, sequence, binding, or WebCast signaling.
- Accessibility denial must return `not_authorized` and release active buttons on reset/fence.

## Tasks

- [x] Add tested asynchronous macOS sink and Tauri command bridge; cover authorization, pointer/button/drag/modifier mapping, one-contact validation, reset and bridge calls.
- [x] Add `cfg(target_os = "macos")` CoreGraphics implementation and platform command registration; keep Windows command paths separate.
- [x] Select macOS sink in the Tauri page and show mouse support, protocol-extension limits, and “多指触控暂不支持”; sync `dist` assets and permissions/docs.
- [ ] Run full JavaScript tests, Windows Rust tests/check/build, syntax/diff checks; record macOS CI/manual validation limits.

## Review Focus

- An async `invoke` result must not authorize input before Accessibility permission is confirmed.
- A second contact or changed button state must be rejected without emitting a click.
- Reset/fence must release a pressed button even when the session ends during async injection.
- macOS must never call Windows pointer commands; AirPlay remains display-only.
- Existing Launcher binary frames and sequence handling must remain byte-compatible.
