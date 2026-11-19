import test from 'node:test';
import assert from 'node:assert/strict';
import {loadPreferences,savePreferences} from '../src/settings.mjs';
import {applyVideoEncodingParameters,applyVideoTrackConstraints} from '../src/webcast/video-quality.mjs';
const storage=()=>{let value=null;return{getItem:()=>value,setItem:(_,next)=>{value=next;}};};
test('settings persist selected quality, audio, input opt-in and gesture policy',()=>{
  const store=storage(),value={video:{resolution:'2560x1440',bitrateMode:'dynamic',bitrateKbps:8000},systemAudio:false,inputEnabled:true,policy:{touch:'mouse-gestures',mouse:'native',gestures:{holdMs:450,rightClick:'two-finger',rightHoldMs:900,pinchAction:'disabled',feedback:false}}};
  savePreferences(value,store);const restored=loadPreferences(store);
  assert.deepEqual(restored.video,value.video);assert.equal(restored.systemAudio,false);assert.equal(restored.inputEnabled,true);
  assert.equal(restored.policy.touch,'mouse-gestures');assert.equal(restored.policy.gestures.holdMs,450);assert.equal(restored.policy.gestures.feedback,false);
});

test('first-run sharing uses 1080p adaptive encoding capped at 8 Mbps',async()=>{
  const preferences=loadPreferences(storage());
  let constraints,parameters;
  await applyVideoTrackConstraints({applyConstraints:async value=>{constraints=value;}},preferences.video);
  await applyVideoEncodingParameters({getParameters:()=>({encodings:[{}]}),setParameters:async value=>{parameters=value;}},preferences.video);
  assert.deepEqual(constraints,{width:{ideal:1920},height:{ideal:1080},frameRate:{ideal:30,max:30}});
  assert.equal(parameters.degradationPreference,'balanced');
  assert.equal(parameters.encodings[0].maxBitrate,8000000);
  assert.equal(parameters.encodings[0].maxFramerate,30);
});

test('saved advanced video settings survive another launch without being replaced by new defaults',()=>{
  for(const bitrateMode of ['fixed','dynamic']){
    const saved={video:{resolution:'2560x1440',bitrateMode,bitrateKbps:20000},language:'de',theme:'light',localSignaling:false,systemAudio:false,inputEnabled:true,policy:{touch:'native',mouse:'native'}};
    const restored=loadPreferences({getItem:()=>JSON.stringify(saved)});
    assert.deepEqual(restored,saved);
    const store=storage();savePreferences(restored,store);
    assert.deepEqual(loadPreferences(store),saved);
  }
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
