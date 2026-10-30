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
