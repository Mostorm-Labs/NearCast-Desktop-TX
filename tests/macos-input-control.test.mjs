// Future explicit gesture-policy material; not connected to Native typed input.
import test from 'node:test';
import assert from 'node:assert/strict';
import {MacOsInputSink, MACOS_INPUT_STATUS} from '../src/touchback/macos-input.mjs';
import {TouchbackPhase} from '../src/touchback/codec.mjs';

for (const directory of ['src']) {
  test(`${directory}: maps receiver contact records with zero buttons to a complete primary mouse gesture`, async () => {
    const {MacOsInputSink} = await import(`../${directory}/touchback/macos-input.mjs`);
    const calls = [];
    const sink = new MacOsInputSink({native: {
      initialize: async () => true,
      button: async (...args) => calls.push(['button', ...args]),
      move: async (...args) => calls.push(['move', ...args]),
      reset: async () => calls.push(['reset']),
    }});
    assert.equal(await sink.initialize(), 'accepted');
    // Captured from the real receiver: a touch has a contact lifecycle and no
    // mouse button mask, even when the negotiated output mode is mouse.
    const down = {contactId: 350, phase: 0, buttons: 0, x: 41523, y: 18978, modifiers: 0, wheel: 0, dtMs: 0, recordFlags: 0};
    assert.equal(await sink.apply(down), 'accepted');
    assert.equal(await sink.apply({...down, phase: 1, x: 44108, y: 15337}), 'accepted');
    assert.equal(await sink.apply({...down, phase: 2, x: 44108, y: 15337}), 'accepted');
    assert.equal(sink.snapshot().activeContacts, 0);
    assert.equal(await sink.apply({...down, contactId: 351}), 'accepted');
    assert.equal(await sink.apply({...down, contactId: 351, phase: 3}), 'accepted');
    assert.equal(sink.snapshot().buttons, 0);
    assert.deepEqual(calls, [
      ['button', 1, true, 41523, 18978, 0],
      ['move', 44108, 15337, 0],
      ['button', 1, false, 44108, 15337, 0],
      ['button', 1, true, 41523, 18978, 0],
      ['button', 1, false, 41523, 18978, 0],
    ]);
  });
}

test('does not accept a missing held button on an explicit mouse gesture', async () => {
  const sink = new MacOsInputSink({native: {initialize: () => true, button() {}, move() {}}});
  await sink.initialize();
  assert.equal(await sink.apply({contactId: 1, phase: 0, buttons: 1, x: 0, y: 0}), 'accepted');
  assert.equal(await sink.apply({contactId: 1, phase: 1, buttons: 0, x: 1, y: 1}), 'invalid_state');
});

test('maps launcher touchback records to macOS mouse events without changing the wire frame', async () => {
  const calls = [];
  const sink = new MacOsInputSink({
    native: {
      initialize: () => true,
      move: (x, y) => calls.push(['move', x, y]),
      button: (button, down) => calls.push(['button', button, down]),
      scroll: (deltaX, deltaY) => calls.push(['scroll', deltaX, deltaY]),
      reset: () => calls.push(['reset']),
    },
  });

  assert.equal(await sink.initialize(), MACOS_INPUT_STATUS.ACCEPTED);
  assert.equal(await sink.apply({phase: TouchbackPhase.MOVE, x: 100, y: 200, buttons: 0, modifiers: 0, dtMs: 0, recordFlags: 0}), MACOS_INPUT_STATUS.ACCEPTED);
  assert.equal(await sink.apply({phase: TouchbackPhase.DOWN, x: 100, y: 200, buttons: 1, modifiers: 0, dtMs: 0, recordFlags: 0}), MACOS_INPUT_STATUS.ACCEPTED);
  assert.equal(await sink.apply({phase: TouchbackPhase.UP, x: 100, y: 200, buttons: 1, modifiers: 0, dtMs: 0, recordFlags: 0}), MACOS_INPUT_STATUS.ACCEPTED);
  assert.deepEqual(calls, [['move', 100, 200], ['button', 1, true], ['button', 1, false]]);
});

test('does not interpret time deltas or unknown flags as scroll events', async () => {
  const calls = [];
  const sink = new MacOsInputSink({native: {initialize: () => true, move() {}, button() {}, scroll: (...args) => calls.push(args), reset() {}}});
  await sink.initialize();
  assert.equal(await sink.apply({phase: TouchbackPhase.MOVE, x: 0, y: 0, buttons: 0, modifiers: 0, dtMs: 3, recordFlags: 1}), MACOS_INPUT_STATUS.NOT_SUPPORTED);
  assert.deepEqual(calls, []);
});

test('waits for accessibility permission and reports a native rejection', async () => {
  let allow;
  const sink = new MacOsInputSink({native: {initialize: () => new Promise(resolve => { allow = resolve; }), move: async () => { throw 'not_authorized'; }}});
  const initializing = sink.initialize();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(sink.snapshot().initialized, false);
  allow(false);
  assert.equal(await initializing, 'not_authorized');
  sink.native.initialize = async () => true;
  assert.equal(await sink.initialize(), 'accepted');
  assert.equal(await sink.apply({contactId: 0, phase: 1, x: 0, y: 0, buttons: 0}), 'not_authorized');
  assert.equal(sink.snapshot().initialized, false);
});

test('rejects second contacts, combined buttons and button changes before native input', async () => {
  const calls = [];
  const sink = new MacOsInputSink({native: {initialize: async () => true, button: async (...args) => calls.push(args), move: async (...args) => calls.push(args)}});
  await sink.initialize();
  const down = {contactId: 1, phase: 0, x: 123, y: 456, buttons: 4, modifiers: 3};
  assert.equal(await sink.apply({...down, buttons: 3}), 'not_supported');
  assert.equal(await sink.apply(down), 'accepted');
  assert.equal(await sink.apply({...down, contactId: 2}), 'invalid_state');
  assert.equal(await sink.apply({...down, phase: 1, buttons: 2}), 'invalid_state');
  assert.equal(await sink.apply({...down, phase: 1, contactId: 2}), 'invalid_state');
  assert.deepEqual(calls, [[4, true, 123, 456, 3]]);
});

test('reset fences queued input and releases an in-flight press using native last position', async () => {
  let finish;
  const calls = [];
  const sink = new MacOsInputSink({native: {
    initialize: async () => true,
    button: (...args) => { calls.push(['button', ...args]); return new Promise(resolve => { finish = resolve; }); },
    move: async () => calls.push(['move']),
    reset: async () => calls.push(['reset']),
  }});
  await sink.initialize();
  const pressing = sink.apply({contactId: 0, phase: 0, x: 100, y: 200, buttons: 1});
  await new Promise(resolve => setImmediate(resolve));
  const moving = sink.apply({contactId: 0, phase: 1, x: 200, y: 300, buttons: 1});
  const resetting = sink.reset();
  finish();
  await Promise.all([pressing, moving, resetting]);
  assert.deepEqual(calls, [['button', 1, true, 100, 200, 0], ['reset']]);
  assert.equal(sink.snapshot().activeContacts, 0);
});

test('rejects multi-contact records and reports missing macOS accessibility permission', async () => {
  let authorized = false;
  const sink = new MacOsInputSink({native: {initialize: () => authorized, move() {}, button() {}, scroll() {}, reset() {}}});
  assert.equal(await sink.initialize(), MACOS_INPUT_STATUS.NOT_AUTHORIZED);
  authorized = true; assert.equal(await sink.initialize(), MACOS_INPUT_STATUS.ACCEPTED);
  assert.equal(await sink.apply({contactId: 1, phase: TouchbackPhase.DOWN, x: 0, y: 0, buttons: 1, modifiers: 0, dtMs: 0, recordFlags: 0}), MACOS_INPUT_STATUS.ACCEPTED);
  assert.equal(await sink.apply({contactId: 2, phase: TouchbackPhase.MOVE, x: 0, y: 0, buttons: 1, modifiers: 0, dtMs: 0, recordFlags: 0}), MACOS_INPUT_STATUS.INVALID_STATE);
});

test('failed reset is reported and must succeed before input can initialize again', async () => {
  let cleanupAllowed = false;
  const sink = new MacOsInputSink({native:{initialize:async () => true, button:async () => null, reset:async () => { if (!cleanupAllowed) throw 'not_authorized'; }}});
  await sink.initialize();
  await sink.apply({contactId:0, phase:0, x:10, y:20, buttons:1});
  assert.equal(await sink.reset(), 'not_authorized');
  assert.equal(await sink.initialize(), 'not_authorized');
  assert.equal(sink.snapshot().activeContacts, 1);
  cleanupAllowed = true;
  assert.equal(await sink.initialize(), 'accepted');
  assert.equal(sink.snapshot().activeContacts, 0);
});
