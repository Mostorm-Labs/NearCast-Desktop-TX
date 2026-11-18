// This small classic script runs before styles and the async app bootstrap,
// so a saved theme also applies to the first frame of the WebView.
(()=>{
  let theme;
  try{theme=JSON.parse(localStorage.getItem('nearhub-cast-settings-v1'))?.theme;}catch{/* Use the system appearance when storage is unavailable. */}
  document.documentElement.dataset.theme=theme==='dark'||theme==='light'?theme:globalThis.matchMedia?.('(prefers-color-scheme: dark)').matches?'dark':'light';
})();
