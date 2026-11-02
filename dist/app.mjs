import {LauncherWebCastClient, DEFAULT_ENDPOINT} from './webcast/launcher-webcast-client.mjs';
import {ReceiverTrust, formatFingerprint} from './webcast/receiver-trust.mjs';
import {WebCastTouchbackSender} from './webcast/touchback-sender.mjs';
import {createPlatformInputSink} from './touchback/platform-input.mjs';
import {TauriDeviceDiscovery} from './tauri-device-discovery.mjs';
import {loadPlatformInfo, platformSummary, screenCaptureError, touchbackSummary, touchbackError} from './platform-capabilities.mjs';
import {canAttachTouchbackChannel} from './webcast/touchback-channel-policy.mjs';
import {normalizeVideoQuality} from './webcast/video-quality.mjs';

const tauri = globalThis.__TAURI__ ?? {};
const invoke = tauri.core?.invoke ?? (async () => false);
const listen = tauri.event?.listen ?? (async () => () => {});
const codeView = document.querySelector('#code-view');
const castingView = document.querySelector('#casting-view');
const pairForm = document.querySelector('#pair-form');
const digits = [...document.querySelectorAll('.code-digit')];
const connectButton = document.querySelector('#connect-button');
const codeError = document.querySelector('#code-error');
const codeDisplayStatus = document.querySelector('#code-display-status');
const trustCard = document.querySelector('#trust-card');
const trustCopy = document.querySelector('#trust-copy');
const trustFingerprint = document.querySelector('#trust-fingerprint');
const trustCheck = document.querySelector('#trust-check');
const trustCheckLabel = document.querySelector('#trust-check-label');
const trustConfirm = document.querySelector('#trust-confirm');
const trustRetry = document.querySelector('#trust-retry');
const trustCancel = document.querySelector('#trust-cancel');
const trustRevoke = document.querySelector('#trust-revoke');
const trustError = document.querySelector('#trust-error');
const targetName = document.querySelector('#target-name');
const castStatus = document.querySelector('#cast-status');
const shareButton = document.querySelector('#share-button');
const stopShareButton = document.querySelector('#stop-share-button');
const leaveButton = document.querySelector('#leave-button');
const previewWrap = document.querySelector('#preview-wrap');
const preview = document.querySelector('#preview');
const castError = document.querySelector('#cast-error');
const platformStatus = document.querySelector('#platform-status');
const touchbackStatus = document.querySelector('#touchback-status');
const deviceGroups = document.querySelector('#device-groups');
const deviceStatus = document.querySelector('#device-status');
const refreshDevices = document.querySelector('#refresh-devices');
const videoResolution = document.querySelector('#video-resolution');
const videoBitrateMode = document.querySelector('#video-bitrate-mode');
const videoBitrate = document.querySelector('#video-bitrate');
const videoQualitySummary = document.querySelector('#video-quality-summary');

const defaultEndpoint = new URLSearchParams(location.search).get('ws') || DEFAULT_ENDPOINT;
let selectedEndpoint = defaultEndpoint;
let selectedDevice = null;
let activeDevice = null;
let currentStatus = 'idle';
let codeDisplayRequestId = null;
let trustDevice = null;
let platformInfo = null;
let touchback;
let platformReady = Promise.resolve();
let controlGeneration = 0;
let capturePending = false;
let videoQuality = normalizeVideoQuality({resolution: videoResolution.value, bitrateMode: videoBitrateMode.value, bitrateKbps: videoBitrate.value});
globalThis.__nearcastTouchbackDiagnostics = () => touchback?.diagnostics?.() ?? null;

const setError = (element, error) => {
  element.textContent = error ? (error.message || String(error)) : '';
  element.hidden = !error;
};
const setCodeDisplayStatus = text => { codeDisplayStatus.textContent = text || ''; };
const renderVideoQuality = () => {
  videoQuality = normalizeVideoQuality({resolution: videoResolution.value, bitrateMode: videoBitrateMode.value, bitrateKbps: videoBitrate.value});
  const resolution = videoQuality.resolution === 'auto' ? 'Auto' : videoQuality.resolution.replace('x', ' × ');
  videoQualitySummary.textContent = `${videoQuality.bitrateMode === 'fixed' ? 'Fixed' : 'Dynamic'} · ${resolution}${videoQuality.bitrateMode === 'fixed' ? ` · ${videoQuality.bitrateKbps / 1000} Mbps` : ''}`;
  videoBitrate.disabled = false;
};
videoResolution.addEventListener('change', renderVideoQuality);
videoBitrateMode.addEventListener('change', renderVideoQuality);
videoBitrate.addEventListener('change', renderVideoQuality);
renderVideoQuality();
const renderTrust = state => {
  trustCard.hidden = !state || state.phase === 'idle' || state.phase === 'trusted' && !state.fingerprint;
  trustCheck.checked = false; trustConfirm.disabled = true; trustConfirm.hidden = state?.phase !== 'compare'; trustCheckLabel.hidden = true; trustRevoke.hidden = true;
  trustRetry.hidden = !['changed','expired','untrusted','error'].includes(state?.phase) || !state.device?.supportsTrustDisplay;
  trustFingerprint.textContent = '';
  setError(trustError, state?.error ? new Error(state.error) : null);
  if (!state || state.phase === 'idle') return;
  if (state.phase === 'trusted') { trustCopy.textContent = '此设备已完成现场核对，可以请求接收端显示配对码。'; trustFingerprint.textContent = formatFingerprint(state.fingerprint); trustRevoke.hidden = false; return; }
  if (state.phase === 'compare') { trustCopy.textContent = `${state.previousFingerprint && state.previousFingerprint !== state.fingerprint ? '此设备的公钥已变化。' : ''}请确认接收端顶部显示的指纹与下方四行内容完全一致，核对后勾选确认。`; trustFingerprint.textContent = formatFingerprint(state.fingerprint); trustCheckLabel.hidden = false; return; }
  if (state.phase === 'preparing' || state.phase === 'checking') { trustCopy.textContent = '正在建立安全连接并请求接收端显示指纹…'; trustFingerprint.textContent = ''; return; }
  if (state.phase === 'unsupported') { trustCopy.textContent = '接收端没有提供指纹显示能力，请现场查看配对码并手动输入。'; trustFingerprint.textContent = ''; return; }
  if (state.phase === 'changed') { trustCopy.textContent = '接收端公钥已变化，已阻止请求。请重新在现场核对新的完整指纹。'; trustFingerprint.textContent = state.fingerprint ? formatFingerprint(state.fingerprint) : ''; trustRevoke.hidden = !state.fingerprint; return; }
  if (state.phase === 'expired') { trustCopy.textContent = '指纹核对已过期，请重新显示指纹。'; trustFingerprint.textContent = ''; }
  else if (state.phase === 'saving') trustCopy.textContent = '正在保存现场确认…';
  else if (state.phase === 'error') trustCopy.textContent = '无法完成设备信任，请使用现场配对码或重试。';
  else if (state.phase === 'untrusted') trustCopy.textContent = '已撤销此设备信任，重新请求配对码前需要再次现场核对。';
};
const codeValue = () => digits.map(input => input.value.trim()).join('').toUpperCase();
const setView = status => {
  currentStatus = status;
  const connected = ['joined', 'connected', 'sharing'].includes(status);
  codeView.hidden = connected;
  castingView.hidden = !connected;
  connectButton.disabled = status !== 'idle';
  digits.forEach(input => { input.disabled = status !== 'idle'; });
  shareButton.disabled = capturePending || !['connected', 'sharing'].includes(status);
  deviceGroups.querySelectorAll('.device-row.selectable').forEach(row => { row.disabled = status !== 'idle'; });
  castStatus.textContent = status === 'sharing' ? 'Your screen is being shared to the receiver.' : status === 'connected' ? 'Receiver is ready for casting.' : 'Connecting to receiver…';
};
const focusNext = index => { if (index < digits.length - 1) digits[index + 1].focus(); };
digits.forEach((input, index) => {
  input.addEventListener('input', () => {
    input.value = input.value.replace(/[^a-z0-9]/gi, '').slice(-1).toUpperCase();
    setError(codeError, null);
    if (input.value) focusNext(index);
  });
  input.addEventListener('keydown', event => { if (event.key === 'Backspace' && !input.value && index > 0) digits[index - 1].focus(); });
  input.addEventListener('paste', event => {
    event.preventDefault();
    const pasted = (event.clipboardData?.getData('text') || '').replace(/[^a-z0-9]/gi, '').slice(0, 4).toUpperCase();
    pasted.split('').forEach((value, offset) => { if (digits[index + offset]) digits[index + offset].value = value; });
    focusNext(Math.min(index + pasted.length - 1, digits.length - 1));
  });
});

const buildTouchback = info => new WebCastTouchbackSender({
  nativeBridge: createPlatformInputSink(info, {invoke, viewport: {width: screen.width, height: screen.height}}),
  onStatus: status => {
    if (status === 'accepted') touchbackStatus.textContent = `${touchbackSummary(info)} · 反控已就绪`;
    else if (status === 'native_ready') touchbackStatus.textContent = `${touchbackSummary(info)} · 本机输入已初始化，等待接收端开启反控`;
    else setError(castError, touchbackError(status, info));
  },
});
touchback = buildTouchback({os: 'unknown', touchback: false, inputControl: 'none'});
const client = new LauncherWebCastClient({
  endpoint: selectedEndpoint,
  videoQuality,
  codeDisplayTransport: ({instance, request}) => invoke('nearcast_code_display', {instance, request}),
  onStatus: setView,
  onError: error => { setError(codeError, error); client.stop({notify: false}); activeDevice = null; },
  onCodeDisplayResult: result => {
    if (result.requestId !== codeDisplayRequestId) return;
    const messages = {shown: '配对码已在接收端显示，请输入 4 位配对码。', unavailable: '接收端暂时无法显示配对码，请现场查看接收端。', rate_limited: '请求过于频繁，请稍后再试。', not_supported: '该接收端不支持远程显示配对码，请现场查看。'};
    setCodeDisplayStatus(messages[result.status] || '');
  },
  onCodeDisplayError: (error, request) => {
    if (request.requestId !== codeDisplayRequestId) return;
    setCodeDisplayStatus(`无法请求接收端显示配对码：${error.message || error}`);
    if (String(error.message || error).includes('NEARCAST_KEY_MISMATCH')) trustManager.keyMismatch(error.message || error);
  },
  onSessionEnded: () => { controlGeneration++; touchback.fence(); },
  onControlChannel: channel => {
    if (!canAttachTouchbackChannel(channel)) return;
    const generation = ++controlGeneration;
    try {
      platformReady.then(() => {
        if (generation !== controlGeneration || channel.readyState !== 'open') return;
        return touchback.attachControlChannel(channel, {authorized: true, protocol: 'webcast'});
      }).catch(error => { if (generation === controlGeneration) setError(castError, error); });
    } catch (error) { setError(castError, error); }
  },
  onControlMessage: message => touchback.handleControlMessage(message),
  onStream: stream => {
    preview.srcObject = stream;
    previewWrap.hidden = !stream;
    shareButton.hidden = Boolean(stream);
    stopShareButton.hidden = !stream;
    if (stream) preview.play?.().catch(() => {});
  },
});

const requestCodeDisplayFor = device => {
  if (!device?.supportsCodeDisplay) { setCodeDisplayStatus('该接收端不支持远程显示配对码，请现场查看。'); return; }
  try { codeDisplayRequestId = client.requestCodeDisplay({device: {...device, trustRequired: true, trustState: trustDevice && trustDevice.discoveryId === device.discoveryId && trustManager.state.phase === 'trusted' ? 'trusted' : 'untrusted'}, reason: 'sender-device-selected'}); }
  catch (error) { setCodeDisplayStatus(error.message || String(error)); }
};

const trustManager = new ReceiverTrust({invoke, onChange: renderTrust, onTrusted: device => {
  if (!trustDevice || device.discoveryId !== trustDevice.discoveryId || currentStatus !== 'idle') return;
  trustDevice = device;
  if (device.supportsCodeDisplay) { setCodeDisplayStatus('指纹已确认，正在请求接收端显示配对码…'); requestCodeDisplayFor(device); }
}});
trustCheck.addEventListener('change', () => { trustConfirm.disabled = !trustCheck.checked; });
trustConfirm.addEventListener('click', async () => { try { await trustManager.confirm(trustCheck.checked); } catch (error) { setError(trustError, error); } });
trustRetry.addEventListener('click', () => trustManager.prepare());
trustCancel.addEventListener('click', () => { trustManager.cancel(); trustDevice = null; client.cancelCodeDisplay(); codeDisplayRequestId = null; setCodeDisplayStatus('已取消指纹核对，可现场输入配对码。'); });
trustRevoke.addEventListener('click', async () => { try { client.cancelCodeDisplay(); codeDisplayRequestId = null; await trustManager.revoke(); setCodeDisplayStatus('已撤销信任。'); } catch (error) { setError(trustError, error); } });

pairForm.addEventListener('submit', async event => {
  event.preventDefault();
  const pairCode = codeValue();
  if (!/^[A-Z0-9]{4}$/.test(pairCode)) { setError(codeError, new Error('请输入 4 位字母或数字配对码')); return; }
  setError(codeError, null);
  if (selectedDevice && selectedDevice.expiresAt <= Date.now()) { setError(codeError, new Error('接收端发现已过期，请重新扫描并选择设备。')); return; }
  activeDevice = selectedDevice;
  trustManager.cancel(); trustDevice = null; client.cancelCodeDisplay(); codeDisplayRequestId = null;
  client.endpoint = selectedEndpoint;
  try {
    await platformReady;
    touchback = buildTouchback(platformInfo ?? {});
    await client.connect(pairCode);
    targetName.textContent = selectedDevice?.displayName || 'NearCast';
  } catch (error) {
    setError(codeError, error);
    await client.stop({notify: false});
    setView('idle');
  }
});
shareButton.addEventListener('click', async () => {
  if (capturePending) return;
  capturePending = true; shareButton.disabled = true;
  setError(castError, null);
  try { client.videoQuality = videoQuality; await client.startScreenShare({video: true, audio: false}); }
  catch (error) { setError(castError, screenCaptureError(error, platformInfo)); }
  finally { capturePending = false; shareButton.disabled = !['connected', 'sharing'].includes(currentStatus); }
});
stopShareButton.addEventListener('click', async () => { setError(castError, null); await client.stopStream(); });
leaveButton.addEventListener('click', async () => { setError(castError, null); touchback.fence(); await client.stop(); digits.forEach(input => { input.value = ''; }); });
window.addEventListener('beforeunload', () => { touchback.fence(); trustManager.cancel(); client.stop({notify: false}); });

const renderDevices = devices => {
  if (selectedDevice && currentStatus === 'idle') {
    const current = devices.find(device => device.discoveryId === selectedDevice.discoveryId && device.selectable);
    if (!current || current.instance !== selectedDevice.instance || current.endpoint !== selectedDevice.endpoint || current.deviceId !== selectedDevice.deviceId || current.capability !== selectedDevice.capability) {
      trustManager.cancel(); trustDevice = null;
      selectedDevice = null; selectedEndpoint = defaultEndpoint; client.endpoint = defaultEndpoint; client.cancelCodeDisplay(); codeDisplayRequestId = null;
      setCodeDisplayStatus('接收端已离线或服务发生变化，请重新扫描并选择。');
    } else {
      selectedDevice = current;
      if (trustDevice) { trustDevice = current; trustManager.device = current; }
    }
  }
  deviceGroups.replaceChildren();
  const groups = [{protocol: 'webcast', label: 'NEARCAST RECEIVERS', icon: '▣'}, {protocol: 'airplay', label: 'AIRPLAY DEVICES', icon: ''}];
  const available = devices.filter(device => device.protocol === 'webcast' || device.protocol === 'airplay');
  deviceStatus.textContent = available.length ? `${available.length} device${available.length === 1 ? '' : 's'} found on your local network` : 'No receivers found yet — keep scanning…';
  for (const group of groups) {
    const entries = devices.filter(device => device.protocol === group.protocol);
    if (!entries.length) continue;
    const section = document.createElement('div'); section.className = 'device-group';
    const title = document.createElement('div'); title.className = 'group-title'; title.textContent = group.label; section.append(title);
    for (const device of entries) {
      const row = document.createElement('button'); row.type = 'button'; row.className = `device-row ${device.selectable ? 'selectable' : 'disabled'}`;
      row.disabled = !device.selectable || currentStatus !== 'idle';
      row.setAttribute('aria-pressed', String(device.selectable && device.discoveryId === selectedDevice?.discoveryId));
      row.innerHTML = `<span class="device-icon">${group.icon}</span><span class="device-copy"><span class="device-name"></span><span class="device-meta"></span></span><span class="device-action">${device.selectable ? 'Use' : 'Display only'}</span>`;
      row.querySelector('.device-name').textContent = device.displayName;
      row.querySelector('.device-meta').textContent = device.addresses?.[0] ? `${device.addresses[0]}${device.port ? `:${device.port}` : ''}` : device.hostname || device.model || device.protocol;
      if (device.selectable) row.addEventListener('click', () => {
        if (currentStatus !== 'idle') return;
        client.cancelCodeDisplay(); codeDisplayRequestId = null;
        if (selectedDevice?.discoveryId !== device.discoveryId) digits.forEach(input => { input.value = ''; });
        selectedDevice = device; trustDevice = device; selectedEndpoint = defaultEndpoint; client.endpoint = selectedEndpoint; digits[0].focus(); setError(codeError, null);
        setCodeDisplayStatus(device.supportsTrustDisplay ? '正在请求现场核对指纹…' : '该接收端不支持指纹显示，请现场输入配对码。');
        trustManager.select(device);
      });
      section.append(row);
    }
    deviceGroups.append(section);
  }
};

const discovery = new TauriDeviceDiscovery({invoke, listen});
const startDiscovery = async () => {
  trustManager.cancel(); trustDevice = null; client.cancelCodeDisplay(); codeDisplayRequestId = null;
  refreshDevices.disabled = true; deviceStatus.textContent = 'Scanning for AirPlay and WebCast receivers…';
  try { await discovery.stop().catch(() => {}); await discovery.start(renderDevices); }
  catch (error) { deviceStatus.textContent = `Scan unavailable: ${error.message || error}`; }
  finally { refreshDevices.disabled = false; }
};
refreshDevices.addEventListener('click', startDiscovery);
setView('idle');
platformReady = loadPlatformInfo(invoke).then(info => {
  platformInfo = info;
  platformStatus.textContent = platformSummary(info);
  touchbackStatus.textContent = touchbackSummary(info);
  if (currentStatus === 'idle') touchback = buildTouchback(info);
  return info;
}).catch(() => ({os: 'unknown', touchback: false, inputControl: 'none'}));
startDiscovery();
