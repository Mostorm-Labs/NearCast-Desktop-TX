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
    const {mountPairingInput}=await import('/pairing-input.mjs');
    window.pairTest={changes:0};
    window.pair=mountPairingInput({inputs:[...document.querySelectorAll('.code-digit')],help:document.querySelector('#pair-input-help'),onChange:()=>pairTest.changes++});
  });
  const cells=page.locator('.code-digit');
  const values=()=>cells.evaluateAll(inputs=>inputs.map(input=>input.value));
  assert.deepEqual(await cells.evaluateAll(inputs=>inputs.map(input=>input.readOnly)),[true,true,true,true]);
  await cells.first().focus();await page.keyboard.type('aB7z');
  assert.deepEqual(await values(),['A','B','7','Z']);
  await cells.first().focus();await page.keyboard.type('q');
  assert.deepEqual(await values(),['Q','B','7','Z']);
  await page.evaluate(()=>pair.clear());await cells.first().focus();
  // Browser's actual composition entry must not insert a preedit buffer into
  // read-only code cells, even though maxlength does not limit native IME.
  const cdp=await page.context().newCDPSession(page);
  await cdp.send('Input.imeSetComposition',{text:'tttttttt',selectionStart:8,selectionEnd:8});
  assert.deepEqual(await values(),['','','','']);
  await cdp.send('Input.imeSetComposition',{text:'',selectionStart:0,selectionEnd:0});
  // Every composition phase must restore the last controlled character.
  await page.keyboard.type('a');await cells.first().focus();
  const phases=await cells.first().evaluate(input=>{
    const states=[];
    input.dispatchEvent(new CompositionEvent('compositionstart',{data:''}));states.push(input.value);
    for(const text of ['tt','tttttt','涛涛涛涛']){
      input.value=text;input.dispatchEvent(new InputEvent('input',{data:text,isComposing:true,inputType:'insertCompositionText'}));states.push(input.value);
      input.dispatchEvent(new CompositionEvent('compositionupdate',{data:text}));states.push(input.value);
    }
    input.dispatchEvent(new CompositionEvent('compositionend',{data:'涛'}));states.push(input.value);
    input.value='涛';input.dispatchEvent(new InputEvent('input',{data:'涛',inputType:'insertFromComposition'}));states.push(input.value);
    return states;
  });
  assert.ok(phases.every(value=>value==='A'));
  assert.equal(await cells.first().evaluate(input=>input===document.activeElement),true);
  await page.evaluate(()=>pair.clear());await cells.first().focus();
  await page.keyboard.type('!@#中文');assert.deepEqual(await values(),['','','','']);
  const paste=async(index,text)=>cells.nth(index).evaluate((input,text)=>{const clipboardData=new DataTransfer();clipboardData.setData('text/plain',text);input.dispatchEvent(new ClipboardEvent('paste',{clipboardData,bubbles:true,cancelable:true}));},text);
  await paste(0,'a1b2');assert.deepEqual(await values(),['A','1','B','2']);
  await paste(0,'abcde');assert.deepEqual(await values(),['A','1','B','2']);
  await paste(0,'你好');assert.deepEqual(await values(),['A','1','B','2']);
  await cells.nth(2).focus();await page.keyboard.press('Backspace');assert.deepEqual(await values(),['A','1','','2']);
  await page.keyboard.press('Backspace');assert.deepEqual(await values(),['A','','','2']);
  assert.equal(await cells.nth(1).evaluate(input=>input===document.activeElement),true);
  await page.keyboard.press('Home');await page.keyboard.press('Delete');assert.deepEqual(await values(),['','','','2']);
  await page.evaluate(()=>pair.clear());await cells.first().focus();await page.keyboard.type('n4p8');
  assert.deepEqual(await values(),['N','4','P','8']);
  assert.deepEqual(errors,[]);
  console.log('PASS: four controlled cells, uppercase single keys, real IME preedit blocked, composition invariant, paste, correction and clear');
}finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
