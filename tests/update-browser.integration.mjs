import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {resolve,sep} from 'node:path';
const require=createRequire(import.meta.url);
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const root=resolve('dist');
const server=createServer(async(req,res)=>{
  try{
    const path=resolve(root,'.'+new URL(req.url,'http://localhost').pathname);
    if(!path.startsWith(root+sep)){res.writeHead(403).end();return;}
    res.setHeader('content-type',path.endsWith('.mjs')?'text/javascript':path.endsWith('.css')?'text/css':'text/html');
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
  await page.evaluate(async()=>{
    const {mountUpdates}=await import('/update/update-ui.mjs');
    const update={version:'0.2.0.37',notes:'修复投屏和音频\\n后台更新测试',size:1024};
    window.updateCalls=[];
    window.updates=mountUpdates({document,listen:async()=>()=>{},isSharing:()=>true,
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
  assert.equal(await page.locator('#update-dialog').evaluate(x=>x.open),true);
  assert.match(await page.locator('#update-detail').textContent(),/结束当前投屏/);
  await page.locator('#update-later').click();
  assert.equal(await page.locator('#update-dialog').evaluate(x=>x.open),false);
  await page.evaluate(()=>{document.querySelector('#code-view').hidden=true;document.querySelector('#settings-view').hidden=false;document.querySelector('#settings-general').hidden=true;document.querySelector('#settings-updates').hidden=false;});
  assert.equal(await page.locator('#settings-version').textContent(),'0.1.0.0');
  assert.match(await page.locator('#settings-update-status').textContent(),/0.2.0.37.*已下载/);
  await page.locator('#settings-update-check').click();
  assert.equal(await page.locator('#update-dialog').evaluate(x=>x.open),true);
  await page.locator('#update-install').click();
  await page.waitForFunction(()=>document.querySelector('#update-error').textContent==='测试安装错误');
  assert.equal(await page.locator('#code-view').evaluate(x=>x.inert),false);
  assert.equal(await page.locator('#settings-view').evaluate(x=>x.inert),false);
  assert.equal(await page.locator('#settings-update-error').textContent(),'测试安装错误');
  const calls=await page.evaluate(()=>window.updateCalls);
  assert.ok(calls.indexOf('cleanup')<calls.indexOf('nearcast_update_install'));
  assert.deepEqual(errors,[]);
  await page.evaluate(()=>window.updates.stop());
  console.log('PASS: startup modal, background download, later, reopen, cleanup and install error UI');
}finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
