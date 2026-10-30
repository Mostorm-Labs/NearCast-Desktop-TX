import {DiscoveryRegistry, normalizeDiscoveryDevice} from './devices.mjs';

export class TauriDeviceDiscovery {
  constructor({invoke, listen, now = () => Date.now()} = {}) {
    if (typeof invoke !== 'function' || typeof listen !== 'function') throw new TypeError('Tauri invoke/listen required');
    this.invoke = invoke;
    this.listen = listen;
    this.now = now;
    this.registry = new DiscoveryRegistry();
    this.unsubscribers = [];
    this.timer = null;
  }
  async start(onChange) {
    const emit = () => onChange?.(this.registry.list(this.now()));
    this.unsubscribers.push(await this.listen('nearcast://mdns-service', event => {
      try { this.registry.upsert(normalizeDiscoveryDevice(event.payload, this.now())); emit(); } catch { /* malformed service is ignored */ }
    }));
    this.unsubscribers.push(await this.listen('nearcast://mdns-service-removed', event => {
      const instance = event.payload?.instance;
      for (const device of this.registry.list(this.now())) if (device.instance === instance) this.registry.remove(device.discoveryId);
      emit();
    }));
    this.timer = setInterval(emit, 1000);
    await this.invoke('nearcast_mdns_start', {services: ['_nearcast._tcp', '_airplay._tcp', '_raop._tcp']});
    emit();
  }
  async stop() {
    for (const unsubscribe of this.unsubscribers.splice(0)) unsubscribe?.();
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.invoke('nearcast_mdns_stop', {});
  }
}
