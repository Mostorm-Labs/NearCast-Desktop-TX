import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizePlatformInfo,
  platformSummary,
  screenCaptureError,
  touchbackSummary,
  touchbackError,
  loadPlatformInfo,
} from '../src/platform-capabilities.mjs';

test('normalizes Windows 10/11 capabilities from the native command', () => {
  const info = normalizePlatformInfo({
    os: 'windows',
    webview: 'WebView2',
    screenCapture: true,
    screenCapturePermission: 'not_required',
    touchback: true,
  });

  assert.equal(info.os, 'windows');
  assert.equal(info.screenCapture, true);
  assert.equal(info.touchback, true);
  assert.match(platformSummary(info), /Windows 10\/11/);
  assert.match(touchbackSummary(info), /Windows.*Touch/);
  assert.match(touchbackSummary(info), /原生 Touch 和 Mouse/);
});

test('normalizes macOS 13+ capabilities and calls out Screen Recording permission', () => {
  const info = normalizePlatformInfo({
    os: 'macos',
    webview: 'WKWebView',
    screenCapture: true,
    screenCapturePermission: 'required',
    touchback: true,
    inputControl: 'macos-mouse',
    multiTouch: false,
    accessibilityPermission: 'required',
  });

  assert.equal(info.os, 'macos');
  assert.equal(info.screenCapture, true);
  assert.equal(info.touchback, true);
  assert.equal(info.inputControl, 'macos-mouse');
  assert.match(platformSummary(info), /macOS 13\+/);
  assert.match(platformSummary(info), /屏幕录制/);
  assert.match(touchbackSummary(info), /主屏幕/);
  assert.match(touchbackSummary(info), /Mouse/);
  assert.match(touchbackSummary(info), /可配置 Touch 转鼠标或滚动/);
  assert.match(touchbackError('not_authorized', info).message, /隐私与安全性 → 辅助功能/);
  assert.match(screenCaptureError(new DOMException('denied', 'NotAllowedError'), info).message, /屏幕录制/);
});

test('reports a useful WebView error when getDisplayMedia is unavailable', () => {
  const info = normalizePlatformInfo({os: 'windows', screenCapture: false, touchback: true});
  const error = screenCaptureError(new Error('Screen capture is unavailable'), info);
  assert.match(error.message, /WebView2/);
});

test('loads native platform information without making browser tests depend on Tauri', async () => {
  const info = await loadPlatformInfo(async command => {
    assert.equal(command, 'nearcast_platform_info');
    return {os: 'macos', screenCapturePermission: 'required', touchback: false};
  });
  assert.equal(info.os, 'macos');
  assert.equal(info.touchback, false);
});
