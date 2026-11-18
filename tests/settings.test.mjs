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

test('language follows the system by default and a chosen locale survives preference saves',()=>{
  const store=storage();assert.equal(loadPreferences(store).language,'system');
  for(const language of ['zh','en','ja','de','system']){
    savePreferences({...loadPreferences(store),language},store);
    assert.equal(loadPreferences(store).language,language);
  }
  assert.equal(loadPreferences({getItem:()=>' {"language":"fr","systemAudio":false}'}).language,'system');
  assert.equal(loadPreferences({getItem:()=>' {"language":"fr","systemAudio":false}'}).systemAudio,false);
});

test('theme follows the system for old settings and preserves explicit choices across unrelated saves',()=>{
  const store=storage();assert.equal(loadPreferences(store).theme,'system');
  for(const theme of ['dark','light','system']){
    savePreferences({...loadPreferences(store),theme,systemAudio:false},store);
    savePreferences({...loadPreferences(store),language:'ja'},store);
    assert.equal(loadPreferences(store).theme,theme);
    assert.equal(loadPreferences(store).systemAudio,false);
  }
  assert.equal(loadPreferences({getItem:()=>'{"theme":"unexpected","systemAudio":false}'}).theme,'system');
  assert.equal(loadPreferences({getItem:()=>'{"theme":"unexpected","systemAudio":false}'}).systemAudio,false);
});
