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

test('retains a rejected native Windows error for sender diagnostics', async () => {
  const bridge = createTauriNativeBridge({viewport: {width: 100, height: 100}, invoke: async command => {
    if (command === 'nearcast_pointer_initialize') return true;
    throw 'windows_inject_touch_input_failed:0x80070057';
  }});
  assert.deepEqual(await bridge.injectTouchInput({contactId: 1, phase: 0, x: 1, y: 2}), {
    ok: false,
    error: 'windows_inject_touch_input_failed:0x80070057',
  });
});

test('maps arbitrary wire contact IDs to bounded Windows pointer IDs', async () => {
  const calls = [];
  const bridge = createTauriNativeBridge({viewport: {width: 100, height: 100}, invoke: async (command, args) => { calls.push([command, args]); return true; }});
  await bridge.initializeTouchInjection(10);
  assert.equal(await bridge.injectTouchInput({contactId: 42, phase: 0, x: 1, y: 2}), true);
  assert.equal(await bridge.injectTouchInput({contactId: 42, phase: 2, x: 1, y: 2}), true);
  assert.equal(await bridge.injectTouchInput({contactId: 65535, phase: 0, x: 1, y: 2}), true);
  assert.deepEqual(calls.slice(1).map(([, args]) => args.contactId), [1, 1, 1]);
});

test('treats a successful Rust Result unit as a null Tauri value', async () => {
  const calls = [];
  const bridge = createTauriNativeBridge({viewport: {width: 100, height: 100}, invoke: async (command, args) => {
    calls.push([command, args]);
    return command === 'nearcast_pointer_initialize' ? true : null;
  }});
  await bridge.initializeTouchInjection(10);
  assert.equal(await bridge.injectTouchInput({contactId: 42, phase: 0, x: 1, y: 2}), true);
  assert.equal(calls[1][0], 'nearcast_pointer_inject');
});

test('maps every contact in a frame and invokes one native batch', async () => {
  const calls = [];
  const bridge = createTauriNativeBridge({viewport: {width: 100, height: 100}, invoke: async (command, args) => { calls.push([command, args]); return true; }});
  await bridge.initializeTouchInjection(10);
  assert.equal(await bridge.injectTouchInputs([
    {contactId: 42, phase: 0, x: 1, y: 2},
    {contactId: 65535, phase: 0, x: 3, y: 4},
  ]), true);
  assert.equal(calls[1][0], 'nearcast_pointer_inject_batch');
  assert.deepEqual(calls[1][1].records.map(record => record.contactId), [1, 2]);
});

test('rolls back local pointer IDs when a batch contains an unmapped contact', async () => {
  const calls = [];
  const bridge = createTauriNativeBridge({viewport: {width: 100, height: 100}, invoke: async (command, args) => { calls.push([command, args]); return true; }});
  await bridge.initializeTouchInjection(10);
  const first = Array.from({length: 9}, (_, index) => ({contactId: index + 1, phase: 0, x: 1, y: 2}));
  assert.equal(await bridge.injectTouchInputs(first), true);
  assert.match((await bridge.injectTouchInputs([{contactId: 999, phase: 0, x: 1, y: 2}, {contactId: 1000, phase: 0, x: 1, y: 2}])).error, /contact_mapping_failed/);
  assert.equal(await bridge.injectTouchInputs([{contactId: 2000, phase: 0, x: 1, y: 2}]), true);
  assert.equal(calls.at(-1)[1].records[0].contactId, 10);
  assert.equal(await bridge.injectTouchInputs([{contactId: 1, phase: 1, x: 1, y: 2}]), true);
  assert.equal(calls.at(-1)[1].records[0].contactId, 1);
});

test('a failed native down does not consume a local pointer ID', async () => {
  let fail = true;
  const bridge = createTauriNativeBridge({invoke: async command => {
    if (command === 'nearcast_pointer_initialize') return true;
    if (fail) throw 'windows_inject_touch_input_failed:0x80070057';
    return null;
  }});
  await bridge.initializeTouchInjection(10);
  assert.equal((await bridge.injectTouchInput({contactId: 42, phase: 0, x: 0, y: 0})).ok, false);
  fail = false;
  assert.equal(await bridge.injectTouchInputs(Array.from({length: 10}, (_, contactId) => ({contactId, phase: 0, x: 0, y: 0}))), true);
});
