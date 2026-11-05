import test from 'node:test';
import assert from 'node:assert/strict';
import {createPlatformInputSink} from '../src/touchback/platform-input.mjs';

test('macOS injects normalized coordinates through macOS commands only', async () => {
  const calls = [];
  const sink = createPlatformInputSink({os: 'macos', touchback: true, inputControl: 'macos-mouse'}, {invoke: async (command, args) => { calls.push([command, args]); return command.endsWith('initialize') ? true : null; }, viewport: {width: 1920, height: 1080}});
  assert.equal(await sink.initialize(), 'accepted');
  assert.equal(await sink.apply({contactId: 0, phase: 0, x: 65535, y: 32768, buttons: 2, modifiers: 8}), 'accepted');
  assert.equal(await sink.apply({contactId: 0, phase: 1, x: 12345, y: 45678, buttons: 2, modifiers: 8}), 'accepted');
  await sink.reset();
  assert.deepEqual(calls, [
    ['nearcast_macos_input_initialize', undefined],
    ['nearcast_macos_input_button', {button: 2, down: true, x: 65535, y: 32768, modifiers: 8}],
    ['nearcast_macos_input_move', {x: 12345, y: 45678, modifiers: 8}],
    ['nearcast_macos_input_reset', undefined],
  ]);
});

test('Windows keeps Pointer Injection and maps coordinates to its viewport', async () => {
  const calls = [];
  const sink = createPlatformInputSink({os: 'windows', touchback: true, inputControl: 'windows-pointer'}, {invoke: async (command, args) => { calls.push([command, args]); return true; }, viewport: {width: 1920, height: 1080}});
  assert.equal(await sink.initialize(), 'accepted');
  assert.equal(await sink.apply({contactId: 1, phase: 0, x: 65535, y: 65535, buttons: 1, modifiers: 0}), 'accepted');
  assert.equal(calls[0][0], 'nearcast_pointer_initialize');
  assert.deepEqual(calls.find(([command]) => command === 'nearcast_pointer_inject'), ['nearcast_pointer_inject', {contactId: 1, phase: 0, x: 1919, y: 1079, buttons: 1, modifiers: 0}]);
});

test('unsupported or contradictory platform capabilities cannot invoke input commands', async () => {
  for (const info of [{os: 'linux', touchback: true}, {os: 'unknown'}, {os: 'macos', touchback: false}, {os: 'macos', touchback: true, inputControl: 'windows-pointer'}]) {
    const sink = createPlatformInputSink(info, {invoke: () => assert.fail('native input should not be invoked')});
    assert.equal(await sink.initialize(), 'not_supported');
    assert.equal(await sink.apply({}), 'not_supported');
    await sink.reset();
  }
});
