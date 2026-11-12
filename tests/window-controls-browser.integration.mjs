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
    res.end((await readFile(path,'utf8')).replace('<script type="module" src="./app.mjs"></script>',''));
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
    const {mountWindowControls}=await import('/window-controls.mjs');
    window.controlTest={calls:[],failClose:true,cleanup:0};
    let position={x:-1920,y:100,scaleFactor:1.5,maximized:false};
    mountWindowControls({document,invoke:async(command,{action})=>{
      controlTest.calls.push({command,action});
      if(action.kind==='move'){await new Promise(resolve=>setTimeout(resolve,30));position={...position,x:action.x,y:action.y};}
      if(action.kind==='toggleMaximize')position.maximized=!position.maximized;
      return position;
    },beforeClose:async()=>{controlTest.cleanup++;if(controlTest.failClose)throw Error('cleanup pending');}});
  });
  assert.equal(await page.locator('#window-titlebar').isVisible(),true);
  await page.locator('#window-maximize').click();
  await page.waitForFunction(()=>document.querySelector('#window-maximize').getAttribute('aria-label')==='还原窗口');
  await page.locator('#window-maximize').click();
  await page.waitForFunction(()=>document.querySelector('#window-maximize').getAttribute('aria-label')==='最大化窗口');
  await page.locator('#window-minimize').click();
  await page.waitForFunction(()=>controlTest.calls.some(c=>c.action.kind==='minimize'));
  await page.locator('#window-close').click();
  await page.waitForFunction(()=>document.querySelector('#window-error').textContent.includes('cleanup pending'));
  assert.equal(await page.evaluate(()=>controlTest.calls.some(c=>c.action.kind==='close')),false);
  assert.equal(await page.locator('#window-close').isEnabled(),true);
  // Actual browser pointer capture: high-frequency moves must end at the last
  // coordinate, with at most one IPC move outstanding, including negative X.
  await page.mouse.move(180,18);await page.mouse.down();await page.waitForTimeout(20);
  for(let x=190;x<=280;x+=10)await page.mouse.move(x,38);
  await page.mouse.up();await page.waitForTimeout(150);
  const moves=await page.evaluate(()=>controlTest.calls.filter(c=>c.action.kind==='move').map(c=>c.action));
  assert.ok(moves.length>0);assert.deepEqual(moves.at(-1),{kind:'move',x:-1770,y:130});
  await page.evaluate(()=>controlTest.failClose=false);await page.locator('#window-close').click();
  await page.waitForFunction(()=>controlTest.calls.some(c=>c.action.kind==='close'));
  assert.equal(await page.evaluate(()=>controlTest.cleanup),2);
  assert.deepEqual(errors,[]);
  console.log('PASS: custom titlebar maximize/restore, minimize, coalesced drag, negative DPI coordinates and close cleanup');
}finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
