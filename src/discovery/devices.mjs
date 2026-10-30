const SERVICE_PROTOCOLS = Object.freeze({
  airplay: new Set(['_airplay._tcp.local.', '_raop._tcp.local.']),
  webcast: new Set(['_nearcast._tcp.local.']),
});

const stripServiceSuffix = (instance, serviceType) => String(instance ?? '').replace(new RegExp(`\\.${serviceType.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}$`, 'i'), '').replace(/\.$/, '');
const text = value => typeof value === 'string' ? value.trim() : '';
const capabilityTokens = value => new Set(String(value ?? '').split(/[\s,;]+/).map(token => token.trim().toLowerCase()).filter(Boolean).slice(0, 32));
const canonicalDeviceId = value => text(value).toLowerCase().replace(/[^a-z0-9]/g, '');
const instanceHardwareId = instance => {
  const match = text(instance).match(/^([0-9a-f]{2}(?:[-:][0-9a-f]{2}){5})@/i);
  return match ? canonicalDeviceId(match[1]) : '';
};
const secureEndpoint = (service, txt, hostname, port) => {
  const advertised = text(txt.endpoint || txt.url || txt.wss || txt.https);
  if (advertised) return advertised;
  const host = hostname || (Array.isArray(service?.addresses) ? text(service.addresses[0]) : '');
  if (!host) return '';
  const authority = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  return `https://${authority}:${port || 443}`;
};

export function normalizeDiscoveryDevice(service, nowMs = Number(service?.nowMs ?? Date.now())) {
  const serviceType = text(service?.serviceType ?? service?.service_type).toLowerCase();
  const protocol = SERVICE_PROTOCOLS.airplay.has(serviceType) ? 'airplay' : SERVICE_PROTOCOLS.webcast.has(serviceType) ? 'webcast' : null;
  if (!protocol) throw new RangeError('unsupported discovery service');
  const txt = service?.txt ?? {};
  const addresses = Array.isArray(service?.addresses) ? service.addresses.map(text).filter(Boolean) : [];
  const hostname = text(service?.hostname).replace(/\.$/, '');
  const port = Number(service?.port ?? 0);
  let displayName = text(txt.display) || stripServiceSuffix(text(service?.instance), serviceType) || hostname || 'Unknown device';
  if (serviceType === '_raop._tcp.local.' && displayName.includes('@')) displayName = displayName.slice(displayName.indexOf('@') + 1);
  const endpoint = protocol === 'webcast' ? secureEndpoint(service, txt, hostname, port) : '';
  const advertisedDeviceId = text(txt.deviceId || txt.device_id || txt.id);
  const hardwareId = canonicalDeviceId(advertisedDeviceId || txt.deviceid) || (serviceType === '_raop._tcp.local.' ? instanceHardwareId(service?.instance) : '');
  const discoveryId = hardwareId ? `${protocol}:${hardwareId}` : `${protocol}:${text(service?.instance) || displayName}`;
  const ttlSeconds = Number(txt.ttl ?? 60);
  if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0) throw new RangeError('ttl');
  if (protocol === 'webcast' && !endpoint) throw new RangeError('webcast endpoint');
  return {
    discoveryId,
    deviceId: protocol === 'webcast' ? (advertisedDeviceId || null) : null,
    protocol,
    displayName: displayName.slice(0, 128),
    instance: text(service?.instance),
    hostname,
    addresses,
    port,
    endpoint: endpoint || null,
    model: text(txt.model),
    version: text(txt.version || txt.srcvers),
    capability: text(txt.capability),
    capabilities: capabilityTokens(txt.capability),
    supportsCodeDisplay: capabilityTokens(txt.capability).has('code-display-v1'),
    supportsTouchback: capabilityTokens(txt.capability).has('touchback-v1'),
    authorized: false,
    selectable: protocol === 'webcast',
    expiresAt: nowMs + Math.min(5 * 60 * 1000, ttlSeconds * 1000),
  };
}

export class DiscoveryRegistry {
  constructor() { this.entries = new Map(); }
  upsert(entry) { if (!entry?.discoveryId || !Number.isFinite(entry.expiresAt)) throw new TypeError('invalid lease'); this.entries.set(entry.discoveryId, {...entry}); }
  remove(id) { return this.entries.delete(id); }
  expire(nowMs = Date.now()) { let count = 0; for (const [id, entry] of this.entries) if (entry.expiresAt <= nowMs) { this.entries.delete(id); count += 1; } return count; }
  list(nowMs = Date.now()) { this.expire(nowMs); return [...this.entries.values()].sort((a, b) => a.protocol.localeCompare(b.protocol) || a.displayName.localeCompare(b.displayName)); }
}

export {SERVICE_PROTOCOLS};

