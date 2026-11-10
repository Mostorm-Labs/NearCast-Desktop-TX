import test from 'node:test';
import assert from 'node:assert/strict';
import {TauriDeviceDiscovery} from '../src/discovery/tauri-device-discovery.mjs';

test('browses only NearCast and ignores AirPlay/RAOP events and snapshots', async () => {
  const calls = []; const listeners = new Map(); const snapshots = [];
  const discovery = new TauriDeviceDiscovery({
    invoke: async (command, args) => { calls.push([command, args]); },
    listen: async (name, handler) => { listeners.set(name, handler); return () => listeners.delete(name); },
    now: () => 1000,
  });
  await discovery.start(devices => snapshots.push(devices));
  listeners.get('nearcast://mdns-service')({payload: {serviceType: '_nearcast._tcp.local.', instance: 'Board._nearcast._tcp.local.', hostname: 'board.local.', port: 8443, addresses: ['192.168.1.9'], txt: {id: 'board', endpoint: 'wss://board.local:8443', capability: 'webcast,code-display-v1', ttl: '60'}}});
  for (const serviceType of ['_airplay._tcp.local.', '_raop._tcp.local.']) {
    const service = {serviceType, instance: 'TV.'+serviceType, hostname: 'tv.local.', port: 7000, addresses: ['192.168.1.8'], txt: {capability:'webcast'}};
    listeners.get('nearcast://mdns-service')({payload: service});
    listeners.get('nearcast://mdns-snapshot')({payload:{service_type:serviceType,lease_ms:45000,services:[service]}});
  }
  assert.equal(snapshots.at(-1).length, 1);
  assert.equal(snapshots.at(-1)[0].deviceId, 'board');
  assert.deepEqual(calls[0][1].services, ['_nearcast._tcp']);
  await discovery.stop();
  assert.equal(calls.at(-1)[0], 'nearcast_mdns_stop');
});

test('native snapshots renew unchanged receivers past TXT ttl and immediately remove offline instances', async () => {
  const listeners = new Map(); const snapshots = []; let now = 1000;
  const discovery = new TauriDeviceDiscovery({invoke: async () => {}, listen: async (name, handler) => { listeners.set(name, handler); return () => listeners.delete(name); }, now: () => now});
  const service = {service_type:'_nearcast._tcp.local.',instance:'Board._nearcast._tcp.local.',hostname:'board.local.',port:8443,addresses:['192.0.2.21'],txt:{id:'board',capability:'webcast,code-display-v1',ttl:'60',endpoint:'https://other-subnet.invalid:8443'}};
  try {
    await discovery.start(devices => snapshots.push(devices));
    const emit = payload => listeners.get('nearcast://mdns-snapshot')?.({payload});
    for (now = 1000; now <= 91000; now += 15000) {
      emit({service_type:'_nearcast._tcp.local.',services:[service],lease_ms:45000});
      assert.equal(snapshots.at(-1).length,1,`healthy device must survive at ${now}ms`);
      assert.equal(snapshots.at(-1)[0].endpoint,'https://board.local:8443');
    }
    emit({service_type:'_nearcast._tcp.local.',services:[],lease_ms:45000});
    assert.equal(snapshots.at(-1).length,0);
  } finally { await discovery.stop(); }
});

test('native snapshot bridge leases expire if the worker stops renewing them', async () => {
  const listeners = new Map(); let now = 1000;
  const discovery = new TauriDeviceDiscovery({invoke:async()=>{},listen:async(name,handler)=>{listeners.set(name,handler);return()=>listeners.delete(name);},now:()=>now});
  try {
    await discovery.start(()=>{});
    listeners.get('nearcast://mdns-snapshot')?.({payload:{service_type:'_nearcast._tcp.local.',lease_ms:45000,services:[{service_type:'_nearcast._tcp.local.',instance:'Board',hostname:'board.local.',port:8443,txt:{id:'board',capability:'webcast',ttl:'3600'}}]}});
    assert.equal(discovery.registry.list(now).length,1);
    now = 46001;
    assert.equal(discovery.registry.list(now).length,0);
    await discovery.stop();
    assert.equal(discovery.registry.list(now).length,0);
  } finally { await discovery.stop(); }
});
