import test from 'node:test';
import assert from 'node:assert/strict';
import {DiscoveryRegistry, normalizeDiscoveryDevice} from '../src/discovery/devices.mjs';

test('normalizes the NearCast service as a selectable WebCast receiver with capability tokens', () => {
  const nearcast = normalizeDiscoveryDevice({serviceType: '_nearcast._tcp.local.', instance: 'Board._nearcast._tcp.local.', hostname: 'board.local.', port: 8443, addresses: ['192.168.1.20'], txt: {id: 'board', display: 'Board', endpoint: 'wss://board.local:8443', capability: 'webcast,code-display-v1,touchback-v1', ttl: '60'}});
  assert.equal(nearcast.protocol, 'webcast');
  assert.equal(nearcast.selectable, true);
  assert.equal(nearcast.endpoint, 'https://board.local:8443');
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
  const device = normalizeDiscoveryDevice({serviceType: '_nearcast._tcp.local.', instance: 'Room._nearcast._tcp.local.', hostname: 'room.local.', port: 9443, addresses: ['192.168.1.21'], txt: {id: 'room', capability: 'webcast', ttl: '30'}});
  assert.equal(device.endpoint, 'https://room.local:9443');
  assert.equal(device.selectable, true);
});

test('AirPlay cannot acquire NearCast capabilities through TXT fields', () => {
  for (const serviceType of ['_airplay._tcp.local.', '_raop._tcp.local.']) {
    const device = normalizeDiscoveryDevice({serviceType, instance: 'TV', txt: {capability: 'webcast,code-display-v1,touchback-v1'}});
    assert.equal(device.selectable, false);
    assert.equal(device.supportsCodeDisplay, false);
    assert.equal(device.supportsTouchback, false);
    assert.deepEqual([...device.capabilities], []);
  }
});

test('NearCast without webcast capability is display-only', () => {
  const device = normalizeDiscoveryDevice({serviceType: '_nearcast._tcp.local.', instance: 'Board', hostname: 'board.local.', port: 8443, txt: {id: 'board', capability: 'code-display-v1,touchback-v1'}});
  assert.equal(device.selectable, false);
  assert.equal(device.supportsCodeDisplay, false);
  assert.equal(device.supportsTouchback, false);
});

test('NearCast discovery rejects private TXT fields and insecure endpoints', () => {
  const service = {serviceType: '_nearcast._tcp.local.', instance: 'Board', txt: {id: 'board', capability: 'webcast', endpoint: 'https://board.local:8443'}};
  for (const key of ['pairCode', 'roomCode', 'TOKEN', 'password', 'secret']) {
    assert.throws(() => normalizeDiscoveryDevice({...service, txt: {...service.txt, [key]: 'private'}}), /private/i);
  }
  for (const endpoint of ['http://board.local', 'ws://board.local', 'https://user:pass@board.local', 'https://board.local/?pairCode=1234']) {
    assert.throws(() => normalizeDiscoveryDevice({...service, txt: {...service.txt, endpoint}}), /endpoint/i);
  }
});

test('display endpoint uses resolved SRV authority even when TXT advertises a different subnet or port', () => {
  const service = {serviceType: '_nearcast._tcp.local.', instance: 'Board', hostname: 'resolved-board.local.', port: 9443, addresses: ['192.0.2.21', '2001:db8::21'], txt: {id: 'board', capability: 'webcast,code-display-v1', endpoint: 'https://unrelated.example:1234'}};
  const device = normalizeDiscoveryDevice(service);
  assert.equal(device.endpoint, 'https://resolved-board.local:9443');
  assert.deepEqual(device.resolvedEndpoints, ['https://192.0.2.21:9443', 'https://[2001:db8::21]:9443', 'https://resolved-board.local:9443']);
  const addressOnly = normalizeDiscoveryDevice({...service, hostname: '', addresses: ['192.0.2.21']});
  assert.equal(addressOnly.endpoint, 'https://192.0.2.21:9443');
  assert.throws(() => normalizeDiscoveryDevice({...service, hostname: '', addresses: []}), /endpoint/i);
  assert.throws(() => normalizeDiscoveryDevice({...service, port: 0}), /port/i);
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
