import test from 'node:test';
import assert from 'node:assert/strict';
import {createSharingWindow} from '../src/sharing-window.mjs';
import {LauncherWebCastClient} from '../src/webcast/launcher-webcast-client.mjs';

test('only a successful stream minimizes to the taskbar, duplicate stops do not steal focus',async()=>{
  const calls=[];const w=createSharingWindow({invoke:async(_,{action})=>calls.push(action.kind)});
  await w.sharing(null);assert.deepEqual(calls,[]);
  await w.sharing({});await w.sharing({});assert.deepEqual(calls,['minimize']);
  await w.sharing(null);await w.sharing(null);assert.deepEqual(calls,['minimize','show']);
});
test('capture ended wins over a delayed minimize and close suppresses restoration',async()=>{
  const calls=[];let finish;
  const w=createSharingWindow({invoke:async(_,{action})=>{calls.push(action.kind);if(action.kind==='minimize')await new Promise(r=>finish=r);}});
  const hide=w.sharing({});await Promise.resolve();const show=w.sharing(null);finish();await hide;await show;
  assert.deepEqual(calls,['minimize','show']);
  const hidden=w.sharing({});await Promise.resolve();finish();await hidden;
  await w.shutdown();await w.sharing(null);assert.deepEqual(calls,['minimize','show','minimize']);
});
test('failed minimize does not poison a later restore',async()=>{
  const errors=[],calls=[];const w=createSharingWindow({onError:e=>errors.push(e),invoke:async(_,{action})=>{calls.push(action.kind);if(action.kind==='minimize')throw Error('minimize failed');}});
  await w.sharing({});await w.sharing(null);assert.deepEqual(calls,['minimize','show']);assert.equal(errors.length,1);
});
test('capture stop restores UI even if RTP sender detach fails',async()=>{
  const stopped=[],streams=[],client=new LauncherWebCastClient({WebSocketImpl:class{},RTCPeerConnectionImpl:class{},onStream:s=>streams.push(s)});
  client.stream={getTracks:()=>[{stop:()=>stopped.push(true)}]};client.pc={};client.status='sharing';
  client.mediaSenders.set('video',{replaceTrack:async()=>{throw Error('peer failed');}});
  await assert.rejects(client.stopStream(),/peer failed/);
  assert.equal(stopped.length,1);assert.deepEqual(streams,[null]);assert.equal(client.status,'connected');
});
