import {NativeInputAdapter} from './native-input-adapter.mjs';
import {OutputPolicyAdapter} from './output-policy.mjs';

// OS capabilities and readiness are native facts, never inferred from UI mode.
export function createPlatformInputAdapter(_platformInfo = {}, options = {}) {
  return new OutputPolicyAdapter(new NativeInputAdapter(options));
}
