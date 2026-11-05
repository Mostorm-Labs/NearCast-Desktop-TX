import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import * as codec from '../src/touchback/codec.mjs';
import {FrameReassembler} from '../src/touchback/frame-codec.mjs';
const corpus=JSON.parse(readFileSync(new URL('./fixtures/axtp/input_stream.json',import.meta.url),'utf8'));

test('TX decodes every official TI-1 R2 valid input frame without changing its type or sampling',()=>{
  const decode=codec.decodeInputFrame;
  let count=0;
  for(const scenario of corpus.cases.filter(item=>item.valid)) for(const frame of scenario.frames ?? []) {
    assert.deepEqual(decode(Buffer.from(frame.hex,'hex')),frame.expectDecode,scenario.name);
    count++;
  }
  assert.equal(count,25);
});

test('bare STREAM, old TouchBatch and damaged or duplicated fragments are rejected',()=>{
  const official=Buffer.from(corpus.cases[0].frames[0].hex,'hex');
  assert.throws(()=>codec.decodeInputFrame(official.subarray(12,-2)),/header|length/);
  assert.throws(()=>codec.decodeInputFrame(Buffer.from('54420102000000000000000000000000000000000000000000000000','hex')),/header|length/);
  const sample=corpus.cases[0].frames[0].expectDecode,fragments=codec.encodeInputFrames(sample,{maxFrameBytes:24});
  const assembler=new FrameReassembler();assert.equal(assembler.accept(fragments[0]),null);
  assert.throws(()=>assembler.accept(fragments[0]),/duplicate/);
  const damaged=fragments[1].slice();damaged[12]^=1;
  assert.throws(()=>new FrameReassembler().accept(damaged),/CRC/);
  assert.deepEqual(codec.decodeInputFrames([...fragments].reverse()),{...sample,frameBytes:fragments.reduce((sum,frame)=>sum+frame.length,0)});
});

test('TX encoder matches the independent full-Frame Touch example including outer CRC16',()=>{
  const expected=corpus.cases.find(item=>item.name==='touch_single').frames[0];
  const encode=codec.encodeInputFrame;
  const actual=encode(expected.expectDecode,{sourceId:1,destinationId:16,messageId:1});
  assert.equal(Buffer.from(actual).toString('hex'),expected.hex);
});
