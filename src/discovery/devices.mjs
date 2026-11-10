const SERVICE_PROTOCOLS = Object.freeze({
  webcast: new Set(['_nearcast._tcp.local.']),
});
const PRIVATE_TXT_KEYS = new Set(['token', 'room', 'roomcode', 'paircode', 'password', 'secret']);

const stripServiceSuffix = (instance, serviceType) => String(instance ?? '').replace(new RegExp(`\\.${serviceType.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}$`, 'i'), '').replace(/\.$/, '');
const text = value => typeof value === 'string' ? value.trim() : '';
const capabilityTokens = value => new Set(String(value ?? '').split(/[\s,;]+/).map(token => token.trim().toLowerCase()).filter(Boolean).slice(0, 32));
const canonicalDeviceId = value => text(value).toLowerCase().replace(/[^a-z0-9]/g, '');
const secureEndpoint = (txt, hostname, addresses, port) => {
  const advertised = text(txt.endpoint || txt.url || txt.wss || txt.https);
  if (advertised) {
    let url; try { url = new URL(advertised); } catch { throw new RangeError('webcast endpoint'); }
    if (!['https:', 'wss:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new RangeError('webcast endpoint must be TLS without credentials');
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new RangeError('webcast SRV port');
  const build = host => {
    if (!host || /[\s/@?#\\]/.test(host)) throw new RangeError('webcast resolved endpoint');
    const authority = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
    const url = new URL(`https://${authority}:${port}`);
    if (url.username || url.password || url.pathname !== '/') throw new RangeError('webcast resolved endpoint');
    return url.origin;
  };
  const resolvedEndpoints = [...new Set([...addresses, ...(hostname ? [hostname] : [])].map(build))];
  if (!resolvedEndpoints.length) throw new RangeError('webcast resolved endpoint required');
  return {endpoint: hostname ? build(hostname) : resolvedEndpoints[0], resolvedEndpoints};
};

export function normalizeDiscoveryDevice(service, nowMs = Number(service?.nowMs ?? Date.now())) {
  const serviceType = text(service?.serviceType ?? service?.service_type).toLowerCase();
  const protocol = SERVICE_PROTOCOLS.webcast.has(serviceType) ? 'webcast' : null;
  if (!protocol) throw new RangeError('unsupported discovery service');
  const txt = service?.txt ?? {};
  for (const key of Object.keys(txt)) if (PRIVATE_TXT_KEYS.has(String(key).toLowerCase())) throw new RangeError('private discovery field');
  const addresses = Array.isArray(service?.addresses) ? service.addresses.map(text).filter(Boolean) : [];
  const hostname = text(service?.hostname).replace(/\.$/, '');
  const port = Number(service?.port ?? 0);
  const displayName = text(txt.display) || stripServiceSuffix(text(service?.instance), serviceType) || hostname || 'Unknown device';
  const rawCapabilities = capabilityTokens(txt.capability);
  const isWebCast = rawCapabilities.has('webcast');
  const capabilities = isWebCast ? rawCapabilities : new Set();
  const {endpoint = '', resolvedEndpoints = []} = isWebCast ? secureEndpoint(txt, hostname, addresses, port) : {};
  const advertisedDeviceId = text(txt.deviceId || txt.device_id || txt.id);
  const hardwareId = canonicalDeviceId(advertisedDeviceId || txt.deviceid);
  const discoveryId = hardwareId ? `${protocol}:${hardwareId}` : `${protocol}:${text(service?.instance) || displayName}`;
  const ttlSeconds = Number(txt.ttl ?? 60);
  if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0) throw new RangeError('ttl');
  if (isWebCast && !endpoint) throw new RangeError('webcast endpoint');
  return {
    discoveryId,
    deviceId: isWebCast ? (advertisedDeviceId || null) : null,
    protocol,
    displayName: displayName.slice(0, 128),
    instance: text(service?.instance),
    hostname,
    addresses,
    port,
    endpoint: endpoint || null,
    resolvedEndpoints,
    model: text(txt.model),
    version: text(txt.version || txt.srcvers),
    capability: isWebCast ? text(txt.capability) : '',
    capabilities,
    supportsCodeDisplay: isWebCast && capabilities.has('code-display-v1'),
    supportsTrustDisplay: isWebCast && capabilities.has('trust-display-v1'),
    supportsTouchback: isWebCast && capabilities.has('touchback-v1'),
    authorized: false,
    selectable: isWebCast,
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

