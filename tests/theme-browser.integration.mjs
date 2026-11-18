// Exercise saved appearance, OS changes and the actual themed UI together.
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
const browser=await chromium.launch({channel:process.env.BROWSER_CHANNEL||'chrome',headless:true});
const errors=[];
const open=async({colorScheme='light',theme,os='windows',preloadOnly=false}={})=>{
  const context=await browser.newContext({viewport:{width:960,height:692},locale:'en-US',colorScheme});
  const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
  await page.addInitScript(({theme,os})=>{
    if(theme)localStorage.setItem('nearhub-cast-settings-v1',JSON.stringify({theme,systemAudio:true}));
    globalThis.fixture={calls:[],listeners:{}};
    globalThis.__TAURI__={core:{invoke:async(command,args)=>{
      fixture.calls.push({command,args});
      if(command==='nearcast_platform_info')return{os,screenCapture:true,captureBackend:'browser',systemAudio:true,touchback:false};
      if(command==='nearcast_macos_permissions')return{localNetwork:'available',screenRecording:'not_granted',accessibility:'not_granted'};
      if(command==='nearcast_window_action')return{maximized:false,x:0,y:0,scaleFactor:1};
      if(command.startsWith('nearcast_update_'))return{status:'current',currentVersion:'0.2.0.27'};
      return null;
    }},event:{listen:async(name,callback)=>{fixture.listeners[name]=callback;return()=>{};}}};
  },{theme,os});
  if(preloadOnly)await page.route('**/bootstrap.mjs',route=>route.abort());
  await page.goto('http://127.0.0.1:'+server.address().port+'/index.html');
  return{context,page};
};
const effective=page=>page.locator('html').getAttribute('data-theme');
const screenshot=async(page,name)=>{if(process.env.NEARCAST_UI_ARTIFACTS){await mkdir(process.env.NEARCAST_UI_ARTIFACTS,{recursive:true});await page.screenshot({path:join(process.env.NEARCAST_UI_ARTIFACTS,name+'.png')});}};
try{
  const {context,page}=await open();
  await page.locator('#settings-open').click();await page.locator('[data-settings-tab=general]').click();
  const select=page.locator('#theme-select');
  assert.equal(await select.count(),1,'General exposes a theme selector');
  assert.equal(await select.inputValue(),'system');
  assert.equal(await effective(page),'light','default appearance follows the OS');
  assert.equal(await page.locator('.topbar .logo').innerText(),'NearHub');
  assert.equal(await page.locator('body').evaluate(el=>getComputedStyle(el).backgroundColor),'rgb(255, 255, 255)','light mode uses a white page');
  await screenshot(page,'general-light');
  await select.selectOption('dark');
  assert.equal(await effective(page),'dark');
  await page.emulateMedia({colorScheme:'light'});
  assert.equal(await effective(page),'dark','an explicit theme ignores OS changes');
  await page.locator('#system-audio-enabled').uncheck();
  assert.equal(await page.evaluate(()=>JSON.parse(localStorage.getItem('nearhub-cast-settings-v1')).theme),'dark','unrelated settings saves retain appearance');
  await screenshot(page,'general-dark');
  await select.selectOption('light');
  await page.locator('#system-audio-enabled').check();
  const blue=await page.locator('#system-audio-enabled + .switch-images').evaluate(el=>getComputedStyle(el).backgroundColor);
  assert.equal(blue,'rgb(67, 155, 252)','enabled switches use the display icon blue');
  assert.equal(await page.evaluate(()=>getComputedStyle(document.documentElement).colorScheme),'light');
  await select.selectOption('system');
  await page.emulateMedia({colorScheme:'dark'});await page.waitForFunction(()=>document.documentElement.dataset.theme==='dark');
  await page.emulateMedia({colorScheme:'light'});await page.waitForFunction(()=>document.documentElement.dataset.theme==='light');
  assert.ok(await page.evaluate(()=>fixture.calls.some(call=>call.command==='nearcast_window_action'&&call.args?.action?.kind==='setTheme'&&call.args.action.theme==='system')),'native window appearance follows the selected preference');
  await select.selectOption('dark');
  await page.reload();await page.locator('#settings-open').click();await page.locator('[data-settings-tab=general]').click();
  assert.equal(await select.inputValue(),'dark');assert.equal(await effective(page),'dark','saved theme survives a restart');
  await select.selectOption('light');
  for(const tab of ['permissions','updates','feedback']){
    await page.locator('[data-settings-tab='+tab+']').click();await screenshot(page,tab+'-light');
  }
  await page.setViewportSize({width:360,height:480});
  await page.locator('[data-settings-tab=general]').click();await select.scrollIntoViewIfNeeded();
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'the appearance row fits a narrow window');
  await page.locator('#settings-close').click();await screenshot(page,'home-light-small');
  await context.close();

  const early=await open({theme:'dark',colorScheme:'light',preloadOnly:true});
  assert.equal(await effective(early.page),'dark','saved appearance is applied before the app module loads');
  await early.context.close();
  const mac=await open({theme:'light',os:'macos'});
  await mac.page.locator('#permission-onboarding').waitFor({state:'visible'});
  assert.equal(await effective(mac.page),'light');
  await screenshot(mac.page,'onboarding-light');await mac.context.close();
  assert.deepEqual(errors,[]);
  console.log('PASS: dark/light/system appearance, saved preference, OS changes, early paint, blue switches, NearHub branding, native window theme and light-mode pages');
}finally{await browser.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
