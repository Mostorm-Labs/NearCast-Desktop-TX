import {check,integer} from './frame-codec.mjs';
export function proveCaptureGeometry(settings,snapshot){
  check(snapshot&&typeof snapshot.revision==='string'&&snapshot.revision.length>0,'Native display geometry unavailable');
  check(Array.isArray(snapshot.displays)&&snapshot.displays.length===1,'Reverse input currently requires a single primary display');
  const display=snapshot.displays[0];
  check(display.primary===true&&display.rotation===0,'Unsupported display target/rotation');
  check(settings?.displaySurface==='monitor','Reverse input requires full monitor capture');
  check(integer(display.captureWidth,1,0x7fffffff)&&integer(display.captureHeight,1,0x7fffffff),'Native capture dimensions unavailable');
  check(settings.width===display.captureWidth&&settings.height===display.captureHeight,'Reverse input requires original monitor resolution; select Auto video resolution');
  return{...structuredClone(display),proven:true,revision:snapshot.revision,
    evidence:'single-native-primary-full-resolution-monitor',captureFacts:{displaySurface:'monitor',width:settings.width,height:settings.height}};
}
