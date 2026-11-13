import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {browserPlatform,captureSourceInfo} from '../src/webcast/source-info.mjs';

test('platform and capture classification keep unknown facts explicit',()=>{
  assert.equal(browserPlatform({userAgentData:{platform:'Windows'}}),'windows');
  assert.equal(browserPlatform({platform:'MacIntel'}),'macos');
  assert.equal(browserPlatform({platform:'MacIntel',maxTouchPoints:5}),'ios');
  assert.equal(browserPlatform({platform:'Linux',userAgent:'Android'}),'android');
  assert.equal(browserPlatform({platform:'Linux'}),'linux');
  assert.equal(browserPlatform({}),'unknown');
  assert.deepEqual(captureSourceInfo(),{platform:'unknown',clientKind:'unknown',product:'unknown',displaySurface:'unknown'});
  assert.equal(captureSourceInfo({}, {readyState:'ended',getSettings:()=>({displaySurface:'monitor'})}).displaySurface,'unknown');
  assert.equal(captureSourceInfo({product:'Bad Value'}).product,'unknown');
  assert.deepEqual(captureSourceInfo({platform:'android',clientKind:'mobile',product:'nearhub-cast'}, {getSettings:()=>({displaySurface:'monitor'})}),
    {platform:'android',clientKind:'mobile',product:'nearhub-cast',displaySurface:'monitor'});
  for(const file of ['source-info.mjs','launcher-webcast-client.mjs'])
    assert.equal(fs.readFileSync(new URL('../src/webcast/'+file,import.meta.url),'utf8'),fs.readFileSync(new URL('../dist/webcast/'+file,import.meta.url),'utf8'));
});
