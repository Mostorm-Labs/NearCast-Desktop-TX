import {check,integer} from './frame-codec.mjs';
export function proveCaptureGeometry(settings,snapshot){
  check(snapshot&&typeof snapshot.revision==='string'&&snapshot.revision.length>0,'Native display geometry unavailable');
  if(settings?.nearcastCaptureId||snapshot.capture){
    const capture=snapshot.capture;
    check(capture&&settings.nearcastCaptureId===capture.captureId&&capture.nativeId===`capture:${capture.captureId}`,'Native capture identity mismatch');
    check(settings.nearcastCaptureRevision===capture.revision&&snapshot.revision===capture.revision,'Native capture revision changed');
    check(capture.inputReady===true,capture.disabledReason??'Native capture input not ready');
    check(['monitor','window'].includes(capture.kind)&&settings.displaySurface===capture.kind,'Native capture kind mismatch');
    check(integer(settings.width,1,16384)&&integer(settings.height,1,16384)&&integer(capture.captureWidth,1,16384)&&integer(capture.captureHeight,1,16384),'Native capture dimensions unavailable');
    // H.264 canvas dimensions round down to even pixels on each axis.
    check(Math.abs(settings.width*capture.captureHeight-settings.height*capture.captureWidth)<=2*Math.max(capture.captureWidth,capture.captureHeight),'Native capture aspect ratio mismatch');
    return{...structuredClone(capture),proven:true,evidence:'native-wgc-capture-lease',captureFacts:{displaySurface:capture.kind,width:settings.width,height:settings.height}};
  }
  check(Array.isArray(snapshot.displays)&&snapshot.displays.length===1,'Reverse input currently requires a single primary display');
  const display=snapshot.displays[0];
  check(display.primary===true&&display.rotation===0,'Unsupported display target/rotation');
  check(settings?.displaySurface==='monitor','Reverse input requires full monitor capture');
  check(integer(display.captureWidth,1,0x7fffffff)&&integer(display.captureHeight,1,0x7fffffff),'Native capture dimensions unavailable');
  check(settings.width===display.captureWidth&&settings.height===display.captureHeight,'Reverse input requires original monitor resolution; select Auto video resolution');
  return{...structuredClone(display),proven:true,revision:snapshot.revision,
    evidence:'single-native-primary-full-resolution-monitor',captureFacts:{displaySurface:'monitor',width:settings.width,height:settings.height}};
}
