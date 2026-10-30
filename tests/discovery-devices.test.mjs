import test from 'node:test';
import assert from 'node:assert/strict';
import {DiscoveryRegistry, normalizeDiscoveryDevice} from '../src/discovery/devices.mjs';

test('normalizes the NearCast service as a selectable WebCast receiver with capability tokens', () => {
  const nearcast = normalizeDiscoveryDevice({serviceType: '_nearcast._tcp.local.', instance: 'Board._nearcast._tcp.local.', hostname: 'board.local.', port: 8443, addresses: ['192.168.1.20'], txt: {id: 'board', display: 'Board', endpoint: 'wss://board.local:8443', capability: 'webcast,code-display-v1,touchback-v1', ttl: '60'}});
  assert.equal(nearcast.protocol, 'webcast');
  assert.equal(nearcast.selectable, true);
  assert.equal(nearcast.endpoint, 'wss://board.local:8443');
  assert.deepEqual([...nearcast.capabilities].sort(), ['code-display-v1', 'touchback-v1', 'webcast']);
  assert.equal(nearcast.supportsCodeDisplay, true);
  assert.equal(nearcast.supportsTouchback, true);
});

test('rejects the retired WebCast DNS-SD service type', () => {
  assert.throws(() => normalizeDiscoveryDevice({serviceType: '_webcast._tcp.local.', instance: 'Room._webcast._tcp.local.', hostname: 'room.local.', port: 9443, txt: {endpoint: 'https://room.local:9443'}}), /unsupported/i);
});

test('normalizes AirPlay records for display without treating them as WebCast authorization', () => {
  const device = normalizeDiscoveryDevice({serviceType: '_airplay._tcp.local.', instance: 'Living Room._airplay._tcp.local.', hostname: 'tv.local.', port: 7000, addresses: ['192.168.1.30'], txt: {flags: '0x4', model: 'AppleTV5,3', srcvers: '220.68'}});
  assert.equal(device.protocol, 'airplay');
  assert.equal(device.displayName, 'Living Room');
  assert.equal(device.selectable, false);
  assert.equal(device.authorized, false);
});

test('derives a secure WebCast endpoint when the DNS-SD TXT record only exposes host and port', () => {
  const device = normalizeDiscoveryDevice({serviceType: '_nearcast._tcp.local.', instance: 'Room._nearcast._tcp.local.', hostname: 'room.local.', port: 9443, addresses: ['192.168.1.21'], txt: {id: 'room', ttl: '30'}});
  assert.equal(device.endpoint, 'https://room.local:9443');
  assert.equal(device.selectable, true);
});

test('preserves the receiver deviceId used by the code-display request protocol', () => {
  const device = normalizeDiscoveryDevice({serviceType: '_nearcast._tcp.local.', instance: 'Board._nearcast._tcp.local.', hostname: 'board.local.', port: 8443, txt: {deviceId: 'receiver-opaque-1', endpoint: 'wss://board.local:8443', capability: 'webcast', ttl: '60'}});
  assert.equal(device.deviceId, 'receiver-opaque-1');
});

test('does not advertise code display when the capability token is absent', () => {
  const device = normalizeDiscoveryDevice({serviceType: '_nearcast._tcp.local.', instance: 'Board._nearcast._tcp.local.', hostname: 'board.local.', port: 8443, txt: {id: 'board', endpoint: 'wss://board.local:8443', capability: 'webcast,touchback-v1'}});
  assert.equal(device.supportsCodeDisplay, false);
  assert.equal(device.capabilities.has('code-display-v1'), false);
});

test('coalesces AirPlay and RAOP advertisements for one receiver', () => {
  const registry = new DiscoveryRegistry();
  registry.upsert(normalizeDiscoveryDevice({serviceType: '_airplay._tcp.local.', instance: 'Room._airplay._tcp.local.', hostname: 'room.local.', port: 7000, addresses: ['192.168.1.30'], txt: {deviceid: 'AA:BB:CC:DD:EE:FF', model: 'AppleTV5,3'}}));
  registry.upsert(normalizeDiscoveryDevice({serviceType: '_raop._tcp.local.', instance: 'AA-BB-CC-DD-EE-FF@Room._raop._tcp.local.', hostname: 'room.local.', port: 5000, addresses: ['192.168.1.30'], txt: {model: 'AppleTV5,3'}}));
  assert.equal(registry.list().length, 1);
});

test('registry replaces updates and removes expired discovery devices', () => {
  const registry = new DiscoveryRegistry();
  registry.upsert({discoveryId: 'a', expiresAt: 100, protocol: 'webcast'});
  registry.upsert({discoveryId: 'a', expiresAt: 200, protocol: 'webcast', displayName: 'Updated'});
  registry.upsert({discoveryId: 'b', expiresAt: 100, protocol: 'airplay'});
  assert.equal(registry.list(150).length, 1);
  assert.equal(registry.list(150)[0].displayName, 'Updated');
  assert.equal(registry.remove('a'), true);
  assert.equal(registry.list(150).length, 0);
});
