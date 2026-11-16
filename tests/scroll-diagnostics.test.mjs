import test from 'node:test';
import assert from 'node:assert/strict';
import {ScrollDiagnostics} from '../src/touchback/scroll-diagnostics.mjs';
import {scrollSample} from '../src/diagnostics.mjs';

test('scroll diagnostic totals preserve signed axes, separate units and native work',()=>{
  const d=new ScrollDiagnostics();d.opened();
  const wheel=(wheelX,wheelY,wheelUnit=0)=>({inputType:'mouse',eventKind:2,wheelX,wheelY,wheelUnit});
  d.record('received',wheel(3,-6));d.record('received',wheel(-2,10));d.record('submitted',wheel(3,-6),12,2);
  d.record('received',wheel(0,512,1));d.record('received',{inputType:'touch'});d.record('submitted',{inputType:'touch'});
  const value=d.snapshot();assert.deepEqual(value.detent120.received,{samples:2,positiveX:3,negativeX:2,positiveY:10,negativeY:6});
  assert.equal(value.regionQ16_16.received.positiveY,512);assert.equal(value.wheelBridgeMs,12);assert.equal(value.wheelNativeMs,2);
  const logged=scrollSample({scroll:value,nativeInput:{nativeExecution:{wheelSubmitted:{events:1,positiveY:6,secret:'no'}}},pairCode:'secret'});
  assert.equal(logged.nativeWheel.positiveY,6);assert.equal(logged.nativeWheel.secret,undefined);assert.equal(logged.touchReceived,1);
  value.detent120.received.positiveY=999;assert.equal(d.snapshot().detent120.received.positiveY,10);
});
