import {TouchbackPhase} from './codec.mjs';

// Tauri serializes a successful Result<(), String> as JSON null.
const accepted = result => result === true || result === undefined || result === null;
const nativeFailure = result => result && typeof result === 'object' ? result : {ok: false, error: 'native injection failed'};

export function createTauriNativeBridge({invoke, viewport} = {}) {
  if (typeof invoke !== 'function') throw new TypeError('Tauri invoke required');
  const width = Math.max(1, Number(viewport?.width ?? 1));
  const height = Math.max(1, Number(viewport?.height ?? 1));
  let wireToNative = new Map();
  let maxContacts = 10;
  const pixel = (value, extent) => Math.min(extent - 1, Math.max(0, Math.round(value * (extent - 1) / 65535)));

  // Allocate against a candidate map. A rejected native call must not consume
  // IDs or release existing contacts; commit only after successful injection.
  const prepare = records => {
    const next = new Map(wireToNative);
    const mapped = [];
    for (const record of records) {
      let localId = next.get(record.contactId);
      if (record.phase === TouchbackPhase.DOWN) {
        if (localId !== undefined) return {error: `contact_mapping_already_active:${record.contactId}`};
        const used = new Set(next.values());
        for (let id = 1; id <= maxContacts; id += 1) if (!used.has(id)) { localId = id; break; }
        if (localId === undefined) return {error: `contact_mapping_failed:${record.contactId}`};
        next.set(record.contactId, localId);
      }
      if (localId === undefined) return {error: `contact_mapping_missing:${record.contactId}`};
      mapped.push({...record, contactId: localId, x: pixel(record.x, width), y: pixel(record.y, height)});
    }
    for (const record of records) if (record.phase === TouchbackPhase.UP || record.phase === TouchbackPhase.CANCEL) next.delete(record.contactId);
    return {mapped, next};
  };
  const inject = async (records, batch) => {
    const prepared = prepare(records);
    if (prepared.error) return {ok: false, error: prepared.error};
    try {
      const result = await invoke(batch ? 'nearcast_pointer_inject_batch' : 'nearcast_pointer_inject', batch ? {records: prepared.mapped} : prepared.mapped[0]);
      if (!accepted(result)) return nativeFailure(result);
      wireToNative = prepared.next;
      return true;
    } catch (error) { return {ok: false, error: String(error?.message ?? error)}; }
  };
  return {
    initializeTouchInjection: async requestedMax => {
      const result = await invoke('nearcast_pointer_initialize', {maxContacts: requestedMax});
      if (result === true) { maxContacts = Math.min(10, Math.max(1, requestedMax)); wireToNative.clear(); }
      return result;
    },
    injectTouchInputs: async records => {
      const groups = [];
      let group = [];
      for (const record of records) {
        if (group.some(item => item.contactId === record.contactId)) { groups.push(group); group = []; }
        group.push(record);
      }
      if (group.length) groups.push(group);
      for (const batch of groups) {
        const result = await inject(batch, true);
        if (result !== true) return result;
      }
      return true;
    },
    injectTouchInput: record => inject([record], false),
    cancelTouchContacts: async contactIds => {
      const localIds = contactIds.map(id => wireToNative.get(id)).filter(id => id !== undefined);
      try {
        const result = await invoke('nearcast_pointer_reset', {contactIds: localIds});
        if (!accepted(result)) return false;
        for (const id of contactIds) wireToNative.delete(id);
        return true;
      } catch { return false; }
    },
  };
}
