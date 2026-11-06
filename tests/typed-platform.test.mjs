import test from 'node:test';
import assert from 'node:assert/strict';
import {createPlatformInputAdapter} from '../src/touchback/platform-input.mjs';
test('all platforms obtain actual typed capabilities from the guarded native provider',async()=>{
  for(const os of ['windows','macos','linux']){
    const calls=[];const capabilities={inputTypes:os==='windows'?['touch']:os==='macos'?['mouse']:[],nativeReady:os!=='linux'};
    const provider=createPlatformInputAdapter({os},{invoke:async command=>{calls.push(command);return capabilities;}});
    assert.deepEqual(await provider.probe(),capabilities);assert.deepEqual(calls,['nearcast_input_probe']);
    assert.deepEqual(provider.snapshot(),{owners:0,activeContacts:0,lastSubmission:null});
  }
});
