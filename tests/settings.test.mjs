import test from 'node:test';
import assert from 'node:assert/strict';
import {loadPreferences,savePreferences} from '../src/settings.mjs';
const storage=()=>{let value=null;return{getItem:()=>value,setItem:(_,next)=>{value=next;}};};
test('settings persist selected quality, audio, input opt-in and gesture policy',()=>{
  const store=storage(),value={video:{resolution:'2560x1440',bitrateMode:'dynamic',bitrateKbps:8000},systemAudio:false,inputEnabled:true,policy:{touch:'mouse-gestures',mouse:'native',gestures:{holdMs:450,rightClick:'two-finger',rightHoldMs:900,pinchAction:'disabled',feedback:false}}};
  savePreferences(value,store);const restored=loadPreferences(store);
  assert.deepEqual(restored.video,value.video);assert.equal(restored.systemAudio,false);assert.equal(restored.inputEnabled,true);
  assert.equal(restored.policy.touch,'mouse-gestures');assert.equal(restored.policy.gestures.holdMs,450);assert.equal(restored.policy.gestures.feedback,false);
});
test('missing, corrupt or unsupported preferences safely fall back and never enable input',()=>{
  const defaults=loadPreferences(storage());assert.equal(defaults.inputEnabled,false);
  for(const raw of ['{','null','{"policy":{"touch":"unexpected"}}','{"video":{"bitrateKbps":1234},"inputEnabled":true}']){
    assert.deepEqual(loadPreferences({getItem:()=>raw}),defaults);
  }
  assert.deepEqual(loadPreferences({getItem:()=>{throw Error('blocked');}}),defaults);
  assert.equal(loadPreferences({getItem:()=>' {"inputEnabled":"true"}'}).inputEnabled,false);
  assert.throws(()=>savePreferences(defaults,{setItem:()=>{throw Error('full');}}),/full/);
});
