import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const run=promisify(execFile);

test('Core Audio converts actual stereo PCM across device rates and fences stopped callbacks',
  {skip:process.platform!=='darwin'},async t=>{
    const directory=await mkdtemp(join(tmpdir(),'nearcast-core-audio-test-'));
    try{
      const executable=join(directory,'core-audio-test');
      await run('xcrun',['clang','-fobjc-arc','-fblocks','-mmacosx-version-min=13.0',
        'tests/fixtures/macos-core-audio.m','-framework','Foundation','-framework','CoreAudio','-framework','AVFAudio','-o',executable]);
      const result=await run(executable,[],{timeout:10000});
      if(result.stdout.includes('SKIP Core Audio taps')){t.skip('Core Audio taps require macOS 14.2');return;}
      assert.match(result.stdout,/PASS conversion 44100 Hz/);
      assert.match(result.stdout,/PASS conversion 96000 Hz/);
      assert.match(result.stdout,/PASS invalid formats/);
    }finally{await rm(directory,{recursive:true,force:true});}
  });
