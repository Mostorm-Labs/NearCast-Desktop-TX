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
  browser=await chromium.launch({channel:'msedge',headless:true});
  const page=await browser.newPage({viewport:{width:960,height:640}});
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto('http://127.0.0.1:'+server.address().port+'/index.html');
  await page.waitForFunction(()=>document.documentElement.dataset.view==='home');
  await page.evaluate(async()=>{
    const {i18n}=await import('/i18n.mjs');i18n.setLanguage('zh');
    const {mountUpdates}=await import('/update/update-ui.mjs');
    const update={version:'0.2.0.37',notes:'修复投屏和音频\n后台更新测试',size:1024};
    window.updateCalls=[];
    window.updates=mountUpdates({document,listen:async(_,callback)=>{window.updateProgress=callback;return()=>{};},isSharing:()=>true,
      beforeInstall:async()=>window.updateCalls.push('cleanup'),
      invoke:async command=>{
        window.updateCalls.push(command);
        if(command==='nearcast_update_initialize')return {status:'current',currentVersion:'0.1.0.0'};
        if(command==='nearcast_update_check')return {status:'available',currentVersion:'0.1.0.0',update};
        if(command==='nearcast_update_download')return {status:'ready',update};
        if(command==='nearcast_update_install')throw new Error('测试安装错误');
      },setTimer:callback=>{queueMicrotask(callback);return null;}});
  });
  await page.waitForFunction(()=>document.querySelector('#update-button').textContent==='更新已就绪');
  assert.equal(await page.locator('#settings-update-version').textContent(),'0.2.0.37');
  assert.match(await page.locator('#settings-update-notes').textContent(),/修复投屏和音频/);
  assert.equal(await page.locator('#update-dialog').evaluate(x=>x.open),true);
  assert.match(await page.locator('#update-detail').textContent(),/结束当前投屏/);
  await page.locator('#update-later').click();
  assert.equal(await page.locator('#update-dialog').evaluate(x=>x.open),false);
  await page.locator('#settings-open').click();await page.locator('[data-settings-tab=updates]').click();
  assert.equal(await page.locator('#settings-version').textContent(),'0.1.0.0');
  assert.match(await page.locator('#settings-update-status').textContent(),/0.2.0.37.*已下载/);
  if(process.env.NEARCAST_UI_ARTIFACTS){await mkdir(process.env.NEARCAST_UI_ARTIFACTS,{recursive:true});await page.screenshot({path:join(process.env.NEARCAST_UI_ARTIFACTS,'settings-updates.png')});}
  await page.locator('#settings-update-check').click();
  await page.locator('#update-button').click();
  assert.equal(await page.locator('#update-dialog').evaluate(x=>x.open),true);
  await page.locator('#update-install').click();
  await page.waitForFunction(()=>document.querySelector('#update-error').textContent==='测试安装错误');
  assert.equal(await page.locator('#code-view').evaluate(x=>x.inert),false);
  assert.equal(await page.locator('#settings-view').evaluate(x=>x.inert),false);
  assert.equal(await page.locator('#settings-update-error').textContent(),'测试安装错误');
  const calls=await page.evaluate(()=>window.updateCalls);
  assert.ok(calls.indexOf('cleanup')<calls.indexOf('nearcast_update_install'));
  await page.locator('#update-close').click();
  await page.evaluate(()=>updates.manager.apply({status:'downloading',error:null,prompt:true}));
  await page.evaluate(()=>updateProgress({payload:{total:1024,received:512}}));
  assert.equal(await page.locator('#update-progress').isVisible(),true);
  assert.equal(await page.locator('#update-progress').evaluate(node=>node.value/node.max),0.5);
  assert.equal(await page.locator('#update-install').isVisible(),false);
  if(process.env.NEARCAST_UI_ARTIFACTS)await page.screenshot({path:join(process.env.NEARCAST_UI_ARTIFACTS,'settings-update-download.png')});
  await page.locator('#update-close').click();
  assert.equal(await page.locator('#update-dialog').evaluate(node=>node.open),false);
  assert.equal(await page.evaluate(()=>updates.manager.state.status),'downloading','closing the modal must not pretend to cancel the native download');
  await page.evaluate(()=>updates.manager.apply({status:'current',update:null,error:null,prompt:true}));
  assert.match(await page.locator('#update-detail').textContent(),/最新版本/,'a no-update dialog must explain the result');
  assert.equal(await page.locator('#settings-update-target').isVisible(),false);
  assert.equal(await page.locator('#settings-update-release').isVisible(),false);
  await page.locator('#update-close').click();
  assert.deepEqual(errors,[]);
  await page.evaluate(()=>window.updates.stop());
  console.log('PASS: startup modal, background download, later, reopen, cleanup and install error UI');
}finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
