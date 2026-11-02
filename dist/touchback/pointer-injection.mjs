import {TouchbackPhase} from './codec.mjs';

export const PointerInjectionStatus = Object.freeze({ACCEPTED: 'accepted', NOT_SUPPORTED: 'not_supported', INVALID_STATE: 'invalid_state'});

export class PointerInjectionSink {
  constructor({native = null, maxContacts = 10} = {}) {
    this.native = native;
    this.maxContacts = maxContacts;
    this.initialized = false;
    this.active = new Map();
    this.resetBlocked = false;
    this.pending = null;
    this.generation = 0;
    this.stats = {injected: 0, rejected: 0, resets: 0};
    this.lastFailure = null;
  }
  run(task) {
    const result = this.pending ? this.pending.then(task, task) : task();
    if (!result || typeof result.then !== 'function') return result;
    const pending = Promise.resolve(result).finally(() => { if (this.pending === pending) this.pending = null; });
    this.pending = pending;
    return pending;
  }
  initialize() {
    return this.run(() => {
      if (!this.native?.initializeTouchInjection || (!this.native?.injectTouchInput && !this.native?.injectTouchInputs)) return PointerInjectionStatus.NOT_SUPPORTED;
      if (this.resetBlocked) return PointerInjectionStatus.INVALID_STATE;
      const finish = ok => { this.initialized = Boolean(ok); return ok ? PointerInjectionStatus.ACCEPTED : PointerInjectionStatus.NOT_SUPPORTED; };
      try {
        const result = this.native.initializeTouchInjection(this.maxContacts);
        return result && typeof result.then === 'function' ? result.then(finish, () => finish(false)) : finish(result);
      } catch { return finish(false); }
    });
  }
  apply(record) {
    // Reject input at arrival while a reset is fencing the old contact set.
    // Queuing a new DOWN behind reset would otherwise let it run after the
    // fence is lifted, even though it belongs to the pre-reset interaction.
    if (this.resetBlocked) return PointerInjectionStatus.INVALID_STATE;
    const generation = this.generation;
    return this.run(() => this.applyNow(record, generation));
  }
  applyBatch(records) {
    if (!Array.isArray(records) || records.length === 0) return PointerInjectionStatus.ACCEPTED;
    if (this.resetBlocked) return PointerInjectionStatus.INVALID_STATE;
    const generation = this.generation;
    return this.run(async () => {
      if (!this.initialized || !this.native || generation !== this.generation) return PointerInjectionStatus.INVALID_STATE;
      const working = new Map(this.active);
      const groups = [];
      let group = [];
      const flush = () => { if (group.length) { groups.push(group); group = []; } };
      for (const record of records) {
        if (!record || !Number.isInteger(record.contactId) || record.contactId < 0 || record.contactId > 0xffff) {
          this.lastFailure = {kind: 'invalid_contact', contactId: record?.contactId ?? null, maxContacts: this.maxContacts};
          return PointerInjectionStatus.INVALID_STATE;
        }
        if (group.some(item => item.contactId === record.contactId)) flush();
        group.push(record);
      }
      flush();
      let injected = 0;
      for (const batch of groups) {
        const next = new Map(working);
        for (const record of batch) {
          if (record.phase === TouchbackPhase.DOWN) {
            if (next.has(record.contactId) || next.size >= this.maxContacts) {
              this.lastFailure = {kind: 'contact_capacity', contactId: record.contactId, maxContacts: this.maxContacts};
              return PointerInjectionStatus.INVALID_STATE;
            }
            next.set(record.contactId, {...record});
          } else if (record.phase === TouchbackPhase.MOVE) {
            if (!next.has(record.contactId)) return PointerInjectionStatus.INVALID_STATE;
            next.set(record.contactId, {...record});
          } else if (record.phase === TouchbackPhase.UP || record.phase === TouchbackPhase.CANCEL) {
            if (!next.has(record.contactId)) return PointerInjectionStatus.INVALID_STATE;
            next.delete(record.contactId);
          } else return PointerInjectionStatus.INVALID_STATE;
        }
        const frame = new Map(working);
        for (const record of batch) {
          const previous = working.get(record.contactId);
          const terminal = record.phase === TouchbackPhase.UP || record.phase === TouchbackPhase.CANCEL;
          frame.set(record.contactId, terminal && previous ? {...record, x: previous.x, y: previous.y} : {...record});
        }
        for (const [contactId, record] of frame) {
          if (!batch.some(item => item.contactId === contactId)) frame.set(contactId, {...record, phase: TouchbackPhase.MOVE});
        }
        let result;
        try {
          result = this.native.injectTouchInputs ? this.native.injectTouchInputs([...frame.values()])
            : batch.length === 1 ? this.native.injectTouchInput(batch[0])
            : {ok: false, error: 'native batch injection unavailable'};
          result = result && typeof result.then === 'function' ? await result : result;
        } catch (error) {
          this.lastFailure = {kind: 'native_error', error: String(error?.message ?? error)};
          return PointerInjectionStatus.INVALID_STATE;
        }
        if (result && typeof result === 'object' && !result.ok) {
          this.lastFailure = {kind: 'native_error', error: String(result.error ?? 'native injection failed')};
          return PointerInjectionStatus.INVALID_STATE;
        }
        if (!result && result !== null && result !== undefined) {
          this.lastFailure = {kind: 'native_error', error: 'native injection failed'};
          return PointerInjectionStatus.INVALID_STATE;
        }
        working.clear();
        for (const [contactId, value] of next) working.set(contactId, value);
        injected += batch.length;
      }
      this.active = working;
      this.stats.injected += injected;
      return PointerInjectionStatus.ACCEPTED;
    });
  }
  applyNow(record, generation) {
    if (!this.initialized || !this.native) return PointerInjectionStatus.NOT_SUPPORTED;
    if (this.resetBlocked || generation !== this.generation) return PointerInjectionStatus.INVALID_STATE;
    if (!record || !Number.isInteger(record.contactId) || record.contactId < 0 || record.contactId > 0xffff) {
      this.lastFailure = {kind: 'invalid_contact', contactId: record?.contactId ?? null, maxContacts: this.maxContacts};
      this.stats.rejected += 1;
      return PointerInjectionStatus.INVALID_STATE;
    }
    if (record.phase === TouchbackPhase.DOWN && this.active.has(record.contactId)) return PointerInjectionStatus.INVALID_STATE;
    if (record.phase === TouchbackPhase.DOWN && this.active.size >= this.maxContacts) {
      this.lastFailure = {kind: 'contact_capacity', contactId: record.contactId, maxContacts: this.maxContacts};
      this.stats.rejected += 1;
      return PointerInjectionStatus.INVALID_STATE;
    }
    if ((record.phase === TouchbackPhase.MOVE || record.phase === TouchbackPhase.UP || record.phase === TouchbackPhase.CANCEL) && !this.active.has(record.contactId)) return PointerInjectionStatus.INVALID_STATE;
    let result;
    try { result = this.native.injectTouchInput(record); } catch (error) { this.lastFailure = {kind: 'native_error', error: String(error?.message ?? error)}; return PointerInjectionStatus.INVALID_STATE; }
    const finish = ok => {
      if (ok && typeof ok === 'object') {
        if (!ok.ok) { this.lastFailure = {kind: 'native_error', error: String(ok.error ?? 'native injection failed')}; this.stats.rejected += 1; return PointerInjectionStatus.INVALID_STATE; }
        ok = true;
      }
      if (!ok) { this.lastFailure = {kind: 'native_error', error: 'native injection failed'}; this.stats.rejected += 1; return PointerInjectionStatus.INVALID_STATE; }
      if (record.phase === TouchbackPhase.DOWN || record.phase === TouchbackPhase.MOVE) this.active.set(record.contactId, {...record});
      else if (record.phase === TouchbackPhase.UP || record.phase === TouchbackPhase.CANCEL) this.active.delete(record.contactId);
      this.stats.injected += 1;
      return PointerInjectionStatus.ACCEPTED;
    };
    return result && typeof result.then === 'function' ? result.then(finish, () => finish(false)) : finish(result);
  }
  reset() {
    this.generation++;
    this.resetBlocked = true;
    return this.run(() => {
      if (this.active.size && !this.native?.cancelTouchContacts) return PointerInjectionStatus.INVALID_STATE;
      let result;
      try { result = this.active.size ? this.native.cancelTouchContacts([...this.active.keys()]) : true; } catch { result = false; }
      const finish = ok => {
        if (ok === false) return PointerInjectionStatus.INVALID_STATE;
        this.active.clear(); this.resetBlocked = false; this.stats.resets += 1;
        return PointerInjectionStatus.ACCEPTED;
      };
      return result && typeof result.then === 'function' ? result.then(finish, () => finish(false)) : finish(result !== false);
    });
  }
  snapshot() { return {initialized: this.initialized, activeContacts: this.active.size, ...this.stats, lastFailure: this.lastFailure}; }
}
