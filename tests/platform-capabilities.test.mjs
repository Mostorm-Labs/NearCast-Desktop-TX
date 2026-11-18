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
  assert.equal(screenCaptureError(new DOMException('denied', 'NotAllowedError'), info, {screenRecording:'not_granted'}).permission,'screenRecording');
});

for(const location of ['../src/platform-capabilities.mjs','../dist/platform-capabilities.mjs']){
  test(`${location}: explicit picker cancellation never becomes a permission error even without an OS grant`,async()=>{
    const {screenCaptureError}=await import(location);
    for(const message of ['Cancelled by user','User canceled screen selection','用户取消了屏幕选择']){
      const failure=screenCaptureError(new DOMException(message,'NotAllowedError'),{os:'macos'},{screenRecording:'not_granted'});
      assert.equal(failure.code,'screen_capture_cancelled');assert.equal(failure.permission,undefined);
    }
  });
  test(`${location}: ambiguous picker denial only offers settings after a confirmed missing native permission`,async()=>{
    const {screenCaptureError}=await import(location);
    for(const screenRecording of ['granted','unknown',undefined]){
      const failure=screenCaptureError(new DOMException('Permission denied','NotAllowedError'),{os:'macos',screenCapturePermission:'required'},{screenRecording});
      assert.equal(failure.code,'screen_capture_not_allowed');assert.equal(failure.permission,undefined);
    }
    const failure=screenCaptureError(new DOMException('Permission denied','NotAllowedError'),{os:'macos',screenCapturePermission:'required'},{screenRecording:'not_granted'});
    assert.equal(failure.code,'screen_capture_permission_required');assert.equal(failure.permission,'screenRecording');
    const picker=screenCaptureError(new DOMException('Permission denied','NotAllowedError'),{os:'macos',screenCapturePermission:'on_selection'},{screenRecording:'not_granted'});
    assert.equal(picker.code,'screen_capture_not_allowed');assert.equal(picker.permission,undefined,'a missing broad grant cannot explain a session-scoped picker failure');
  });
  test(`${location}: Windows cancellation never exposes a macOS settings action and unrelated failures stay intact`,async()=>{
    const {screenCaptureError}=await import(location);
    const failure=screenCaptureError(new DOMException('Cancelled by user','NotAllowedError'),{os:'windows'});
    assert.equal(failure.code,'screen_capture_cancelled');assert.equal(failure.permission,undefined);
    const original=new Error('Encoder failed');assert.equal(screenCaptureError(original,{os:'macos'},{screenRecording:'not_granted'}),original);
  });
}

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
