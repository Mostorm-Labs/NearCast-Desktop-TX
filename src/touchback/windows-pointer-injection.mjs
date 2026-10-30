import {PointerInjectionSink} from './pointer-injection.mjs';

export function createWindowsPointerInjectionSink(nativeBridge) {
  return new PointerInjectionSink({native: nativeBridge, maxContacts: 10});
}

export const WINDOWS_POINTER_INJECTION_CONTRACT = Object.freeze({
  initialize: 'InitializeTouchInjection',
  inject: 'InjectTouchInput',
  reset: 'cancelTouchContacts',
  mouseFallback: false,
});
