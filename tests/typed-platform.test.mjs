import test from 'node:test';
import assert from 'node:assert/strict';
import {createPlatformInputAdapter} from '../src/touchback/platform-input.mjs';
test('all platforms obtain actual typed capabilities from the guarded native provider',async()=>{
  for(const os of ['windows','macos','linux']){
    const calls=[];const capabilities={inputTypes:os==='windows'?['touch']:os==='macos'?['mouse']:[],nativeReady:os!=='linux',
      ...(os==='windows'?{touch:{maxContacts:10}}:os==='macos'?{mouse:{buttonsMask:7,modifierMask:15,allowChords:false,wheelUnits:['regionQ16_16'],continuousScroll:true}}:{})};
    const provider=createPlatformInputAdapter({os},{invoke:async command=>{calls.push(command);return capabilities;}});
    assert.deepEqual(await provider.probe(),{...capabilities,nativeTypes:capabilities.inputTypes});assert.deepEqual(calls,['nearcast_input_probe']);
    assert.deepEqual(provider.snapshot(),{owners:0,activeContacts:0,lastSubmission:null,lastCleanup:null,nativeExecution:null,outputPolicy:{touch:'native',mouse:'native'},nativeInputTypes:capabilities.inputTypes,lastConversion:null});
  }
});
