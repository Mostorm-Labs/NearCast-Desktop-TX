import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {createServer} from 'node:http';
import {readFile,mkdir} from 'node:fs/promises';
import {resolve,sep,join,extname} from 'node:path';
const require=createRequire(import.meta.url);
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const root=resolve('dist');
const server=createServer(async(req,res)=>{
  try{
    const path=resolve(root,'.'+new URL(req.url,'http://localhost').pathname);
    if(!path.startsWith(root+sep)){res.writeHead(403).end();return;}
    res.setHeader('content-type',({'.mjs':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.png':'image/png'})[extname(path)]||'text/html');
    res.end(await readFile(path));
  }catch{res.writeHead(404).end();}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
let browser;
try{
  browser=await chromium.launch({channel:process.env.BROWSER_CHANNEL||'msedge',headless:true});
  const page=await browser.newPage({viewport:{width:946,height:692}}),errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.goto('http://127.0.0.1:'+server.address().port+'/index.html');
  await page.waitForFunction(()=>document.documentElement.dataset.view==='home');
  await page.evaluate(async()=>{
    const {i18n}=await import('/i18n.mjs');i18n.setLanguage('zh');
    const {mountUpdates}=await import('/update/update-ui.mjs');
    window.updateFixture={hasUpdate:true,failDownload:false,holdDownload:false,calls:[],update:{version:'0.2.0.60',notes:'修复投屏和音频\n优化更新体验',size:10*1024*1024}};
    window.updates=mountUpdates({document,listen:async(_,callback)=>{window.updateProgress=callback;return()=>{};},isSharing:()=>true,
      beforeInstall:async()=>updateFixture.calls.push('cleanup'),
      invoke:async command=>{
        const fixture=updateFixture;fixture.calls.push(command);
        if(command==='nearcast_update_initialize')return{status:'current',currentVersion:'0.2.0.58',channel:'release'};
        if(command==='nearcast_update_check')return{status:fixture.hasUpdate?'available':'current',currentVersion:'0.2.0.58',update:fixture.hasUpdate?fixture.update:null};
        if(command==='nearcast_update_download'){
          if(fixture.failDownload)throw Error('测试下载错误');
          if(fixture.holdDownload)await new Promise(resolve=>{fixture.finishDownload=resolve;});
          return{status:'ready',update:fixture.update};
        }
        if(command==='nearcast_update_install')throw Error('测试安装错误');
        throw Error('Unexpected updater command: '+command);
      },setTimer:callback=>{queueMicrotask(callback);return null;}});
  });
  await page.waitForFunction(()=>updates.manager.state.status==='ready');
  assert.equal(await page.locator('#update-dialog').evaluate(node=>node.open),true);
  assert.match(await page.locator('#update-detail').textContent(),/结束当前投屏/);
  await page.locator('#update-later').click();
  await page.locator('#settings-open').click();await page.locator('[data-settings-tab=updates]').click();
  assert.equal(await page.locator('#settings-updates button:visible').count(),1,'Settings has one updater action');
  assert.equal(await page.locator('#settings-version').textContent(),'0.2.0.58');
  assert.match(await page.locator('#settings-update-status').textContent(),/0.2.0.60.*已下载/);
  assert.ok(!(await page.locator('main').innerText()).includes('修复投屏和音频'),'release notes live in the shared dialog');
  const screenshot=async name=>{if(process.env.NEARCAST_UI_ARTIFACTS){await mkdir(process.env.NEARCAST_UI_ARTIFACTS,{recursive:true});await page.screenshot({path:join(process.env.NEARCAST_UI_ARTIFACTS,name+'.png')});}};
  await screenshot('settings-update-ready');
  await page.locator('#settings-update-check').click();
  assert.equal(await page.locator('#update-dialog').evaluate(node=>node.open),true);
  assert.equal(await page.locator('#update-current-version').textContent(),'0.2.0.58');
  assert.equal(await page.locator('#update-target-version').textContent(),'0.2.0.60');
  assert.match(await page.locator('#update-notes').innerText(),/修复投屏和音频/);
  await page.evaluate(()=>updates.manager.apply({update:{...updateFixture.update,notes:'<img src=x onerror=alert(1)>'}}));
  assert.equal(await page.locator('#update-notes').innerText(),'<img src=x onerror=alert(1)>');
  assert.equal(await page.locator('#update-notes img').count(),0,'release notes cannot inject markup');
  await page.evaluate(()=>updates.manager.apply({update:{...updateFixture.update,notes:'长更新说明\n'.repeat(100)}}));
  await page.setViewportSize({width:640,height:480});
  const actions=await page.locator('#update-install').evaluate(node=>{const rect=node.getBoundingClientRect();return{top:rect.top,bottom:rect.bottom,height:innerHeight};});
  assert.ok(actions.top>=0&&actions.bottom<=actions.height,'the update action stays visible with long notes in a small window: '+JSON.stringify(actions));
  await screenshot('update-dialog-small');
  await page.setViewportSize({width:946,height:692});
  await page.evaluate(()=>updates.manager.apply({update:updateFixture.update}));
  assert.equal(await page.locator('#update-dialog .update-actions button:visible').count(),2,'one primary action and one dismissal');
  await page.locator('#update-install').click();
  await page.waitForFunction(()=>document.querySelector('#update-error').textContent==='测试安装错误');
  assert.equal(await page.locator('#settings-view').evaluate(node=>node.inert),false);
  assert.equal(await page.locator('#settings-update-error').textContent(),'测试安装错误');
  const calls=await page.evaluate(()=>updateFixture.calls);
  assert.ok(calls.indexOf('cleanup')<calls.indexOf('nearcast_update_install'));
  await page.locator('#update-close').click();await page.locator('#settings-close').click();
  await page.evaluate(()=>updates.manager.apply({error:null}));
  const header=page.locator('#app-version-button');
  assert.equal(await page.locator('#app-version').textContent(),'v0.2.0.58');
  assert.equal(await page.locator('#app-update-icon').isVisible(),true);
  assert.equal(await header.isEnabled(),true);assert.match(await header.getAttribute('aria-label'),/0.2.0.60/);
  for(const theme of ['light','dark']){
    await page.evaluate(theme=>{document.documentElement.dataset.theme=theme;},theme);
    assert.equal(await header.evaluate(node=>getComputedStyle(node).color),'rgb(67, 155, 252)');
    await screenshot('update-entry-'+theme);
    const count=await page.evaluate(()=>updateFixture.calls.length);
    await header.focus();await page.keyboard.press('Enter');
    assert.equal(await page.locator('#update-dialog').evaluate(node=>node.open),true);
    assert.equal(await page.evaluate(()=>updateFixture.calls.length),count,'opening version details cannot install or query');
    await screenshot('update-dialog-'+theme);
    await page.keyboard.press('Escape');
    assert.equal(await page.evaluate(()=>updates.manager.state.prompt),false);
  }
  await page.evaluate(()=>{updates.manager.apply({status:'current',update:null,error:null,prompt:false});updateFixture.hasUpdate=false;});
  await page.evaluate(()=>{document.documentElement.dataset.theme='light';});
  assert.equal(await header.isDisabled(),true);assert.equal(await page.locator('#app-update-icon').isVisible(),false);
  await page.locator('#settings-open').click();await page.locator('[data-settings-tab=updates]').click();
  assert.equal(await page.locator('#settings-updates button:visible').count(),1);
  const checkCount=await page.evaluate(()=>updateFixture.calls.filter(command=>command==='nearcast_update_check').length);
  await page.locator('#settings-update-check').click();
  await page.waitForFunction(()=>!updates.manager.state.checking);
  assert.equal(await page.evaluate(()=>updateFixture.calls.filter(command=>command==='nearcast_update_check').length),checkCount+1);
  assert.equal(await page.locator('#update-dialog').evaluate(node=>node.open),false);
  assert.match(await page.locator('#settings-update-status').textContent(),/最新版本/);
  await screenshot('settings-update-current');
  await page.evaluate(()=>{updateFixture.hasUpdate=true;updateFixture.holdDownload=true;});
  await page.locator('#settings-update-check').click();
  await page.waitForFunction(()=>updates.manager.state.status==='downloading'&&updates.manager.state.prompt);
  assert.equal(await page.locator('#update-notes').isVisible(),true,'notes remain readable while downloading');
  assert.equal(await page.locator('#update-install').isDisabled(),true);
  await page.evaluate(()=>updateProgress({payload:{total:10485760,received:5242880}}));
  assert.equal(await page.locator('#update-progress').evaluate(node=>node.value/node.max),0.5);
  await screenshot('update-dialog-downloading');
  await page.locator('#update-later').click();
  assert.equal(await page.evaluate(()=>updates.manager.state.status),'downloading','closing details keeps the background download');
  await header.click();assert.equal(await page.locator('#update-dialog').evaluate(node=>node.open),true);
  await page.evaluate(()=>updateFixture.finishDownload());
  await page.waitForFunction(()=>updates.manager.state.status==='ready');
  assert.equal(await page.locator('#update-install').isEnabled(),true);
  await page.locator('#update-close').click();
  await page.evaluate(()=>{updates.manager.apply({status:'available',update:updateFixture.update,error:'测试下载错误',prompt:true});updateFixture.holdDownload=false;updateFixture.failDownload=true;});
  assert.match(await page.locator('#update-install').textContent(),/重试/);
  const installCount=await page.evaluate(()=>updateFixture.calls.filter(command=>command==='nearcast_update_install').length);
  await page.locator('#update-install').click();await page.waitForFunction(()=>!updates.manager.state.checking);
  assert.equal(await page.evaluate(()=>updateFixture.calls.filter(command=>command==='nearcast_update_install').length),installCount,'retrying a download cannot install');
  assert.match(await page.locator('#update-error').textContent(),/测试下载错误/);
  await page.evaluate(()=>{updateFixture.failDownload=false;});
  await page.locator('#update-install').click();await page.waitForFunction(()=>updates.manager.state.status==='ready');
  await page.evaluate(()=>updates.manager.apply({installing:true,prompt:true}));
  assert.equal(await page.locator('#update-close').isDisabled(),true);
  assert.equal(await page.locator('#update-later').isDisabled(),true);
  await page.keyboard.press('Escape');assert.equal(await page.locator('#update-dialog').evaluate(node=>node.open),true);
  assert.equal(await page.locator('#settings-view').evaluate(node=>node.inert),true);
  await page.evaluate(()=>updates.manager.apply({installing:false,prompt:false}));
  assert.deepEqual(errors,[]);await page.evaluate(()=>updates.stop());
  console.log('PASS: one updater action, shared release dialog, branded version arrow, manual checks, download retry and install safety');
}finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
