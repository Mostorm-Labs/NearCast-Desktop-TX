import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {createServer} from 'node:http';
import {readFile,mkdir} from 'node:fs/promises';
import {resolve,sep,extname,join} from 'node:path';

const require=createRequire(import.meta.url);
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const root=resolve('dist'),types={'.mjs':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.png':'image/png','.webp':'image/webp'};
const server=createServer(async(req,res)=>{
  try{
    const file=resolve(root,'.'+new URL(req.url,'http://localhost').pathname);
    if(!file.startsWith(root+sep)){res.writeHead(403).end();return;}
    res.setHeader('content-type',types[extname(file)]||'text/html');res.end(await readFile(file));
  }catch{res.writeHead(404).end();}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const browser=await chromium.launch({channel:process.env.BROWSER_CHANNEL||'msedge',headless:true});
const marker='nearhub-cast-macos-permissions-onboarding-v1';
const errors=[];
const open=async({os='macos',locale='en-US',pauseCheck=false,completed=false,permissions={},screenCapturePermission='on_selection'}={})=>{
  const context=await browser.newContext({viewport:{width:960,height:627},locale});
  const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));
  await page.addInitScript(({os,pauseCheck,completed,permissions,marker,screenCapturePermission})=>{
    if(completed)localStorage.setItem(marker,'completed');
    globalThis.fixture={os,pauseCheck,calls:[],listeners:{},fail:false,permissions:{localNetwork:'available',screenRecording:'not_granted',accessibility:'not_granted',...permissions}};
    globalThis.__TAURI__={core:{invoke:async(command,args)=>{
      fixture.calls.push({command,args});
      if(command==='nearcast_platform_info')return{os:fixture.os,screenCapture:true,systemAudio:false,touchback:true,screenCapturePermission};
      if(command==='nearcast_macos_permissions'){if(fixture.pauseCheck)await new Promise(resolve=>{fixture.releaseCheck=resolve;});if(fixture.fail)throw Error('permission-check-failed');return{...fixture.permissions};}
      if(command==='nearcast_macos_permission_settings')return null;
      if(command==='nearcast_window_action')return{maximized:false,x:0,y:0,scaleFactor:1};
      if(command==='nearcast_input_probe')return{inputTypes:['mouse'],mouse:{buttonsMask:7,modifierMask:15,wheelUnits:['detent120','regionQ16_16'],continuousScroll:true}};
      if(command.startsWith('nearcast_update_'))return{status:'current',currentVersion:'0.2.0.25'};
      return null;
    }},event:{listen:async(name,callback)=>{fixture.listeners[name]=callback;return()=>{};}}};
  },{os,pauseCheck,completed,permissions,marker,screenCapturePermission});
  await page.goto('http://127.0.0.1:'+server.address().port+'/index.html');
  await page.waitForFunction(()=>fixture.calls.some(call=>call.command==='nearcast_platform_info'));
  return{context,page};
};
try{
  const {context,page}=await open();
  assert.equal(await page.locator('#permission-onboarding').isVisible(),true,'first macOS launch shows the Figma permission screen');
  await page.waitForFunction(()=>document.querySelector('[data-onboarding-grant=localNetwork]')?.dataset.state==='available');
  assert.equal(await page.locator('#code-view').isVisible(),false);
  assert.equal(await page.locator('#settings-view').isVisible(),false);
  assert.equal(await page.locator('#onboarding-continue').isDisabled(),false,'session-scoped video does not require broad recording access');
  assert.equal(await page.locator('[data-onboarding-row=screenRecording] [data-onboarding-requirement]').innerText(),'Optional');
  assert.equal(await page.locator('[data-onboarding-row=accessibility] [data-onboarding-requirement]').innerText(),'Optional');
  assert.equal(await page.evaluate(()=>fixture.calls.some(call=>call.command==='nearcast_macos_permission_settings')),false,'startup checks permissions without requesting screen or accessibility access');
  const assets=await page.locator('#permission-onboarding img').evaluateAll(nodes=>nodes.map(node=>({src:node.getAttribute('src'),loaded:node.complete&&node.naturalWidth>0,width:node.getBoundingClientRect().width,height:node.getBoundingClientRect().height})));
  assert.ok(assets.length>=5&&assets.every(asset=>asset.loaded),JSON.stringify(assets));
  const icons=await page.locator('.onboarding-permission-icon').evaluateAll(nodes=>nodes.map(node=>[node.getBoundingClientRect().width,node.getBoundingClientRect().height]));
  assert.deepEqual(icons,[[40,40],[40,40],[40,40]]);
  const dividers=await page.locator('.onboarding-divider img').evaluateAll(nodes=>nodes.map(node=>[node.getBoundingClientRect().width,node.getBoundingClientRect().height]));
  assert.deepEqual(dividers,[[558,1],[558,1]],'Figma divider assets retain their exported geometry');
  const check=await page.locator('.onboarding-status-icon img:visible').boundingBox();
  assert.ok(Math.abs(check.width-8.5)<.02&&Math.abs(check.height-5.64286)<.02,'the granted check preserves its SVG root dimensions: '+JSON.stringify(check));
  if(process.env.NEARCAST_UI_ARTIFACTS){await mkdir(process.env.NEARCAST_UI_ARTIFACTS,{recursive:true});await page.screenshot({path:join(process.env.NEARCAST_UI_ARTIFACTS,'macos-first-launch-en.png')});}
  await page.locator('[data-onboarding-grant=screenRecording]').click();
  await page.waitForFunction(()=>fixture.calls.some(call=>call.command==='nearcast_macos_permission_settings'));
  assert.deepEqual(await page.evaluate(()=>fixture.calls.find(call=>call.command==='nearcast_macos_permission_settings').args),{permission:'screenRecording'});
  assert.equal(await page.locator('[data-onboarding-grant=screenRecording]').getAttribute('data-state'),'not_granted','opening settings cannot optimistically grant recording');
  await page.evaluate(()=>{fixture.permissions.screenRecording='granted';window.dispatchEvent(new Event('focus'));});
  await page.waitForFunction(()=>!document.querySelector('#onboarding-continue').disabled);
  assert.equal(await page.locator('[data-onboarding-grant=accessibility]').isDisabled(),false,'optional accessibility may still be granted separately');
  await page.locator('#onboarding-continue').click();
  assert.equal(await page.locator('#permission-onboarding').isVisible(),false);
  assert.equal(await page.locator('#code-view').isVisible(),true);
  assert.equal(await page.evaluate(key=>localStorage.getItem(key),marker),'completed');
  await page.reload();await page.waitForFunction(()=>fixture.listeners['nearcast://mdns-snapshot']);
  assert.equal(await page.locator('#permission-onboarding').isVisible(),false,'revoking optional recording access cannot block pure screen sharing');
  await page.locator('#settings-open').click();
  await page.waitForFunction(()=>document.querySelector('[data-permission=screenRecording]')?.getAttribute('aria-checked')==='false');
  assert.equal(await page.locator('[data-permission=screenRecording]').getAttribute('aria-checked'),'false','settings still reads real permissions after onboarding was completed');
  await context.close();

  const deferred=await open({locale:'zh-CN',permissions:{localNetwork:'unknown'}});
  await deferred.page.waitForFunction(()=>document.querySelector('#permission-onboarding')?.hidden===false);
  await deferred.page.evaluate(()=>{fixture.permissions.localNetwork='unknown';fixture.fail=true;window.dispatchEvent(new Event('focus'));});
  await deferred.page.waitForFunction(()=>!document.querySelector('#onboarding-error').hidden);
  assert.equal(await deferred.page.locator('#onboarding-continue').isDisabled(),true);
  assert.ok(!(await deferred.page.locator('[data-onboarding-grant=localNetwork]').innerText()).includes('已授权'));
  await deferred.page.locator('#onboarding-refresh').click();
  assert.equal(await deferred.page.locator('#onboarding-error').isVisible(),true);
  await deferred.page.evaluate(()=>{fixture.fail=false;window.dispatchEvent(new Event('focus'));});
  await deferred.page.waitForFunction(()=>document.querySelector('#onboarding-error').hidden);
  await deferred.page.locator('[data-onboarding-grant=accessibility]').click();
  assert.deepEqual(await deferred.page.evaluate(()=>fixture.calls.find(call=>call.command==='nearcast_macos_permission_settings').args),{permission:'accessibility'});
  await deferred.page.locator('#onboarding-not-now').click();
  assert.equal(await deferred.page.locator('#code-view').isVisible(),true,'denying permissions never traps the user in onboarding');
  await deferred.page.reload();await deferred.page.locator('#permission-onboarding').waitFor({state:'visible'});
  assert.equal(await deferred.page.locator('#onboarding-continue').isDisabled(),true,'Not Now cannot suppress missing required permissions on the next launch');
  await deferred.context.close();

  const ready=await open({completed:true,permissions:{screenRecording:'granted'}});
  await ready.page.waitForFunction(()=>fixture.listeners['nearcast://mdns-snapshot']);
  assert.equal(await ready.page.locator('#permission-onboarding').isVisible(),false,'both required permissions skip a previously completed guide even without accessibility');
  assert.equal(await ready.page.evaluate(()=>fixture.calls.filter(call=>call.command==='nearcast_macos_permissions').length),1,'completed setup still checks current permissions once at startup');
  await ready.page.reload();await ready.page.waitForFunction(()=>fixture.listeners['nearcast://mdns-snapshot']);
  assert.equal(await ready.page.locator('#permission-onboarding').isVisible(),false);
  await ready.context.close();

  const networkMissing=await open({completed:true,permissions:{localNetwork:'unknown',screenRecording:'granted'}});
  await networkMissing.page.locator('#permission-onboarding').waitFor({state:'visible'});
  assert.equal(await networkMissing.page.locator('#onboarding-continue').isDisabled(),true,'network unavailability alone repeats the startup guide');
  await networkMissing.context.close();

  const legacy=await open({completed:true,screenCapturePermission:'required'});
  await legacy.page.locator('#permission-onboarding').waitFor({state:'visible'});
  assert.equal(await legacy.page.locator('#onboarding-continue').isDisabled(),true,'legacy capture still requires recording access');
  assert.equal(await legacy.page.locator('[data-onboarding-row=screenRecording] [data-onboarding-requirement]').innerText(),'Required');
  await legacy.context.close();

  const pending=await open({pauseCheck:true});
  await pending.page.waitForFunction(()=>typeof fixture.releaseCheck==='function');
  await pending.page.locator('#onboarding-not-now').click();
  await pending.page.evaluate(()=>{fixture.pauseCheck=false;fixture.releaseCheck();});
  await pending.page.waitForFunction(()=>document.querySelector('#input-touch-output').options.length>0&&fixture.listeners['nearcast://mdns-snapshot']);
  assert.equal(await pending.page.evaluate(()=>fixture.calls.filter(call=>call.command==='nearcast_mdns_start').length),1,'deferring during the first permission check starts discovery only once');
  assert.equal(await pending.page.locator('#permission-onboarding').isVisible(),false,'a late check cannot reopen dismissed onboarding');
  await pending.context.close();

  for(const locale of ['de-DE','ja-JP']){
    const {context,page}=await open({locale});
    await page.waitForFunction(()=>document.querySelector('[data-onboarding-grant=localNetwork]')?.dataset.state==='available');
    await page.setViewportSize({width:360,height:480});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'translated onboarding must not overflow a narrow window');
    await page.locator('#onboarding-not-now').scrollIntoViewIfNeeded();
    assert.equal(await page.locator('#onboarding-not-now').isVisible(),true);
    if(process.env.NEARCAST_UI_ARTIFACTS)await page.screenshot({path:join(process.env.NEARCAST_UI_ARTIFACTS,'macos-first-launch-'+locale+'.png'),fullPage:true});
    await context.close();
  }
  const windows=await open({os:'windows'});
  await windows.page.waitForFunction(()=>fixture.listeners['nearcast://mdns-snapshot']);
  assert.equal(await windows.page.locator('#permission-onboarding').isVisible(),false);
  assert.equal(await windows.page.evaluate(()=>fixture.calls.some(call=>call.command==='nearcast_macos_permissions')),false);
  await windows.context.close();
  assert.deepEqual(errors,[]);
  console.log('PASS: macOS startup rechecks, missing/revoked required permissions, per-run deferral, truthful grants, optional accessibility, recovery, localized responsive assets and Windows exclusion');
}finally{await browser.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
