import test from 'node:test';
import assert from 'node:assert/strict';
import {UpdateManager} from '../src/update/update-manager.mjs';

const available = {status:'available',currentVersion:'0.1.0.0',update:{version:'0.1.0.3',notes:'修复',size:123}};
test('startup prompts once and downloads in the background without installing', async () => {
  const calls = [], changes = [];
  const manager = new UpdateManager({invoke:async command => {
    calls.push(command);
    if(command==='nearcast_update_initialize')return {status:'idle',currentVersion:'0.1.0.0'};
    if(command==='nearcast_update_check')return available;
    if(command==='nearcast_update_download')return {...available,status:'ready'};
  }, onChange:state=>changes.push(state)});
  await manager.start({schedule:false});
  assert.ok(changes.some(state=>state.prompt));
  assert.equal(manager.state.status,'ready');
  assert.deepEqual(calls,['nearcast_update_initialize','nearcast_update_check','nearcast_update_download']);
  assert.ok(!calls.includes('nearcast_update_install'));
  manager.dismiss(); assert.equal(manager.state.prompt,false);
  await manager.check(); assert.equal(manager.state.prompt,false);
});
test('cached update remains offered after offline query and later is scoped to this launch', async () => {
  const manager = new UpdateManager({invoke:async command => {
    if(command==='nearcast_update_initialize')return {...available,status:'ready'};
    if(command==='nearcast_update_check')throw new Error('offline');
  }});
  await manager.start({schedule:false});
  assert.equal(manager.state.status,'ready');
  assert.equal(manager.state.prompt,true);
  manager.dismiss(); assert.equal(manager.state.prompt,false);
});
test('install releases the media/input session before native installation', async () => {
  const calls=[];
  const manager=new UpdateManager({invoke:async command=>{calls.push(command);return {...available,status:'installing'};},beforeInstall:async()=>calls.push('cleanup')});
  manager.apply({...available,status:'ready'});
  await manager.install();
  assert.deepEqual(calls,['cleanup','nearcast_update_install']);
});
test('failed cleanup prevents installation and preserves retry', async () => {
  let installed=false;
  const manager=new UpdateManager({invoke:async()=>{installed=true;},beforeInstall:async()=>{throw new Error('touch cleanup pending');}});
  manager.apply({...available,status:'ready'});
  await manager.install();
  assert.equal(installed,false);assert.equal(manager.state.status,'ready');assert.match(manager.state.error,/cleanup/);
});
test('periodic updates do not interrupt the user with a modal', async()=>{
  const manager=new UpdateManager({invoke:async command=>({...available,status:command.endsWith('download')?'ready':'available'})});
  await manager.check();
  assert.equal(manager.state.status,'ready');assert.equal(manager.state.prompt,false);
});
test('a failed download cannot mark a new version ready using an older cache', async()=>{
  const manager=new UpdateManager({invoke:async command=>{
    if(command==='nearcast_update_check')return {...available,update:{...available.update,version:'0.1.0.4'}};
    throw new Error('download interrupted');
  }});
  manager.apply({...available,status:'ready'});
  await manager.check();
  assert.equal(manager.state.update.version,'0.1.0.4');assert.equal(manager.state.status,'available');
});
