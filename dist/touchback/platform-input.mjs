import {NativeInputAdapter} from './native-input-adapter.mjs';

// OS capabilities and readiness are native facts, never inferred from UI mode.
export function createPlatformInputAdapter(_platformInfo = {}, options = {}) {
  return new NativeInputAdapter(options);
}
