import test from 'node:test';
import assert from 'node:assert/strict';
import {TouchFeedback} from '../src/touchback/touch-feedback.mjs';
const geometry={nativeId:'capture:cap-1',revision:'r1',units:'physical-pixels',region:{x:-1920,y:0,width:1920,height:1080}};
const event=(stage,seqId,x=-1800,phase=0)=>({stage,seqId,streamId:1,ownerId:'owner-1',geometry,records:[{contactId:9,x,y:200,phase}]});
const turn=()=>new Promise(resolve=>setImmediate(resolve));
function fixture(invoke=async()=>{}){
  let clock=0,next=0;const tasks=new Map(),calls=[];
  const feedback=new TouchFeedback({invoke:async(method,args)=>{calls.push([method,args]);return invoke(method,args);},now:()=>clock,setTimer:fn=>{tasks.set(++next,fn);return next;},clearTimer:id=>tasks.delete(id)});
  return{feedback,calls,advance:value=>clock=value,flush:async()=>{const work=[...tasks.values()];tasks.clear();for(const fn of work)fn();await turn();}};
}
test('Touch circles preserve negative physical coordinates and ignore older native completions',async()=>{
  const f=fixture();f.feedback.observe(event('received',1));await f.flush();
  assert.equal(f.calls[0][0],'nearcast_capture_touch_feedback');assert.equal(f.calls[0][1].points[0].x,-1800);assert.equal(f.calls[0][1].points[0].submitted,false);
  f.feedback.observe(event('received',2,-1700,1));f.feedback.observe(event('submitted',1,-1800));await f.flush();
  assert.equal(f.calls.at(-1)[1].points[0].x,-1700);assert.equal(f.calls.at(-1)[1].points[0].submitted,false);
  f.feedback.observe(event('submitted',2,-1700,1));await f.flush();assert.equal(f.calls.at(-1)[1].points[0].submitted,true);
  f.feedback.observe(event('received',3,-1700,2));await f.flush();assert.equal(f.calls.at(-1)[1].points[0].expiresInMs,700);
  f.advance(800);f.feedback.observe(event('received',4,-1600,0));await f.flush();assert.equal(f.calls.at(-1)[1].points.length,1);
});
test('a slow or failed visual IPC never creates an unbounded request queue and disabling clears it',async()=>{
  let finish;const f=fixture(()=>new Promise(resolve=>{finish=resolve;}));
  f.feedback.observe(event('received',1));await f.flush();
  for(let i=2;i<1002;i++)f.feedback.observe(event('received',i,-1800+i%100,1));
  await f.flush();assert.equal(f.calls.length,1);
  finish({});await turn();await f.flush();assert.equal(f.calls.length,2);
  f.feedback.setEnabled(false);f.feedback.observe(event('received',1002));finish({});await turn();await f.flush();
  assert.deepEqual(f.calls.at(-1)[1].points,[]);assert.ok(f.calls.every(([method])=>method==='nearcast_capture_touch_feedback'));
  finish({});await turn();
  const failed=fixture(async()=>{throw new Error('overlay unavailable');});failed.feedback.observe(event('received',1));await failed.flush();assert.match(failed.feedback.diagnostics().lastError,/unavailable/);
});
test('source replacement and cleanup cannot resurrect old circles or native completions',async()=>{
  const f=fixture();f.feedback.observe(event('received',1));await f.flush();f.feedback.observe({stage:'clear'});await f.flush();assert.deepEqual(f.calls.at(-1)[1].points,[]);
  f.feedback.observe(event('submitted',1));await f.flush();assert.deepEqual(f.calls.at(-1)[1].points,[]);
  f.feedback.observe({...event('received',1),ownerId:'owner-2'});f.feedback.observe(event('submitted',1));await f.flush();assert.equal(f.calls.at(-1)[1].points[0].submitted,false);
});
