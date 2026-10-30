import test from 'node:test';
import assert from 'node:assert/strict';
import {DiscoveryRegistry, parseNearCastService} from '../src/discovery/nearcast.mjs';

test('accepts bounded public TXT discovery fields and never treats discovery as authorization', () => {
  const lease = parseNearCastService({
    instance: 'Board._nearcast._tcp.local.', hostname: 'board.local.', port: 8443,
    txt: {id: 'opaque-board', display: 'Board', endpoint: 'https://board.local:8443', version: '1', ttl: '60', capability: 'webcast'},
    nowMs: 1000,
  });
  assert.equal(lease.discoveryId, 'opaque-board');
  assert.equal(lease.authorized, false);
  assert.equal(lease.expiresAt, 61000);
  assert.equal('token' in lease, false);
});

test('rejects token, room code, invalid endpoint, and expired leases', () => {
  assert.throws(() => parseNearCastService({instance: 'x', hostname: 'x', port: 1, txt: {id: 'x', endpoint: 'http://x', token: 'secret'}}), /private/i);
  assert.throws(() => parseNearCastService({instance: 'x', hostname: 'x', port: 1, txt: {id: 'x', endpoint: 'ftp://x'}}), /endpoint/i);
  const registry = new DiscoveryRegistry();
  registry.upsert({discoveryId: 'x', expiresAt: 10});
  assert.equal(registry.expire(11), 1);
  assert.equal(registry.list().length, 0);
});
