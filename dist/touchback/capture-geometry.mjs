import {check,integer} from './frame-codec.mjs';
export function proveCaptureGeometry(settings,snapshot){
  check(snapshot&&typeof snapshot.revision==='string'&&snapshot.revision.length>0,'Native display geometry unavailable');
  check(settings?.displaySurface==='monitor','BROWSER_WINDOW_INPUT_UNSUPPORTED: 仅整个屏幕支持反控，窗口投屏继续');
  const request=settings.nearcastDisplayBinding;
  if(request){
    const binding=snapshot.browserBinding;
    check(binding&&binding.sourceId===request.sourceId&&binding.bindingId===request.bindingId,'BROWSER_DISPLAY_BINDING_RETIRED: 屏幕绑定已失效，请停止后重新分享');
    check(snapshot.revision===binding.layoutRevision,'BROWSER_DISPLAY_LAYOUT_CHANGED: 显示布局已变化，请停止后重新分享');
    check(binding.rotation===0&&binding.units==='physical-pixels','Unsupported display binding geometry');
    const source=settings.nearcastBrowserSource??settings;
    check(source.displaySurface==='monitor'&&integer(source.width,1,16384)&&integer(source.height,1,16384),'Browser source facts unavailable');
    check(Math.abs(source.width*binding.captureHeight-source.height*binding.captureWidth)<=2*Math.max(binding.captureWidth,binding.captureHeight),'Bound source aspect ratio changed');
    check(integer(settings.width,1,16384)&&integer(settings.height,1,16384)&&Math.abs(settings.width*source.height-settings.height*source.width)<=2*Math.max(source.width,source.height),'Browser capture aspect ratio changed');
    return{...structuredClone(binding),proven:true,evidence:'browser-four-corner-display-challenge',captureFacts:{displaySurface:'monitor',width:source.width,height:source.height}};
  }
  check(Array.isArray(snapshot.displays)&&snapshot.displays.length===1,'BROWSER_MULTIPLE_DISPLAYS_UNPROVEN: 多显示器下无法确认所选屏幕，投屏继续');
  const display=snapshot.displays[0];
  check(display.primary===true&&display.rotation===0,'Unsupported display target/rotation');
  check(integer(display.captureWidth,1,0x7fffffff)&&integer(display.captureHeight,1,0x7fffffff),'Native capture dimensions unavailable');
  const source=settings.nearcastBrowserSource??settings;
  check(source.displaySurface==='monitor'&&source.width===display.captureWidth&&source.height===display.captureHeight,'BROWSER_SOURCE_SIZE_UNPROVEN: Reverse input requires original monitor source dimensions');
  check(integer(settings.width,1,16384)&&integer(settings.height,1,16384)&&Math.abs(settings.width*source.height-settings.height*source.width)<=2*Math.max(source.width,source.height),'Browser capture aspect ratio changed');
  return{...structuredClone(display),proven:true,revision:snapshot.revision,
    evidence:'single-native-primary-full-resolution-monitor',captureFacts:{displaySurface:'monitor',width:source.width,height:source.height}};
}
