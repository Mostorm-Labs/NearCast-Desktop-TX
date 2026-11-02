import test from 'node:test';
import assert from 'node:assert/strict';
import {PointerInjectionSink} from '../src/touchback/pointer-injection.mjs';
import {TouchbackPhase} from '../src/touchback/codec.mjs';

test('uses only Windows Pointer Injection and clears active contacts on reset', () => {
  const calls = [];
  const sink = new PointerInjectionSink({native: {
    initializeTouchInjection(max) { calls.push(['initialize', max]); return true; },
    injectTouchInput(record) { calls.push(['inject', record.phase]); return true; },
    cancelTouchContacts(ids) { calls.push(['cancel', ids]); },
  }});
  assert.equal(sink.initialize(), 'accepted');
  assert.equal(sink.apply({contactId: 1, phase: TouchbackPhase.DOWN, x: 1, y: 2}), 'accepted');
  assert.equal(sink.apply({contactId: 1, phase: TouchbackPhase.UP, x: 1, y: 2}), 'accepted');
  assert.equal(sink.snapshot().activeContacts, 0);
  assert.equal(calls.some(call => call[0] === 'mouse'), false);
});

test('reset waits for an in-flight down and cancels it before any newer input', async () => {
  const calls = []; let finishDown;
  const sink = new PointerInjectionSink({native: {
    initializeTouchInjection: () => true,
    injectTouchInput: record => { calls.push(['inject', record.phase]); return new Promise(resolve => { finishDown = resolve; }); },
    cancelTouchContacts: ids => { calls.push(['cancel', ids]); return true; },
  }});
  await sink.initialize();
  const down = sink.apply({contactId: 1, phase: TouchbackPhase.DOWN, x: 10, y: 20});
  const reset = sink.reset();
  const stale = sink.apply({contactId: 2, phase: TouchbackPhase.DOWN, x: 30, y: 40});
  finishDown(true); await down; await reset;
  assert.equal(await stale, 'invalid_state');
  assert.deepEqual(calls, [['inject', TouchbackPhase.DOWN], ['cancel', [1]]]);
  assert.equal(sink.snapshot().activeContacts, 0);
});

test('initialization waits for pending cancellation before accepting a new contact', async () => {
  const calls = []; let finishCancel;
  const sink = new PointerInjectionSink({native: {
    initializeTouchInjection: () => { calls.push('initialize'); return true; },
    injectTouchInput: () => true,
    cancelTouchContacts: () => new Promise(resolve => { finishCancel = resolve; }),
  }});
  await sink.initialize();
  await sink.apply({contactId: 1, phase: TouchbackPhase.DOWN, x: 10, y: 20});
  const reset = sink.reset(); const initialize = sink.initialize();
  assert.deepEqual(calls, ['initialize']);
  finishCancel(true); await reset;
  assert.equal(await initialize, 'accepted');
  assert.deepEqual(calls, ['initialize', 'initialize']);
});

test('failed native cancellation keeps the contact tracked and blocks input until reset succeeds', async () => {
  let cancelOkay = false;
  const sink = new PointerInjectionSink({native: {
    initializeTouchInjection: () => true, injectTouchInput: () => true,
    cancelTouchContacts: () => cancelOkay,
  }});
  await sink.initialize();
  await sink.apply({contactId: 1, phase: TouchbackPhase.DOWN, x: 10, y: 20});
  assert.equal(await sink.reset(), 'invalid_state');
  assert.equal(sink.snapshot().activeContacts, 1);
  assert.equal(await sink.apply({contactId: 2, phase: TouchbackPhase.DOWN}), 'invalid_state');
  cancelOkay = true;
  assert.equal(await sink.reset(), 'accepted');
  assert.equal(sink.snapshot().activeContacts, 0);
});

test('accepts arbitrary u16 wire contact IDs and limits simultaneous contacts by capacity', async () => {
  let nativeCalls = 0;
  const sink = new PointerInjectionSink({native: {
    initializeTouchInjection: () => true,
    injectTouchInput: () => { nativeCalls += 1; return true; },
  }});
  await sink.initialize();
  assert.equal(await sink.apply({contactId: 42, phase: TouchbackPhase.DOWN, x: 1, y: 2}), 'accepted');
  assert.equal(await sink.apply({contactId: 65535, phase: TouchbackPhase.DOWN, x: 1, y: 2}), 'accepted');
  assert.equal(nativeCalls, 2);
  for (let contactId = 100; contactId < 108; contactId += 1) assert.equal(await sink.apply({contactId, phase: TouchbackPhase.DOWN, x: 1, y: 2}), 'accepted');
  assert.equal(await sink.apply({contactId: 108, phase: TouchbackPhase.DOWN, x: 1, y: 2}), 'invalid_state');
  assert.equal(sink.snapshot().lastFailure.kind, 'contact_capacity');
});

test('preserves a native Windows injection error separately from contact validation', async () => {
  const sink = new PointerInjectionSink({native: {
    initializeTouchInjection: () => true,
    injectTouchInput: () => ({ok: false, error: 'windows_inject_touch_input_failed:0x80070057'}),
  }});
  await sink.initialize();
  assert.equal(await sink.apply({contactId: 1, phase: TouchbackPhase.DOWN, x: 1, y: 2}), 'invalid_state');
  assert.deepEqual(sink.snapshot().lastFailure, {kind: 'native_error', error: 'windows_inject_touch_input_failed:0x80070057'});
});

test('sends a multi-contact frame to the native bridge as one batch', async () => {
  const calls = [];
  const sink = new PointerInjectionSink({native: {
    initializeTouchInjection: () => true,
    injectTouchInputs: records => { calls.push(records); return true; },
  }});
  await sink.initialize();
  assert.equal(await sink.applyBatch([
    {contactId: 42, phase: TouchbackPhase.DOWN, x: 1, y: 2},
    {contactId: 65535, phase: TouchbackPhase.DOWN, x: 3, y: 4},
  ]), 'accepted');
  assert.deepEqual(calls, [[
    {contactId: 42, phase: TouchbackPhase.DOWN, x: 1, y: 2},
    {contactId: 65535, phase: TouchbackPhase.DOWN, x: 3, y: 4},
  ]]);
  assert.equal(sink.snapshot().activeContacts, 2);
});

test('uses the last active coordinates when ending a contact in a batch', async () => {
  const calls = [];
  const sink = new PointerInjectionSink({native: {
    initializeTouchInjection: () => true,
    injectTouchInputs: records => { calls.push(records); return true; },
  }});
  await sink.initialize();
  await sink.applyBatch([{contactId: 9, phase: TouchbackPhase.DOWN, x: 100, y: 200}]);
  await sink.applyBatch([{contactId: 9, phase: TouchbackPhase.MOVE, x: 300, y: 400}]);
  await sink.applyBatch([{contactId: 9, phase: TouchbackPhase.UP, x: 1, y: 2}]);
  assert.deepEqual(calls.at(-1), [{contactId: 9, phase: TouchbackPhase.UP, x: 300, y: 400}]);
});

test('keeps repeated phases for one contact ordered inside a batch', async () => {
  const calls = [];
  const sink = new PointerInjectionSink({native: {
    initializeTouchInjection: () => true,
    injectTouchInputs: records => { calls.push(records.map(({contactId, phase, x, y}) => ({contactId, phase, x, y}))); return true; },
  }});
  await sink.initialize();
  assert.equal(await sink.applyBatch([
    {contactId: 7, phase: TouchbackPhase.DOWN, x: 10, y: 20},
    {contactId: 7, phase: TouchbackPhase.MOVE, x: 30, y: 40},
    {contactId: 7, phase: TouchbackPhase.UP, x: 1, y: 2},
  ]), 'accepted');
  assert.deepEqual(calls, [
    [{contactId: 7, phase: TouchbackPhase.DOWN, x: 10, y: 20}],
    [{contactId: 7, phase: TouchbackPhase.MOVE, x: 30, y: 40}],
    [{contactId: 7, phase: TouchbackPhase.UP, x: 30, y: 40}],
  ]);
  assert.equal(sink.snapshot().activeContacts, 0);
});
