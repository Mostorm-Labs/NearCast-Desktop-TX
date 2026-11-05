import {TouchbackPhase} from './codec.mjs';

export const MACOS_INPUT_STATUS = Object.freeze({ACCEPTED: 'accepted', NOT_SUPPORTED: 'not_supported', NOT_AUTHORIZED: 'not_authorized', INVALID_STATE: 'invalid_state'});
const errorStatus = error => {
  const message = String(error?.message ?? error ?? '').toLowerCase();
  if (/not.?supported|unsupported/.test(message)) return MACOS_INPUT_STATUS.NOT_SUPPORTED;
  if (/authoriz|accessib|permission|trusted|tcc/.test(message)) return MACOS_INPUT_STATUS.NOT_AUTHORIZED;
  return MACOS_INPUT_STATUS.INVALID_STATE;
};

export class MacOsInputSink {
  constructor({native = null} = {}) {
    this.native = native;
    this.supportedModes = ['mouse'];
    this.maxContacts = 1;
    this.initialized = false;
    this.button = 0;
    this.activeContact = null;
    this._pending = Promise.resolve();
    this.generation = 0;
    this.cleanupPending = false;
  }

  _enqueue(task) {
    const result = this._pending.then(task, task);
    this._pending = result.catch(() => {});
    return result;
  }

  initialize() {
    return this._enqueue(async () => {
      if (!this.native || typeof this.native.initialize !== 'function') return MACOS_INPUT_STATUS.NOT_SUPPORTED;
      try {
        if (this.cleanupPending) {
          const cleanup = await this._resetNative();
          if (cleanup !== MACOS_INPUT_STATUS.ACCEPTED) return cleanup;
        }
        const result = await this.native.initialize();
        this.initialized = result === true;
        return this.initialized ? MACOS_INPUT_STATUS.ACCEPTED : MACOS_INPUT_STATUS.NOT_AUTHORIZED;
      } catch (error) {
        this.initialized = false;
        return errorStatus(error);
      }
    });
  }

  apply(record) {
    const generation = this.generation;
    return this._enqueue(async () => {
      if (generation !== this.generation) return MACOS_INPUT_STATUS.INVALID_STATE;
      if (!this.initialized || !record) return MACOS_INPUT_STATUS.NOT_AUTHORIZED;
      const contactId = Number.isInteger(record.contactId) ? record.contactId : 0;
      if (contactId < 0 || contactId > 65535) return MACOS_INPUT_STATUS.INVALID_STATE;
      const modifiers = Number(record.modifiers) || 0;
      const call = async (name, ...args) => {
        if (typeof this.native?.[name] !== 'function') return MACOS_INPUT_STATUS.NOT_SUPPORTED;
        try {
          if ((await this.native[name](...args)) !== false) return MACOS_INPUT_STATUS.ACCEPTED;
          this.initialized = false;
          return MACOS_INPUT_STATUS.NOT_AUTHORIZED;
        } catch (error) {
          const status = errorStatus(error);
          if (status === MACOS_INPUT_STATUS.NOT_AUTHORIZED) this.initialized = false;
          return status;
        }
      };
      if (record.recordFlags) return MACOS_INPUT_STATUS.NOT_SUPPORTED;
      if (![record.x, record.y].every(value => Number.isInteger(value) && value >= 0 && value <= 65535)) return MACOS_INPUT_STATUS.INVALID_STATE;
      const button = Number(record.buttons ?? 0);
      if (![0, 1, 2, 4].includes(button)) return MACOS_INPUT_STATUS.NOT_SUPPORTED;
      if (record.phase === TouchbackPhase.DOWN) {
        if (this.activeContact !== null || !button) return MACOS_INPUT_STATUS.INVALID_STATE;
        const status = await call('button', button, true, record.x, record.y, modifiers);
        if (status === MACOS_INPUT_STATUS.ACCEPTED) { this.activeContact = contactId; this.button = button; }
        return status;
      }
      if (record.phase === TouchbackPhase.UP || record.phase === TouchbackPhase.CANCEL) {
        if (this.activeContact === null || contactId !== this.activeContact) return MACOS_INPUT_STATUS.INVALID_STATE;
        const status = await call('button', this.button, false, record.x, record.y, modifiers);
        if (status === MACOS_INPUT_STATUS.ACCEPTED) { this.activeContact = null; this.button = 0; }
        return status;
      }
      if (record.phase === TouchbackPhase.MOVE) {
        if (this.activeContact !== null && (contactId !== this.activeContact || button !== this.button)) return MACOS_INPUT_STATUS.INVALID_STATE;
        if (this.activeContact === null && button) return MACOS_INPUT_STATUS.INVALID_STATE;
        return call('move', record.x, record.y, modifiers);
      }
      return MACOS_INPUT_STATUS.INVALID_STATE;
    });
  }

  reset() {
    // Invalidate queued work immediately; native reset runs after any in-flight
    // invoke and releases its button at the last injected location.
    this.generation++;
    return this._enqueue(() => this._resetNative());
  }

  async _resetNative() {
    try {
      if ((await this.native?.reset?.()) === false) throw 'not_authorized';
      this.activeContact = null; this.button = 0; this.cleanupPending = false;
      return MACOS_INPUT_STATUS.ACCEPTED;
    } catch (error) {
      this.cleanupPending = true; this.initialized = false;
      return errorStatus(error);
    }
  }

  snapshot() { return {initialized: this.initialized, activeContacts: this.activeContact === null ? 0 : 1, buttons: this.button}; }
}
