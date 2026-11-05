// Future explicit gesture-policy material; not connected to Native typed input.
import test from 'node:test';
import assert from 'node:assert/strict';

const record = (phase, overrides = {}) => ({contactId: 350, phase, buttons: 0, x: 10000, y: 20000, modifiers: 0, wheel: 0, dtMs: 0, recordFlags: 0, ...overrides});
const nativeRecorder = calls => ({
  initialize: async () => true,
  move: async (...args) => calls.push(['move', ...args]),
  button: async (...args) => calls.push(['button', ...args]),
  scroll: async (...args) => calls.push(['scroll', ...args]),
  reset: async () => calls.push(['reset']),
});

for (const directory of ['src']) {
  const {MacOsInputSink} = await import(`../${directory}/touchback/macos-input.mjs`);

  test(`${directory}: touch scrolling sends anchored two-axis deltas and ends without a mouse press`, async () => {
    const calls = [];
    const sink = new MacOsInputSink({native: nativeRecorder(calls), interactionMode: 'touch-scroll'});
    await sink.initialize();
    for (const r of [record(0), record(1, {y: 18000}), record(1, {x: 11000, y: 17000}), record(2, {x: 11000, y: 17000})]) {
      assert.equal(await sink.apply(r), 'accepted');
    }
    assert.deepEqual(calls, [
      ['move', 10000, 20000, 0],
      ['scroll', 10000, 20000, 0, -2000, 'began', 0],
      ['scroll', 10000, 20000, 1000, -1000, 'changed', 0],
      ['scroll', 10000, 20000, 0, 0, 'ended', 0],
    ]);
    assert.equal(sink.snapshot().activeContacts, 0);
  });

  test(`${directory}: a tap with small jitter clicks only on release and cancellation never clicks`, async () => {
    const calls = [];
    const sink = new MacOsInputSink({native: nativeRecorder(calls), interactionMode: 'touch-scroll'});
    await sink.initialize();
    for (const r of [record(0), record(1, {x: 10032}), record(2, {x: 10032}), record(0), record(3)]) {
      assert.equal(await sink.apply(r), 'accepted');
    }
    assert.deepEqual(calls, [
      ['move', 10000, 20000, 0],
      ['button', 1, true, 10000, 20000, 0],
      ['button', 1, false, 10000, 20000, 0],
      ['move', 10000, 20000, 0],
    ]);
  });

  test(`${directory}: cancelled scrolling sends a terminal phase and permits a fresh gesture`, async () => {
    const calls = [];
    const sink = new MacOsInputSink({native: nativeRecorder(calls), interactionMode: 'touch-scroll'});
    await sink.initialize();
    for (const r of [record(0), record(1, {x: 12000}), record(3), record(0, {contactId: 351})]) assert.equal(await sink.apply(r), 'accepted');
    assert.deepEqual(calls, [
      ['move', 10000, 20000, 0],
      ['scroll', 10000, 20000, 2000, 0, 'began', 0],
      ['scroll', 10000, 20000, 0, 0, 'cancelled', 0],
      ['move', 10000, 20000, 0],
    ]);
  });

  test(`${directory}: switching modes releases a held button and ignores the retired contact tail`, async () => {
    const calls = [];
    const sink = new MacOsInputSink({native: nativeRecorder(calls)});
    await sink.initialize();
    await sink.apply(record(0));
    assert.equal(await sink.setInteractionMode('touch-scroll'), 'accepted');
    assert.equal(sink.snapshot().interactionMode, 'touch-scroll');
    assert.equal(sink.snapshot().buttons, 0);
    await sink.apply(record(1));
    await sink.apply(record(2));
    await sink.apply(record(0, {contactId: 351}));
    await sink.apply(record(2, {contactId: 351}));
    assert.deepEqual(calls, [
      ['button', 1, true, 10000, 20000, 0], ['reset'],
      ['move', 10000, 20000, 0],
      ['button', 1, true, 10000, 20000, 0], ['button', 1, false, 10000, 20000, 0],
    ]);
    assert.equal(await sink.setInteractionMode('mouse'), 'accepted');
    await sink.apply(record(0, {buttons: 2}));
    await sink.apply(record(1, {buttons: 2, x: 11000}));
    await sink.apply(record(2, {buttons: 2, x: 11000}));
    assert.deepEqual(calls.slice(-4), [
      ['reset'], ['button', 2, true, 10000, 20000, 0], ['move', 11000, 20000, 0], ['button', 2, false, 11000, 20000, 0],
    ]);
  });

  test(`${directory}: a failed cleanup keeps the previous mode and reports withdrawn permission`, async () => {
    const sink = new MacOsInputSink({native: {...nativeRecorder([]), reset: async () => {throw 'not_authorized';}}});
    await sink.initialize();
    assert.equal(await sink.setInteractionMode('touch-scroll'), 'not_authorized');
    assert.equal(sink.snapshot().interactionMode, 'mouse');
    assert.equal(await sink.setInteractionMode('other'), 'not_supported');
  });

  test(`${directory}: scroll injection failures revoke native readiness`, async () => {
    const sink = new MacOsInputSink({native: {...nativeRecorder([]), scroll: async () => {throw 'not_authorized';}}, interactionMode: 'touch-scroll'});
    await sink.initialize();
    await sink.apply(record(0));
    assert.equal(await sink.apply(record(1, {y: 10000})), 'not_authorized');
    assert.equal(sink.snapshot().initialized, false);
  });

}
