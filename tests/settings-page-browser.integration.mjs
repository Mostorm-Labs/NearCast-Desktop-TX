// Exercises the complete Settings UI: platform facts must not become fake
// permissions, and reorganizing controls must keep their persisted behavior.
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
  for(const os of ['windows','macos']){
    const context=await browser.newContext({viewport:{width:960,height:627},locale:'zh-CN'});
    const page=await context.newPage(),errors=[];
    page.on('pageerror',error=>errors.push(error.message));
    await page.addInitScript(os=>{
      // Completed setup still reopens when required permissions are missing.
      if(os==='macos')localStorage.setItem('nearhub-cast-macos-permissions-onboarding-v1','completed');
      globalThis.fixture={calls:[],listeners:{},permissions:{localNetwork:'unknown',screenRecording:'not_granted',accessibility:'granted'}};
      globalThis.__TAURI__={core:{invoke:async(command,args)=>{
        fixture.calls.push({command,args});
        if(command==='nearcast_platform_info')return{os,screenCapture:true,captureBackend:'browser',systemAudio:true,touchback:false};
        if(command==='nearcast_window_action')return{maximized:false,x:0,y:0,scaleFactor:1};
        if(command==='nearcast_macos_permissions')return{...fixture.permissions};
        if(command==='nearcast_macos_permission_settings')return null;
        if(command==='nearcast_update_initialize'||command==='nearcast_update_check')return{status:'current',currentVersion:'0.2.0.12',channel:'alpha'};
        return null;
      }},event:{listen:async(name,callback)=>{fixture.listeners[name]=callback;return()=>delete fixture.listeners[name];}}};
    },os);
    await page.goto('http://127.0.0.1:'+server.address().port+'/index.html');
    await page.waitForFunction(()=>document.querySelector('#permission-rows').children.length>0);
    if(os==='macos')await page.locator('#onboarding-not-now').click();
    await page.locator('#settings-open').click();
    assert.equal(await page.locator('#settings-permissions').isVisible(),true);
    for(const height of [780,627]){
      await page.setViewportSize({width:960,height});
      const position=await page.locator('#settings-view').evaluate(node=>{
        const rect=node.getBoundingClientRect(),main=node.parentElement,box=main.getBoundingClientRect(),style=getComputedStyle(main);
        return{center:rect.top+rect.height/2,contentCenter:(box.top+parseFloat(style.paddingTop)+box.bottom-parseFloat(style.paddingBottom))/2,top:rect.top,bottom:rect.bottom};
      });
      assert.ok(Math.abs(position.center-position.contentCenter)<2,'Settings stays centered below the title bar: '+JSON.stringify(position));
      assert.ok(position.top>=52&&position.bottom<=height-12,'Settings stays inside the usable window');
    }
    await page.setViewportSize({width:960,height:780});
    if(os==='windows'){
      assert.equal(await page.locator('#permission-rows [role=switch]').count(),0,'Windows must not claim macOS authorization');
      assert.match(await page.locator('#permission-status-screenRecording').textContent(),/选择时授权/);
    }else{
      assert.equal(await page.locator('[data-permission=localNetwork]').getAttribute('aria-checked'),null,'network unknown is not authorization');
      assert.equal(await page.locator('[data-permission=screenRecording]').getAttribute('aria-checked'),'false');
      await page.locator('[data-permission=screenRecording]').click();
      assert.equal(await page.locator('[data-permission=screenRecording]').getAttribute('aria-checked'),'false','opening settings alone does not grant permission');
      assert.deepEqual(await page.evaluate(()=>fixture.calls.find(call=>call.command==='nearcast_macos_permission_settings').args),{permission:'screenRecording'});
      await page.evaluate(()=>{fixture.permissions={localNetwork:'available',screenRecording:'granted',accessibility:'granted'};window.dispatchEvent(new Event('focus'));});
      await page.waitForFunction(()=>document.querySelector('[data-permission=screenRecording]').getAttribute('aria-checked')==='true');
    }
    const assets=await page.locator('#settings-view img:visible').evaluateAll(images=>images.map(image=>({file:image.getAttribute('src'),loaded:image.complete&&image.naturalWidth>0,width:image.getBoundingClientRect().width,height:image.getBoundingClientRect().height})));
    assert.ok(assets.length>=6&&assets.every(asset=>asset.loaded&&asset.width>0&&asset.height>0),JSON.stringify(assets));
    if(process.env.NEARCAST_UI_ARTIFACTS){await mkdir(process.env.NEARCAST_UI_ARTIFACTS,{recursive:true});await page.screenshot({path:join(process.env.NEARCAST_UI_ARTIFACTS,'settings-permissions-'+os+'.png')});}
    await page.locator('[data-settings-tab=general]').click();
    const quality=page.locator('.video-quality');
    const clickTitle=async count=>{for(let index=0;index<count;index++)await page.locator('#settings-title').click();};
    assert.equal(await quality.isVisible(),false,'advanced video controls start hidden');
    assert.equal(await page.locator('#video-resolution').inputValue(),'1920x1080');
    assert.equal(await page.locator('#video-bitrate-mode').inputValue(),'dynamic');
    assert.equal(await page.locator('#video-bitrate').inputValue(),'8000');
    await clickTitle(7);assert.equal(await quality.isVisible(),false,'seven title clicks cannot reveal advanced controls');
    await clickTitle(1);assert.equal(await quality.isVisible(),true,'the eighth title click reveals existing controls');
    await clickTitle(7);assert.equal(await quality.isVisible(),true,'seven more clicks do not hide controls');
    await clickTitle(1);assert.equal(await quality.isVisible(),false,'eight more clicks hide controls');
    if(process.env.NEARCAST_UI_ARTIFACTS){await page.screenshot({path:join(process.env.NEARCAST_UI_ARTIFACTS,'settings-general-default-'+os+'.png')});}
    await clickTitle(8);
    await page.locator('#video-resolution').selectOption('2560x1440');
    await page.locator('#video-bitrate-mode').selectOption('fixed');
    await page.locator('#video-bitrate').selectOption('20000');
    await page.locator('#system-audio-enabled').uncheck();
    await page.locator('#local-signaling-enabled').uncheck();
    await page.locator('#input-enabled').check();
    const saved=await page.evaluate(()=>JSON.parse(localStorage.getItem('nearhub-cast-settings-v1')));
    assert.deepEqual(saved.video,{resolution:'2560x1440',bitrateMode:'fixed',bitrateKbps:20000});
    assert.equal(saved.systemAudio,false);assert.equal(saved.localSignaling,false);assert.equal(saved.inputEnabled,true);
    await clickTitle(8);assert.equal(await quality.isVisible(),false);
    assert.deepEqual(await page.evaluate(()=>JSON.parse(localStorage.getItem('nearhub-cast-settings-v1'))),saved,'hiding advanced controls cannot change saved settings');
    await clickTitle(8);
    assert.equal(await page.locator('.input-mapping').isVisible(),false,'input conversion is hidden while the default policy still applies');
    assert.equal(await page.locator('#export-diagnostics').count(),0,'the diagnostic export row and action are removed');
    await page.locator('#settings-close').click();
    assert.equal(await page.locator('#connect-panel-code').isVisible(),true);
    await page.reload();await page.waitForFunction(()=>document.querySelector('#permission-rows').children.length>0);
    if(os==='macos')await page.locator('#onboarding-not-now').click();
    assert.equal(await page.locator('#connect-panel-devices').isVisible(),true);
    await page.locator('#settings-open').click();await page.locator('[data-settings-tab=general]').click();
    assert.equal(await quality.isVisible(),false,'reloading always hides advanced controls');
    await clickTitle(7);assert.equal(await quality.isVisible(),false,'the reveal click count starts over after reload');
    await clickTitle(1);assert.equal(await quality.isVisible(),true);
    assert.equal(await page.locator('#video-resolution').inputValue(),'2560x1440');
    assert.equal(await page.locator('#video-bitrate-mode').inputValue(),'fixed');
    assert.equal(await page.locator('#video-bitrate').inputValue(),'20000','saved advanced video values survive while controls start hidden');
    assert.equal(await page.locator('#local-signaling-enabled').isChecked(),false);
    assert.equal(await page.locator('#system-audio-enabled').isChecked(),false);
    assert.equal(await page.locator('#input-enabled').isChecked(),true);
    await page.locator('#video-resolution').selectOption('1920x1080');
    await page.locator('#video-bitrate-mode').selectOption('dynamic');await page.locator('#video-bitrate').selectOption('8000');
    if(process.env.NEARCAST_UI_ARTIFACTS)await page.screenshot({path:join(process.env.NEARCAST_UI_ARTIFACTS,'settings-general-'+os+'.png')});
    await page.locator('[data-settings-tab=feedback]').click();
    assert.equal(await page.locator('#feedback-consent').isChecked(),true,'feedback consent starts checked');
    await page.locator('#feedback-email').fill('');await page.locator('#feedback-email').focus();
    if(process.env.NEARCAST_UI_ARTIFACTS)await page.screenshot({path:join(process.env.NEARCAST_UI_ARTIFACTS,'settings-feedback-'+os+'.png')});
    await page.setViewportSize({width:360,height:480});
    for(const tab of ['permissions','general','updates','feedback']){
      await page.locator('[data-settings-tab='+tab+']').click();
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'small-window Settings must not overflow');
      const box=await page.locator('#settings-view').boundingBox();
      assert.ok(box.y>=52&&box.y+box.height<=480-12,'short-window Settings stays below the title bar with Back reachable');
    }
    await page.locator('#settings-close').click();
    assert.equal(await page.locator('#code-view').isVisible(),true);
    assert.deepEqual(errors,[]);
    await context.close();
  }
  console.log('PASS: eight-click video settings toggle, hidden after reload, persistent advanced values, Windows/macOS permissions and small-window Settings');
}finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
