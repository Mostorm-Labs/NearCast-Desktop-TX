import test from 'node:test';
import assert from 'node:assert/strict';
import {ReceiverTrust, formatFingerprint} from '../src/webcast/receiver-trust.mjs';
import {normalizeDiscoveryDevice} from '../src/discovery/devices.mjs';

const pin = 'A1B2'.repeat(16);
const device = (changes = {}) => ({deviceId:'Board-ID',instance:'Board._nearcast._tcp.local.',protocol:'webcast',selectable:true,supportsTrustDisplay:true,expiresAt:Date.now()+60000,...changes});
const candidate = {deviceId:'Board-ID',candidateId:'ticket',fingerprint:pin,previousFingerprint:null,expiresAt:Date.now()+60000};
function fixture(overrides = {}) {
  const calls=[]; const ready=[]; const updates=[];
  const invoke = async (command,args) => {
    calls.push([command,args]);
    if (overrides[command]) return overrides[command](args);
    if (command==='nearcast_trust_status') return {trusted:false,fingerprint:null,deviceId:args.deviceId};
    if (command==='nearcast_trust_prepare') return {...candidate};
  };
  const trust = new ReceiverTrust({invoke,onChange:state=>updates.push(state),onTrusted:receiver=>ready.push(receiver)});
  return {trust,calls,ready,updates};
}

test('discovery exposes trust-display only for NearCast with explicit capability',()=>{
  const service = {serviceType:'_nearcast._tcp.local.',instance:'Board',hostname:'board.local.',port:8443,txt:{id:'Board-ID',capability:'webcast,trust-display-v1',fingerprint:pin}};
  assert.equal(normalizeDiscoveryDevice(service).supportsTrustDisplay,true);
  assert.throws(()=>normalizeDiscoveryDevice({...service,serviceType:'_airplay._tcp.local.'}),/unsupported/i);
  assert.equal(normalizeDiscoveryDevice({...service,txt:{...service.txt,capability:'webcast'}}).supportsTrustDisplay,false);
});

test('full fingerprint displays four lines of four groups without truncation',()=>{
  const lines=formatFingerprint(pin).split('\n');
  assert.equal(lines.length,4); for(const line of lines) assert.match(line,/^[A-F0-9]{4}( [A-F0-9]{4}){3}$/);
  assert.equal(lines.join('').replaceAll(' ',''),pin);
  assert.throws(()=>formatFingerprint('1234'));
});

test('first selection displays candidate but only explicit physical comparison persists trust',async()=>{
  const {trust,calls,ready}=fixture();
  await trust.select(device());
  assert.equal(trust.state.phase,'compare'); assert.equal(trust.state.fingerprint,pin); assert.deepEqual(ready,[]);
  await assert.rejects(()=>trust.confirm(false),/核对/);
  assert.equal(calls.some(([command])=>command==='nearcast_trust_confirm'),false);
  await trust.confirm(true);
  assert.equal(trust.state.phase,'trusted'); assert.equal(ready.length,1);
  assert.deepEqual(calls.find(([command])=>command==='nearcast_trust_confirm')[1],{deviceId:'Board-ID',candidateId:'ticket',fingerprint:pin});
  trust.cancel();
});

test('saved key permits code display, mismatch blocks until a new explicit comparison',async()=>{
  const {trust,ready,calls}=fixture({nearcast_trust_status:async()=>({trusted:true,deviceId:'Board-ID',fingerprint:pin})});
  await trust.select(device()); assert.equal(ready.length,1);
  assert.equal(calls.some(([command])=>command==='nearcast_trust_prepare'),false);
  trust.keyMismatch('NEARCAST_KEY_MISMATCH: key changed');
  assert.equal(trust.state.phase,'changed'); assert.equal(ready.length,1);
  await trust.prepare(); assert.equal(trust.state.phase,'compare'); assert.equal(ready.length,1);
  await trust.confirm(true); assert.equal(ready.length,2);
  await trust.revoke(); assert.equal(trust.state.phase,'untrusted');
  assert.equal(calls.at(-1)[0],'nearcast_trust_revoke'); trust.cancel();
});

test('cancelled/switched and expired candidates cannot become trusted via late callbacks',async()=>{
  let resolvePrepare;
  const {trust,ready,calls}=fixture({nearcast_trust_prepare:()=>new Promise(resolve=>{resolvePrepare=resolve;})});
  const selecting=trust.select(device()); await new Promise(resolve=>setTimeout(resolve,0));
  trust.cancel(); resolvePrepare({...candidate}); await selecting;
  assert.equal(trust.state.phase,'idle'); assert.deepEqual(ready,[]);
  assert.equal(calls.some(([command])=>command==='nearcast_trust_confirm'),false);
  const expired=fixture({nearcast_trust_prepare:async()=>({...candidate,expiresAt:1})});
  await expired.trust.select(device());
  await assert.rejects(()=>expired.trust.confirm(true),/过期|核对/);
  assert.deepEqual(expired.ready,[]); expired.trust.cancel();
});

test('missing capability or native failure preserves manual pairing without automatic trust',async()=>{
  const first=fixture(); await first.trust.select(device({supportsTrustDisplay:false}));
  assert.equal(first.trust.state.phase,'unsupported'); assert.deepEqual(first.ready,[]);
  assert.equal(first.calls.some(([command])=>command==='nearcast_trust_prepare'),false);
  const second=fixture({nearcast_trust_status:async()=>{throw 'trust file unreadable';}});
  await second.trust.select(device()); assert.equal(second.trust.state.phase,'error'); assert.match(second.trust.state.error,/unreadable/);
  assert.deepEqual(second.ready,[]); first.trust.cancel(); second.trust.cancel();
});

test('two selections in the same turn cannot reuse the newer selection generation',async()=>{
  let resolveFirst; const pending=[];
  const {trust,ready}=fixture({nearcast_trust_status:args=>args.deviceId==='Board-ID'?new Promise(resolve=>{resolveFirst=resolve;}):Promise.resolve({trusted:false}),nearcast_trust_prepare:async args=>{pending.push(args.deviceId);return {...candidate,deviceId:args.deviceId};}});
  const first=trust.select(device());
  const second=trust.select(device({deviceId:'Second-ID',instance:'Second'}));
  await new Promise(resolve=>setTimeout(resolve,0));
  resolveFirst?.({trusted:true,deviceId:'Board-ID',fingerprint:pin});
  await Promise.all([first,second]);
  assert.equal(trust.device.deviceId,'Second-ID'); assert.equal(trust.state.deviceId,'Second-ID'); assert.deepEqual(ready,[]);
  assert.deepEqual(pending,['Second-ID']); trust.cancel();
});

test('repeated retries ignore an earlier response and failed saving cannot authorize code display',async()=>{
  const pending=[];
  const {trust,ready}=fixture({nearcast_trust_prepare:()=>new Promise(resolve=>pending.push(resolve)),nearcast_trust_confirm:async()=>{throw 'disk full';}});
  const selecting=trust.select(device()); await new Promise(resolve=>setTimeout(resolve,0));
  const retry=trust.prepare();
  pending[1]({...candidate,candidateId:'new'}); await retry;
  pending[0]({...candidate,candidateId:'old'}); await selecting;
  assert.equal(trust.state.candidateId,'new');
  await trust.confirm(true); assert.equal(trust.state.phase,'error'); assert.match(trust.state.error,/disk full/); assert.deepEqual(ready,[]); trust.cancel();
});
