// Endpoints, candidates and cache paths are owned by native code.
export class UpdateManager {
  constructor({invoke = globalThis.__TAURI__?.core?.invoke, onChange = () => {}, beforeInstall = async () => {}, setTimer = (callback,delay) => setTimeout(callback,delay), clearTimer = handle => clearTimeout(handle)} = {}) {
    Object.assign(this, {invoke, onChange, beforeInstall, setTimer, clearTimer});
    this.state = {status:'idle', currentVersion:'', update:null, error:null, prompt:false};
    this.dismissed = new Set();
    this.timer = null; this.busy = false; this.stopped = false; this.failures = 0;
  }
  apply(value = {}) {
    this.state = {...this.state, ...value};
    this.onChange(this.state);
    return this.state;
  }
  offer(startup) {
    const version = this.state.update?.version;
    if (startup && version && !this.dismissed.has(version)) this.apply({prompt:true});
  }
  dismiss() {
    if (this.state.update) this.dismissed.add(this.state.update.version);
    this.apply({prompt:false});
  }
  open() { this.apply({prompt:true}); }
  async start({schedule = true} = {}) {
    this.scheduled = schedule;
    try { this.apply(await this.invoke('nearcast_update_initialize')); this.offer(true); }
    catch(error) { this.apply({error:String(error?.message ?? error)}); }
    return this.check({startup:true});
  }
  async check({startup = false} = {}) {
    if (this.busy || this.stopped) return this.state;
    this.busy = true;
    const previous = this.state;
    this.apply({checking:true, error:null});
    try {
      this.apply(await this.invoke('nearcast_update_check'));
      this.offer(startup);
      if(this.state.status === 'available') {
        this.apply({status:'downloading'});
        this.apply(await this.invoke('nearcast_update_download'));
      }
      this.failures = 0;
    } catch(error) {
      this.failures++;
      const sameCachedUpdate = previous.status === 'ready' && previous.update?.version === this.state.update?.version;
      this.apply({status:sameCachedUpdate ? 'ready' : this.state.update ? 'available' : 'error', error:String(error?.message ?? error)});
    } finally {
      this.busy = false; this.apply({checking:false});
      if(this.scheduled && !this.stopped) {
        this.clearTimer(this.timer);
        const delay = this.failures ? Math.min(30 * 60_000, 60_000 * 2 ** Math.min(this.failures - 1, 5)) : 4 * 60 * 60_000;
        this.timer = this.setTimer(() => void this.check(), delay);
      }
    }
    return this.state;
  }
  async install() {
    if (this.busy || this.state.status !== 'ready') return this.state;
    this.busy = true;
    this.apply({installing:true,error:null});
    try {
      await this.beforeInstall();
      this.apply(await this.invoke('nearcast_update_install'));
    } catch(error) { this.apply({status:'ready',error:String(error?.message ?? error),installing:false}); }
    finally { this.busy = false; }
    return this.state;
  }
  stop() { this.stopped = true; this.clearTimer(this.timer); }
}
