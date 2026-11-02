import test from 'node:test';
import assert from 'node:assert/strict';
import {canAttachTouchbackChannel} from '../src/webcast/touchback-channel-policy.mjs';

test('manual pairing can attach an authenticated WebCast channel without a discovery device', () => {
  assert.equal(canAttachTouchbackChannel({readyState: 'open'}), true);
});

test('Touchback channel policy still rejects non-WebCast or unopened channels', () => {
  assert.equal(canAttachTouchbackChannel({readyState: 'open'}, 'airplay'), false);
  assert.equal(canAttachTouchbackChannel({readyState: 'connecting'}), false);
  assert.equal(canAttachTouchbackChannel(null), false);
});
