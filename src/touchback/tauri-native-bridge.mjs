export function createTauriNativeBridge({invoke, viewport} = {}) {
  if (typeof invoke !== 'function') throw new TypeError('Tauri invoke required');
  const width = Math.max(1, Number(viewport?.width ?? 1));
  const height = Math.max(1, Number(viewport?.height ?? 1));
  return {
    initializeTouchInjection: maxContacts => invoke('nearcast_pointer_initialize', {maxContacts}),
    injectTouchInput: record => invoke('nearcast_pointer_inject', {
      contactId: record.contactId,
      phase: record.phase,
      x: Math.min(width - 1, Math.max(0, Math.round(record.x * (width - 1) / 65535))),
      y: Math.min(height - 1, Math.max(0, Math.round(record.y * (height - 1) / 65535))),
      buttons: record.buttons,
      modifiers: record.modifiers,
    }),
    cancelTouchContacts: contactIds => invoke('nearcast_pointer_reset', {contactIds}),
  };
}
