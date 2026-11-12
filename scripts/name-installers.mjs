import {readdir,rename,readFile,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

export const INSTALLER_NAME='NearHub Cast Desktop Installer';
export function installerFileName(name){
  return /^NearHub Cast_.*(?:-setup\.exe|\.msi)$/.test(name)?name.replace(/^NearHub Cast_/,INSTALLER_NAME+'_'):name;
}
// Tauri bundle output has the application name. Rename only installer assets;
// app bundles, binaries and installed shortcuts keep the shorter product name.
export async function nameInstallers(root){
  for(const format of ['nsis','msi']){
    const dir=join(root,format);
    let entries;try{entries=await readdir(dir);}catch(error){if(error.code==='ENOENT')continue;throw error;}
    for(const name of entries){
      const next=installerFileName(name);if(next===name)continue;
      const target=join(dir,next);
      // Fail rather than replace another package from a previous build.
      try{await readFile(target);throw new Error('Installer already exists: '+target);}catch(error){if(error.code!=='ENOENT')throw error;}
      await rename(join(dir,name),target);
      for(const suffix of ['.sig','.sha256']){
        let bytes;try{bytes=await readFile(join(dir,name+suffix));}catch(error){if(error.code==='ENOENT')continue;throw error;}
        if(suffix==='.sha256')await writeFile(join(dir,name+suffix),bytes.toString().replaceAll(name,next));
        await rename(join(dir,name+suffix),target+suffix);
      }
      console.log(target);
    }
  }
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  if(!process.argv[2])throw new Error('Expected Tauri bundle output directory');
  await nameInstallers(resolve(process.argv[2]));
}
