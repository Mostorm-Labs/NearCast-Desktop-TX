import {createTauriNativeBridge} from './tauri-native-bridge.mjs';
import {createWindowsPointerInjectionSink} from './windows-pointer-injection.mjs';
import {PointerInjectionStatus as Status} from './pointer-injection.mjs';

const accepted = value => value === null || value === undefined || value === true;

// A single queue owns both Windows input paths. Mode changes and reset fence
// queued work immediately, then release native state after the in-flight call.
export class WindowsInputSink {
  constructor({invoke, viewport} = {}) {
    this.invoke = invoke;
    this.touch = createWindowsPointerInjectionSink(createTauriNativeBridge({invoke, viewport}));
    this.supportedModes = ['touch', 'mouse'];
    this.maxContacts = 10;
    this.mode = 'touch';
    this.initialized = false;
    this.blocked = false;
    this.generation = 0;
    this.pending = Promise.resolve();
    this.mouseContacts = 0;
    this.lastFailure = null;
  }
  enqueue(task) {
    const result = this.pending.then(task, task);
    this.pending = result.catch(() => {});
    return result;
  }
  async mouseCommand(command, args) {
    try {
      const result = await this.invoke(command, args);
      if (!accepted(result)) throw result?.error ?? 'native mouse input unavailable';
      return Status.ACCEPTED;
    } catch (error) {
      this.lastFailure = {kind:'native_error',error:String(error?.message ?? error)};
      return Status.INVALID_STATE;
    }
  }
  initialize() {
    return this.enqueue(async () => {
      if (this.blocked && await this.release() !== Status.ACCEPTED) return Status.INVALID_STATE;
      const touchStatus = await this.touch.initialize();
      const mouseStatus = await this.mouseCommand('nearcast_windows_mouse_initialize');
      this.supportedModes = [touchStatus === Status.ACCEPTED ? 'touch' : null, mouseStatus === Status.ACCEPTED ? 'mouse' : null].filter(Boolean);
      this.initialized = this.supportedModes.length > 0;
      if (!this.supportedModes.includes(this.mode)) this.mode = this.supportedModes[0] ?? 'touch';
      return this.initialized ? Status.ACCEPTED : touchStatus !== Status.ACCEPTED ? touchStatus : mouseStatus;
    });
  }
  setMode(mode) {
    if (!this.supportedModes.includes(mode)) return Promise.resolve(Status.NOT_SUPPORTED);
    this.generation++;
    this.blocked = true;
    return this.enqueue(async () => {
      if (!this.initialized) return Status.NOT_SUPPORTED;
      const status = await this.release();
      if (status === Status.ACCEPTED) this.mode = mode;
      return status;
    });
  }
  apply(record) { return this.dispatch([record], false); }
  applyBatch(records) { return this.dispatch(records, true); }
  dispatch(records, batch) {
    const generation = this.generation;
    // Do not let work arriving during failed cleanup become valid later.
    if (this.blocked) return Promise.resolve(Status.INVALID_STATE);
    return this.enqueue(async () => {
      if (!this.initialized || this.blocked || generation !== this.generation) return Status.INVALID_STATE;
      if (!Array.isArray(records) || records.length > 1024) return Status.INVALID_STATE;
      if (!records.length) return Status.ACCEPTED;
      if (this.mode === 'touch') {
        const status = await (batch ? this.touch.applyBatch(records) : this.touch.apply(records[0]));
        if (status !== Status.ACCEPTED) this.lastFailure = this.touch.snapshot().lastFailure;
        return status;
      }
      const status = await this.mouseCommand('nearcast_windows_mouse_inject', {records});
      if (status === Status.ACCEPTED) for (const record of records) {
        if (record.phase === 0) this.mouseContacts = 1;
        else if (record.phase >= 2) this.mouseContacts = 0;
      }
      return status;
    });
  }
  reset() {
    this.generation++;
    this.blocked = true;
    return this.enqueue(() => this.release());
  }
  async release() {
    const touchStatus = await this.touch.reset();
    const mouseStatus = await this.mouseCommand('nearcast_windows_mouse_reset');
    this.blocked = touchStatus !== Status.ACCEPTED || mouseStatus !== Status.ACCEPTED;
    if (mouseStatus === Status.ACCEPTED) this.mouseContacts = 0;
    if (touchStatus !== Status.ACCEPTED) this.lastFailure = this.touch.snapshot().lastFailure ?? {kind:'native_error',error:'Windows touch reset failed'};
    return this.blocked ? Status.INVALID_STATE : Status.ACCEPTED;
  }
  snapshot() {
    return {...this.touch.snapshot(),initialized:this.initialized,mode:this.mode,
      activeContacts:this.mode === 'mouse' ? this.mouseContacts : this.touch.snapshot().activeContacts,
      cleanupPending:this.blocked,lastFailure:this.lastFailure};
  }
}
