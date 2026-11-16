import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {dirname, resolve} from 'node:path';
import {buildDesktop} from './build.mjs';

export function selectSigningIdentity(output, requested = '') {
  if (requested === '-') throw new Error('ad-hoc signing cannot preserve macOS permissions across builds');
  const entries = [...output.matchAll(/^\s*\d+\) ([A-Fa-f0-9]{40}) "([^"]+)"/gm)]
    .map(([, hash, name]) => ({hash, name}));
  if (requested) {
    if (!entries.some(entry => entry.name === requested || entry.hash === requested)) throw new Error('Requested signing identity not found in the keychain');
    return requested;
  }
  const names = [...new Set(entries.map(entry => entry.name))];
  const development = names.filter(name => name.startsWith('Apple Development:'));
  const candidates = development.length ? development : names.filter(name => name.startsWith('Developer ID Application:'));
  if (candidates.length !== 1) throw new Error('Install an Apple signing certificate, or choose one with APPLE_SIGNING_IDENTITY');
  return candidates[0];
}

export function appIsRunning(processes, executable) {
  return processes.split('\n').some(line => line.match(/^\s*\d+\s+(.+)$/)?.[1] === executable);
}

async function build() {
  if (process.platform !== 'darwin') throw new Error('This build command requires macOS');
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const app = resolve(root, 'src-tauri/target/debug/bundle/macos/NearHub Cast.app');
  const executable = resolve(app, 'Contents/MacOS/NearHub Cast');
  const processes = execFileSync('/bin/ps', ['-axo', 'pid=,comm='], {encoding: 'utf8'});
  if (appIsRunning(processes, executable)) throw new Error('请先退出 NearHub Cast，再构建；覆盖运行中的应用会使系统授权失效。');
  const identities = execFileSync('/usr/bin/security', ['find-identity', '-v', '-p', 'codesigning'], {encoding: 'utf8'});
  const identity = selectSigningIdentity(identities, process.env.APPLE_SIGNING_IDENTITY);
  console.log(`Building with stable signing identity: ${identity}`);
  const status=await buildDesktop(['--debug','--bundles','app'],{root,env:{...process.env,APPLE_SIGNING_IDENTITY:identity}});
  if(status!==0)throw Error('macOS application build failed');
  execFileSync('/usr/bin/codesign', ['--verify', '--strict', '--verbose=2', app], {stdio: 'inherit'});
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await build(); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
