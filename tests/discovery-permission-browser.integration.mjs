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
    globalThis.fixture={os:sessionStorage.getItem('platform')||'macos',network:'available',calls:[],listeners:{}};
    globalThis.__TAURI__={core:{invoke:async(command,args)=>{
      fixture.calls.push({command,args});
      if(command==='nearcast_platform_info')return{os:fixture.os,screenCapture:true,systemAudio:true,touchback:false};
      if(command==='nearcast_macos_permissions'){
        if(fixture.failQuery)throw Error('permission query unavailable');
        return{localNetwork:fixture.network,screenRecording:'granted',accessibility:'not_granted'};
      }
      if(command==='nearcast_macos_permission_settings'){
        if(fixture.failOpen)throw Error('settings jump failed');
        if(fixture.deferOpen)await new Promise(resolve=>{fixture.releaseOpen=resolve;});return null;
      }
      if(command==='nearcast_window_action')return{maximized:false,x:0,y:0,scaleFactor:1};
      if(command.startsWith('nearcast_update_'))return{status:'current',currentVersion:'0.2.0.35'};
      return null;
    }},event:{listen:async(name,callback)=>{fixture.listeners[name]=callback;return()=>delete fixture.listeners[name];}}};
  });
  const page=await context.newPage(),errors=[];page.setDefaultTimeout(10000);page.on('pageerror',error=>errors.push(error.message));
  await page.goto('http://127.0.0.1:'+server.address().port+'/index.html');
  await page.waitForFunction(()=>fixture.listeners['nearcast://mdns-snapshot']&&!document.querySelector('#refresh-devices').disabled);
  const notice=page.locator('#discovery-permission-notice'),button=page.locator('#discovery-permission-settings');
  const scan=async()=>{await page.locator('#refresh-devices').click();await page.waitForFunction(()=>!document.querySelector('#refresh-devices').disabled);};
  assert.equal(await notice.isVisible(),true,'an empty macOS device list offers permission troubleshooting');
  assert.doesNotMatch(await notice.innerText(),/被系统阻止/,'zero devices do not prove denial');
  assert.equal(await page.evaluate(()=>fixture.calls.some(call=>call.command==='nearcast_macos_permission_settings')),false,'scanning never opens settings automatically');
  await page.evaluate(()=>{fixture.network='not_granted';});await scan();
  assert.match(await notice.innerText(),/本地网络.*被系统阻止/);
  assert.match(await notice.innerText(),/隐私与安全性.*本地网络/);
  await page.evaluate(()=>{fixture.deferOpen=true;});await button.click();
  assert.equal(await button.isDisabled(),true);
  assert.deepEqual(await page.evaluate(()=>fixture.calls.find(call=>call.command==='nearcast_macos_permission_settings').args),{permission:'localNetwork'});
  await page.evaluate(()=>{fixture.deferOpen=false;fixture.releaseOpen();});
  await page.waitForFunction(()=>!document.querySelector('#discovery-permission-settings').disabled);
  assert.match(await notice.innerText(),/被系统阻止/,'opening settings cannot mark the permission granted');
  await page.evaluate(()=>{fixture.failOpen=true;});await button.click();
  await page.waitForFunction(()=>document.querySelector('#discovery-permission-notice').textContent.includes('settings jump failed'));
  assert.equal(await button.isEnabled(),true,'failed jumps remain retryable');
  await page.evaluate(()=>{fixture.failOpen=false;fixture.network='available';window.dispatchEvent(new Event('focus'));});
  await page.waitForFunction(()=>!document.querySelector('#refresh-devices').disabled&&!document.querySelector('#discovery-permission-notice').textContent.includes('被系统阻止'));
  assert.ok(await page.evaluate(()=>fixture.calls.filter(call=>call.command==='nearcast_mdns_start').length>=3),'returning from network settings restarts discovery');
  await page.evaluate(()=>fixture.listeners['nearcast://mdns-snapshot']({payload:{service_type:'_nearcast._tcp.local.',lease_ms:45000,services:[{
    service_type:'_nearcast._tcp.local.',instance:'Board',hostname:'board.local.',port:78,addresses:['192.0.2.3'],txt:{id:'board',capability:'webcast'},
  }]}}));
  assert.equal(await notice.isVisible(),false,'successful discovery clears empty-list guidance');
  assert.equal(await page.locator('.device-row').count(),1);
  await page.evaluate(()=>{fixture.failQuery=true;});await scan();
  assert.equal(await notice.isVisible(),true);
  assert.doesNotMatch(await notice.innerText(),/被系统阻止/,'failed permission checks stay uncertain');
  await page.evaluate(()=>{fixture.failQuery=false;fixture.network='unknown';});await scan();
  assert.doesNotMatch(await notice.innerText(),/被系统阻止/);
  await page.evaluate(async()=>{const{i18n}=await import('/i18n.mjs');i18n.setLanguage('en');});
  assert.equal(await button.innerText(),'Open System Settings');
  assert.match(await notice.innerText(),/Local Network/);
  await page.evaluate(()=>{fixture.network='not_granted';});await scan();
  if(process.env.NEARCAST_UI_ARTIFACTS){await mkdir(process.env.NEARCAST_UI_ARTIFACTS,{recursive:true});await page.screenshot({path:join(process.env.NEARCAST_UI_ARTIFACTS,'discovery-local-network-denied.png')});}
  await page.setViewportSize({width:360,height:480});await button.scrollIntoViewIfNeeded();
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'the notice fits a narrow device list');
  await page.evaluate(()=>{sessionStorage.setItem('platform','windows');});await page.reload();
  await page.waitForFunction(()=>fixture.listeners['nearcast://mdns-snapshot']&&!document.querySelector('#refresh-devices').disabled);
  assert.equal(await notice.isVisible(),false,'Windows never offers macOS permission settings');
  assert.deepEqual(errors,[]);
  await context.close();
  console.log('PASS: scan denial, empty/unknown distinction, contextual network settings, retry, focus rescan, recovery, localization, responsive list and Windows exclusion');
}finally{await browser.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
