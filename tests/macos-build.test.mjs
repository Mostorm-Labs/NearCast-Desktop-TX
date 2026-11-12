import test from 'node:test';
import assert from 'node:assert/strict';
import {selectSigningIdentity, appIsRunning} from '../scripts/build-macos.mjs';

const identities = `
  1) AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA "Developer ID Application: Example (TEAM)"
  2) BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB "Apple Development: Developer (DEV)"
     2 valid identities found
`;

test('macOS permission builds prefer a stable development certificate over distribution', () => {
  assert.equal(selectSigningIdentity(identities), 'Apple Development: Developer (DEV)');
  assert.equal(selectSigningIdentity(identities, 'Developer ID Application: Example (TEAM)'), 'Developer ID Application: Example (TEAM)');
});

test('macOS permission builds refuse ad-hoc signing and missing or ambiguous identities', () => {
  assert.throws(() => selectSigningIdentity(identities, '-'), /ad-hoc/);
  assert.throws(() => selectSigningIdentity('0 valid identities found'), /Apple/);
  assert.throws(() => selectSigningIdentity(identities, 'Missing certificate'), /not found/);
  const multiple = `${identities}\n  3) CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC "Apple Development: Another (OTHER)"`;
  assert.throws(() => selectSigningIdentity(multiple), /APPLE_SIGNING_IDENTITY/);
});

test('macOS build refuses to overwrite its own running bundle while allowing other apps', () => {
  const executable = '/workspace/NearHub Cast.app/Contents/MacOS/NearHub Cast';
  assert.equal(appIsRunning(` 123 ${executable}\n 456 /Applications/Other.app/Contents/MacOS/other`, executable), true);
  assert.equal(appIsRunning(` 123 /other/NearHub Cast.app/Contents/MacOS/NearHub Cast`, executable), false);
});
