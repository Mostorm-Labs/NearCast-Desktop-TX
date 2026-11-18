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
const browser=await chromium.launch({channel:process.env.BROWSER_CHANNEL||'chrome',headless:true});
try{
  const context=await browser.newContext({viewport:{width:946,height:692},locale:'zh-CN'});
  await context.addInitScript(()=>{
    localStorage.setItem('nearhub-cast-macos-permissions-onboarding-v1','completed');
    globalThis.fixture={permissions:{localNetwork:'available',screenRecording:sessionStorage.getItem('screenRecording')||'granted',accessibility:sessionStorage.getItem('accessibility')||'granted'},calls:[],listeners:{}};
    globalThis.__TAURI__={core:{invoke:async(command,args)=>{
      fixture.calls.push({command,args});
      if(command==='nearcast_platform_info')return{os:'macos',screenCapture:true,systemAudio:true,touchback:true,screenCapturePermission:'on_selection'};
      if(command==='nearcast_macos_permissions'){
        if(fixture.deferCheck)await new Promise(resolve=>{fixture.releaseCheck=resolve;});
        if(fixture.failCheck)throw Error('permission check failed');return{...fixture.permissions};
      }
      if(command==='nearcast_macos_permission_settings')return null;
      if(command==='nearcast_window_action')return{maximized:false,x:0,y:0,scaleFactor:1};
      if(command==='nearcast_input_probe')return{inputTypes:['mouse'],mouse:{buttonsMask:7,modifierMask:15,wheelUnits:['detent120'],continuousScroll:true}};
      if(command.startsWith('nearcast_update_'))return{status:'current',currentVersion:'0.2.0.36'};
      return null;
    }},event:{listen:async(name,callback)=>{fixture.listeners[name]=callback;return()=>delete fixture.listeners[name];}}};
  });
  const page=await context.newPage(),errors=[];page.setDefaultTimeout(10000);page.on('pageerror',error=>errors.push(error.message));
  await page.goto('http://127.0.0.1:'+server.address().port+'/index.html');
  await page.waitForFunction(()=>fixture.listeners['nearcast://mdns-snapshot']);
  await page.locator('#settings-open').click();await page.locator('[data-settings-tab=general]').click();
  const audio=page.locator('#system-audio-enabled'),input=page.locator('#input-enabled');
  const audioNotice=page.locator('#settings-general [data-feature-permission=audio]'),inputNotice=page.locator('#settings-general [data-feature-permission=input]');
  const enable=async(control,id)=>{await control.click();await page.waitForFunction(id=>!document.querySelector(id).disabled,id);};
  await audio.uncheck();
  await page.evaluate(()=>{fixture.permissions.screenRecording='not_granted';});
  await enable(audio,'#system-audio-enabled');
  assert.equal(await audio.isChecked(),false,'audio cannot be enabled with a stale cached screen-recording grant');
  assert.equal(await audioNotice.isVisible(),true);assert.match(await audioNotice.innerText(),/录屏与系统录音/);
  assert.equal(await page.evaluate(()=>fixture.calls.some(call=>call.command==='nearcast_macos_permission_settings')),false,'a failed check only shows guidance');
  await audioNotice.getByRole('button',{name:'打开系统设置'}).click();
  await page.waitForFunction(()=>fixture.calls.some(call=>call.command==='nearcast_macos_permission_settings'));
  assert.deepEqual(await page.evaluate(()=>fixture.calls.find(call=>call.command==='nearcast_macos_permission_settings').args),{permission:'screenRecording'});
  assert.equal(await audio.isChecked(),false,'opening settings cannot enable audio');
  await page.evaluate(()=>{fixture.permissions.screenRecording='granted';window.dispatchEvent(new Event('focus'));});
  await audioNotice.waitFor({state:'hidden'});assert.equal(await audio.isChecked(),false,'returning from settings requires a new enable intent');
  await enable(audio,'#system-audio-enabled');assert.equal(await audio.isChecked(),true);
  await page.evaluate(()=>{fixture.permissions.accessibility='not_granted';});
  await enable(input,'#input-enabled');assert.equal(await input.isChecked(),false);
  assert.equal(await page.evaluate(()=>__nearcastTouchbackDiagnostics().localEnabled),false,'missing accessibility cannot arm the real input engine');
  assert.equal(await inputNotice.isVisible(),true);assert.match(await inputNotice.innerText(),/辅助功能/);
  await inputNotice.getByRole('button',{name:'打开系统设置'}).click();
  assert.deepEqual(await page.evaluate(()=>fixture.calls.filter(call=>call.command==='nearcast_macos_permission_settings').at(-1).args),{permission:'accessibility'});
  if(process.env.NEARCAST_UI_ARTIFACTS){await mkdir(process.env.NEARCAST_UI_ARTIFACTS,{recursive:true});await page.screenshot({path:join(process.env.NEARCAST_UI_ARTIFACTS,'feature-permission-input.png')});}
  await page.evaluate(()=>{fixture.permissions.accessibility='granted';window.dispatchEvent(new Event('focus'));});await inputNotice.waitFor({state:'hidden'});
  await enable(input,'#input-enabled');assert.equal(await input.isChecked(),true);
  assert.equal(await page.evaluate(()=>__nearcastTouchbackDiagnostics().localEnabled),true);
  await page.evaluate(()=>{fixture.permissions.accessibility='not_granted';window.dispatchEvent(new Event('focus'));});
  await page.waitForFunction(()=>!document.querySelector('#input-enabled').checked&&!__nearcastTouchbackDiagnostics().localEnabled);
  await page.evaluate(()=>{fixture.failCheck=true;});await enable(input,'#input-enabled');
  assert.equal(await input.isChecked(),false);assert.match(await inputNotice.innerText(),/无法确认/);assert.doesNotMatch(await inputNotice.innerText(),/尚未开启/);
  await page.evaluate(()=>{sessionStorage.setItem('screenRecording','not_granted');sessionStorage.setItem('accessibility','not_granted');});
  await page.reload();await page.waitForFunction(()=>fixture.listeners['nearcast://mdns-snapshot']);
  assert.equal(await page.locator('#permission-onboarding').isVisible(),false,'missing optional audio/control permissions cannot block startup');
  await page.locator('#settings-open').click();await page.locator('[data-settings-tab=general]').click();
  assert.equal(await audio.isChecked(),false,'saved audio opt-in is inactive until its local permission is available');
  assert.equal(await input.isChecked(),false);
  await page.setViewportSize({width:360,height:480});await enable(input,'#input-enabled');await inputNotice.getByRole('button').scrollIntoViewIfNeeded();
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  assert.deepEqual(errors,[]);await context.close();
  console.log('PASS: audio/accessibility checks on enable, stale/unknown grants, real input-engine gate, settings jump, explicit retry, revocation, optional startup and narrow hints');
}finally{await browser.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
