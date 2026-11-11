import test from 'node:test';
import assert from 'node:assert/strict';

const {TouchMouseGestures,normalizeGestureSettings}=await import('../src/touchback/touch-mouse-gestures.mjs');
const region={x:0,y:0,width:1001,height:1001};
const r=(id,phase,x=100,y=100)=>({contactId:id,phase,x,y});
const make=(settings={})=>new TouchMouseGestures({region,settings:{holdMs:300,rightClick:'two-finger',pinchAction:'browser-zoom',...settings}});

test('single touch taps click, early motion scrolls, and cancel never clicks',()=>{
  const g=make();g.accept([r(1,0)],0);assert.deepEqual(g.accept([r(1,2)],100).map(a=>[a.eventKind,a.buttons]),[[1,1],[1,0]]);
  g.accept([r(1,0)],200);
  const scroll=g.accept([r(1,1,100,80)],220);assert.equal(scroll[0].wheelPhase,1);assert.ok(scroll[0].wheelY<0);
  assert.equal(g.accept([r(1,3,100,80)],240)[0].wheelPhase,4);
  g.accept([r(1,0)],300);assert.deepEqual(g.accept([r(1,3)],350),[]);
});

test('adjustable hold arms without pressing, then motion starts a drag that cannot become a scroll',()=>{
  const g=make({holdMs:200});g.accept([r(1,0)],0);
  assert.equal(g.tick(199).stage,'holding');assert.equal(g.tick(200).stage,'armed');
  assert.deepEqual(g.accept([r(1,1,110,100)],210).map(a=>[a.eventKind,a.buttons]),[[1,1],[0,1]]);
  assert.equal(g.tick(1500).stage,'dragging');
  assert.deepEqual(g.accept([r(1,2,130,100)],1600).map(a=>[a.eventKind,a.buttons]),[[1,0]]);
  assert.equal(g.feedback().stage,'released');assert.equal(g.tick(1900),null);
});

test('two-finger tap produces exactly one right click after both contacts end and never left clicks',()=>{
  const g=make();g.accept([r(1,0)],0);g.accept([r(1,1),r(2,0,200,100)],30);
  assert.equal(g.feedback().stage,'two-finger');
  assert.deepEqual(g.accept([r(1,2),r(2,1,200,100)],90),[]);
  assert.deepEqual(g.accept([r(2,2,200,100)],100).map(a=>[a.eventKind,a.buttons]),[[1,2],[1,0]]);
  assert.equal(g.feedback().stage,'right-released');assert.equal(g.tick(400),null);
});

test('pinch emits bounded zoom steps, suppresses the right click, and consumes the remaining finger',()=>{
  const g=make();g.accept([r(1,0),r(2,0,200,100)],0);
  const zoom=g.accept([r(1,1,70,100),r(2,1,230,100)],30);
  assert.equal(zoom[0].inputType,'zoom');assert.ok(zoom[0].steps>0&&zoom[0].steps<=4);
  assert.equal(g.feedback().stage,'pinching');
  assert.deepEqual(g.accept([r(1,2,70,100),r(2,1,230,100)],60),[]);
  assert.deepEqual(g.accept([r(2,1,300,100)],80),[]);
  assert.deepEqual(g.accept([r(2,2,300,100)],100),[]);
});

test('ctrl-wheel pinch uses explicit control modifier and discrete wheel units',()=>{
  const g=make({pinchAction:'ctrl-wheel'});g.accept([r(1,0),r(2,0,200,100)],0);
  const actions=g.accept([r(1,1,80,100),r(2,1,220,100)],30);
  assert.equal(actions[0].inputType,'mouse');assert.equal(actions[0].modifiers,2);assert.equal(actions[0].wheelUnit,0);assert.ok(actions[0].wheelY>0);
});

test('adding a second finger during drag releases left and cannot trigger a right click',()=>{
  const g=make();g.accept([r(1,0)],0);g.accept([r(1,1,120)],350);
  assert.deepEqual(g.accept([r(1,1,120),r(2,0,200)],360).map(a=>[a.eventKind,a.buttons]),[[1,0]]);
  assert.deepEqual(g.accept([r(1,2,120),r(2,2,200)],400),[]);
});

test('long two-finger holds, translations, and cancelled groups never become right clicks',()=>{
  for(const end of [[r(1,2),r(2,2,200)], [r(1,3),r(2,2,200)]]){
    const g=make();g.accept([r(1,0),r(2,0,200)],0);assert.deepEqual(g.accept(end,700),[]);
  }
  const g=make();g.accept([r(1,0),r(2,0,200)],0);g.accept([r(1,1,120),r(2,1,220)],20);
  assert.deepEqual(g.accept([r(1,2,120),r(2,2,220)],40),[]);
});

test('timing is validated and feedback distinguishes hold progress, ready ring and action state',()=>{
  assert.equal(normalizeGestureSettings({holdMs:150}).holdMs,150);
  for(const holdMs of [0,100,2001,NaN])assert.throws(()=>normalizeGestureSettings({holdMs}));
  const g=make();g.accept([r(1,0)],0);const f=g.tick(150);assert.equal(f.stage,'holding');assert.equal(f.progress,0.5);
  assert.equal(g.tick(300).stage,'armed');assert.equal(g.tick(2000).stage,'armed');
  const actions=g.accept([r(1,2)],2001);assert.equal(actions[0].buttons,1);
});

test('a final displaced Up preserves drag or scroll movement before ending it',()=>{
  const g=make();g.accept([r(1,0)],0);g.accept([r(1,1,100,80)],20);
  const actions=g.accept([r(1,2,100,60)],40);
  assert.deepEqual(actions.map(a=>a.wheelPhase),[2,3]);assert.ok(actions[0].wheelY<0);
});

test('disabled halos do not change gesture decisions and disabled pinch never turns into a click',()=>{
  const g=make({feedback:false,pinchAction:'disabled'});g.accept([r(1,0)],0);
  assert.equal(g.tick(300),null);
  assert.deepEqual(g.accept([r(1,1,120)],310).map(a=>[a.eventKind,a.buttons]),[[1,1],[0,1]]);
  g.accept([r(1,2,120)],320);
  g.accept([r(1,0),r(2,0,200)],400);assert.deepEqual(g.accept([r(1,1,50),r(2,1,250)],420),[]);
  assert.deepEqual(g.accept([r(1,2,50),r(2,2,250)],440),[]);
});

test('sequential contacts and replacing a finger are not a two-finger right click',()=>{
  const g=make();g.accept([r(1,0)],0);
  assert.deepEqual(g.accept([r(1,2),r(2,0,200)],30),[]);
  assert.deepEqual(g.accept([r(2,2,200)],60),[]);
  const h=make();h.accept([r(1,0),r(2,0,200)],0);h.accept([r(1,2),r(2,1,200)],30);
  h.accept([r(2,1,200),r(3,0,300)],50);
  assert.deepEqual(h.accept([r(2,2,200),r(3,2,300)],70),[]);
});

test('right-click defaults to 700ms hold and cannot precede the drag hold',()=>{
  const defaults=normalizeGestureSettings();assert.equal(defaults.rightClick,'hold');assert.equal(defaults.rightHoldMs,700);
  assert.equal(normalizeGestureSettings({holdMs:900}).rightHoldMs,900);
  assert.throws(()=>normalizeGestureSettings({holdMs:450,rightHoldMs:400}),/right|右键/i);
  assert.equal(normalizeGestureSettings({holdMs:450,rightHoldMs:450}).rightHoldMs,450);
  for(const rightHoldMs of [100,3001,NaN])assert.throws(()=>normalizeGestureSettings({rightHoldMs}));
  assert.throws(()=>normalizeGestureSettings({rightClick:'unknown'}));
});

test('hold feedback progresses to right-ready and only release triggers one right click',()=>{
  const g=make({rightClick:'hold'});g.accept([r(1,0)],0);
  assert.equal(g.tick(150).stage,'holding');
  assert.equal(g.tick(300).stage,'right-wait');assert.equal(g.tick(500).progress,0.5);
  assert.equal(g.tick(699).stage,'right-wait');assert.equal(g.tick(700).stage,'right-ready');
  assert.deepEqual(g.accept([r(1,1)],900),[]);
  assert.deepEqual(g.accept([r(1,2)],950).map(a=>[a.eventKind,a.buttons]),[[1,2],[1,0]]);
  assert.equal(g.feedback().stage,'right-released');assert.ok(g.tick(1050).progress>0);
  assert.equal(g.tick(1300),null);
});

test('release just before threshold stays a left click while drag and cancel suppress hold right-click',()=>{
  const g=make({rightClick:'hold'});g.accept([r(1,0)],0);
  assert.deepEqual(g.accept([r(1,2)],699).map(a=>a.buttons),[1,0]);
  assert.equal(g.feedback().stage,'released');
  g.accept([r(1,0)],1000);assert.equal(g.feedback().stage,'holding');
  assert.deepEqual(g.accept([r(1,1,130)],1800).map(a=>[a.eventKind,a.buttons]),[[1,1],[0,1]]);
  assert.deepEqual(g.accept([r(1,2,150)],2500).map(a=>a.buttons),[0]);
  g.accept([r(1,0)],3000);assert.deepEqual(g.accept([r(1,3)],4000),[]);assert.equal(g.feedback(),null);
});

test('two-finger right-click choice disables hold right-click and hold choice still permits pinch',()=>{
  const g=make({rightClick:'two-finger'});g.accept([r(1,0)],0);assert.equal(g.tick(1000).stage,'armed');
  assert.deepEqual(g.accept([r(1,2)],1100).map(a=>a.buttons),[1,0]);
  const h=make({rightClick:'hold'});h.accept([r(1,0),r(2,0,200)],0);
  assert.deepEqual(h.accept([r(1,2),r(2,2,200)],100),[]);
  h.accept([r(1,0),r(2,0,200)],200);assert.equal(h.accept([r(1,1,50),r(2,1,250)],230)[0].inputType,'zoom');
});

test('equal hold delays enter right-ready with finite progress and feedback disabled never leaves a release halo',()=>{
  const g=make({rightClick:'hold',holdMs:300,rightHoldMs:300});g.accept([r(1,0)],0);
  assert.deepEqual(g.tick(300),{stage:'right-ready',x:100,y:100,progress:1});
  const h=make({rightClick:'hold',feedback:false});h.accept([r(1,0)],0);
  assert.deepEqual(h.accept([r(1,2)],800).map(a=>a.buttons),[2,0]);assert.equal(h.feedback(),null);
});
