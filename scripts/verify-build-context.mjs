import {currentVersion} from './build-version.mjs';
if(!(process.env.NEARCAST_BUILD_VERSION)||process.env.NEARCAST_BUILD_VERSION!==(await currentVersion()).display){
  throw Error('Use node scripts/build.mjs <Tauri options> so the build counter and package version are allocated together.');
}
