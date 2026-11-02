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
    this.generation = 0;
  }
  async start(onChange) {
    const generation = ++this.generation;
    const emit = () => onChange?.(this.registry.list(this.now()));
    const records = new Map();
    this.unsubscribers.push(await this.listen('nearcast://mdns-snapshot', event => {
      if (generation !== this.generation) return;
      const {service_type: serviceType, services, lease_ms: leaseMs} = event.payload ?? {};
      if (!['_nearcast._tcp.local.', '_airplay._tcp.local.', '_raop._tcp.local.'].includes(serviceType) || !Array.isArray(services) || !Number.isFinite(leaseMs) || leaseMs <= 0) return;
      const now = this.now(); const valid = [];
      for (const service of services) {
        if ((service.service_type ?? service.serviceType) !== serviceType) continue;
        try { valid.push({...normalizeDiscoveryDevice(service, now), expiresAt: now + Math.min(45000, leaseMs)}); } catch { /* ignore malformed records */ }
      }
      const currentKeys = new Set(valid.map(device => device.instance));
      for (const [key, device] of records) if (device.serviceType === serviceType && !currentKeys.has(device.instance)) records.delete(key);
      for (const device of valid) records.set(`${serviceType}:${device.instance}`, {...device, serviceType});
      // Rebuild both service families so removing RAOP cannot remove surviving AirPlay.
      this.registry.entries.clear();
      for (const device of records.values()) if (device.expiresAt > now) this.registry.upsert(device);
      emit();
    }));
    this.unsubscribers.push(await this.listen('nearcast://mdns-service', event => {
      if (generation !== this.generation) return;
      try { this.registry.upsert(normalizeDiscoveryDevice(event.payload, this.now())); emit(); } catch { /* malformed service is ignored */ }
    }));
    this.unsubscribers.push(await this.listen('nearcast://mdns-service-removed', event => {
      if (generation !== this.generation) return;
      const instance = event.payload?.instance;
      for (const device of this.registry.list(this.now())) if (device.instance === instance) this.registry.remove(device.discoveryId);
      emit();
    }));
    this.timer = setInterval(emit, 1000);
    await this.invoke('nearcast_mdns_start', {services: ['_nearcast._tcp', '_airplay._tcp', '_raop._tcp']});
    emit();
  }
  async stop() {
    this.generation++;
    for (const unsubscribe of this.unsubscribers.splice(0)) unsubscribe?.();
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.registry.entries.clear();
    await this.invoke('nearcast_mdns_stop', {});
  }
}
