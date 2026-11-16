// The legacy top-level bootstrap transfers just this settings key through
// one-shot native memory. No third-party iframe storage or network is used.
export async function migrateLegacyPreferences({window=globalThis.window}={}) {
  if(window.location.origin!=='http://cast.nearhub.localhost'||!window.__TAURI__?.core?.invoke)return;
  try{
    const value=await window.__TAURI__.core.invoke('nearcast_take_legacy_settings');
    const key='nearhub-cast-settings-v1';
    if(typeof value==='string'&&value.length<=16384&&window.localStorage.getItem(key)===null){
      const parsed=JSON.parse(value);
      if(parsed&&typeof parsed==='object'&&!Array.isArray(parsed))window.localStorage.setItem(key,value);
    }
  }catch{/* Corrupt/blocked legacy storage cannot prevent startup. */}
}
