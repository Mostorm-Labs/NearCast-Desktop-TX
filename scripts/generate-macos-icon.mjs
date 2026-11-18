import {execFileSync} from 'node:child_process';
import {copyFileSync,mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const source=readFileSync(join(root,'src-tauri/icons/icon.svg'),'utf8');
// Legacy ICNS artwork needs its own transparent margins. Preserve the original
// brand asset and its Windows exports, fitting the macOS tile into 824/1024 px.
const canvas=1024,artwork=824,inset=(canvas-artwork)/2;
const artworkSvg=source.replace(/<svg\b[^>]*>/,opening=>opening
  .replace(/\bwidth="[^"]*"/,`width="${artwork}"`)
  .replace(/\bheight="[^"]*"/,`height="${artwork}"`)
  .replace('<svg ',`<svg x="${inset}" y="${inset}" `));
const directory=mkdtempSync(join(tmpdir(),'nearhub-macos-icon-'));
try{
  const input=join(directory,'macos.svg'),output=join(directory,'icons');
  writeFileSync(input,`<svg xmlns="http://www.w3.org/2000/svg" width="${canvas}" height="${canvas}" viewBox="0 0 ${canvas} ${canvas}">\n${artworkSvg}\n</svg>\n`);
  execFileSync(process.execPath,[join(root,'node_modules/@tauri-apps/cli/tauri.js'),'icon',input,'--output',output],{stdio:'inherit'});
  copyFileSync(join(output,'icon.icns'),join(root,'src-tauri/icons/nearhub-cast.icns'));
  console.log(`Updated macOS icon: ${artwork} px artwork, ${inset} px transparent margins on a ${canvas} px canvas.`);
}finally{
  rmSync(directory,{recursive:true,force:true});
}
