import test from 'node:test';
import assert from 'node:assert/strict';
import {localSocketFactory,signalingChoice} from '../src/webcast/local-signaling.mjs';
import {loadPreferences,savePreferences} from '../src/settings.mjs';
import {normalizeDiscoveryDevice} from '../src/discovery/devices.mjs';
const turn=()=>new Promise(r=>setImmediate(r));
const device={instance:'Board._nearcast._tcp.local.',deviceId:'board',signaling:{local:'ready',cloud:'ready',runtimeInstanceId:'runtime-1'}};

test('default local mode never falls back to cloud or guesses a device from a code',()=>{
  assert.equal(loadPreferences({getItem:()=>null}).localSignaling,true);
  let stored;savePreferences({...loadPreferences({getItem:()=>null}),localSignaling:false},{setItem:(_,v)=>stored=v});
  assert.equal(loadPreferences({getItem:()=>stored}).localSignaling,false);
  assert.deepEqual(signalingChoice(device,true),{backend:'local',runtimeInstanceId:'runtime-1'});
  assert.deepEqual(signalingChoice(null,false),{backend:'cloud'});
  assert.throws(()=>signalingChoice(null,true),/选择接收端/);
  assert.throws(()=>signalingChoice({...device,signaling:null},true),/不支持/);
  assert.throws(()=>signalingChoice({...device,signaling:{...device.signaling,local:'unavailable'}},true),/未就绪/);
});
test('discovery exposes bounded non-secret signaling readiness and runtime fencing',()=>{
  const value=normalizeDiscoveryDevice({serviceType:'_nearcast._tcp.local.',instance:device.instance,hostname:'board.local',port:78,
    addresses:['192.0.2.1'],txt:{id:'board',capability:'webcast,code-display-v2,signaling-select-v1',runtime:'runtime-1','status-rev':'23','local-state':'ready','cloud-state':'unavailable'}});
  assert.deepEqual(value.signaling,{runtimeInstanceId:'runtime-1',revision:'23',local:'ready',cloud:'unavailable'});
});
test('native IPC socket subscribes before opening, orders sends and ignores other owners',async()=>{
  const calls=[];let callback,removed=false;
  const socket=localSocketFactory({device,listen:async(_,fn)=>{callback=fn;return()=>removed=true;},invoke:async(name,args)=>{calls.push([name,args]);}})();
  let opened=0,received=[];socket.onopen=()=>opened++;socket.onmessage=e=>received.push(e.data);
  await turn();const id=calls[0][1].connectionId;
  callback({payload:{kind:'open',connection_id:'other'}});assert.equal(opened,0);
  callback({payload:{kind:'open',connection_id:id}});assert.equal(socket.readyState,1);
  socket.send('first');socket.send('second');await turn();
  assert.deepEqual(calls.filter(([n])=>n==='nearcast_local_signal_send').map(([,a])=>a.data),['first','second']);
  callback({payload:{kind:'message',connection_id:id,data:'answer'}});assert.deepEqual(received,['answer']);
  socket.close();assert.equal(socket.readyState,3);assert.equal(removed,true);
  callback({payload:{kind:'open',connection_id:id}});assert.equal(opened,1);
});
test('closing while the listener is pending cannot open a native connection',async()=>{
  let finish,removed=false;const calls=[];
  const socket=localSocketFactory({device,listen:()=>new Promise(r=>finish=()=>r(()=>removed=true)),invoke:async(name)=>calls.push(name)})();
  socket.close();finish();await turn();assert.equal(removed,true);assert.ok(!calls.includes('nearcast_local_signal_open'));
});
