// Language changes must update live UI without navigation, losing a code, or
// changing saved signaling preferences. Long translations must remain usable.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {createServer} from 'node:http';
import {readFile,mkdir} from 'node:fs/promises';
import {resolve,sep,extname,join} from 'node:path';
const require=createRequire(import.meta.url);
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const root=resolve('dist'),types={'.mjs':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.png':'image/png'};
const server=createServer(async(req,res)=>{try{const file=resolve(root,'.'+new URL(req.url,'http://localhost').pathname);if(!file.startsWith(root+sep)){res.writeHead(403).end();return;}res.setHeader('content-type',types[extname(file)]||'text/html');res.end(await readFile(file));}catch{res.writeHead(404).end();}});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const browser=await chromium.launch({channel:process.env.BROWSER_CHANNEL||'msedge',headless:true});
try{
  if(process.env.NEARCAST_UI_ARTIFACTS)await mkdir(process.env.NEARCAST_UI_ARTIFACTS,{recursive:true});
  for(const [locale,want]of [['zh-CN','zh-CN'],['ja-JP','ja'],['de-DE','de'],['en-US','en']]){
    const context=await browser.newContext({locale,viewport:{width:946,height:692}}),page=await context.newPage(),errors=[];
    page.on('pageerror',error=>errors.push(error.message));
    await page.addInitScript(()=>{
      globalThis.fixture={listeners:{}};
      if(!localStorage.getItem('nearhub-cast-settings-v1'))localStorage.setItem('nearhub-cast-settings-v1',JSON.stringify({policy:{touch:'mouse-gestures',mouse:'disabled'}}));
      globalThis.__TAURI__={core:{invoke:async command=>command==='nearcast_platform_info'?{os:'windows',screenCapture:true,systemAudio:true}:command==='nearcast_input_probe'?{inputTypes:['touch','mouse'],touch:{maxContacts:10},mouse:{buttonsMask:7,modifierMask:15,wheelUnits:['detent120','regionQ16_16'],continuousScroll:true}}:command==='nearcast_window_action'?{maximized:false,x:0,y:0,scaleFactor:1}:command.startsWith('nearcast_update_')?{status:'current',currentVersion:'0.2.0.19'}:null},event:{listen:async(name,callback)=>{fixture.listeners[name]=callback;return()=>{};}}};
    });
    const open=async()=>{await page.goto('http://127.0.0.1:'+server.address().port+'/index.html');await page.waitForFunction(()=>fixture.listeners['nearcast://mdns-snapshot']);};
    await open();
    assert.equal(await page.locator('html').getAttribute('lang'),want,'system language is selected on startup');
    await page.evaluate(()=>fixture.listeners['nearcast://mdns-snapshot']({payload:{service_type:'_nearcast._tcp.local.',lease_ms:45000,services:[{serviceType:'_nearcast._tcp.local.',instance:'Display-only',hostname:'room.local',port:8443,addresses:['192.0.2.1'],txt:{id:'room-1',display:'会議室 München',capability:''}}]}}));
    assert.equal(await page.locator('.device-name').innerText(),'会議室 München','receiver names are never translated');
    await page.locator('#settings-open').click();await page.locator('[data-settings-tab=general]').click();
    assert.equal(await page.locator('#language-select').inputValue(),'system');
    assert.equal(await page.locator('.input-mapping').isVisible(),false);
    await page.waitForFunction(()=>document.querySelector('#input-touch-output').value==='native'&&document.querySelector('#input-mouse-output').value==='native');
    assert.equal(await page.locator('#export-diagnostics').count(),0);
    await page.locator('#local-signaling-enabled').uncheck();
    assert.deepEqual(await page.evaluate(()=>JSON.parse(localStorage.getItem('nearhub-cast-settings-v1')).policy),{touch:'native',mouse:'native'},'hidden conversions use the default policy even after upgrading with a saved custom policy');
    await page.locator('#settings-close').click();
    await page.locator('.code-digit').first().focus();await page.keyboard.type('AB7Z');
    await page.locator('#settings-shortcut').click();
    for(const [language,title,general]of [['zh','投屏设置','通用'],['en','Cast Settings','General'],['ja','画面共有の設定','一般'],['de','Übertragungseinstellungen','Allgemein']]){
      await page.locator('#language-select').selectOption(language);
      const {messages}=await import('../src/i18n.mjs');
      assert.ok((await page.locator('.device-row').getAttribute('title')).endsWith(messages[language]['discovery.displayOnly']),'a discovered device tooltip changes language without rescanning');
      assert.equal(await page.locator('#settings-title').innerText(),title);
      assert.equal(await page.locator('[data-settings-tab=general]').innerText(),general);
      for(const id of ['window-minimize','window-close'])assert.equal(await page.locator('#'+id).getAttribute('title'),await page.locator('#'+id).getAttribute('aria-label'),'native window tooltips follow the selected language');
      assert.equal(await page.locator('#settings-general').isVisible(),true);
      if(process.env.NEARCAST_UI_ARTIFACTS)await page.screenshot({path:join(process.env.NEARCAST_UI_ARTIFACTS,'general-'+language+'.png')});
      await page.locator('[data-settings-tab=feedback]').click();
      assert.equal(await page.locator('#feedback-consent').isChecked(),true);
      assert.equal(await page.locator('#feedback-message').getAttribute('placeholder')!== 'Describe the issue and how to reproduce it',language!=='en');
      if(language==='zh')assert.equal(await page.locator('.feedback-consent span').innerText(),'同意上传问题描述及诊断包至NearHub。日志不含配对码、音视频或设备信息密钥。');
      if(process.env.NEARCAST_UI_ARTIFACTS)await page.screenshot({path:join(process.env.NEARCAST_UI_ARTIFACTS,'feedback-'+language+'.png')});
      await page.locator('[data-settings-tab=updates]').click();
      await page.waitForFunction(()=>document.querySelector('#app-version').textContent);
      assert.ok(!(await page.locator('#settings-update-check').innerText()).includes('update.'));
      await page.locator('[data-settings-tab=permissions]').click();
      if(process.env.NEARCAST_UI_ARTIFACTS){await mkdir(process.env.NEARCAST_UI_ARTIFACTS,{recursive:true});await page.screenshot({path:join(process.env.NEARCAST_UI_ARTIFACTS,'permissions-'+language+'.png')});}
      await page.locator('[data-settings-tab=general]').click();
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    }
    await page.locator('#settings-close').click();
    assert.deepEqual(await page.locator('.code-digit').evaluateAll(inputs=>inputs.map(input=>input.value)),['A','B','7','Z']);
    await page.locator('#return-to-devices').click();await page.reload();
    await page.waitForFunction(()=>fixture.listeners['nearcast://mdns-snapshot']);
    assert.equal(await page.locator('html').getAttribute('lang'),'de','explicit language survives a restart');
    assert.equal(await page.locator('#connect-panel-devices').isVisible(),true,'cloud preference cannot skip startup discovery');
    await page.locator('#settings-open').click();await page.locator('[data-settings-tab=general]').click();
    assert.equal(await page.locator('#local-signaling-enabled').isChecked(),false);
    await page.locator('#language-select').selectOption('system');
    assert.equal(await page.locator('html').getAttribute('lang'),want,'switching back follows the system locale again');
    await page.evaluate(()=>{Object.defineProperty(navigator,'languages',{configurable:true,value:['ja-JP']});window.dispatchEvent(new Event('languagechange'));});
    assert.equal(await page.locator('html').getAttribute('lang'),'ja','system language changes apply without restarting');
    await page.locator('#language-select').selectOption('de');
    await page.evaluate(()=>{Object.defineProperty(navigator,'languages',{configurable:true,value:['en-US']});window.dispatchEvent(new Event('languagechange'));});
    assert.equal(await page.locator('html').getAttribute('lang'),'de','a manual language choice survives system language changes');
    await page.setViewportSize({width:360,height:480});
    for(const tab of ['general','permissions','updates','feedback']){
      await page.locator('[data-settings-tab='+tab+']').click();
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'German settings never overflow the window');
    }
    assert.deepEqual(errors,[]);await context.close();
  }
  console.log('PASS: four system locales, live switching, persistence, preserved pairing/signaling, simplified settings and long German layout');
}finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
