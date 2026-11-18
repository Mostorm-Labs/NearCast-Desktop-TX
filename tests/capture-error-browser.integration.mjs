import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {createServer} from 'node:http';
import {readFile,mkdir} from 'node:fs/promises';
import {resolve,sep,extname,join} from 'node:path';
const require=createRequire(import.meta.url);
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const root=resolve('dist'),types={'.mjs':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.png':'image/png'};
const server=createServer(async(req,res)=>{
  try{
    const file=resolve(root,'.'+new URL(req.url,'http://localhost').pathname);
    if(!file.startsWith(root+sep)){res.writeHead(403).end();return;}
    let data=await readFile(file);
    if(file.endsWith('index.html'))data=data.toString().replace('<script type="module" src="./bootstrap.mjs"></script>','');
    res.setHeader('content-type',types[extname(file)]||'text/html');res.end(data);
  }catch{res.writeHead(404).end();}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const browser=await chromium.launch({channel:process.env.BROWSER_CHANNEL||'chrome',headless:true});
try{
  const page=await browser.newPage({viewport:{width:946,height:692},locale:'zh-CN'}),errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.goto('http://127.0.0.1:'+server.address().port+'/index.html');
  assert.equal(await page.locator('#cast-permission-settings').count(),1,'a capture error has a contextual System Settings action');
  await page.evaluate(async()=>{
    const {i18n}=await import('/i18n.mjs');i18n.setLanguage('zh');
    const {MacOsPermissions}=await import('/macos-permissions.mjs');
    const {mountCaptureError}=await import('/capture/capture-error-ui.mjs');
    globalThis.fixture={calls:[],os:'macos',screen:'not_granted',permissionMode:'required'};
    fixture.permissions=new MacOsPermissions({invoke:async(command,args)=>{
      fixture.calls.push({command,args});
      if(command==='nearcast_macos_permission_settings'){
        if(fixture.failOpen)throw Error('settings jump failed');
        if(fixture.deferOpen)await new Promise(resolve=>{fixture.releaseOpen=resolve;});return null;
      }
      if(fixture.deferQuery)await new Promise(resolve=>{fixture.releaseQuery=resolve;});
      if(fixture.failQuery)throw Error('query failed');
      return{localNetwork:'available',screenRecording:fixture.screen,accessibility:'granted'};
    }});
    fixture.ui=mountCaptureError({document,permissions:fixture.permissions,platform:()=>({os:fixture.os,screenCapturePermission:fixture.permissionMode}),onSettingsOpened:()=>{fixture.opened=true;}});
    document.querySelector('#code-view').hidden=true;document.querySelector('#casting-view').hidden=false;document.documentElement.dataset.view='casting';
  });
  const report=(message='Permission denied')=>page.evaluate(message=>fixture.ui.report(new DOMException(message,'NotAllowedError')),message);
  const message=page.locator('#cast-error'),button=page.locator('#cast-permission-settings');
  await report('Cancelled by user');
  assert.match(await message.innerText(),/取消/);assert.equal(await button.isVisible(),false);
  assert.equal(await page.evaluate(()=>fixture.calls.length),0,'explicit cancellation does not query or request permission');
  await page.evaluate(()=>{fixture.permissionMode='on_selection';});await report();
  assert.equal(await button.isVisible(),false,'modern picker failures cannot be blamed on a missing broad recording grant');
  await page.evaluate(()=>{fixture.permissionMode='required';});
  await page.evaluate(()=>{fixture.screen='granted';});await report();
  assert.doesNotMatch(await message.innerText(),/系统设置|权限未开启/);assert.equal(await button.isVisible(),false);
  await page.evaluate(()=>{fixture.screen='not_granted';});await report();
  assert.match(await message.innerText(),/录屏与系统录音/);assert.equal(await button.isVisible(),true);
  assert.equal(await page.evaluate(()=>fixture.calls.some(call=>call.command==='nearcast_macos_permission_settings')),false,'an error never opens settings automatically');
  await page.evaluate(()=>{fixture.deferOpen=true;});await button.click();
  await page.waitForFunction(()=>document.querySelector('#cast-permission-settings').disabled);
  assert.deepEqual(await page.evaluate(()=>fixture.calls.find(call=>call.command==='nearcast_macos_permission_settings').args),{permission:'screenRecording'});
  await page.evaluate(()=>{fixture.deferOpen=false;fixture.releaseOpen();});
  await page.waitForFunction(()=>!document.querySelector('#cast-permission-settings').disabled);
  assert.equal(await message.isVisible(),true,'opening settings alone is not a permission grant');
  await page.evaluate(async()=>{fixture.screen='granted';await fixture.permissions.refresh();fixture.ui.permissionsChanged();});
  assert.equal(await message.isVisible(),false,'a confirmed grant clears stale permission guidance');
  await page.evaluate(()=>{fixture.screen='not_granted';fixture.failOpen=true;});await report();await button.click();
  await page.waitForFunction(()=>document.querySelector('#cast-error').textContent.includes('settings jump failed'));
  assert.equal(await button.isEnabled(),true,'a failed settings jump can be retried');
  await page.evaluate(()=>{fixture.failOpen=false;fixture.failQuery=true;});await button.click();
  await page.waitForFunction(()=>!document.querySelector('#cast-permission-settings').disabled);
  assert.equal(await button.isVisible(),false,'a failed refresh after opening settings removes stale permission guidance');
  assert.doesNotMatch(await message.innerText(),/系统检测到录屏权限尚未开启/);
  await report();
  assert.equal(await button.isVisible(),false,'a failed permission query cannot imply missing permission');
  await page.evaluate(()=>{fixture.failQuery=false;fixture.deferQuery=true;fixture.pending=fixture.ui.report(new DOMException('Permission denied','NotAllowedError'));});
  await page.waitForFunction(()=>typeof fixture.releaseQuery==='function');
  await page.evaluate(async()=>{fixture.ui.show(null);fixture.deferQuery=false;fixture.releaseQuery();await fixture.pending;});
  assert.equal(await message.isVisible(),false,'a late check cannot revive a cleared error');
  await report();
  await page.evaluate(async()=>{const {i18n}=await import('/i18n.mjs');i18n.setLanguage('en');});
  assert.equal(await button.innerText(),'Open System Settings');assert.match(await message.innerText(),/Screen & System Audio Recording/);
  if(process.env.NEARCAST_UI_ARTIFACTS){await mkdir(process.env.NEARCAST_UI_ARTIFACTS,{recursive:true});await page.screenshot({path:join(process.env.NEARCAST_UI_ARTIFACTS,'capture-permission-action.png')});}
  await page.setViewportSize({width:360,height:480});await button.scrollIntoViewIfNeeded();
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'long guidance and its action fit a narrow window');
  await page.evaluate(()=>{fixture.os='windows';});await report();assert.equal(await button.isVisible(),false);
  assert.deepEqual(errors,[]);
  console.log('PASS: cancellation, confirmed/unknown permission, contextual settings jump, truthful refresh, retry, stale checks, localization and responsive guidance');
}finally{await browser.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
