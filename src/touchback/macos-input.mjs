import {TouchbackPhase} from './codec.mjs';

export const MACOS_INPUT_STATUS = Object.freeze({ACCEPTED: 'accepted', NOT_SUPPORTED: 'not_supported', NOT_AUTHORIZED: 'not_authorized', INVALID_STATE: 'invalid_state'});
const errorStatus = error => {
  const message = String(error?.message ?? error ?? '').toLowerCase();
  if (/not.?supported|unsupported/.test(message)) return MACOS_INPUT_STATUS.NOT_SUPPORTED;
  if (/authoriz|accessib|permission|trusted|tcc/.test(message)) return MACOS_INPUT_STATUS.NOT_AUTHORIZED;
  return MACOS_INPUT_STATUS.INVALID_STATE;
};

export class MacOsInputSink {
  constructor({native = null, interactionMode = 'mouse'} = {}) {
    this.native = native;
    this.supportedModes = ['mouse'];
    this.maxContacts = 1;
    this.initialized = false;
    this.button = 0;
    this.implicitPrimary = false;
    this.activeContact = null;
    this._pending = Promise.resolve();
    this.generation = 0;
    this.cleanupPending = false;
    this.interactionMode = interactionMode === 'touch-scroll' ? interactionMode : 'mouse';
    this.scrollGesture = null;
    this.ignoreUntilDown = false;
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
      if (this.ignoreUntilDown) {
        if (record.phase !== TouchbackPhase.DOWN) {
          if (this.interactionMode === 'mouse' && record.phase === TouchbackPhase.MOVE && button === 0) return call('move', record.x, record.y, modifiers);
          return MACOS_INPUT_STATUS.ACCEPTED;
        }
        this.ignoreUntilDown = false;
      }
      if (this.scrollGesture || this.interactionMode === 'touch-scroll' && button <= 1 && this.button === 0) {
        return this._applyScroll(record, call);
      }
      if (record.phase === TouchbackPhase.DOWN) {
        if (this.activeContact !== null) return MACOS_INPUT_STATUS.INVALID_STATE;
        // Receiver touch contacts carry no mouse button mask. Translate their
        // lifecycle to the primary mouse button for the macOS mouse output.
        const pressedButton = button || 1;
        const status = await call('button', pressedButton, true, record.x, record.y, modifiers);
        if (status === MACOS_INPUT_STATUS.ACCEPTED) { this.activeContact = contactId; this.button = pressedButton; this.implicitPrimary = button === 0; }
        return status;
      }
      if (record.phase === TouchbackPhase.UP || record.phase === TouchbackPhase.CANCEL) {
        if (this.activeContact === null || contactId !== this.activeContact) return MACOS_INPUT_STATUS.INVALID_STATE;
        const status = await call('button', this.button, false, record.x, record.y, modifiers);
        if (status === MACOS_INPUT_STATUS.ACCEPTED) { this.activeContact = null; this.button = 0; this.implicitPrimary = false; }
        return status;
      }
      if (record.phase === TouchbackPhase.MOVE) {
        const heldButton = this.implicitPrimary && button === 0 ? 1 : button;
        if (this.activeContact !== null && (contactId !== this.activeContact || heldButton !== this.button)) return MACOS_INPUT_STATUS.INVALID_STATE;
        if (this.activeContact === null && button) return MACOS_INPUT_STATUS.INVALID_STATE;
        return call('move', record.x, record.y, modifiers);
      }
      return MACOS_INPUT_STATUS.INVALID_STATE;
    });
  }

  async _applyScroll(record, call) {
    const {phase, x, y} = record;
    const contactId = record.contactId ?? 0;
    const modifiers = Number(record.modifiers) || 0;
    if (phase === TouchbackPhase.DOWN) {
      if (this.activeContact !== null) return MACOS_INPUT_STATUS.INVALID_STATE;
      const status = await call('move', x, y, modifiers);
      if (status === MACOS_INPUT_STATUS.ACCEPTED) {
        this.activeContact = contactId;
        this.scrollGesture = {x, y, lastX: x, lastY: y, scrolling: false};
      }
      return status;
    }
    const gesture = this.scrollGesture;
    if (!gesture) return phase === TouchbackPhase.MOVE && !record.buttons ? call('move', x, y, modifiers) : MACOS_INPUT_STATUS.INVALID_STATE;
    if (contactId !== this.activeContact || record.buttons > 1) return MACOS_INPUT_STATUS.INVALID_STATE;
    if (phase !== TouchbackPhase.MOVE && phase !== TouchbackPhase.UP && phase !== TouchbackPhase.CANCEL) return MACOS_INPUT_STATUS.INVALID_STATE;
    if (phase !== TouchbackPhase.CANCEL && (gesture.scrolling || Math.hypot(x - gesture.x, y - gesture.y) >= 256)) {
      const dx = x - gesture.lastX, dy = y - gesture.lastY;
      if (dx || dy) {
        const status = await call('scroll', gesture.x, gesture.y, dx, dy, gesture.scrolling ? 'changed' : 'began', modifiers);
        if (status !== MACOS_INPUT_STATUS.ACCEPTED) return status;
        gesture.scrolling = true; gesture.lastX = x; gesture.lastY = y;
      }
    }
    if (phase === TouchbackPhase.MOVE) return MACOS_INPUT_STATUS.ACCEPTED;
    if (gesture.scrolling) {
      const status = await call('scroll', gesture.x, gesture.y, 0, 0, phase === TouchbackPhase.CANCEL ? 'cancelled' : 'ended', modifiers);
      if (status !== MACOS_INPUT_STATUS.ACCEPTED) return status;
    } else if (phase === TouchbackPhase.UP) {
      let status = await call('button', 1, true, gesture.x, gesture.y, modifiers);
      if (status !== MACOS_INPUT_STATUS.ACCEPTED) return status;
      this.button = 1;
      status = await call('button', 1, false, gesture.x, gesture.y, modifiers);
      if (status !== MACOS_INPUT_STATUS.ACCEPTED) return status;
    }
    this.scrollGesture = null; this.activeContact = null; this.button = 0;
    return MACOS_INPUT_STATUS.ACCEPTED;
  }

  setInteractionMode(mode) {
    if (!['mouse', 'touch-scroll'].includes(mode)) return Promise.resolve(MACOS_INPUT_STATUS.NOT_SUPPORTED);
    // Queue cleanup after in-flight native calls. New records cannot cross the
    // mode boundary, and the rest of a held contact cannot turn into a click.
    this.generation++;
    return this._enqueue(async () => {
      if (mode === this.interactionMode) return MACOS_INPUT_STATUS.ACCEPTED;
      const status = await this._resetNative();
      if (status === MACOS_INPUT_STATUS.ACCEPTED) { this.interactionMode = mode; this.ignoreUntilDown = true; }
      return status;
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
      this.activeContact = null; this.button = 0; this.implicitPrimary = false; this.cleanupPending = false;
      this.scrollGesture = null; this.ignoreUntilDown = false;
      return MACOS_INPUT_STATUS.ACCEPTED;
    } catch (error) {
      this.cleanupPending = true; this.initialized = false;
      return errorStatus(error);
    }
  }

  snapshot() { return {initialized: this.initialized, activeContacts: this.activeContact === null ? 0 : 1, buttons: this.button, interactionMode: this.interactionMode}; }
}
