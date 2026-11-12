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
    const {mountSettings,mountFeedback,savePreferences,loadPreferences}=await import('/settings.mjs');
    globalThis.testSettings={connected:false,calls:[],fail:false};
    const state=testSettings;
    globalThis.settings=mountSettings({document,isConnected:()=>state.connected});
    mountFeedback({document,invoke:async(command,data)=>{state.calls.push({command,data});if(state.fail)throw Error('HTTP 503');await new Promise(resolve=>setTimeout(resolve,80));return{status:'submitted',id:99};}});
    savePreferences({...loadPreferences(),video:{resolution:'1280x720',bitrateMode:'dynamic',bitrateKbps:4000}});
  });
  await page.locator('#settings-open').click();
  assert.equal(await page.locator('#settings-general').isVisible(),true);
  assert.equal(await page.locator('#code-view').isVisible(),false);
  await page.locator('[data-settings-tab=feedback]').click();
  await page.locator('#feedback-email').fill('test@example.com');await page.locator('#feedback-message').fill('Synthetic feedback fixture');
  await page.locator('#feedback-submit').click();assert.equal(await page.evaluate(()=>testSettings.calls.length),0);
  await page.locator('#feedback-consent').check();await page.locator('#feedback-submit').click();
  await page.waitForFunction(()=>document.querySelector('#feedback-status').textContent.includes('99'));
  assert.deepEqual(await page.evaluate(()=>testSettings.calls[0]),{command:'nearcast_feedback_submit',data:{email:'test@example.com',message:'Synthetic feedback fixture',consent:true}});
  assert.equal(await page.locator('#feedback-consent').isChecked(),false);
  await page.evaluate(()=>testSettings.fail=true);await page.locator('#feedback-consent').check();await page.locator('#feedback-submit').click();
  await page.waitForFunction(()=>document.querySelector('#feedback-status').textContent.includes('503'));
  assert.equal(await page.locator('#feedback-message').inputValue(),'Synthetic feedback fixture');
  await page.locator('#settings-close').click();assert.equal(await page.locator('#code-view').isVisible(),true);
  await page.evaluate(()=>{testSettings.connected=true;settings.render();});
  await page.locator('#settings-open').click();await page.locator('#settings-close').click();
  assert.equal(await page.locator('#casting-view').isVisible(),true);
  assert.equal(await page.locator('#code-view').isVisible(),false);
  assert.equal(await page.evaluate(async()=>(await import('/settings.mjs')).loadPreferences().video.bitrateKbps),4000);
  await page.reload();
  assert.equal(await page.evaluate(async()=>(await import('/settings.mjs')).loadPreferences().video.resolution),'1280x720');
  assert.deepEqual(errors,[]);
  console.log('PASS: separate settings navigation, persistence, Feedback consent, confirmed submission and retry');
}finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
