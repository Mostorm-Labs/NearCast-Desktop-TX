const RESOLUTION_VALUES = Object.freeze({
  auto: null,
  '1280x720': {width: 1280, height: 720},
  '1920x1080': {width: 1920, height: 1080},
  '2560x1440': {width: 2560, height: 1440},
  '3840x2160': {width: 3840, height: 2160},
});

export const DEFAULT_VIDEO_QUALITY = Object.freeze({resolution: '1920x1080', bitrateMode: 'fixed', bitrateKbps: 12000});
export const VIDEO_RESOLUTIONS = Object.freeze(Object.keys(RESOLUTION_VALUES));
export const VIDEO_BITRATES_KBPS = Object.freeze([2000, 4000, 8000, 12000, 20000]);

const integer = value => Number.isInteger(value) ? value : Number.parseInt(value, 10);

export function normalizeVideoQuality(value = {}) {
  const resolution = RESOLUTION_VALUES[value.resolution] ? value.resolution : 'auto';
  const bitrateMode = value.bitrateMode === 'fixed' ? 'fixed' : 'dynamic';
  const parsed = integer(value.bitrateKbps);
  const bitrateKbps = Number.isFinite(parsed) ? Math.min(50000, Math.max(250, parsed)) : DEFAULT_VIDEO_QUALITY.bitrateKbps;
  return {resolution, bitrateMode, bitrateKbps};
}

export function videoCaptureConstraints(quality = DEFAULT_VIDEO_QUALITY) {
  const normalized = normalizeVideoQuality(quality);
  const dimensions = RESOLUTION_VALUES[normalized.resolution];
  return dimensions ? {width: {ideal: dimensions.width}, height: {ideal: dimensions.height}} : true;
}

export async function applyVideoTrackConstraints(track, quality = DEFAULT_VIDEO_QUALITY) {
  if (!track || typeof track.applyConstraints !== 'function') return false;
  const constraints = videoCaptureConstraints(quality);
  if (constraints === true) return false;
  await track.applyConstraints(constraints);
  return true;
}

export async function applyVideoEncodingParameters(sender, quality = DEFAULT_VIDEO_QUALITY) {
  if (!sender || typeof sender.getParameters !== 'function' || typeof sender.setParameters !== 'function') return false;
  const normalized = normalizeVideoQuality(quality);
  const parameters = sender.getParameters() || {};
  const encodings = Array.isArray(parameters.encodings) && parameters.encodings.length ? parameters.encodings : [{}];
  parameters.encodings = encodings.map(encoding => {
    const next = {...encoding};
    next.maxBitrate = normalized.bitrateKbps * 1000;
    next.maxFramerate = 60;
    next.scaleResolutionDownBy = 1;
    return next;
  });
  parameters.degradationPreference = normalized.bitrateMode === 'fixed' ? 'maintain-resolution' : 'balanced';
  await sender.setParameters(parameters);
  return true;
}
