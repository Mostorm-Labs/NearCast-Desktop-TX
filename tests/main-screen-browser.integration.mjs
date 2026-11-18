// Catches navigation/selection lost by the device-first layout, disconnected
// settings entry points, and controls clipped by long discovery results.
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
const browser=await chromium.launch({channel:'msedge',headless:true});
try{
  const page=await browser.newPage({viewport:{width:960,height:627},locale:'zh-CN'}),errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.addInitScript(()=>{
    globalThis.fixture={calls:[],listeners:{}};
    globalThis.__TAURI__={core:{invoke:async(command,args)=>{
      fixture.calls.push({command,args});
      if(command==='nearcast_platform_info')return{os:'windows',screenCapture:true,captureBackend:'browser',systemAudio:true,touchback:false};
      if(command==='nearcast_window_action')return{maximized:false,x:0,y:0,scaleFactor:1};
      if(command==='nearcast_update_initialize'||command==='nearcast_update_check')return{status:'current',currentVersion:'0.2.0.11',channel:'alpha'};
      if(command==='nearcast_trust_pair')return{trusted:true,deviceId:args.deviceId,fingerprint:'A'.repeat(64)};
      if(command==='nearcast_code_display')return{type:'nearcast.code_display.result',version:args.request.version,requestId:args.request.requestId,deviceId:args.request.deviceId,backend:args.request.backend,runtimeInstanceId:args.request.runtimeInstanceId,status:'shown'};
      return null;
    }},event:{listen:async(name,callback)=>{fixture.listeners[name]=callback;return()=>delete fixture.listeners[name];}}};
  });
  await page.goto('http://127.0.0.1:'+server.address().port+'/index.html');
  await page.waitForFunction(()=>fixture.listeners['nearcast://mdns-snapshot']&&!document.querySelector('#refresh-devices').disabled);
  const publish=async(count=4)=>page.evaluate(count=>fixture.listeners['nearcast://mdns-snapshot']({payload:{
    service_type:'_nearcast._tcp.local.',lease_ms:45000,services:Array.from({length:count},(_,index)=>({
      serviceType:'_nearcast._tcp.local.',instance:'Room'+index,hostname:'room'+index+'.local',port:8443,addresses:['192.0.2.'+(index+1)],
      txt:{id:'room-'+index,display:'Meeting Room '+(index+1),capability:'webcast,code-display-v1,code-display-v2,signaling-select-v1',runtime:'runtime-room-'+index,'local-state':'ready','cloud-state':'ready'},
    })),
  }}),count);
  await publish();
  await page.waitForFunction(()=>document.querySelector('#app-version').textContent);
  assert.equal(await page.locator('#connect-panel-devices').isVisible(),true);
  assert.equal(await page.locator('#connect-panel-code').isVisible(),false);
  assert.equal(await page.locator('.device-row').count(),4);
  assert.match(await page.locator('#device-status').innerText(),/4/);
  const fourRowHeight=(await page.locator('#device-groups').boundingBox()).height;
  for(const count of [0,1,4,18]){
    await publish(count);
    assert.equal((await page.locator('#device-groups').boundingBox()).height,fourRowHeight,'discovery keeps four rows of space regardless of the number of devices');
  }
  await publish();
  const settingsBox=await page.locator('#settings-open').boundingBox(),rows=await page.locator('.device-row').all();
  assert.ok(settingsBox.y>(await rows.at(-1).boundingBox()).y,'Casting Settings follows the device list');
  const assets=await page.locator('img[src*="assets/figma/"]:visible').evaluateAll(images=>images.map(image=>({file:image.getAttribute('src'),width:image.getBoundingClientRect().width,height:image.getBoundingClientRect().height,loaded:image.complete&&image.naturalWidth>0})));
  assert.ok(assets.length>=11,'brand, display rows, chevrons, divider and settings use local Figma assets');
  assert.ok(assets.every(asset=>asset.loaded&&asset.width>0&&asset.height>0));
  assert.equal(await page.locator('img.device-icon').first().evaluate(image=>image.getBoundingClientRect().width),28);
  await page.keyboard.press('Tab');
  await page.locator('#connect-tab-code').focus();
  assert.equal(await page.locator('#connect-tab-code').evaluate(button=>button.tabIndex),0,'direct pairing remains keyboard reachable');
  await page.keyboard.press('Enter');
  assert.equal(await page.locator('#connect-panel-code').isVisible(),true);
  const returnToDevices=page.locator('#return-to-devices');
  assert.equal(await returnToDevices.isVisible(),true,'manual pairing offers the reciprocal device-list action');
  const card=await page.locator('.discovery-card').boundingBox();
  assert.ok((await returnToDevices.boundingBox()).y>=card.y+card.height,'the return action sits beneath the pairing card');
  assert.equal(await page.locator('.pairing-illustration').evaluate(image=>image.complete&&image.naturalWidth>0&&image.getBoundingClientRect().width===142&&image.getBoundingClientRect().height===95),true);
  await page.locator('.code-digit').first().focus();await page.keyboard.type('aB');
  if(process.env.NEARCAST_UI_ARTIFACTS)await page.screenshot({path:join(process.env.NEARCAST_UI_ARTIFACTS,'pairing-code-960.png')});
  await returnToDevices.focus();await page.keyboard.press('Enter');
  assert.equal(await page.locator('#connect-panel-devices').isVisible(),true);
  assert.equal(await page.locator('#refresh-devices').evaluate(button=>button===document.activeElement),true);
  await page.locator('.device-row').nth(1).hover();
  await page.waitForTimeout(180); // Let the focus/hover transition settle for visual review.
  if(process.env.NEARCAST_UI_ARTIFACTS){await mkdir(process.env.NEARCAST_UI_ARTIFACTS,{recursive:true});await page.screenshot({path:join(process.env.NEARCAST_UI_ARTIFACTS,'main-screen-960.png')});}
  await page.locator('.device-row').nth(1).click();
  assert.equal(await page.locator('#connect-panel-code').isVisible(),true);
  assert.equal(await page.locator('#pair-device-name').innerText(),'Meeting Room 2');
  assert.equal(await page.locator('.pair-target button').count(),0,'the header only identifies the selected device');
  await page.waitForFunction(()=>document.querySelector('#code-display-status').textContent.includes('配对码已'));
  assert.equal(await page.locator('#trust-card').isVisible(),false,'automatic pairing has no fingerprint confirmation card');
  assert.deepEqual(await page.evaluate(()=>fixture.calls.filter(call=>['nearcast_trust_pair','nearcast_code_display'].includes(call.command)).map(call=>call.command)),['nearcast_trust_pair','nearcast_code_display']);
  assert.equal(await page.evaluate(()=>fixture.calls.find(call=>call.command==='nearcast_code_display').args.request.backend),'local');
  if(process.env.NEARCAST_UI_ARTIFACTS)await page.screenshot({path:join(process.env.NEARCAST_UI_ARTIFACTS,'pairing-automatic-device.png')});
  await page.keyboard.type('aB7z');
  assert.deepEqual(await page.locator('.code-digit').evaluateAll(inputs=>inputs.map(input=>input.value)),['A','B','7','Z']);
  await page.locator('#settings-shortcut').click();
  assert.equal(await page.locator('#settings-view').isVisible(),true);
  await page.locator('#settings-close').click();
  assert.equal(await page.locator('#connect-panel-code').isVisible(),true);
  assert.deepEqual(await page.locator('.code-digit').evaluateAll(inputs=>inputs.map(input=>input.value)),['A','B','7','Z']);
  assert.equal(await returnToDevices.isVisible(),true,'selected-device pairing exposes the same return action');
  await returnToDevices.click();
  await page.locator('#settings-open').click();await page.locator('#settings-close').click();
  assert.equal(await page.locator('#connect-panel-devices').isVisible(),true);
  await page.locator('#connect-tab-code').click();
  assert.equal(await page.locator('#pair-device-name').isVisible(),false);
  assert.deepEqual(await page.locator('.code-digit').evaluateAll(inputs=>inputs.map(input=>input.value)),['','','','']);
  await page.locator('#connect-tab-devices').click();await publish(0);
  assert.equal(await page.locator('.device-row').count(),0);
  assert.equal(await page.locator('#settings-open').isEnabled(),true);
  await page.locator('#refresh-devices').click();await publish(18);
  assert.equal((await page.locator('#device-groups').boundingBox()).height,fourRowHeight);
  assert.equal(await page.locator('#device-groups').evaluate(node=>node.scrollHeight>node.clientHeight),true,'extra devices scroll within the fixed viewport');
  await page.setViewportSize({width:640,height:480});
  assert.equal((await page.locator('#device-groups').boundingBox()).height,fourRowHeight,'small windows retain the four-row viewport');
  await page.locator('.device-row').last().scrollIntoViewIfNeeded();
  assert.equal(await page.locator('.device-row').last().isVisible(),true);
  await page.locator('#settings-open').click();await page.locator('#settings-close').click();
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'narrow windows do not clip controls horizontally');
  await page.locator('#connect-tab-code').click();
  await returnToDevices.scrollIntoViewIfNeeded();
  assert.equal(await returnToDevices.isVisible(),true,'the return action stays reachable in a short window');
  await returnToDevices.click();
  await page.setViewportSize({width:960,height:627});await publish();
  await page.evaluate(()=>fixture.listeners['nearcast://mdns-service']({payload:{serviceType:'_nearcast._tcp.local.',instance:'Display-only',hostname:'display-only.local',port:8443,txt:{id:'display-only',display:'Display only'}}}));
  assert.equal(await page.getByRole('button',{name:'Display only',exact:true}).isDisabled(),true);
  await page.locator('#settings-open').click();
  await page.locator('[data-settings-tab=general]').click();
  await page.locator('#local-signaling-enabled').uncheck();
  await page.locator('#settings-close').click();
  assert.equal(await page.locator('#connect-panel-code').isVisible(),true,'cloud preference retains direct-code entry');
  await page.reload();
  await page.waitForFunction(()=>fixture.listeners['nearcast://mdns-snapshot']);
  assert.equal(await page.locator('#connect-panel-devices').isVisible(),true,'every startup shows devices even with a saved cloud preference');
  assert.equal(await page.locator('#local-signaling-enabled').isChecked(),false,'startup does not change the saved connection backend');
  // The real connected/share settings shortcut is exercised with a live
  // RTCPeerConnection in webcast-browser.integration.mjs.
  assert.deepEqual(errors,[]);
  console.log('PASS: fixed four-row discovery for 0/1/4/18 devices, scroll overflow, Figma assets, pairing and settings return, scan and narrow windows');
}finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
