import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
test('Tauri frontend is self-contained under dist', () => {
  const app = fs.readFileSync(path.join(root, 'dist', 'app.mjs'), 'utf8');
  assert.equal(app.includes("../src/"), false);
  for (const file of ['dist/webcast/launcher-webcast-client.mjs', 'dist/webcast/video-quality.mjs', 'dist/webcast/receiver-trust.mjs', 'dist/webcast/touchback-sender.mjs', 'dist/webcast/touchback-channel-policy.mjs', 'dist/webcast/input-control-adapter.mjs', 'dist/touchback/codec.mjs', 'dist/touchback/axtp-session.mjs', 'dist/touchback/input-engine.mjs', 'dist/touchback/native-input-adapter.mjs', 'dist/touchback/platform-input.mjs', 'dist/discovery-devices.mjs', 'dist/tauri-device-discovery.mjs', 'dist/platform-capabilities.mjs', 'dist/assets/background.webp']) {
    assert.equal(fs.existsSync(path.join(root, file)), true, `${file} missing`);
  }
});

test('every packaged runtime module exactly matches its source',()=>{
  for(const directory of ['touchback','webcast'])for(const file of fs.readdirSync(path.join(root,'src',directory)).filter(file=>file.endsWith('.mjs'))){
    assert.equal(fs.readFileSync(path.join(root,'dist',directory,file),'utf8'),fs.readFileSync(path.join(root,'src',directory,file),'utf8'),`${directory}/${file}`);
  }
});

test('packaged discovery module resolves its dependencies and matches source capabilities', async () => {
  const {TauriDeviceDiscovery} = await import('../dist/tauri-device-discovery.mjs');
  const listeners = new Map(); const snapshots = [];
  const discovery = new TauriDeviceDiscovery({invoke: async () => {}, listen: async (name, callback) => { listeners.set(name, callback); return () => listeners.delete(name); }});
  try {
    await discovery.start(devices => snapshots.push(devices));
    listeners.get('nearcast://mdns-service')({payload:{serviceType:'_airplay._tcp.local.', instance:'TV', txt:{capability:'webcast,code-display-v1,touchback-v1'}}});
    const device = snapshots.at(-1)[0];
    assert.equal(device.selectable, false);
    assert.equal(device.supportsCodeDisplay, false);
    assert.equal(device.supportsTouchback, false);
  } finally { await discovery.stop(); }
});
