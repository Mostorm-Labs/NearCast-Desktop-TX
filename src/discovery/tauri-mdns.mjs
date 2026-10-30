import {parseNearCastService} from './nearcast.mjs';

export class TauriMdnsDiscovery {
  constructor({invoke, listen, now = () => Date.now()} = {}) {
    if (typeof invoke !== 'function' || typeof listen !== 'function') throw new TypeError('Tauri invoke/listen required');
    this.invoke = invoke;
    this.listen = listen;
    this.now = now;
    this.unsubscribe = null;
    this.onLease = null;
  }
  async start(onLease) {
    this.onLease = onLease;
    this.unsubscribe = await this.listen('nearcast://mdns-service', event => {
      try { const lease = parseNearCastService({...event.payload, nowMs: this.now()}); this.onLease?.(lease); } catch { /* malformed or private TXT is ignored */ }
    });
    await this.invoke('nearcast_mdns_start', {service: '_nearcast._tcp'});
  }
  async stop() {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.onLease = null;
    await this.invoke('nearcast_mdns_stop', {});
  }
}
