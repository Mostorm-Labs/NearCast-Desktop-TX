export function createMacOsInputBridge({invoke} = {}) {
  if (typeof invoke !== 'function') throw new TypeError('Tauri invoke required');
  return {
    initialize: () => invoke('nearcast_macos_input_initialize'),
    // CoreGraphics maps normalized coordinates using its own display bounds,
    // avoiding WKWebView CSS-pixel / Retina scaling differences.
    move: (x, y, modifiers = 0) => invoke('nearcast_macos_input_move', {x, y, modifiers}),
    button: (button, down, x = 0, y = 0, modifiers = 0) => invoke('nearcast_macos_input_button', {button, down, x, y, modifiers}),
    reset: () => invoke('nearcast_macos_input_reset'),
  };
}
