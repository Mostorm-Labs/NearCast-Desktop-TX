import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {migrateLegacyPreferences} from '../src/local-origin.mjs';

test('local origin migration copies only a bounded object and never replaces current settings',async()=>{
  const fixture=(value,existing=null)=>{
    let saved=existing,calls=0;
    return {window:{location:{origin:'http://cast.nearhub.localhost'},localStorage:{getItem:()=>saved,setItem:(_key,next)=>{saved=next;}},
      __TAURI__:{core:{invoke:async command=>{assert.equal(command,'nearcast_take_legacy_settings');calls++;return value;}}}},get value(){return saved;},get calls(){return calls;}};
  };
  const legacy=JSON.stringify({video:{resolution:'1280x720'},systemAudio:false,inputEnabled:false});
  const migrated=fixture(legacy);await migrateLegacyPreferences(migrated);assert.equal(migrated.value,legacy);
  const current=fixture(legacy,'{"systemAudio":true}');await migrateLegacyPreferences(current);assert.equal(current.value,'{"systemAudio":true}');
  for(const invalid of ['{','null','[]','"text"',' '.repeat(16385),null]){const bad=fixture(invalid);await migrateLegacyPreferences(bad);assert.equal(bad.value,null);}
  const foreign=fixture(legacy);foreign.window.location.origin='https://example.com';await migrateLegacyPreferences(foreign);assert.equal(foreign.calls,0);
  const mac=fixture(legacy);mac.window.location.origin='tauri://localhost';await migrateLegacyPreferences(mac);assert.equal(mac.calls,0);
  assert.equal(fs.readFileSync('src/local-origin.mjs','utf8'),fs.readFileSync('dist/local-origin.mjs','utf8'));
});
