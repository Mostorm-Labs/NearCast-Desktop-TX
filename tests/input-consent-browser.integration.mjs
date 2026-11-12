import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {resolve,sep} from 'node:path';
const require=createRequire(import.meta.url),{chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright'),root=resolve('dist');
const server=createServer(async(req,res)=>{try{const path=resolve(root,'.'+new URL(req.url,'http://localhost').pathname);if(!path.startsWith(root+sep)){res.writeHead(403).end();return;}res.setHeader('content-type','text/javascript');res.end(await readFile(path));}catch{res.writeHead(404).end();}});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const browser=await chromium.launch({channel:'msedge',headless:true});
try{
  const page=await browser.newPage();await page.goto('http://127.0.0.1:'+server.address().port+'/touchback/consent-ui.mjs');
  await page.evaluate(async()=>{document.body.textContent='';const {showInputConsent}=await import('/touchback/consent-ui.mjs');globalThis.promptInput=showInputConsent;globalThis.open=()=>{globalThis.abort=new AbortController();globalThis.result=null;showInputConsent({signal:abort.signal}).then(value=>globalThis.result=value);};open();});
  await page.getByRole('button',{name:'允许反控',exact:true}).click();await page.waitForFunction(()=>result===true);assert.equal(await page.locator('dialog').count(),0);
  await page.evaluate(()=>open());await page.getByRole('button',{name:'拒绝',exact:true}).click();await page.waitForFunction(()=>result===false);
  await page.evaluate(()=>open());await page.evaluate(()=>abort.abort());await page.waitForFunction(()=>result===false);assert.equal(await page.locator('dialog').count(),0);
  console.log('PASS: sender consent dialog accepts, rejects and closes on cancellation in actual browser DOM');
}finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
