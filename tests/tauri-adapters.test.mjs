import test from 'node:test';
import assert from 'node:assert/strict';
import {TauriMdnsDiscovery} from '../src/discovery/tauri-mdns.mjs';

test('Tauri mDNS adapter delegates discovery to native DNS-SD and filters leases', async () => {
  const calls = [];
  const listeners = new Map();
  const discovery = new TauriMdnsDiscovery({
    invoke: async (command, args) => { calls.push([command, args]); return {ok: true}; },
    listen: async (event, handler) => { listeners.set(event, handler); return () => listeners.delete(event); },
    now: () => 1000,
  });
  const result = [];
  await discovery.start(lease => result.push(lease));
  listeners.get('nearcast://mdns-service')({payload: {instance: 'Board', hostname: 'board.local.', port: 8443, txt: {id: 'board', endpoint: 'https://board.local:8443', ttl: '30'}}});
  listeners.get('nearcast://mdns-service')({payload: {instance: 'Private', hostname: 'private.local.', port: 8443, txt: {id: 'private', endpoint: 'https://private.local:8443', token: 'secret'}}});
  assert.equal(result.length, 1);
  assert.equal(calls[0][0], 'nearcast_mdns_start');
  await discovery.stop();
  assert.equal(calls.at(-1)[0], 'nearcast_mdns_stop');
});
