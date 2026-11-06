import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {CaptureTargetPreviews} from '../src/capture/target-previews.mjs';
const bmp=Uint8Array.from(readFileSync(new URL('./fixtures/capture-thumbnail.bmp',import.meta.url))).buffer;
const turn=()=>new Promise(resolve=>setImmediate(resolve));

test('thumbnail requests are bounded, deduplicated and cached by native target identity',async()=>{
  const pending=[],states=[],created=[],revoked=[];
  const previews=new CaptureTargetPreviews({invoke:async(method,args)=>{assert.equal(method,'nearcast_capture_thumbnail');pending.push(args.targetId);return new Promise(resolve=>created.push(resolve));},createObjectURL:blob=>{assert.equal(blob.type,'image/bmp');return `blob:${pending.length}`;},revokeObjectURL:url=>revoked.push(url)});
  for(const id of ['a','b','c'])previews.request(id,state=>states.push([id,state]));
  previews.request('a',state=>states.push(['a',state]));await turn();assert.deepEqual(pending,['a','b']);
  created[0](bmp);await turn();assert.deepEqual(pending,['a','b','c']);
  created[1](bmp);created[2](bmp);await turn();
  assert.equal(states.filter(([,s])=>s.status==='ready').length,3);
  previews.request('a',state=>assert.equal(state.status,'ready'));await turn();assert.equal(pending.length,3);
  previews.dispose();assert.equal(revoked.length,3);
});

test('closing the chooser drops queued work and ignores late thumbnails without allocating URLs',async()=>{
  const pending=[],callbacks=[],urls=[];
  const previews=new CaptureTargetPreviews({invoke:async(_method,args)=>new Promise(resolve=>pending.push([args.targetId,resolve])),createObjectURL:()=>{urls.push('allocated');return 'blob:late';},revokeObjectURL(){}});
  for(const id of ['a','b','c'])previews.request(id,state=>callbacks.push(state));await turn();assert.equal(pending.length,2);
  previews.dispose();const before=callbacks.length;for(const [,resolve]of pending)resolve(bmp);await turn();
  assert.equal(callbacks.length,before);assert.equal(pending.length,2);assert.deepEqual(urls,[]);
});

test('an unavailable or malformed preview does not block other target thumbnails',async()=>{
  const states=[];const previews=new CaptureTargetPreviews({invoke:async(_method,{targetId})=>{if(targetId==='closed')throw new Error('window closed');return targetId==='bad'?new Uint8Array([0]).buffer:bmp;},createObjectURL:()=> 'blob:ok',revokeObjectURL(){}});
  for(const id of ['closed','bad','good'])previews.request(id,state=>states.push([id,state.status]));await turn();await turn();
  assert.ok(states.some(([id,state])=>id==='closed'&&state==='error'));assert.ok(states.some(([id,state])=>id==='bad'&&state==='error'));assert.ok(states.some(([id,state])=>id==='good'&&state==='ready'));previews.dispose();
});
