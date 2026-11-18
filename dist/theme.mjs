export const normalizeTheme=value=>['dark','light'].includes(value)?value:'system';

export function mountTheme({document,preference='system',invoke,matchMedia=globalThis.matchMedia?.bind(globalThis)}={}){
  const system=matchMedia?.('(prefers-color-scheme: dark)');
  let selected=normalizeTheme(preference);
  let nativeUpdate=Promise.resolve();
  const render=()=>{
    document.documentElement.dataset.theme=selected==='system'?(system?.matches?'dark':'light'):selected;
  };
  const setPreference=value=>{
    selected=normalizeTheme(value);render();
    // Native title bars and pickers follow the same preference. A cosmetic
    // window failure must not interrupt a cast or the local theme change.
    const theme=selected;
    if(invoke)nativeUpdate=nativeUpdate.then(()=>invoke('nearcast_window_action',{action:{kind:'setTheme',theme}})).catch(()=>{});
  };
  system?.addEventListener('change',()=>{if(selected==='system')render();});
  setPreference(selected);
  return{setPreference};
}
