import {TouchbackPhase} from './codec.mjs';

export const PointerInjectionStatus = Object.freeze({ACCEPTED: 'accepted', NOT_SUPPORTED: 'not_supported', INVALID_STATE: 'invalid_state'});

export class PointerInjectionSink {
  constructor({native = null, maxContacts = 10} = {}) {
    this.native = native;
    this.maxContacts = maxContacts;
    this.initialized = false;
    this.active = new Set();
    this.stats = {injected: 0, rejected: 0, resets: 0};
  }
  initialize() {
    if (!this.native?.initializeTouchInjection || !this.native?.injectTouchInput) return PointerInjectionStatus.NOT_SUPPORTED;
    const result = this.native.initializeTouchInjection(this.maxContacts);
    const finish = ok => { if (!ok) return PointerInjectionStatus.NOT_SUPPORTED; this.initialized = true; return PointerInjectionStatus.ACCEPTED; };
    return result && typeof result.then === 'function' ? result.then(finish) : finish(result);
  }
  apply(record) {
    if (!this.initialized || !this.native) return PointerInjectionStatus.NOT_SUPPORTED;
    if (!record || !Number.isInteger(record.contactId) || record.contactId < 0 || record.contactId >= this.maxContacts) return PointerInjectionStatus.INVALID_STATE;
    if (record.phase === TouchbackPhase.DOWN && this.active.has(record.contactId)) return PointerInjectionStatus.INVALID_STATE;
    if ((record.phase === TouchbackPhase.MOVE || record.phase === TouchbackPhase.UP || record.phase === TouchbackPhase.CANCEL) && !this.active.has(record.contactId)) return PointerInjectionStatus.INVALID_STATE;
    const result = this.native.injectTouchInput(record);
    const finish = ok => {
      if (!ok) return PointerInjectionStatus.INVALID_STATE;
      if (record.phase === TouchbackPhase.DOWN || record.phase === TouchbackPhase.MOVE) this.active.add(record.contactId);
      else this.active.delete(record.contactId);
      this.stats.injected += 1;
      return PointerInjectionStatus.ACCEPTED;
    };
    return result && typeof result.then === 'function' ? result.then(finish) : finish(result);
  }
  reset() {
    if (this.active.size && this.native?.cancelTouchContacts) this.native.cancelTouchContacts([...this.active]);
    this.active.clear();
    this.stats.resets += 1;
    return PointerInjectionStatus.ACCEPTED;
  }
  snapshot() { return {initialized: this.initialized, activeContacts: this.active.size, ...this.stats}; }
}
