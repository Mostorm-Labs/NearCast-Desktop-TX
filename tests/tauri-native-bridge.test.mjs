import test from 'node:test';
import assert from 'node:assert/strict';
import {createTauriNativeBridge} from '../src/touchback/tauri-native-bridge.mjs';

test('maps normalized Touchback coordinates through Tauri invoke without adding mouse fallback', async () => {
  const calls = [];
  const bridge = createTauriNativeBridge({viewport: {width: 1920, height: 1080}, invoke: async (command, args) => { calls.push([command, args]); return true; }});
  assert.equal(await bridge.initializeTouchInjection(10), true);
  assert.equal(await bridge.injectTouchInput({contactId: 1, phase: 0, x: 65535, y: 32768, buttons: 1, modifiers: 0}), true);
  assert.deepEqual(calls[1], ['nearcast_pointer_inject', {contactId: 1, phase: 0, x: 1919, y: 540, buttons: 1, modifiers: 0}]);
  assert.equal(calls.some(([command]) => command.includes('mouse')), false);
});
