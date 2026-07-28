import { createAudioBuffer } from "./wav-utils.js";

export const FORGE_SAMPLE_RATE = 96000;

export const DEFAULT_FORGE_CONFIG = Object.freeze({
  seed: 20260728,
  sampleRate: FORGE_SAMPLE_RATE,
  sourceCount: 8,
  whooshCount: 12,
  outputCount: 8,
  sourceDuration: [8, 14],
  whooshDuration: [10, 18],
  outputDuration: [20, 30],
  variation: 0.7,
  tonal: 0.72,
  motion: 0.78,
  violence: 0.82,
});

const SCALES = {
  DORIAN: [0, 2, 3, 5, 7, 9, 10],
  LYDIAN: [0, 2, 4, 6, 7, 9, 11],
  MINOR: [0, 2, 3, 5, 7, 8, 10],
  PENTATONIC: [0, 2, 4, 7, 9],
};

const SCALE_NAMES = Object.keys(SCALES);
const CROSSOVERS = [90, 360, 1800, 6500];
const SPEED_OF_SOUND = 343;
const EPSILON = 1e-12;

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const dbToGain = (db) => 10 ** (db / 20);
const midiToFrequency = (midi) => 440 * 2 ** ((midi - 69) / 12);
const randomBetween = (rng, range) => range[0] + rng() * (range[1] - range[0]);
const pick = (rng, values) => values[Math.floor(rng() * values.length)];

export const hashForgeSeed = (seed) => {
  let value = Number(seed) || 1;
  value ^= value >>> 16;
  value = Math.imul(value, 0x7feb352d);
  value ^= value >>> 15;
  value = Math.imul(value, 0x846ca68b);
  value ^= value >>> 16;
  return value >>> 0;
};

export const createForgeRandom = (seed) => {
  let state = hashForgeSeed(seed);
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
};

export const createForgeDna = (seed) => {
  const rng = createForgeRandom(seed);
  const scaleName = pick(rng, SCALE_NAMES);
  return {
    seed: hashForgeSeed(seed),
    scaleName,
    scale: SCALES[scaleName],
    rootMidi: 38 + Math.floor(rng() * 8),
    peakRatio: 0.4 + rng() * 0.2,
    direction: rng() > 0.5 ? 1 : -1,
    familyMotion: 0.72 + rng() * 0.24,
  };
};

const abortError = () => new DOMException("Forge render cancelled", "AbortError");

const assertActive = (signal) => {
  if (signal?.aborted) throw abortError();
};

const makeSaturationCurve = (drive = 2.5, mix = 0.7) => {
  const curve = new Float32Array(32768);
  const normalization = Math.tanh(drive);
  for (let index = 0; index < curve.length; index += 1) {
    const input = index * 2 / (curve.length - 1) - 1;
    const saturated = Math.tanh(input * drive) / Math.max(EPSILON, normalization);
    curve[index] = input * (1 - mix) + saturated * mix;
  }
  return curve;
};

const makeCeilingCurve = (ceilingDb = -1) => {
  const ceiling = dbToGain(ceilingDb);
  const curve = new Float32Array(32768);
  for (let index = 0; index < curve.length; index += 1) {
    const input = index * 2 / (curve.length - 1) - 1;
    curve[index] = clamp(input, -ceiling, ceiling);
  }
  return curve;
};

const createFilter = (context, type, frequency, q = Math.SQRT1_2) => {
  const filter = context.createBiquadFilter();
  filter.type = type;
  filter.frequency.value = frequency;
  filter.Q.value = q;
  return filter;
};

const connectSeries = (nodes) => {
  for (let index = 0; index < nodes.length - 1; index += 1) {
    nodes[index].connect(nodes[index + 1]);
  }
};

const scaleFrequency = (dna, degree, octave = 0) => {
  const scaleLength = dna.scale.length;
  const wrapped = ((degree % scaleLength) + scaleLength) % scaleLength;
  const octaveOffset = Math.floor(degree / scaleLength) * 12;
  return midiToFrequency(dna.rootMidi + dna.scale[wrapped] + octaveOffset + octave * 12);
};

const scheduleEnvelope = (gain, start, attack, peak, hold, release) => {
  gain.setValueAtTime(0.0001, start);
  gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), start + attack);
  gain.setValueAtTime(Math.max(0.0002, peak * 0.82), start + attack + hold);
  gain.exponentialRampToValueAtTime(0.0001, start + attack + hold + release);
};

const scheduleOscillator = ({
  context,
  destination,
  frequency,
  start,
  duration,
  level,
  type,
  pan = 0,
  sweep = 1,
}) => {
  const oscillator = context.createOscillator();
  const envelope = context.createGain();
  const panner = context.createStereoPanner();
  oscillator.type = type;
  oscillator.frequency.setValueAtTime(Math.max(18, frequency), start);
  oscillator.frequency.exponentialRampToValueAtTime(
    Math.max(18, frequency * sweep),
    start + Math.max(0.03, duration * 0.82),
  );
  scheduleEnvelope(
    envelope.gain,
    start,
    Math.min(0.045, duration * 0.12),
    level,
    duration * 0.46,
    Math.max(0.035, duration * 0.4),
  );
  panner.pan.value = clamp(pan, -1, 1);
  oscillator.connect(envelope);
  envelope.connect(panner);
  panner.connect(destination);
  oscillator.start(start);
  oscillator.stop(start + duration + 0.08);
};

const scheduleSourceScene = (context, destination, dna, rng, duration, config) => {
  const eventCount = Math.max(5, Math.floor(duration * (0.7 + config.variation * 0.55)));
  const eventStep = Math.max(0.48, (duration - 1.2) / eventCount);
  for (let event = 0; event < eventCount; event += 1) {
    const start = 0.18 + event * eventStep + rng() * eventStep * 0.28;
    const degree = Math.floor(rng() * dna.scale.length) + (rng() > 0.76 ? dna.scale.length : 0);
    const gesture = pick(rng, ["DROP", "RISE", "PULSE", "GLIDE"]);
    const titanBase = scaleFrequency(dna, degree - dna.scale.length, -1);
    const titanDuration = 0.9 + rng() * 1.7;
    const titanSweep = gesture === "DROP"
      ? 0.72 + rng() * 0.2
      : gesture === "RISE" ? 1.12 + rng() * 0.34 : 0.94 + rng() * 0.13;
    scheduleOscillator({
      context,
      destination,
      frequency: titanBase,
      start,
      duration: titanDuration,
      level: 0.11 + rng() * 0.08,
      type: "sine",
      pan: -0.12,
      sweep: titanSweep,
    });
    scheduleOscillator({
      context,
      destination,
      frequency: titanBase * 2.002,
      start: start + 0.012,
      duration: titanDuration * 0.9,
      level: 0.045 + rng() * 0.045,
      type: rng() > 0.5 ? "triangle" : "sine",
      pan: 0.12,
      sweep: titanSweep,
    });

    const kawaiiNotes = 2 + Math.floor(rng() * 3);
    for (let note = 0; note < kawaiiNotes; note += 1) {
      const noteDegree = degree + pick(rng, [0, 1, 2, 4]);
      const onset = start + 0.06 + note * (0.035 + rng() * 0.11);
      scheduleOscillator({
        context,
        destination,
        frequency: scaleFrequency(dna, noteDegree, 1),
        start: onset,
        duration: 0.22 + rng() * 0.72,
        level: (0.045 + rng() * 0.055) / Math.sqrt(kawaiiNotes),
        type: pick(rng, ["sine", "triangle", "square"]),
        pan: -0.65 + note / Math.max(1, kawaiiNotes - 1) * 1.3,
        sweep: 0.96 + rng() * 0.11,
      });
    }

    const prismPartials = 3 + Math.floor(rng() * 4);
    for (let partial = 0; partial < prismPartials; partial += 1) {
      const onset = start + 0.14 + rng() * 0.35;
      scheduleOscillator({
        context,
        destination,
        frequency: scaleFrequency(dna, degree + partial, 2) * (1 + partial * 0.003),
        start: onset,
        duration: 0.6 + rng() * 1.5,
        level: (0.024 + rng() * 0.035) / Math.sqrt(prismPartials),
        type: partial % 3 === 0 ? "triangle" : "sine",
        pan: -0.9 + rng() * 1.8,
        sweep: pick(rng, [0.75, 1, 1.25, 1.5]),
      });
    }
  }
};

const renderSource = async (config, dna, seed, index, signal) => {
  assertActive(signal);
  const rng = createForgeRandom(seed);
  const duration = randomBetween(rng, config.sourceDuration);
  const frameCount = Math.ceil(duration * config.sampleRate);
  const context = new OfflineAudioContext(2, frameCount, config.sampleRate);
  const sourceBus = context.createGain();
  const dry = context.createGain();
  const delay = context.createDelay(1.5);
  const feedback = context.createGain();
  const delayFilter = createFilter(context, "lowpass", 1800 + rng() * 6800);
  const delayWet = context.createGain();
  const split = context.createChannelSplitter(2);
  const merge = context.createChannelMerger(2);
  const leftAllpass = createFilter(context, "allpass", 180 + rng() * 4200, 3 + rng() * 11);
  const rightAllpass = createFilter(context, "allpass", 230 + rng() * 5200, 3 + rng() * 11);
  const disperseWet = context.createGain();
  const highpass = createFilter(context, "highpass", 20);
  const saturation = context.createWaveShaper();
  const compressor = context.createDynamicsCompressor();
  const master = context.createGain();

  dry.gain.value = 0.72;
  delay.delayTime.value = 0.06 + rng() * 0.32;
  feedback.gain.value = 0.1 + rng() * 0.32;
  delayWet.gain.value = 0.1 + rng() * 0.24;
  disperseWet.gain.value = 0.08 + rng() * 0.22;
  saturation.curve = makeSaturationCurve(1.4 + config.violence * 1.8, 0.28 + config.violence * 0.34);
  saturation.oversample = "2x";
  compressor.threshold.value = -12;
  compressor.knee.value = 8;
  compressor.ratio.value = 3;
  compressor.attack.value = 0.008;
  compressor.release.value = 0.14;
  master.gain.setValueAtTime(0.0001, 0);
  master.gain.linearRampToValueAtTime(0.82, 0.08);
  master.gain.setValueAtTime(0.82, Math.max(0.1, duration - 0.12));
  master.gain.linearRampToValueAtTime(0.0001, duration);

  sourceBus.connect(dry);
  dry.connect(highpass);
  sourceBus.connect(delay);
  delay.connect(delayFilter);
  delayFilter.connect(feedback);
  feedback.connect(delay);
  delayFilter.connect(delayWet);
  delayWet.connect(highpass);
  sourceBus.connect(split);
  split.connect(leftAllpass, 0);
  split.connect(rightAllpass, 1);
  leftAllpass.connect(merge, 0, 0);
  rightAllpass.connect(merge, 0, 1);
  merge.connect(disperseWet);
  disperseWet.connect(highpass);
  connectSeries([highpass, saturation, compressor, master, context.destination]);
  scheduleSourceScene(context, sourceBus, dna, rng, duration, config);
  const buffer = await context.startRendering();
  assertActive(signal);
  return {
    id: `source-${String(index + 1).padStart(2, "0")}`,
    seed,
    duration,
    buffer,
    transforms: [
      "MOD_DELAY",
      "DISPERSER",
      pick(rng, ["PITCH_DRIFT", "MICRO_GRAIN", "REVERSE_GESTURE"]),
      pick(rng, ["TAPE_COLOR", "HARMONIC_FOLD", "GLASS_DRIVE"]),
    ],
  };
};

const automateDopplerPath = ({
  delay,
  reflectionDelay,
  gain,
  reflectionGain,
  pan,
  reflectionPan,
  filter,
  duration,
  peakRatio,
  direction,
  rng,
  motion,
}) => {
  const startDistance = 45 + rng() * 85 * motion;
  const endDistance = 55 + rng() * 95 * motion;
  const lateral = 3 + rng() * 16;
  const sourceHeight = 0.6 + rng() * 5;
  const listenerHeight = 1.65;
  const approachPower = 0.72 + rng() * 0.9;
  const awayPower = 0.72 + rng() * 1.15;
  const steps = 72;
  for (let step = 0; step <= steps; step += 1) {
    const ratio = step / steps;
    let x;
    if (ratio <= peakRatio) {
      const progress = (ratio / peakRatio) ** approachPower;
      x = -startDistance * (1 - progress);
    } else {
      const progress = ((ratio - peakRatio) / (1 - peakRatio)) ** awayPower;
      x = endDistance * progress;
    }
    x *= direction;
    const distance = Math.sqrt(x * x + lateral * lateral + sourceHeight * sourceHeight);
    const reflectedDistance = Math.sqrt(
      x * x + lateral * lateral + (sourceHeight + listenerHeight) ** 2,
    );
    const time = ratio * duration;
    const directLevel = clamp(3.4 / Math.sqrt(distance + 1), 0.13, 0.94);
    const floorLevel = directLevel * (0.12 + rng() * 0.08);
    delay.delayTime.setValueAtTime(distance / SPEED_OF_SOUND, time);
    reflectionDelay.delayTime.setValueAtTime(reflectedDistance / SPEED_OF_SOUND, time);
    gain.gain.setValueAtTime(directLevel, time);
    reflectionGain.gain.setValueAtTime(floorLevel, time);
    const panValue = clamp((x / (Math.abs(x) + lateral)) * direction, -0.92, 0.92);
    pan.pan.setValueAtTime(panValue, time);
    reflectionPan.pan.setValueAtTime(clamp(panValue * 0.78, -0.8, 0.8), time);
    filter.frequency.setValueAtTime(
      clamp(18000 * Math.exp(-distance / 150), 2400, 18000),
      time,
    );
  }
};

const renderWhoosh = async (config, dna, sources, seed, index, signal) => {
  assertActive(signal);
  const rng = createForgeRandom(seed);
  const duration = randomBetween(rng, config.whooshDuration);
  const context = new OfflineAudioContext(2, Math.ceil(duration * config.sampleRate), config.sampleRate);
  const sum = context.createGain();
  const layerCount = 1 + Math.floor(rng() * 3);
  const selected = [];
  const peakRatio = clamp(dna.peakRatio + (rng() * 2 - 1) * 0.1, 0.35, 0.65);

  for (let layer = 0; layer < layerCount; layer += 1) {
    const sourceAsset = sources[Math.floor(rng() * sources.length)];
    selected.push(sourceAsset.id);
    const source = context.createBufferSource();
    const inputGain = context.createGain();
    const airFilter = createFilter(context, "lowpass", 12000);
    const delay = context.createDelay(2);
    const reflectionFilter = createFilter(context, "lowpass", 3600 + rng() * 4200);
    const reflectionDelay = context.createDelay(2);
    const directGain = context.createGain();
    const floorGain = context.createGain();
    const panner = context.createStereoPanner();
    const floorPanner = context.createStereoPanner();
    const playbackRate = pick(rng, [0.5, 0.67, 0.75, 1, 1, 1.25, 1.5]);

    source.buffer = sourceAsset.buffer;
    source.loop = true;
    source.loopEnd = sourceAsset.buffer.duration;
    source.playbackRate.value = playbackRate;
    inputGain.gain.value = (0.55 + rng() * 0.4) / Math.sqrt(layerCount);
    source.connect(inputGain);
    inputGain.connect(airFilter);
    airFilter.connect(delay);
    delay.connect(directGain);
    directGain.connect(panner);
    panner.connect(sum);
    airFilter.connect(reflectionFilter);
    reflectionFilter.connect(reflectionDelay);
    reflectionDelay.connect(floorGain);
    floorGain.connect(floorPanner);
    floorPanner.connect(sum);
    automateDopplerPath({
      delay,
      reflectionDelay,
      gain: directGain,
      reflectionGain: floorGain,
      pan: panner,
      reflectionPan: floorPanner,
      filter: airFilter,
      duration,
      peakRatio,
      direction: layer % 2 ? -dna.direction : dna.direction,
      rng,
      motion: config.motion,
    });
    source.start(0, rng() * Math.max(0.01, sourceAsset.buffer.duration - 0.1));
    source.stop(duration);
  }

  const envelope = context.createGain();
  const compressor = context.createDynamicsCompressor();
  const color = context.createWaveShaper();
  const ceiling = context.createWaveShaper();
  envelope.gain.setValueAtTime(0.0001, 0);
  envelope.gain.linearRampToValueAtTime(0.88, 0.08);
  envelope.gain.setValueAtTime(0.88, Math.max(0.1, duration - 0.14));
  envelope.gain.linearRampToValueAtTime(0.0001, duration);
  compressor.threshold.value = -10;
  compressor.knee.value = 6;
  compressor.ratio.value = 4;
  compressor.attack.value = 0.006;
  compressor.release.value = 0.16;
  color.curve = makeSaturationCurve(1.8 + config.violence * 1.6, 0.45);
  color.oversample = "2x";
  ceiling.curve = makeCeilingCurve(-1.4);
  connectSeries([sum, compressor, color, ceiling, envelope, context.destination]);
  const buffer = await context.startRendering();
  assertActive(signal);
  return {
    id: `whoosh-${String(index + 1).padStart(2, "0")}`,
    kind: "whoosh",
    seed,
    duration,
    peakRatio,
    sources: selected,
    buffer,
  };
};

const createBandPath = (context, input, bandIndex) => {
  const filters = [];
  if (bandIndex > 0) {
    filters.push(
      createFilter(context, "highpass", CROSSOVERS[bandIndex - 1]),
      createFilter(context, "highpass", CROSSOVERS[bandIndex - 1]),
    );
  }
  if (bandIndex < CROSSOVERS.length) {
    filters.push(
      createFilter(context, "lowpass", CROSSOVERS[bandIndex]),
      createFilter(context, "lowpass", CROSSOVERS[bandIndex]),
    );
  }
  input.connect(filters[0]);
  connectSeries(filters);
  return filters.at(-1);
};

const renderLayerMix = async (config, dna, whooshes, seed, duration, signal) => {
  assertActive(signal);
  const rng = createForgeRandom(seed);
  const context = new OfflineAudioContext(2, Math.ceil(duration * config.sampleRate), config.sampleRate);
  const sum = context.createGain();
  const layerCount = 4 + Math.floor(rng() * 4);
  const sharedPeak = duration * clamp(dna.peakRatio + (rng() * 2 - 1) * 0.08, 0.35, 0.65);
  const selected = [];

  for (let layer = 0; layer < layerCount; layer += 1) {
    const asset = whooshes[Math.floor(rng() * whooshes.length)];
    selected.push(asset.id);
    const source = context.createBufferSource();
    const filter = context.createBiquadFilter();
    const gain = context.createGain();
    const panner = context.createStereoPanner();
    const rate = pick(rng, [0.67, 0.75, 0.84, 1, 1, 1.18, 1.33]);
    const effectiveDuration = asset.buffer.duration / rate;
    const jitter = (rng() * 2 - 1) * 0.15;
    const desiredStart = sharedPeak - effectiveDuration * asset.peakRatio + jitter;
    const start = Math.max(0, desiredStart);
    const offset = desiredStart < 0 ? Math.min(asset.buffer.duration - 0.05, -desiredStart * rate) : 0;
    const playable = Math.min(duration - start, (asset.buffer.duration - offset) / rate);
    const fade = Math.min(0.12, playable * 0.15);
    const role = layer % 4;

    source.buffer = asset.buffer;
    source.playbackRate.value = rate;
    if (role === 0) {
      filter.type = "lowpass";
      filter.frequency.value = 520 + rng() * 680;
      filter.Q.value = 0.72;
    } else if (role === 1) {
      filter.type = "bandpass";
      filter.frequency.value = 850 + rng() * 1400;
      filter.Q.value = 0.55 + rng() * 0.8;
    } else if (role === 2) {
      filter.type = "bandpass";
      filter.frequency.value = 2600 + rng() * 3700;
      filter.Q.value = 0.55 + rng() * 1.1;
    } else {
      filter.type = "highpass";
      filter.frequency.value = 4200 + rng() * 3800;
      filter.Q.value = 0.68;
    }
    const level = (0.48 + rng() * 0.42) / Math.sqrt(layerCount);
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.linearRampToValueAtTime(level, start + fade);
    gain.gain.setValueAtTime(level, Math.max(start + fade, start + playable - fade));
    gain.gain.linearRampToValueAtTime(0.0001, start + playable);
    panner.pan.value = clamp(-0.82 + layer / Math.max(1, layerCount - 1) * 1.64 + (rng() * 2 - 1) * 0.18, -1, 1);
    source.connect(filter);
    filter.connect(gain);
    gain.connect(panner);
    panner.connect(sum);
    source.start(start, offset);
    source.stop(start + playable);
  }

  const highpass = createFilter(context, "highpass", 18);
  const safety = context.createDynamicsCompressor();
  safety.threshold.value = -5;
  safety.knee.value = 5;
  safety.ratio.value = 5;
  safety.attack.value = 0.003;
  safety.release.value = 0.13;
  sum.gain.value = 0.92;
  connectSeries([sum, highpass, safety, context.destination]);
  const buffer = await context.startRendering();
  assertActive(signal);
  return { buffer, selected };
};

const renderFinalBus = async (config, buffer, signal) => {
  assertActive(signal);
  const context = new OfflineAudioContext(2, buffer.length, config.sampleRate);
  const source = context.createBufferSource();
  const input = context.createGain();
  const sum = context.createGain();
  const lowShelf = createFilter(context, "lowshelf", 95);
  const body = createFilter(context, "peaking", 720, 0.62);
  const highShelf = createFilter(context, "highshelf", 6900);
  const color = context.createWaveShaper();
  const glue = context.createDynamicsCompressor();
  const ceiling = context.createWaveShaper();
  const thresholds = [-8, -10.5, -12, -10, -8.5];
  const releases = [0.26, 0.19, 0.12, 0.075, 0.045];

  source.buffer = buffer;
  input.gain.value = dbToGain(5 + config.violence * 7);
  thresholds.forEach((threshold, bandIndex) => {
    const band = createBandPath(context, input, bandIndex);
    const compressor = context.createDynamicsCompressor();
    const makeup = context.createGain();
    compressor.threshold.value = threshold;
    compressor.knee.value = bandIndex === 2 ? 3 : 1;
    compressor.ratio.value = bandIndex === 2 ? 12 : 18;
    compressor.attack.value = bandIndex < 2 ? 0.003 : 0.001;
    compressor.release.value = releases[bandIndex];
    makeup.gain.value = [1.08, 1.03, 0.97, 1.035, 1.08][bandIndex];
    band.connect(compressor);
    compressor.connect(makeup);
    makeup.connect(sum);
  });
  sum.gain.value = 0.64;
  lowShelf.gain.value = 1.2 + config.violence * 0.9;
  body.gain.value = -0.8;
  highShelf.gain.value = 1.4 + config.violence;
  color.curve = makeSaturationCurve(2.1 + config.violence * 1.4, 0.62);
  color.oversample = "4x";
  glue.threshold.value = -8;
  glue.knee.value = 5;
  glue.ratio.value = 3;
  glue.attack.value = 0.012;
  glue.release.value = 0.16;
  ceiling.curve = makeCeilingCurve(-1.2);
  ceiling.oversample = "none";
  source.connect(input);
  connectSeries([sum, lowShelf, body, highShelf, color, glue, ceiling, context.destination]);
  source.start();
  const rendered = await context.startRendering();
  assertActive(signal);
  return rendered;
};

class ForgeDspWorker {
  constructor() {
    this.worker = new Worker(new URL("./forge-dsp.worker.js", import.meta.url), { type: "module" });
    this.sequence = 0;
  }

  run(operation, buffer, options, signal, onProgress) {
    assertActive(signal);
    const id = ++this.sequence;
    const left = new Float32Array(buffer.getChannelData(0));
    const right = new Float32Array(buffer.numberOfChannels > 1
      ? buffer.getChannelData(1)
      : buffer.getChannelData(0));
    return new Promise((resolve, reject) => {
      const abort = () => {
        cleanup();
        reject(abortError());
      };
      const onMessage = (event) => {
        const message = event.data;
        if (message.id !== id) return;
        if (message.type === "progress") {
          onProgress?.(message.phase, message.progress);
          return;
        }
        cleanup();
        if (message.type === "error") {
          reject(new Error(message.message));
        } else if (message.type === "encoded") {
          resolve(new Blob([message.wav], { type: "audio/wav" }));
        } else {
          resolve({
            buffer: createAudioBuffer(message.left, message.right, buffer.sampleRate),
            metrics: message.metrics,
          });
        }
      };
      const cleanup = () => {
        this.worker.removeEventListener("message", onMessage);
        signal?.removeEventListener("abort", abort);
      };
      this.worker.addEventListener("message", onMessage);
      signal?.addEventListener("abort", abort, { once: true });
      this.worker.postMessage({
        id,
        operation,
        left,
        right,
        sampleRate: buffer.sampleRate,
        options,
      }, [left.buffer, right.buffer]);
    });
  }

  destroy() {
    this.worker.terminate();
  }
}

const createAssetMetrics = (metrics, buffer, extra = {}) => ({
  lufs: metrics?.lufs ?? null,
  truePeakDb: metrics?.truePeakDb ?? null,
  dcDb: metrics?.dcDb ?? null,
  spectralFlatness: metrics?.spectralFlatness ?? null,
  peakTime: extra.peakTime ?? buffer.duration * 0.5,
});

const qualityPassed = (metrics) => (
  metrics
  && Number.isFinite(metrics.lufs)
  && metrics.lufs >= -10.5
  && metrics.lufs <= -7
  && Number.isFinite(metrics.truePeakDb)
  && metrics.truePeakDb <= -0.8
  && Number.isFinite(metrics.dcDb)
  && metrics.dcDb <= -48
);

export const runForgeRoll = async (configuration = {}, callbacks = {}) => {
  const config = {
    ...DEFAULT_FORGE_CONFIG,
    ...configuration,
    sourceDuration: configuration.sourceDuration || DEFAULT_FORGE_CONFIG.sourceDuration,
    whooshDuration: configuration.whooshDuration || DEFAULT_FORGE_CONFIG.whooshDuration,
    outputDuration: configuration.outputDuration || DEFAULT_FORGE_CONFIG.outputDuration,
  };
  const { signal, onProgress, onAsset } = callbacks;
  const dna = createForgeDna(config.seed);
  const dsp = new ForgeDspWorker();
  const sources = [];
  const whooshes = [];
  const masters = [];
  const emit = (stage, index, total, detail = "", itemProgress = 0) => {
    const ranges = {
      SOURCE: [0, 0.3],
      WHOOSH: [0.3, 0.62],
      MASTER: [0.62, 1],
    };
    const [start, end] = ranges[stage];
    const local = (index + itemProgress) / Math.max(1, total);
    onProgress?.({
      stage,
      index,
      total,
      detail,
      percent: Math.round((start + (end - start) * local) * 100),
    });
  };

  try {
    for (let index = 0; index < config.sourceCount; index += 1) {
      assertActive(signal);
      const seed = hashForgeSeed(dna.seed + index * 0x9e3779b9);
      emit("SOURCE", index, config.sourceCount, "SYNTHESIS");
      const source = await renderSource(config, dna, seed, index, signal);
      const tonal = await dsp.run("tonal", source.buffer, {
        amount: config.tonal,
        floorDb: -24,
        residualMix: 0.12 + (1 - config.tonal) * 0.16,
        lowProtectHz: 125,
        driveDb: 5 + config.violence * 6,
        colorMix: 0.55 + config.violence * 0.2,
        transient: 0.7 + config.violence * 0.55,
      }, signal, (phase, progress) => emit(
        "SOURCE",
        index,
        config.sourceCount,
        phase.toUpperCase(),
        0.25 + progress * 0.7,
      ));
      source.buffer = tonal.buffer;
      sources.push(source);
      emit("SOURCE", index + 1, config.sourceCount, "READY");
    }

    for (let index = 0; index < config.whooshCount; index += 1) {
      assertActive(signal);
      const seed = hashForgeSeed(dna.seed + 0x51ed270b + index * 0x85ebca6b);
      emit("WHOOSH", index, config.whooshCount, "DOPPLER");
      const whoosh = await renderWhoosh(config, dna, sources, seed, index, signal);
      const sweetened = await dsp.run("tonal", whoosh.buffer, {
        amount: 0.22 + config.tonal * 0.24,
        floorDb: -18,
        residualMix: 0.22,
        lowProtectHz: 95,
        driveDb: 3 + config.violence * 4,
        colorMix: 0.42,
        transient: 0.45 + config.violence * 0.35,
      }, signal, (phase, progress) => emit(
        "WHOOSH",
        index,
        config.whooshCount,
        phase.toUpperCase(),
        0.58 + progress * 0.35,
      ));
      whoosh.buffer = sweetened.buffer;
      whoosh.wavBlob = await dsp.run("encode", whoosh.buffer, {}, signal);
      whoosh.metrics = createAssetMetrics(null, whoosh.buffer, {
        peakTime: whoosh.duration * whoosh.peakRatio,
      });
      whooshes.push(whoosh);
      onAsset?.({
        ...whoosh,
        buffer: undefined,
        filename: `CONVERGENCE_FORGE_${dna.seed}_${whoosh.id}_96khz_24bit.wav`,
      });
      emit("WHOOSH", index + 1, config.whooshCount, "READY");
    }
    sources.length = 0;

    for (let index = 0; index < config.outputCount; index += 1) {
      assertActive(signal);
      let seed = hashForgeSeed(dna.seed + 0xa511e9b3 + index * 0xc2b2ae35);
      let master = null;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const rng = createForgeRandom(seed);
        const duration = randomBetween(rng, config.outputDuration);
        emit("MASTER", index, config.outputCount, attempt ? "QUALITY RETRY" : "LAYER");
        const layerMix = await renderLayerMix(config, dna, whooshes, seed, duration, signal);
        const cleaned = await dsp.run("cleanup", layerMix.buffer, {
          amount: 0.18 + config.tonal * 0.28,
          floorDb: -18,
          residualMix: 0.24,
          lowProtectHz: 90,
        }, signal, (phase, progress) => emit(
          "MASTER",
          index,
          config.outputCount,
          phase.toUpperCase(),
          0.18 + progress * 0.25,
        ));
        emit("MASTER", index, config.outputCount, "5-BAND", 0.5);
        const limited = await renderFinalBus(config, cleaned.buffer, signal);
        const finished = await dsp.run("finish", limited, {
          targetLufs: -8.5,
          violence: config.violence,
        }, signal);
        master = {
          id: `master-${String(index + 1).padStart(2, "0")}`,
          kind: "master",
          seed,
          duration,
          layers: layerMix.selected,
          buffer: finished.buffer,
          metrics: createAssetMetrics(finished.metrics, finished.buffer),
        };
        if (qualityPassed(master.metrics) || attempt === 1) break;
        seed = hashForgeSeed(seed + 0x9e3779b9);
      }
      master.wavBlob = await dsp.run("encode", master.buffer, {}, signal);
      const completedMaster = {
        ...master,
        buffer: undefined,
        filename: `CONVERGENCE_FORGE_${dna.seed}_${master.id}_96khz_24bit.wav`,
      };
      masters.push(completedMaster);
      onAsset?.(completedMaster);
      master.buffer = null;
      emit("MASTER", index + 1, config.outputCount, "READY");
    }

    return {
      seed: dna.seed,
      dna: {
        scale: dna.scaleName,
        rootMidi: dna.rootMidi,
        peakRatio: dna.peakRatio,
      },
      whooshes: whooshes.map(({ buffer, ...asset }) => asset),
      masters,
    };
  } finally {
    dsp.destroy();
  }
};
