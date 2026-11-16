const number = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
const difference = (current, previous) => number(current) !== null && number(previous) !== null && current >= previous ? current - previous : null;
const rate = (delta, seconds, scale = 1) => delta !== null && seconds > 0 ? delta * scale / seconds : null;
const reasons = new Set(['none', 'cpu', 'bandwidth', 'other']);

// Read existing WebRTC counters only. Never retain SDP, addresses, track labels
// or candidate identifiers in the published diagnostic snapshot.
export class MediaDiagnosticsReader {
  constructor() { this.previous = new WeakMap(); }

  async read(sender) {
    const track = sender?.track;
    if (!track || typeof sender.getStats !== 'function') return null;
    const report = await sender.getStats();
    if (sender.track !== track) return null;
    const rows = [...report.values()];
    const row = rows.find(value => value.type === 'outbound-rtp' && !value.isRemote && (value.kind ?? value.mediaType) === track.kind);
    if (!row) return null;
    const result = {
      framesSent: number(row.framesSent), framesEncoded: number(row.framesEncoded),
      framesPerSecond: number(row.framesPerSecond), totalEncodeTime: number(row.totalEncodeTime),
      qualityLimitationReason: reasons.has(row.qualityLimitationReason) ? row.qualityLimitationReason : null,
    };
    if (track.kind !== 'video') return result;
    const candidates = rows.filter(value => value.type === 'media-source' && value.kind === 'video');
    const source = report.get(row.mediaSourceId) ?? (candidates.length === 1 ? candidates[0] : {});
    const transport = report.get(row.transportId);
    const pair = report.get(transport?.selectedCandidatePairId);
    const remote = report.get(row.remoteId) ?? rows.find(value => value.type === 'remote-inbound-rtp' && value.localId === row.id);
    const previous = this.previous.get(sender);
    const same = previous?.track === track && previous.row.id === row.id && previous.row.ssrc === row.ssrc && previous.source.id === source.id;
    const seconds = same ? difference(row.timestamp, previous.row.timestamp) / 1000 : 0;
    const sourceSeconds = same ? difference(source.timestamp, previous.source.timestamp) / 1000 : 0;
    const encoded = same ? difference(row.framesEncoded, previous.row.framesEncoded) : null;
    const encodeTime = same ? difference(row.totalEncodeTime, previous.row.totalEncodeTime) : null;
    const codec = report.get(row.codecId)?.mimeType?.toLowerCase();
    const durations = row.qualityLimitationDurations ?? {};
    Object.assign(result, {
      frameWidth: number(row.frameWidth), frameHeight: number(row.frameHeight),
      sourceWidth: number(source.width), sourceHeight: number(source.height),
      sourceFrames: number(source.frames), sourceFramesPerSecond: number(source.framesPerSecond),
      sourceIntervalFps: rate(same ? difference(source.frames, previous.source.frames) : null, sourceSeconds),
      intervalMs: seconds > 0 ? seconds * 1000 : null,
      encodedIntervalFps: rate(encoded, seconds),
      sentIntervalFps: rate(same ? difference(row.framesSent, previous.row.framesSent) : null, seconds),
      encodeMsPerFrame: encoded > 0 && encodeTime !== null ? encodeTime * 1000 / encoded : null,
      sendKbps: rate(same ? difference(row.bytesSent, previous.row.bytesSent) : null, seconds, 8 / 1000),
      bytesSent: number(row.bytesSent), targetBitrate: number(row.targetBitrate),
      availableOutgoingBitrate: number(pair?.availableOutgoingBitrate),
      roundTripTimeMs: number(pair?.currentRoundTripTime) === null ? null : pair.currentRoundTripTime * 1000,
      packetsLost: typeof remote?.packetsLost === 'number' && Number.isFinite(remote.packetsLost) ? remote.packetsLost : null,
      fractionLost: number(remote?.fractionLost), retransmittedPacketsSent: number(row.retransmittedPacketsSent),
      nackCount: number(row.nackCount), pliCount: number(row.pliCount),
      qualityCpuSeconds: number(durations.cpu), qualityBandwidthSeconds: number(durations.bandwidth),
      qualityNoneSeconds: number(durations.none), qualityOtherSeconds: number(durations.other),
      powerEfficientEncoder: typeof row.powerEfficientEncoder === 'boolean' ? row.powerEfficientEncoder : null,
      codec: new Set(['video/h264', 'video/vp8', 'video/vp9', 'video/av1', 'video/h265']).has(codec) ? codec.split('/')[1] : 'unknown',
    });
    // Copy cumulative rows so a mutable/mock report cannot corrupt the baseline.
    this.previous.set(sender, {track, row: {...row}, source: {...source}});
    return result;
  }
}
