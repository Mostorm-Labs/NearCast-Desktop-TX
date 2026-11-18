const OS_LABELS = Object.freeze({windows: 'Windows 10/11', macos: 'macOS 13+', linux: 'Linux', unknown: '当前平台'});

export function normalizePlatformInfo(value = {}) {
  value = value ?? {};
  const os = ['windows', 'macos', 'linux'].includes(value.os) ? value.os : 'unknown';
  return Object.freeze({
    os,
    webview: String(value.webview || (os === 'windows' ? 'WebView2' : os === 'macos' ? 'WKWebView' : 'unknown')),
    screenCapture: value.screenCapture !== false,
    nativeCapture:value.nativeCapture===true,
    captureBackend:value.captureBackend??'browser',
    systemAudio:value.systemAudio===true,
    screenCapturePermission: ['required','on_selection'].includes(value.screenCapturePermission) ? value.screenCapturePermission : 'not_required',
    touchback: value.touchback === true,
    inputControl: value.touchback === true ? (['windows-pointer', 'macos-mouse', 'none'].includes(value.inputControl) ? value.inputControl : os === 'macos' ? 'macos-mouse' : os === 'windows' ? 'windows-pointer' : 'none') : 'none',
    multiTouch: value.multiTouch === true,
    accessibilityPermission: value.accessibilityPermission === 'required' ? 'required' : 'not_required',
  });
}

export function platformSummary(info) {
  const value = normalizePlatformInfo(info);
  const permission = value.screenCapturePermission === 'required' ? '；首次分享需要允许“屏幕录制”' : '';
  return `${OS_LABELS[value.os]} · ${value.webview}${permission}`;
}

export function touchbackSummary(info) {
  const value = normalizePlatformInfo(info);
  if (value.inputControl === 'macos-mouse') return '反控：macOS 原生 Mouse；可配置 Touch 转鼠标或滚动；请分享单一主屏幕并允许“辅助功能”';
  if (value.inputControl === 'windows-pointer') return '反控：Windows 原生 Touch 和 Mouse；可配置触控手势转鼠标或 Mouse 转单点 Touch；窗口仅支持投屏';
  return 'Touchback：当前平台不支持反向控制';
}

export function touchbackError(status, info) {
  const value = normalizePlatformInfo(info);
  if (status === 'not_authorized' && value.os === 'macos') return new Error('macOS 反向控制需要在“系统设置 → 隐私与安全性 → 辅助功能”中允许 NearHub Cast，然后重新连接接收端。');
  if (status === 'not_supported') return new Error('当前平台不支持 Touchback；屏幕分享仍可继续。');
  return new Error(`Touchback 控制失败：${status}`);
}

export function screenCaptureError(error, info, {screenRecording} = {}) {
  const value = normalizePlatformInfo(info);
  const original = error instanceof Error ? error : new Error(String(error || 'Screen capture failed'));
  const failure=(code,permission)=>Object.assign(new Error(code),{code,...(permission?{permission}:{})});
  // A cancelled picker can reject with NotAllowedError too. Explicit user
  // cancellation takes precedence over permission words and cached OS state.
  if (/cancel|用户.*(?:取消|退出|关闭)|取消.*(?:选屏|屏幕选择)/i.test(original.message)) {
    return failure('screen_capture_cancelled');
  }
  if (!value.screenCapture || /unavailable|not supported/i.test(original.message)) {
    return new Error(`${platformSummary(value)}：当前 WebView 不提供屏幕分享，请更新应用或使用受支持的系统。`);
  }
  if (['NotAllowedError','SecurityError'].includes(original.name) || /denied|permission|not_authorized/i.test(original.message)) {
    if(value.os==='macos'&&value.screenCapturePermission==='required'&&screenRecording==='not_granted')return failure('screen_capture_permission_required','screenRecording');
    return failure('screen_capture_not_allowed');
  }
  return original;
}

export async function loadPlatformInfo(invoke = globalThis.__TAURI__?.core?.invoke) {
  if (typeof invoke !== 'function') return normalizePlatformInfo();
  try { return normalizePlatformInfo(await invoke('nearcast_platform_info')); }
  catch { return normalizePlatformInfo(); }
}
