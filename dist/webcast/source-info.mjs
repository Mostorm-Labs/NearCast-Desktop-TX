export function browserPlatform(navigator = globalThis.navigator) {
  const platform = navigator?.userAgentData?.platform ?? navigator?.platform ?? '';
  const agent = navigator?.userAgent ?? '';
  if (/Android/i.test(agent)) return 'android';
  if (/iPhone|iPad|iPod/i.test(agent) || (/Mac/i.test(platform) && navigator?.maxTouchPoints > 1)) return 'ios';
  if (/Win/i.test(platform)) return 'windows';
  if (/Mac/i.test(platform)) return 'macos';
  if (/Linux/i.test(platform)) return 'linux';
  return 'unknown';
}

export function captureSourceInfo(identity = {}, track = null) {
  const platform = ['windows','macos','linux','android','ios'].includes(identity.platform) ? identity.platform : 'unknown';
  const clientKind = ['desktop','mobile','web'].includes(identity.clientKind) ? identity.clientKind : 'unknown';
  const product = typeof identity.product === 'string' && /^[a-z0-9.-]{1,64}$/.test(identity.product) ? identity.product : 'unknown';
  const surface = track?.readyState === 'ended' ? null : track?.getSettings?.().displaySurface;
  return {platform,clientKind,product,displaySurface:['monitor','window','browser'].includes(surface) ? surface : 'unknown'};
}
