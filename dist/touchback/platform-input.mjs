import {createTauriNativeBridge} from './tauri-native-bridge.mjs';
import {createWindowsPointerInjectionSink} from './windows-pointer-injection.mjs';
import {MacOsInputSink, MACOS_INPUT_STATUS} from './macos-input.mjs';
import {createMacOsInputBridge} from './macos-native-bridge.mjs';

const UnsupportedSink = Object.freeze({
  initialize: async () => MACOS_INPUT_STATUS.NOT_SUPPORTED,
  apply: async () => MACOS_INPUT_STATUS.NOT_SUPPORTED,
  reset: async () => MACOS_INPUT_STATUS.ACCEPTED,
  snapshot: () => ({initialized: false, activeContacts: 0}),
});

export function createPlatformInputSink(platformInfo = {}, {invoke, viewport, interactionMode} = {}) {
  const os = platformInfo.os;
  const control = platformInfo.inputControl || (platformInfo.touchback ? (os === 'windows' ? 'windows-pointer' : os === 'macos' ? 'macos-mouse' : 'none') : 'none');
  if (typeof invoke !== 'function') return UnsupportedSink;
  if (platformInfo.touchback !== true) return UnsupportedSink;
  if (control === 'windows-pointer' && os === 'windows') return createWindowsPointerInjectionSink(createTauriNativeBridge({invoke, viewport}));
  if (control === 'macos-mouse' && os === 'macos') return new MacOsInputSink({native: createMacOsInputBridge({invoke, viewport}), interactionMode});
  return UnsupportedSink;
}

