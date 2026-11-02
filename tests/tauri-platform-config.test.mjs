import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();

test('Tauri bundle declares Windows installers and macOS 13 minimum', () => {
  const config = JSON.parse(fs.readFileSync(path.join(root, 'src-tauri', 'tauri.conf.json'), 'utf8'));
  assert.equal(config.bundle.active, true);
  assert.deepEqual(config.bundle.targets, ['nsis', 'msi', 'app', 'dmg']);
  assert.equal(config.bundle.windows.webviewInstallMode.type, 'downloadBootstrapper');
  assert.equal(config.bundle.macOS.minimumSystemVersion, '13.0');
  assert.equal(config.bundle.macOS.infoPlist, 'Info.plist');
});

test('macOS bundle explains screen capture and Bonjour discovery', () => {
  const plist = fs.readFileSync(path.join(root, 'src-tauri', 'Info.plist'), 'utf8');
  assert.match(plist, /NSScreenCaptureUsageDescription/);
  assert.match(plist, /NSAccessibilityUsageDescription/);
  assert.match(plist, /NSLocalNetworkUsageDescription/);
  for (const service of ['_nearcast._tcp', '_airplay._tcp', '_raop._tcp']) assert.match(plist, new RegExp(service.replaceAll('_', '\\_')));
});
