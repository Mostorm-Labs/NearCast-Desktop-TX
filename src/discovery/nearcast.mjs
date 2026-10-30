const MAX_TTL_MS = 5 * 60 * 1000;
const PRIVATE_KEYS = new Set(['token', 'room', 'roomCode', 'pairCode', 'password', 'secret']);

export function parseNearCastService(service) {
  const txt = service?.txt ?? {};
  for (const key of Object.keys(txt)) if (PRIVATE_KEYS.has(key)) throw new RangeError('private discovery field');
  const discoveryId = String(txt.id ?? '').trim(); const endpoint = String(txt.endpoint ?? '').trim();
  if (!discoveryId || discoveryId.length > 128) throw new RangeError('discovery id');
  let parsed; try { parsed = new URL(endpoint); } catch { throw new RangeError('endpoint'); }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'wss:') throw new RangeError('endpoint must be TLS');
  const ttlSeconds = Number(txt.ttl ?? 60); if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0) throw new RangeError('ttl');
  const nowMs = Number(service.nowMs ?? Date.now()); const ttlMs = Math.min(MAX_TTL_MS, ttlSeconds * 1000);
  const port = service.port ?? parsed.port ?? '443';
  return {discoveryId, displayName: String(txt.display ?? service.instance ?? '').slice(0, 128), endpoint, hostname: String(service.hostname ?? '').replace(/\.$/, ''), port: Number(port), version: String(txt.version ?? ''), capability: String(txt.capability ?? ''), authorized: false, expiresAt: nowMs + ttlMs};
}

export class DiscoveryRegistry {
  constructor() { this.entries = new Map(); }
  upsert(entry) { if (!entry?.discoveryId || !Number.isFinite(entry.expiresAt)) throw new TypeError('invalid lease'); this.entries.set(entry.discoveryId, {...entry, authorized: false}); }
  expire(nowMs = Date.now()) { let count = 0; for (const [id, entry] of this.entries) if (entry.expiresAt <= nowMs) { this.entries.delete(id); count += 1; } return count; }
  remove(id) { return this.entries.delete(id); }
  list(nowMs = Date.now()) { this.expire(nowMs); return [...this.entries.values()].map(entry => ({...entry})); }
}
