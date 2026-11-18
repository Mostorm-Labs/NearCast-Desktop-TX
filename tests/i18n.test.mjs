import test from 'node:test';
import assert from 'node:assert/strict';

test('system language resolves supported regional variants and falls back to English',async()=>{
  const {resolveLocale}=await import('../src/i18n.mjs');
  for(const [languages,want]of [[['zh-TW'],'zh'],[['ja-JP'],'ja'],[['de-DE'],'de'],[['en-GB'],'en'],[['fr-FR','de-AT'],'de'],[['fr-FR'],'en']]){
    assert.equal(resolveLocale('system',languages),want);
  }
  assert.equal(resolveLocale('en',['ja-JP']),'en');
});

test('all supported dictionaries have complete copy and interpolate user data as text',async()=>{
  const {createI18n,messages}=await import('../src/i18n.mjs');
  const keys=Object.keys(messages.en).sort();
  for(const locale of ['zh','en','ja','de']){
    assert.deepEqual(Object.keys(messages[locale]).sort(),keys);
    const language=createI18n({language:locale,languages:['en-US']});
    assert.ok(!language.t('home.welcome').includes('home.welcome'));
    assert.ok(language.t('cast.target',{name:'<Meeting Room>'}).includes('<Meeting Room>'));
    assert.ok(!language.t('discovery.found',{count:3}).includes('{count}'));
  }
});

test('known connection and capture failures are localized without masking unrelated errors',async()=>{
  const {createI18n}=await import('../src/i18n.mjs');
  for(const locale of ['zh','en','ja','de']){
    const language=createI18n({language:locale});
    for(const [message,key]of [
      ['此接收端尚不支持局域网直连，请更新接收端或关闭“局域网投屏”。','error.localUnsupported'],
      ['接收端本地投屏服务尚未就绪，请稍后重试。','error.localUnavailable'],
      ['无法连接接收端本地信令服务','error.localUnavailable'],
      ['无法完成设备连接，请返回列表重试。','error.pairing'],
      ['Screen capture is unavailable','error.captureUnavailable'],
      ['Display video track unavailable','error.captureUnavailable'],
      ['macos_audio_permission_required','audio.permission'],
      ['macos_audio_start_timeout','audio.startTimeout'],
      ['macos_audio_capture_failed:-3818','audio.captureFailed'],
    ])assert.equal(language.error(new Error(message)),language.t(key));
    assert.equal(language.error(new Error('Updater unavailable: HTTP 503')),'Updater unavailable: HTTP 503');
    assert.equal(language.error(new Error('System audio track unavailable')),'System audio track unavailable');
  }
});
