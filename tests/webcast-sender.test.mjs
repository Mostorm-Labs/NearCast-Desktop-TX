import test from 'node:test';
import assert from 'node:assert/strict';
import {WebCastTouchbackSender} from '../src/webcast/touchback-sender.mjs';

test('requires explicit WebCast authorization and disables AirPlay', () => {
  const native = {initializeTouchInjection: () => true, injectTouchInput: () => true};
  const sender = new WebCastTouchbackSender({nativeBridge: {initialize: () => 'accepted', apply: () => 'accepted', reset() {}, snapshot: () => ({})}});
  assert.equal(sender.attachControlChannel({readyState: 'open'}, {authorized: true, protocol: 'airplay'}), false);
  assert.equal(sender.snapshot().authorized, false);
});
