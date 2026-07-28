import { createWavRecorder } from "./recording.js";
import { createPreviewAudioContext } from "./audio-runtime.js";

const DSP_WORKLET_URL = new URL("./tonal-denoiser.worklet.js", import.meta.url);
const SCALES = {
  DORIAN: [0, 2, 3, 5, 7, 9, 10],
  LYDIAN: [0, 2, 4, 6, 7, 9, 11],
  MINOR: [0, 2, 3, 5, 7, 8, 10],
  PENTATONIC: [0, 2, 4, 7, 9],
};

const MATERIALS = ["GLASS", "RUBBER", "PLASMA", "ALLOY"];
const SCALE_NAMES = Object.keys(SCALES);
const CROSSOVERS = [90, 360, 1800, 6500];
const OTT_CROSSOVERS = [140, 1050, 4800];
const MAX_ACTIVE_SCENES = 2;
const MAX_ACTIVE_EFFECT_RACKS = 9;
export const BURST_COOLDOWN_MS = 420;
const BURST_AUDIO_COOLDOWN_SECONDS = 0.38;
const TITAN_GESTURES = ["DROP", "RISE", "PULSE", "BOUNCE", "GLIDE"];
const KAWAII_GESTURES = ["PLUCK", "STAB", "CHORD", "BEND", "PULSE"];
const PRISM_GESTURES = ["SHARD", "RIBBON", "SWELL", "CASCADE", "PULSE"];

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const dbToGain = (db) => 10 ** (db / 20);
const midiToFrequency = (midi) => 440 * 2 ** ((midi - 69) / 12);

const hashSeed = (seed) => {
  let value = Number(seed) || 1;
  value ^= value >>> 16;
  value = Math.imul(value, 0x7feb352d);
  value ^= value >>> 15;
  value = Math.imul(value, 0x846ca68b);
  value ^= value >>> 16;
  return value >>> 0;
};

const createRandom = (seed) => {
  let state = hashSeed(seed);
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
};

const pickRandom = (rng, values) => values[Math.floor(rng() * values.length)];

const createInflatorCurve = (curveValue = 8, effectValue = 38, clip = false) => {
  const length = 65536;
  const curve = new Float32Array(length);
  const wet = effectValue * 0.01;
  const dry = 1 - wet;
  const a = curveValue * 0.01 + 1.5;
  const b = curveValue * -0.02;
  const c = curveValue * 0.01 - 0.5;
  const d = 0.0625 - curveValue * 0.0025 + curveValue * curveValue * 0.000025;

  for (let index = 0; index < length; index += 1) {
    const input = (index * 2) / length - 1;
    const absolute = Math.abs(input);
    const shaped = absolute < 1
      ? a * absolute + b * absolute ** 2 + c * absolute ** 3
        - d * (absolute ** 2 - 2 * absolute ** 3 + absolute ** 4)
      : absolute < 2 ? 2 * absolute - absolute ** 2 : absolute;
    const mixed = shaped * wet * Math.sign(input) + input * dry;
    curve[index] = clip ? clamp(mixed, -1, 1) : mixed;
  }

  return curve;
};

const createCeilingCurve = (threshold = 0.78, ceilingDb = -1) => {
  const length = 65536;
  const curve = new Float32Array(length);
  const ceiling = dbToGain(ceilingDb);
  const range = Math.max(0.001, ceiling - threshold);

  for (let index = 0; index < length; index += 1) {
    const input = (index * 2) / length - 1;
    const absolute = Math.abs(input);
    const shaped = absolute <= threshold
      ? absolute
      : threshold + range * (1 - Math.exp(-(absolute - threshold) / range));
    curve[index] = Math.sign(input) * Math.min(ceiling, shaped);
  }

  return curve;
};

const createSaturationCurve = (drive = 2, bias = 0, mix = 0.65) => {
  const length = 65536;
  const curve = new Float32Array(length);
  const biasOffset = Math.tanh(bias);
  const normalization = Math.max(0.001, Math.tanh(drive + Math.abs(bias)) - biasOffset);

  for (let index = 0; index < length; index += 1) {
    const input = (index * 2) / (length - 1) - 1;
    const saturated = (Math.tanh(input * drive + bias) - biasOffset) / normalization;
    curve[index] = input * (1 - mix) + saturated * mix;
  }

  return curve;
};

const createHardCeilingCurve = (ceilingDb = -1) => {
  const length = 65536;
  const curve = new Float32Array(length);
  const ceiling = dbToGain(ceilingDb);
  for (let index = 0; index < length; index += 1) {
    const input = (index * 2) / (length - 1) - 1;
    curve[index] = clamp(input, -ceiling, ceiling);
  }
  return curve;
};

const connectSeries = (nodes) => {
  for (let index = 0; index < nodes.length - 1; index += 1) {
    nodes[index].connect(nodes[index + 1]);
  }
};

const createFilter = (ctx, type, frequency, q = Math.SQRT1_2) => {
  const filter = ctx.createBiquadFilter();
  filter.type = type;
  filter.frequency.value = frequency;
  filter.Q.value = q;
  return filter;
};

const createBandPath = (ctx, input, bandIndex, crossovers = CROSSOVERS) => {
  const filters = [];
  if (bandIndex > 0) {
    filters.push(
      createFilter(ctx, "highpass", crossovers[bandIndex - 1]),
      createFilter(ctx, "highpass", crossovers[bandIndex - 1]),
    );
  }
  if (bandIndex < crossovers.length) {
    filters.push(
      createFilter(ctx, "lowpass", crossovers[bandIndex]),
      createFilter(ctx, "lowpass", crossovers[bandIndex]),
    );
  }
  input.connect(filters[0]);
  connectSeries(filters);
  return filters.at(-1);
};

const createMultibandMaster = (ctx) => {
  const input = ctx.createGain();
  const sum = ctx.createGain();
  const postGain = ctx.createGain();
  const clipper = ctx.createWaveShaper();
  const limiter = ctx.createDynamicsCompressor();
  const ceiling = ctx.createWaveShaper();
  const output = ctx.createGain();
  const thresholds = [-1, -2.5, -3.5, -2.5, -1.5];
  const releases = [0.28, 0.2, 0.13, 0.085, 0.055];
  const priorities = [1.06, 1.03, 1, 1.02, 1.05];
  const compressors = [];
  const priorityGains = [];

  input.gain.value = dbToGain(4.5);
  sum.gain.value = 0.88;
  postGain.gain.value = 1.12;
  clipper.curve = createCeilingCurve(0.8, -0.35);
  clipper.oversample = "4x";
  limiter.threshold.value = -0.1;
  limiter.knee.value = 0;
  limiter.ratio.value = 20;
  limiter.attack.value = 0.001;
  limiter.release.value = 0.08;
  ceiling.curve = createCeilingCurve(0.82, -1);
  ceiling.oversample = "4x";

  thresholds.forEach((threshold, bandIndex) => {
    const bandOutput = createBandPath(ctx, input, bandIndex);
    const compressor = ctx.createDynamicsCompressor();
    const priority = ctx.createGain();
    compressor.threshold.value = threshold;
    compressor.knee.value = 1;
    compressor.ratio.value = 10;
    compressor.attack.value = bandIndex < 2 ? 0.003 : 0.0015;
    compressor.release.value = releases[bandIndex];
    priority.gain.value = priorities[bandIndex];
    bandOutput.connect(compressor);
    compressor.connect(priority);
    priority.connect(sum);
    compressors.push(compressor);
    priorityGains.push(priority);
  });

  connectSeries([sum, postGain, clipper, limiter, ceiling, output]);
  return { input, output, compressors, limiter, priorityGains };
};

const createInflatorMaster = (ctx) => {
  const input = ctx.createGain();
  const dcFilter = createFilter(ctx, "highpass", 20, 0.7);
  const lowShelf = createFilter(ctx, "lowshelf", 95);
  const bodyDip = createFilter(ctx, "peaking", 680, 0.55);
  const highShelf = createFilter(ctx, "highshelf", 7200);
  const inflator = ctx.createWaveShaper();
  const glue = ctx.createDynamicsCompressor();
  const postGain = ctx.createGain();
  const clipper = ctx.createWaveShaper();
  const limiter = ctx.createDynamicsCompressor();
  const ceiling = ctx.createWaveShaper();
  const output = ctx.createGain();

  input.gain.value = dbToGain(4.5);
  lowShelf.gain.value = 1.2;
  bodyDip.gain.value = -0.7;
  highShelf.gain.value = 1.6;
  inflator.curve = createInflatorCurve(8, 38, false);
  inflator.oversample = "4x";
  glue.threshold.value = -11;
  glue.knee.value = 7;
  glue.ratio.value = 2;
  glue.attack.value = 0.015;
  glue.release.value = 0.18;
  postGain.gain.value = 1.18;
  clipper.curve = createCeilingCurve(0.7, -0.35);
  clipper.oversample = "4x";
  limiter.threshold.value = -0.1;
  limiter.knee.value = 0;
  limiter.ratio.value = 20;
  limiter.attack.value = 0.001;
  limiter.release.value = 0.09;
  ceiling.curve = createCeilingCurve(0.82, -1);
  ceiling.oversample = "4x";

  connectSeries([
    input,
    dcFilter,
    lowShelf,
    bodyDip,
    highShelf,
    inflator,
    glue,
    postGain,
    clipper,
    limiter,
    ceiling,
    output,
  ]);

  return {
    input,
    output,
    compressors: [glue],
    limiter,
    lowShelf,
    bodyDip,
    highShelf,
    inflator,
  };
};

const createResilientWorkletStage = (ctx, workletsReady, processorName, processorOptions) => {
  const input = ctx.createGain();
  const output = ctx.createGain();
  if (!workletsReady) {
    input.connect(output);
    return { input, output, processor: null };
  }

  const processor = new AudioWorkletNode(ctx, processorName, {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [2],
    channelCount: 2,
    channelCountMode: "explicit",
    processorOptions,
  });
  let bypassed = false;
  input.connect(processor);
  processor.connect(output);
  processor.addEventListener("processorerror", () => {
    if (bypassed) return;
    bypassed = true;
    try { input.disconnect(processor); } catch (error) { /* already disconnected */ }
    try { processor.disconnect(output); } catch (error) { /* already disconnected */ }
    input.connect(output);
    console.warn(`${processorName} failed; switched to transparent bypass.`);
  });
  return { input, output, processor };
};

const createTransientShaper = (ctx, workletsReady, amount = 1.2) => {
  return createResilientWorkletStage(ctx, workletsReady, "transient-shaper", { amount });
};

const createOttSweetener = (ctx) => {
  const input = ctx.createGain();
  const sum = ctx.createGain();
  const lowShelf = createFilter(ctx, "lowshelf", 105);
  const presence = createFilter(ctx, "peaking", 3200, 0.72);
  const airShelf = createFilter(ctx, "highshelf", 9100);
  const output = ctx.createGain();
  const thresholds = [-25, -27, -29, -31];
  const ratios = [3, 3.5, 4.5, 5.5];
  const attacks = [0.026, 0.015, 0.007, 0.003];
  const releases = [0.22, 0.16, 0.1, 0.065];
  const dryMixes = [0.52, 0.48, 0.43, 0.38];
  const wetMixes = [0.36, 0.38, 0.41, 0.44];
  const makeupDb = [2, 2.7, 3.5, 4.2];
  const compressors = [];

  thresholds.forEach((threshold, bandIndex) => {
    const bandOutput = createBandPath(ctx, input, bandIndex, OTT_CROSSOVERS);
    const dry = ctx.createGain();
    const compressor = ctx.createDynamicsCompressor();
    const wet = ctx.createGain();
    dry.gain.value = dryMixes[bandIndex];
    compressor.threshold.value = threshold;
    compressor.knee.value = 12;
    compressor.ratio.value = ratios[bandIndex];
    compressor.attack.value = attacks[bandIndex];
    compressor.release.value = releases[bandIndex];
    wet.gain.value = wetMixes[bandIndex] * dbToGain(makeupDb[bandIndex]);
    bandOutput.connect(dry);
    bandOutput.connect(compressor);
    compressor.connect(wet);
    dry.connect(sum);
    wet.connect(sum);
    compressors.push(compressor);
  });

  sum.gain.value = 0.92;
  lowShelf.gain.value = 0.45;
  presence.gain.value = 0.7;
  airShelf.gain.value = 0.85;
  output.gain.value = 0.98;
  connectSeries([sum, lowShelf, presence, airShelf, output]);
  return { input, output, compressors, lowShelf, presence, airShelf };
};

const createBrutalMaster = (ctx, workletsReady) => {
  const input = ctx.createGain();
  const dcFilter = createFilter(ctx, "highpass", 18, 0.7);
  const safetySaturator = ctx.createWaveShaper();
  const sum = ctx.createGain();
  const l3Limiter = ctx.createDynamicsCompressor();
  const inflatorDrive = ctx.createGain();
  const inflator = ctx.createWaveShaper();
  const inflatorTrim = ctx.createGain();
  const lowShelf = createFilter(ctx, "lowshelf", 92);
  const bodyDip = createFilter(ctx, "peaking", 720, 0.58);
  const highShelf = createFilter(ctx, "highshelf", 6800);
  const colorDrive = ctx.createGain();
  const color = ctx.createWaveShaper();
  const colorTrim = ctx.createGain();
  const ottSweetener = createOttSweetener(ctx);
  const transientShaper = createTransientShaper(ctx, workletsReady, 1.35);
  const softClipper = ctx.createWaveShaper();
  const hardCeiling = ctx.createWaveShaper();
  const output = ctx.createGain();
  const thresholds = [-8, -10.5, -12, -10, -8.5];
  const releases = [0.26, 0.19, 0.12, 0.075, 0.045];
  const priorities = [1.08, 1.035, 0.98, 1.035, 1.08];
  const compressors = [];
  const priorityGains = [];

  input.gain.value = dbToGain(12);
  safetySaturator.curve = createSaturationCurve(1.45, 0, 0.32);
  safetySaturator.oversample = "4x";
  sum.gain.value = 0.68;
  l3Limiter.threshold.value = -4.5;
  l3Limiter.knee.value = 1;
  l3Limiter.ratio.value = 20;
  l3Limiter.attack.value = 0.001;
  l3Limiter.release.value = 0.075;
  inflatorDrive.gain.value = dbToGain(3.5);
  inflator.curve = createInflatorCurve(12, 62, false);
  inflator.oversample = "4x";
  inflatorTrim.gain.value = dbToGain(-7.5);
  lowShelf.gain.value = 1.8;
  bodyDip.gain.value = -1.1;
  highShelf.gain.value = 2.2;
  colorDrive.gain.value = dbToGain(4);
  color.curve = createSaturationCurve(2.8, 0.075, 0.78);
  color.oversample = "4x";
  colorTrim.gain.value = dbToGain(-3.5);
  softClipper.curve = createCeilingCurve(0.76, 0);
  softClipper.oversample = "4x";
  hardCeiling.curve = createHardCeilingCurve(-1);
  hardCeiling.oversample = "none";
  output.gain.value = 0.975;

  input.connect(dcFilter);
  dcFilter.connect(safetySaturator);
  thresholds.forEach((threshold, bandIndex) => {
    const bandOutput = createBandPath(ctx, safetySaturator, bandIndex);
    const compressor = ctx.createDynamicsCompressor();
    const priority = ctx.createGain();
    compressor.threshold.value = threshold;
    compressor.knee.value = bandIndex === 2 ? 2 : 1;
    compressor.ratio.value = bandIndex === 2 ? 14 : 18;
    compressor.attack.value = bandIndex < 2 ? 0.0025 : 0.001;
    compressor.release.value = releases[bandIndex];
    priority.gain.value = priorities[bandIndex];
    bandOutput.connect(compressor);
    compressor.connect(priority);
    priority.connect(sum);
    compressors.push(compressor);
    priorityGains.push(priority);
  });

  connectSeries([
    sum,
    l3Limiter,
    inflatorDrive,
    inflator,
    inflatorTrim,
    lowShelf,
    bodyDip,
    highShelf,
    colorDrive,
    color,
    colorTrim,
    ottSweetener.input,
  ]);
  connectSeries([
    ottSweetener.output,
    transientShaper.input,
  ]);
  connectSeries([
    transientShaper.output,
    softClipper,
    hardCeiling,
    output,
  ]);

  return {
    input,
    output,
    compressors,
    limiter: l3Limiter,
    priorityGains,
    lowShelf,
    bodyDip,
    highShelf,
    inflator,
    transientShaper: transientShaper.processor,
    ottSweetener,
    safetySaturator,
  };
};

const createImpulse = (ctx, duration = 1.7, decay = 2.8) => {
  const impulse = ctx.createBuffer(2, Math.floor(ctx.sampleRate * duration), ctx.sampleRate);
  for (let channel = 0; channel < impulse.numberOfChannels; channel += 1) {
    const data = impulse.getChannelData(channel);
    let smoothed = 0;
    for (let index = 0; index < data.length; index += 1) {
      smoothed = smoothed * 0.55 + (Math.random() * 2 - 1) * 0.45;
      data[index] = smoothed * (1 - index / data.length) ** decay;
    }
  }
  return impulse;
};

const createTonalDenoiser = (ctx, workletsReady, settings) => {
  return createResilientWorkletStage(ctx, workletsReady, "tonal-denoiser", settings);
};

const createStemColor = (ctx, driveDb, curveSettings) => {
  const drive = ctx.createGain();
  const saturation = ctx.createWaveShaper();
  const trim = ctx.createGain();
  drive.gain.value = dbToGain(driveDb);
  saturation.curve = createSaturationCurve(...curveSettings);
  saturation.oversample = "4x";
  trim.gain.value = dbToGain(-driveDb * 0.72);
  return { drive, saturation, trim };
};

const createStemBuses = (ctx, mixBus, workletsReady) => {
  const titanInput = ctx.createGain();
  const titanLow = createFilter(ctx, "lowpass", 760, 0.65);
  const titanColor = createStemColor(ctx, 9, [2.7, 0.055, 0.72]);
  const titanDenoiser = createTonalDenoiser(ctx, workletsReady, {
    amount: 0.78,
    floorDb: -22,
    lowPreserveHz: 165,
  });
  const titanDuck = ctx.createGain();
  const titanLevel = ctx.createGain();
  connectSeries([
    titanInput,
    titanLow,
    titanColor.drive,
    titanColor.saturation,
    titanColor.trim,
    titanDenoiser.input,
  ]);
  connectSeries([
    titanDenoiser.output,
    titanDuck,
    titanLevel,
    mixBus,
  ]);

  const kawaiiInput = ctx.createGain();
  const kawaiiHigh = createFilter(ctx, "highpass", 130, 0.65);
  const kawaiiLow = createFilter(ctx, "lowpass", 10500, 0.65);
  const kawaiiSum = ctx.createGain();
  const kawaiiColor = createStemColor(ctx, 8, [3.2, -0.045, 0.76]);
  const kawaiiDenoiser = createTonalDenoiser(ctx, workletsReady, {
    amount: 0.64,
    floorDb: -18,
    lowPreserveHz: 120,
  });
  const kawaiiDuck = ctx.createGain();
  const kawaiiLevel = ctx.createGain();
  const kawaiiDelay = ctx.createDelay(1);
  const kawaiiFeedback = ctx.createGain();
  const kawaiiDelayFilter = createFilter(ctx, "lowpass", 3600, 0.7);
  const kawaiiWet = ctx.createGain();
  kawaiiDelay.delayTime.value = 0.23;
  kawaiiFeedback.gain.value = 0.22;
  kawaiiWet.gain.value = 0.18;
  connectSeries([kawaiiInput, kawaiiHigh, kawaiiLow]);
  kawaiiLow.connect(kawaiiSum);
  kawaiiLow.connect(kawaiiDelay);
  kawaiiDelay.connect(kawaiiDelayFilter);
  kawaiiDelayFilter.connect(kawaiiFeedback);
  kawaiiFeedback.connect(kawaiiDelay);
  kawaiiDelayFilter.connect(kawaiiWet);
  kawaiiWet.connect(kawaiiSum);
  connectSeries([
    kawaiiSum,
    kawaiiColor.drive,
    kawaiiColor.saturation,
    kawaiiColor.trim,
    kawaiiDenoiser.input,
  ]);
  connectSeries([
    kawaiiDenoiser.output,
    kawaiiDuck,
    kawaiiLevel,
    mixBus,
  ]);

  const prismInput = ctx.createGain();
  const prismHigh = createFilter(ctx, "highpass", 430, 0.65);
  const prismSum = ctx.createGain();
  const prismColor = createStemColor(ctx, 9.5, [3.6, 0.035, 0.8]);
  const prismDenoiser = createTonalDenoiser(ctx, workletsReady, {
    amount: 0.46,
    floorDb: -13,
    lowPreserveHz: 430,
  });
  const prismDuck = ctx.createGain();
  const prismLevel = ctx.createGain();
  const prismDry = ctx.createGain();
  const prismConvolver = ctx.createConvolver();
  const prismWet = ctx.createGain();
  prismDry.gain.value = 0.72;
  prismWet.gain.value = 0.3;
  prismConvolver.buffer = createImpulse(ctx);
  prismInput.connect(prismHigh);
  prismHigh.connect(prismDry);
  prismHigh.connect(prismConvolver);
  prismDry.connect(prismSum);
  prismConvolver.connect(prismWet);
  prismWet.connect(prismSum);
  connectSeries([
    prismSum,
    prismColor.drive,
    prismColor.saturation,
    prismColor.trim,
    prismDenoiser.input,
  ]);
  connectSeries([
    prismDenoiser.output,
    prismDuck,
    prismLevel,
    mixBus,
  ]);

  return {
    titan: {
      name: "titan",
      input: titanInput,
      duck: titanDuck,
      level: titanLevel,
      denoiser: titanDenoiser.processor,
    },
    kawaii: {
      name: "kawaii",
      input: kawaiiInput,
      duck: kawaiiDuck,
      level: kawaiiLevel,
      denoiser: kawaiiDenoiser.processor,
    },
    prism: {
      name: "prism",
      input: prismInput,
      duck: prismDuck,
      level: prismLevel,
      denoiser: prismDenoiser.processor,
    },
  };
};

const createGranularDelay = (ctx, workletsReady, settings) => {
  if (!workletsReady) {
    const fallback = ctx.createDelay(1.5);
    fallback.delayTime.value = settings.delayMs / 1000;
    return fallback;
  }
  return new AudioWorkletNode(ctx, "granular-delay", {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [2],
    channelCount: 2,
    channelCountMode: "explicit",
    processorOptions: settings,
  });
};

const EARLY_FX_PROFILES = {
  titan: {
    modDelay: [0.024, 0.12],
    modDepth: [0.0008, 0.006],
    modRate: [0.08, 1.7],
    grainDelay: [70, 290],
    grainSize: [34, 105],
    disperse: [55, 920],
  },
  kawaii: {
    modDelay: [0.038, 0.24],
    modDepth: [0.002, 0.018],
    modRate: [0.18, 3.8],
    grainDelay: [85, 480],
    grainSize: [22, 92],
    disperse: [180, 5200],
  },
  prism: {
    modDelay: [0.055, 0.38],
    modDepth: [0.003, 0.026],
    modRate: [0.11, 5.2],
    grainDelay: [110, 680],
    grainSize: [18, 128],
    disperse: [620, 12500],
  },
};

const randomBetween = (rng, range) => range[0] + rng() * (range[1] - range[0]);

const createEarlyFxRack = (engine, dna, stem, destination, startTime, cleanupTime) => {
  const { ctx, workletsReady } = engine;
  const rng = dna.rng;
  const profile = EARLY_FX_PROFILES[stem];
  const input = ctx.createGain();
  const output = ctx.createGain();
  const dry = ctx.createGain();
  const modDelay = ctx.createDelay(1);
  const modFilter = createFilter(ctx, "lowpass", stem === "titan" ? 1100 + rng() * 1800 : 2600 + rng() * 7200, 0.7);
  const modFeedback = ctx.createGain();
  const modWet = ctx.createGain();
  const modulator = ctx.createOscillator();
  const modDepth = ctx.createGain();
  const grainSettings = {
    delayMs: randomBetween(rng, profile.grainDelay),
    grainMs: randomBetween(rng, profile.grainSize),
    overlap: 2.1 + rng() * 2.7,
    pitch: pickRandom(rng, [0.5, 0.67, 0.75, 1, 1, 1.25, 1.5, 2]),
    feedback: 0.08 + rng() * (stem === "titan" ? 0.28 : 0.42),
    jitter: 0.12 + rng() * 0.76,
    spread: stem === "titan" ? 0.18 + rng() * 0.42 : 0.45 + rng() * 0.52,
    seed: hashSeed(dna.seed + Math.floor(rng() * 0xffffffff)),
  };
  // One shared granular Worklet runs after the preview stem mix. Scene racks
  // keep a native delay here so randomized movement remains inexpensive.
  const granular = createGranularDelay(ctx, false, grainSettings);
  const granularWet = ctx.createGain();
  const modToGranular = ctx.createGain();
  const granularToDisperser = ctx.createGain();
  const disperserSplitter = ctx.createChannelSplitter(2);
  const disperserMerger = ctx.createChannelMerger(2);
  const disperserWet = ctx.createGain();
  const allpassCount = 2 + Math.floor(rng() * 3);
  const leftAllpasses = [];
  const rightAllpasses = [];
  const mixes = [0.055 + rng() * 0.25, 0.045 + rng() * 0.27, 0.055 + rng() * 0.25];
  const dominant = Math.floor(rng() * mixes.length);
  mixes[dominant] *= 1.28 + rng() * 0.38;
  const wetTotal = mixes[0] + mixes[1] + mixes[2];

  dry.gain.value = clamp(0.9 - wetTotal * 0.34, 0.54, 0.76);
  output.gain.value = 0.86 / Math.sqrt(Math.max(1, dna.triggers.length));
  modDelay.delayTime.value = randomBetween(rng, profile.modDelay);
  modFeedback.gain.value = 0.06 + rng() * (stem === "titan" ? 0.28 : 0.4);
  modWet.gain.value = mixes[0];
  granularWet.gain.value = mixes[1];
  disperserWet.gain.value = mixes[2];
  modToGranular.gain.value = 0.035 + rng() * 0.16;
  granularToDisperser.gain.value = 0.03 + rng() * 0.14;
  modulator.type = pickRandom(rng, ["sine", "sine", "triangle"]);
  modulator.frequency.value = randomBetween(rng, profile.modRate);
  modDepth.gain.value = randomBetween(rng, profile.modDepth);

  input.connect(dry);
  dry.connect(output);
  input.connect(modDelay);
  modDelay.connect(modFilter);
  modFilter.connect(modFeedback);
  modFeedback.connect(modDelay);
  modFilter.connect(modWet);
  modFilter.connect(modToGranular);
  modToGranular.connect(granular);
  modWet.connect(output);
  modulator.connect(modDepth);
  modDepth.connect(modDelay.delayTime);
  input.connect(granular);
  granular.connect(granularWet);
  granular.connect(granularToDisperser);
  granularToDisperser.connect(disperserSplitter);
  granularWet.connect(output);

  for (let index = 0; index < allpassCount; index += 1) {
    const position = (index + 0.5) / allpassCount;
    const base = profile.disperse[0] * (profile.disperse[1] / profile.disperse[0]) ** position;
    leftAllpasses.push(createFilter(ctx, "allpass", base * (0.78 + rng() * 0.38), 2.5 + rng() * 18));
    rightAllpasses.push(createFilter(ctx, "allpass", base * (0.84 + rng() * 0.42), 2.5 + rng() * 18));
  }
  input.connect(disperserSplitter);
  disperserSplitter.connect(leftAllpasses[0], 0, 0);
  disperserSplitter.connect(rightAllpasses[0], 1, 0);
  connectSeries(leftAllpasses);
  connectSeries(rightAllpasses);
  leftAllpasses.at(-1).connect(disperserMerger, 0, 0);
  rightAllpasses.at(-1).connect(disperserMerger, 0, 1);
  disperserMerger.connect(disperserWet);
  disperserWet.connect(output);
  output.connect(destination);

  modulator.start(startTime);
  engine.registerSource(modulator, cleanupTime);
  engine.registerEffectGraph([
    input,
    output,
    dry,
    modDelay,
    modFilter,
    modFeedback,
    modWet,
    modulator,
    modDepth,
    granular,
    granularWet,
    modToGranular,
    granularToDisperser,
    disperserSplitter,
    disperserMerger,
    ...leftAllpasses,
    ...rightAllpasses,
    disperserWet,
  ], cleanupTime + 0.05);

  return {
    input,
    output,
    dominant: ["MOD", "GRAIN", "DISPERSE"][dominant],
    mix: { mod: mixes[0], grain: mixes[1], disperse: mixes[2] },
    grainSettings,
  };
};

const createSceneEffects = (engine, dna, startTime) => {
  const cleanupTime = startTime + dna.duration + 2.2;
  return {
    titan: createEarlyFxRack(engine, dna, "titan", engine.stems.titan.input, startTime, cleanupTime),
    kawaii: createEarlyFxRack(engine, dna, "kawaii", engine.stems.kawaii.input, startTime, cleanupTime),
    prism: createEarlyFxRack(engine, dna, "prism", engine.stems.prism.input, startTime, cleanupTime),
  };
};

const scheduleEnvelope = (gain, time, attack, peak, duration, release = 0.08) => {
  gain.cancelScheduledValues(time);
  gain.setValueAtTime(0.0001, time);
  gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), time + attack);
  gain.exponentialRampToValueAtTime(0.0001, time + Math.max(attack + 0.01, duration));
  gain.setValueAtTime(0.0001, time + duration + release);
};

const scheduleDuck = (gain, time, depth, duration) => {
  gain.cancelScheduledValues(time);
  gain.setValueAtTime(1, time);
  gain.linearRampToValueAtTime(depth, time + 0.012);
  gain.exponentialRampToValueAtTime(1, time + duration);
};

const createSceneDna = (seed, settings) => {
  const rng = createRandom(seed);
  const scaleName = SCALE_NAMES[Math.floor(rng() * SCALE_NAMES.length)];
  const rootMidi = 38 + Math.floor(rng() * 8);
  const contour = rng() > 0.5 ? 1 : -1;
  const material = MATERIALS[Math.floor(rng() * MATERIALS.length)];
  const density = clamp(settings.density, 0, 1);
  const energy = clamp(settings.energy, 0, 1);
  const affinity = clamp(settings.affinity, 0, 1);
  const motion = clamp(settings.motion, 0, 1);
  const triggerCount = 1 + Math.floor(rng() * (1 + density * 3));
  const triggers = [];
  let offset = 0;

  for (let index = 0; index < triggerCount; index += 1) {
    if (index > 0) offset += 0.2 + rng() * (0.36 + motion * 0.58);
    const rawMix = [0.42 + rng() * 1.08, 0.42 + rng() * 1.08, 0.42 + rng() * 1.08];
    const dominant = Math.floor(rng() * rawMix.length);
    rawMix[dominant] *= 1.18 + rng() * 0.42;
    const mixPeak = Math.max(...rawMix);
    const normalizedMix = rawMix.map((value) => clamp(
      (value / mixPeak) * (0.94 + energy * 0.22),
      0.28,
      1.18,
    ));

    triggers.push({
      offset,
      titanGesture: pickRandom(rng, TITAN_GESTURES),
      kawaiiGesture: pickRandom(rng, KAWAII_GESTURES),
      prismGesture: pickRandom(rng, PRISM_GESTURES),
      titanDegree: pickRandom(rng, [0, 0, 0, -1, 1, 2]),
      timing: {
        titan: rng() * 0.08,
        kawaii: 0.025 + rng() * 0.14,
        prism: 0.07 + rng() * 0.24,
      },
      mix: {
        titan: normalizedMix[0],
        kawaii: normalizedMix[1],
        prism: normalizedMix[2],
      },
    });
  }

  const duration = offset + 3.4 + density * 3.2 + rng() * 1.2;
  return {
    seed: hashSeed(seed),
    rng,
    scaleName,
    scale: SCALES[scaleName],
    rootMidi,
    contour,
    material,
    density,
    energy,
    affinity,
    motion,
    space: clamp(settings.space, 0, 1),
    tension: clamp(settings.tension, 0, 1),
    triggers,
    duration,
  };
};

const pickScaleMidi = (dna, degreeIndex, octave = 0) => {
  const scaleLength = dna.scale.length;
  const wrapped = ((degreeIndex % scaleLength) + scaleLength) % scaleLength;
  const octaveOffset = Math.floor(degreeIndex / scaleLength) * 12;
  return dna.rootMidi + dna.scale[wrapped] + octaveOffset + octave * 12;
};

const schedulePulseEnvelope = (gain, time, peak, duration, pulseCount) => {
  const step = duration / pulseCount;
  gain.cancelScheduledValues(time);
  for (let index = 0; index < pulseCount; index += 1) {
    const pulseTime = time + index * step;
    gain.setValueAtTime(0.0001, pulseTime);
    gain.exponentialRampToValueAtTime(Math.max(0.0002, peak * (1 - index * 0.07)), pulseTime + 0.012);
    gain.exponentialRampToValueAtTime(0.0001, pulseTime + step * 0.68);
  }
  gain.setValueAtTime(0.0001, time + duration + 0.04);
};

const scheduleTitanPitch = (frequency, base, time, duration, gesture, dna, glideRatio = 1) => {
  frequency.cancelScheduledValues(time);
  if (gesture === "RISE") {
    frequency.setValueAtTime(base * (0.68 + dna.tension * 0.12), time);
    frequency.exponentialRampToValueAtTime(base * (1.08 + dna.motion * 0.12), time + duration * 0.68);
    frequency.exponentialRampToValueAtTime(base, time + duration * 0.94);
  } else if (gesture === "PULSE") {
    frequency.setValueAtTime(base, time);
    frequency.exponentialRampToValueAtTime(base * 1.08, time + duration * 0.17);
    frequency.exponentialRampToValueAtTime(base * 0.94, time + duration * 0.34);
    frequency.exponentialRampToValueAtTime(base * 1.04, time + duration * 0.52);
    frequency.exponentialRampToValueAtTime(base, time + duration * 0.72);
  } else if (gesture === "BOUNCE") {
    frequency.setValueAtTime(base * 1.08, time);
    frequency.exponentialRampToValueAtTime(base * 0.82, time + duration * 0.24);
    frequency.exponentialRampToValueAtTime(base * 1.16, time + duration * 0.48);
    frequency.exponentialRampToValueAtTime(base * 0.93, time + duration * 0.68);
    frequency.exponentialRampToValueAtTime(base, time + duration * 0.86);
  } else if (gesture === "GLIDE") {
    frequency.setValueAtTime(base * (dna.contour > 0 ? 0.88 : 1.12), time);
    frequency.exponentialRampToValueAtTime(base * glideRatio, time + duration * 0.78);
  } else {
    frequency.setValueAtTime(base * (1.18 + dna.tension * 0.34), time);
    frequency.exponentialRampToValueAtTime(base * 0.985, time + 0.24 + dna.energy * 0.28);
    frequency.exponentialRampToValueAtTime(base, time + duration * 0.72);
  }
};

const spawnTitan = (engine, dna, time, trigger, destination) => {
  const { ctx, stems } = engine;
  const rng = dna.rng;
  const gesture = trigger.titanGesture;
  const baseFrequency = midiToFrequency(pickScaleMidi(dna, trigger.titanDegree, -1));
  const durationBase = {
    DROP: 1.75,
    RISE: 2.25,
    PULSE: 1.45,
    BOUNCE: 1.65,
    GLIDE: 2.05,
  }[gesture];
  const duration = durationBase + dna.energy * 1.15 + rng() * 0.48;
  const accent = trigger.mix.titan * (0.78 + rng() * 0.34);
  const glideDegree = 1 + Math.floor(rng() * Math.min(3, dna.scale.length - 1));
  const glideRatio = 2 ** ((dna.contour * dna.scale[glideDegree]) / 12);
  const fundamental = ctx.createOscillator();
  const bodyLeft = ctx.createOscillator();
  const bodyRight = ctx.createOscillator();
  const upper = ctx.createOscillator();
  const modulator = ctx.createOscillator();
  const pitchedImpact = ctx.createOscillator();
  const fundamentalGain = ctx.createGain();
  const bodyLeftGain = ctx.createGain();
  const bodyRightGain = ctx.createGain();
  const upperGain = ctx.createGain();
  const modulatorGain = ctx.createGain();
  const impactGain = ctx.createGain();
  const bodyLeftPan = ctx.createStereoPanner();
  const bodyRightPan = ctx.createStereoPanner();
  const bodySum = ctx.createGain();
  const bodyFilter = createFilter(ctx, "lowpass", 430 + dna.energy * 520, 0.8 + dna.tension * 2.5);
  const bodyColor = ctx.createWaveShaper();
  const impactFilter = createFilter(ctx, "bandpass", baseFrequency * 4.2, 1.2 + dna.tension * 2);
  const pulseCount = gesture === "PULSE" ? 4 + Math.floor(dna.density * 3) : 3;

  fundamental.type = "sine";
  bodyLeft.type = gesture === "PULSE" ? "square" : dna.material === "RUBBER" ? "triangle" : "sine";
  bodyRight.type = gesture === "RISE" || dna.material === "PLASMA" ? "sawtooth" : "triangle";
  upper.type = gesture === "BOUNCE" ? "square" : dna.material === "GLASS" ? "sine" : "triangle";
  pitchedImpact.type = "sine";
  modulator.type = "sine";
  scheduleTitanPitch(fundamental.frequency, baseFrequency, time, duration, gesture, dna, glideRatio);
  scheduleTitanPitch(bodyLeft.frequency, baseFrequency * 2.002, time, duration, gesture, dna, glideRatio);
  scheduleTitanPitch(bodyRight.frequency, baseFrequency * 1.998, time, duration, gesture, dna, glideRatio);
  scheduleTitanPitch(upper.frequency, baseFrequency * 3.001, time, duration, gesture, dna, glideRatio);
  if (gesture === "RISE") {
    pitchedImpact.frequency.setValueAtTime(baseFrequency * 1.7, time);
    pitchedImpact.frequency.exponentialRampToValueAtTime(baseFrequency * 5.2, time + 0.18);
  } else if (gesture === "BOUNCE") {
    pitchedImpact.frequency.setValueAtTime(baseFrequency * 3.2, time);
    pitchedImpact.frequency.exponentialRampToValueAtTime(baseFrequency * 5.5, time + 0.07);
    pitchedImpact.frequency.exponentialRampToValueAtTime(baseFrequency * 2.6, time + 0.18);
  } else {
    pitchedImpact.frequency.setValueAtTime(baseFrequency * (5.2 + dna.tension * 1.8), time);
    pitchedImpact.frequency.exponentialRampToValueAtTime(baseFrequency * 2.4, time + 0.15);
  }
  modulator.frequency.value = baseFrequency * (gesture === "PULSE" ? 1.5 : 0.48 + dna.motion * 0.34);
  modulatorGain.gain.value = 2.5 + dna.tension * 10 + (gesture === "RISE" ? 8 : 0);
  const attack = gesture === "RISE" ? 0.13 : gesture === "GLIDE" ? 0.045 : 0.006;
  if (gesture === "PULSE" || gesture === "BOUNCE") {
    schedulePulseEnvelope(fundamentalGain.gain, time, (0.22 + dna.energy * 0.11) * accent, duration, pulseCount);
    schedulePulseEnvelope(bodyLeftGain.gain, time, (0.055 + dna.energy * 0.03) * accent, duration * 0.88, pulseCount);
    schedulePulseEnvelope(bodyRightGain.gain, time, (0.047 + dna.tension * 0.028) * accent, duration * 0.84, pulseCount);
    schedulePulseEnvelope(upperGain.gain, time, (0.021 + dna.energy * 0.019) * accent, duration * 0.72, pulseCount);
  } else {
    scheduleEnvelope(fundamentalGain.gain, time, attack, (0.23 + dna.energy * 0.12) * accent, duration);
    scheduleEnvelope(bodyLeftGain.gain, time, attack * 0.8, (0.06 + dna.energy * 0.032) * accent, duration * 0.86);
    scheduleEnvelope(bodyRightGain.gain, time, attack, (0.05 + dna.tension * 0.03) * accent, duration * 0.8);
    scheduleEnvelope(upperGain.gain, time, attack * 0.7, (0.024 + dna.energy * 0.021) * accent, duration * 0.64);
  }
  scheduleEnvelope(impactGain.gain, time, gesture === "RISE" ? 0.025 : 0.0015, (0.07 + dna.energy * 0.05) * accent, 0.18);
  bodyLeftPan.pan.value = -0.18 - dna.motion * 0.08;
  bodyRightPan.pan.value = 0.18 + dna.motion * 0.08;
  bodyColor.curve = createSaturationCurve(2.1, -0.035, 0.54);
  bodyColor.oversample = "4x";

  fundamental.connect(fundamentalGain);
  fundamentalGain.connect(destination);
  modulator.connect(modulatorGain);
  modulatorGain.connect(bodyLeft.frequency);
  modulatorGain.connect(bodyRight.frequency);
  modulatorGain.connect(upper.frequency);
  bodyLeft.connect(bodyLeftGain);
  bodyRight.connect(bodyRightGain);
  upper.connect(upperGain);
  bodyLeftGain.connect(bodyLeftPan);
  bodyRightGain.connect(bodyRightPan);
  bodyLeftPan.connect(bodySum);
  bodyRightPan.connect(bodySum);
  upperGain.connect(bodySum);
  bodySum.connect(bodyFilter);
  bodyFilter.connect(bodyColor);
  bodyColor.connect(destination);
  pitchedImpact.connect(impactFilter);
  impactFilter.connect(impactGain);
  impactGain.connect(destination);
  fundamental.start(time);
  bodyLeft.start(time);
  bodyRight.start(time);
  upper.start(time);
  modulator.start(time);
  pitchedImpact.start(time);
  engine.registerSource(fundamental, time + duration + 0.2);
  engine.registerSource(bodyLeft, time + duration + 0.2);
  engine.registerSource(bodyRight, time + duration + 0.2);
  engine.registerSource(upper, time + duration + 0.2);
  engine.registerSource(modulator, time + duration + 0.2);
  engine.registerSource(pitchedImpact, time + 0.22);
  scheduleDuck(stems.kawaii.duck.gain, time, 0.76, 0.22 + dna.energy * 0.18);
  scheduleDuck(stems.prism.duck.gain, time, 0.68, 0.28 + dna.energy * 0.22);
  engine.signalVoice("titan", time, clamp(dna.energy * trigger.mix.titan, 0, 1));
  return { baseFrequency, duration, gesture };
};

const spawnKawaii = (engine, dna, time, titan, trigger, destination) => {
  const { ctx, stems } = engine;
  const rng = dna.rng;
  const gesture = trigger.kawaiiGesture;
  const gestureSettings = {
    PLUCK: { baseCount: 3, extraCount: 5, spacing: 0.13, duration: 0.16, durationRange: 0.36, attack: 0.005, peak: 0.055 },
    STAB: { baseCount: 2, extraCount: 3, spacing: 0.095, duration: 0.13, durationRange: 0.2, attack: 0.003, peak: 0.048 },
    CHORD: { baseCount: 3, extraCount: 4, spacing: 0.018, duration: 0.42, durationRange: 0.5, attack: 0.025, peak: 0.038 },
    BEND: { baseCount: 2, extraCount: 4, spacing: 0.24, duration: 0.52, durationRange: 0.72, attack: 0.018, peak: 0.044 },
    PULSE: { baseCount: 3, extraCount: 4, spacing: 0.17, duration: 0.12, durationRange: 0.18, attack: 0.003, peak: 0.042 },
  }[gesture];
  const count = gestureSettings.baseCount + Math.floor(dna.density * gestureSettings.extraCount);
  const notes = [];
  let previousDegree = dna.contour > 0 ? 0 : dna.scale.length - 1;

  for (let index = 0; index < count; index += 1) {
    const inheritedStep = gesture === "CHORD"
      ? [0, 2, 4][index % 3] + Math.floor(index / 3) * dna.contour
      : dna.contour * (index % 2 === 0 ? 1 : 2);
    const mutationRange = gesture === "STAB" || gesture === "PULSE" ? 3 : 5;
    const mutation = rng() > dna.affinity ? Math.floor(rng() * mutationRange) - Math.floor(mutationRange / 2) : 0;
    const degree = gesture === "CHORD" ? inheritedStep + mutation : previousDegree + inheritedStep + mutation;
    previousDegree = degree;
    const octave = gesture === "STAB" || gesture === "PULSE"
      ? (index % 4 === 3 ? 1 : 0)
      : gesture === "PLUCK" ? 1 + (index % 4 === 3 ? 1 : 0) : 1;
    const midi = pickScaleMidi(dna, degree, octave);
    const frequency = midiToFrequency(midi);
    const chordGroupDelay = gesture === "CHORD" ? Math.floor(index / 3) * 0.22 : 0;
    const onset = time + 0.045 + chordGroupDelay
      + (gesture === "CHORD" ? index % 3 : index) * gestureSettings.spacing
      + rng() * (gesture === "CHORD" ? 0.012 : 0.045);
    const duration = gestureSettings.duration + rng() * (gestureSettings.durationRange + dna.space * 0.24);
    const oscillator = ctx.createOscillator();
    const harmonic = ctx.createOscillator();
    const fm = ctx.createOscillator();
    const fmGain = ctx.createGain();
    const oscillatorGain = ctx.createGain();
    const harmonicGain = ctx.createGain();
    const voiceSum = ctx.createGain();
    const cutoffBase = {
      PLUCK: 2200,
      STAB: 850,
      CHORD: 1700,
      BEND: 1350,
      PULSE: 680,
    }[gesture];
    const cutoffRange = {
      PLUCK: 6200,
      STAB: 3600,
      CHORD: 4300,
      BEND: 5200,
      PULSE: 2600,
    }[gesture];
    const filter = createFilter(
      ctx,
      "lowpass",
      cutoffBase + dna.energy * cutoffRange + rng() * 900,
      gesture === "STAB" || gesture === "PULSE" ? 0.85 + dna.tension * 2.4 : 1.5 + dna.tension * 5,
    );
    const envelope = ctx.createGain();
    const panner = ctx.createStereoPanner();
    const bendSemitones = gesture === "BEND"
      ? dna.contour * (3 + Math.floor(rng() * 5))
      : gesture === "PULSE" ? (index % 2 ? -2 : 2) : dna.contour * (0.5 + dna.tension * 2.5);
    const targetRatio = 2 ** (bendSemitones / 12);
    const harmonicRatio = gesture === "CHORD" ? 1.5 : gesture === "STAB" ? 2 : index % 3 === 0 ? 1.5 : 2;

    oscillator.type = gesture === "STAB"
      ? (index % 2 ? "triangle" : "sawtooth")
      : gesture === "PULSE" ? "square"
        : gesture === "BEND" ? (index % 2 ? "triangle" : "sawtooth")
          : gesture === "CHORD" ? "triangle"
            : dna.material === "GLASS" ? "sine" : index % 2 ? "triangle" : "sine";
    harmonic.type = gesture === "STAB" ? "triangle" : index % 4 === 0 ? "triangle" : "sine";
    oscillator.frequency.setValueAtTime(frequency, onset);
    oscillator.frequency.exponentialRampToValueAtTime(frequency * targetRatio, onset + duration * 0.72);
    harmonic.frequency.setValueAtTime(frequency * harmonicRatio, onset);
    harmonic.frequency.exponentialRampToValueAtTime(frequency * harmonicRatio * targetRatio, onset + duration * 0.72);
    fm.frequency.value = titan.baseFrequency * [0.5, 1, 1.5, 2][index % 4] * (0.98 + rng() * 0.04);
    const fmDepth = gesture === "STAB" || gesture === "PULSE"
      ? 2 + dna.tension * 22
      : 4 + dna.tension * 58 + dna.motion * 20;
    fmGain.gain.setValueAtTime(fmDepth, onset);
    fmGain.gain.exponentialRampToValueAtTime(0.01, onset + duration);
    oscillatorGain.gain.value = gesture === "CHORD" ? 0.64 : 0.72;
    harmonicGain.gain.value = gesture === "STAB" ? 0.07 : 0.12 + dna.tension * 0.1;
    const voicePeak = (gestureSettings.peak + dna.energy * 0.034) * trigger.mix.kawaii;
    scheduleEnvelope(envelope.gain, onset, gestureSettings.attack, voicePeak, duration);
    panner.pan.value = clamp((index / Math.max(1, count - 1)) * 1.4 - 0.7 + (rng() - 0.5) * 0.3, -1, 1);
    fm.connect(fmGain);
    fmGain.connect(oscillator.frequency);
    fmGain.connect(harmonic.frequency);
    oscillator.connect(oscillatorGain);
    harmonic.connect(harmonicGain);
    oscillatorGain.connect(voiceSum);
    harmonicGain.connect(voiceSum);
    voiceSum.connect(filter);
    filter.connect(envelope);
    envelope.connect(panner);
    panner.connect(destination);
    fm.start(onset);
    oscillator.start(onset);
    harmonic.start(onset);
    engine.registerSource(fm, onset + duration + 0.1);
    engine.registerSource(oscillator, onset + duration + 0.1);
    engine.registerSource(harmonic, onset + duration + 0.1);
    notes.push({ frequency, onset, duration, degree });
    engine.signalVoice("kawaii", onset, clamp(dna.energy * trigger.mix.kawaii * 0.88, 0, 1));
  }

  return notes;
};

const spawnPrism = (engine, dna, time, motif, trigger, destination) => {
  const { ctx, stems } = engine;
  const rng = dna.rng;
  const gesture = trigger.prismGesture;
  const gestureSettings = {
    SHARD: { baseCount: 4, extraCount: 7, duration: 0.12, durationRange: 0.42, attack: 0.006, peak: 0.021 },
    RIBBON: { baseCount: 2, extraCount: 4, duration: 0.72, durationRange: 1.15, attack: 0.055, peak: 0.019 },
    SWELL: { baseCount: 2, extraCount: 3, duration: 1.15, durationRange: 1.65, attack: 0.2, peak: 0.017 },
    CASCADE: { baseCount: 4, extraCount: 7, duration: 0.2, durationRange: 0.62, attack: 0.012, peak: 0.018 },
    PULSE: { baseCount: 4, extraCount: 5, duration: 0.11, durationRange: 0.22, attack: 0.003, peak: 0.017 },
  }[gesture];
  const count = gestureSettings.baseCount + Math.floor(dna.density * gestureSettings.extraCount);
  const sourceNotes = motif.length ? motif : [{ frequency: midiToFrequency(dna.rootMidi + 24), onset: time }];
  const relationMap = {
    SHARD: [1.5, 2, 2.5, 3, 4, 5],
    RIBBON: [0.75, 1, 1.5, 2, 3],
    SWELL: [0.5, 0.75, 1, 1.5, 2],
    CASCADE: [1, 1.5, 2, 2.5, 3],
    PULSE: [0.5, 1, 1.5, 2],
  }[gesture];
  const frequencyRange = {
    SHARD: [700, 18000],
    RIBBON: [320, 9500],
    SWELL: [280, 7200],
    CASCADE: [480, 14000],
    PULSE: [350, 6200],
  }[gesture];

  for (let index = 0; index < count; index += 1) {
    const parent = sourceNotes[index % sourceNotes.length];
    const relation = relationMap[(index + Math.floor(rng() * 3)) % relationMap.length];
    const frequency = clamp(
      parent.frequency * relation * (1 + (rng() - 0.5) * (1 - dna.affinity) * 0.055),
      frequencyRange[0],
      frequencyRange[1],
    );
    const onset = gesture === "SHARD"
      ? Math.max(time + 0.12, parent.onset + 0.06 + rng() * (0.42 + dna.space * 0.8))
      : gesture === "SWELL" ? time + 0.12 + index * 0.08 + rng() * 0.32
        : gesture === "RIBBON" ? time + 0.08 + index * 0.13 + rng() * 0.09
          : gesture === "CASCADE" ? time + 0.08 + index * (0.07 + (1 - dna.motion) * 0.09) + rng() * 0.035
            : time + 0.07 + index * 0.14 + rng() * 0.025;
    const duration = gestureSettings.duration + rng() * (gestureSettings.durationRange + dna.space * 0.28);
    const oscillator = ctx.createOscillator();
    const envelope = ctx.createGain();
    const panner = ctx.createStereoPanner();
    const filterType = gesture === "SHARD" ? "highpass" : gesture === "CASCADE" ? "bandpass" : "lowpass";
    const filterFrequency = gesture === "SHARD"
      ? Math.min(6000, frequency * 0.42)
      : gesture === "CASCADE" ? frequency
        : Math.min(12000, Math.max(850, frequency * (gesture === "PULSE" ? 1.35 : 2.2)));
    const filter = createFilter(ctx, filterType, filterFrequency, gesture === "CASCADE" ? 1.4 + dna.tension * 3 : 0.75);
    const glideSemitones = gesture === "RIBBON"
      ? dna.contour * (4 + Math.floor(rng() * 6))
      : gesture === "CASCADE" ? (index % 2 ? -4 : 5) : gesture === "SWELL" ? dna.contour * 1.5 : 0;
    const targetRatio = 2 ** (glideSemitones / 12);

    oscillator.type = gesture === "RIBBON"
      ? (index % 2 ? "triangle" : "sawtooth")
      : gesture === "SWELL" ? (index % 2 ? "sine" : "triangle")
        : gesture === "PULSE" ? "square"
          : gesture === "CASCADE" ? (index % 3 ? "triangle" : "sawtooth")
            : index % 5 === 0 ? "triangle" : "sine";
    oscillator.frequency.setValueAtTime(frequency, onset);
    if (targetRatio !== 1) oscillator.frequency.exponentialRampToValueAtTime(frequency * targetRatio, onset + duration * 0.78);
    oscillator.detune.setValueAtTime((rng() - 0.5) * (8 + dna.motion * 34), onset);
    oscillator.detune.linearRampToValueAtTime((rng() - 0.5) * 60 * dna.motion, onset + duration);
    const voicePeak = (gestureSettings.peak + dna.energy * 0.018) * trigger.mix.prism;
    scheduleEnvelope(envelope.gain, onset, gestureSettings.attack + rng() * gestureSettings.attack * 0.35, voicePeak, duration);
    panner.pan.value = clamp((rng() * 2 - 1) * (0.45 + dna.motion * 0.5), -1, 1);
    oscillator.connect(filter);
    filter.connect(envelope);
    envelope.connect(panner);
    panner.connect(destination);
    oscillator.start(onset);
    engine.registerSource(oscillator, onset + duration + 0.2);
    engine.signalVoice("prism", onset, clamp(dna.energy * trigger.mix.prism * 0.72, 0, 1));
  }

  if (dna.space > 0.34 && (gesture === "RIBBON" || gesture === "SWELL")) {
    const bloomCount = 2 + Math.floor(dna.density * 2);
    for (let index = 0; index < bloomCount; index += 1) {
      const parent = sourceNotes[index % sourceNotes.length];
      const oscillator = ctx.createOscillator();
      const envelope = ctx.createGain();
      const panner = ctx.createStereoPanner();
      const bloomFilter = createFilter(ctx, "lowpass", 4200 + dna.energy * 4200, 0.7);
      const onset = time + 0.24 + index * 0.12 + rng() * 0.16;
      const duration = 1 + dna.space * 1.8 + rng() * 0.48;
      const ratio = [1, 1.5, 2, 3][index % 4];
      const frequency = clamp(parent.frequency * ratio, 520, 9800);
      oscillator.type = index % 2 ? "triangle" : "sawtooth";
      oscillator.frequency.setValueAtTime(frequency, onset);
      oscillator.detune.setValueAtTime((index - bloomCount / 2) * (2 + dna.motion * 5), onset);
      oscillator.detune.linearRampToValueAtTime((rng() - 0.5) * 22 * dna.motion, onset + duration);
      oscillator.frequency.exponentialRampToValueAtTime(
        frequency * 2 ** ((dna.contour * (2 + index)) / 12),
        onset + duration * 0.82,
      );
      scheduleEnvelope(
        envelope.gain,
        onset,
        0.12 + rng() * 0.18,
        (0.007 + dna.energy * 0.009) * trigger.mix.prism,
        duration,
      );
      panner.pan.value = clamp((index / Math.max(1, bloomCount - 1)) * 1.6 - 0.8, -1, 1);
      oscillator.connect(bloomFilter);
      bloomFilter.connect(envelope);
      envelope.connect(panner);
      panner.connect(destination);
      oscillator.start(onset);
      engine.registerSource(oscillator, onset + duration + 0.1);
      engine.signalVoice("prism", onset, clamp(dna.energy * trigger.mix.prism * 0.52, 0, 1));
    }
  }
};

export class ConvergenceEngine {
  constructor({ onScene, onVoice, onRecordLimit } = {}) {
    this.onScene = onScene;
    this.onVoice = onVoice;
    this.onRecordLimit = onRecordLimit;
    this.activeSources = new Set();
    this.activeEffects = new Set();
    this.activeScenes = [];
    this.schedulingScene = null;
    this.lastBurstAt = Number.NEGATIVE_INFINITY;
    this.lastBurstAudioTime = Number.NEGATIVE_INFINITY;
    this.driftTimer = null;
    this.idleSuspendTimer = null;
    this.masterMode = "BRUTAL";
    this.masterDrive = 12;
    this.masterTone = 0.62;
    this.outputLevel = 1;
    this.stemLevels = { titan: 0.88, kawaii: 0.82, prism: 0.8 };
    this.workletsReady = false;
  }

  async init() {
    if (!this.ctx) {
      this.ctx = createPreviewAudioContext();
      if (this.ctx.state === "suspended") this.ctx.resume().catch(() => {});
      this.readyPromise = this.buildGraph();
    }

    await this.readyPromise;
    this.cancelIdleSuspend();
    if (this.ctx.state === "suspended") await this.ctx.resume();
    return this;
  }

  async buildGraph() {
    if (this.ctx.audioWorklet) {
      try {
        await this.ctx.audioWorklet.addModule(DSP_WORKLET_URL);
        this.workletsReady = true;
      } catch (error) {
        console.warn("CONVERGENCE DSP worklets unavailable; using transparent fallbacks.", error);
      }
    }

    this.stemMixBus = this.ctx.createGain();
    this.mixBus = this.ctx.createGain();
    this.mixBus.gain.value = 0.68;
    this.stems = createStemBuses(this.ctx, this.stemMixBus, false);
    Object.entries(this.stemLevels).forEach(([stem, level]) => {
      this.stems[stem].level.gain.value = level;
    });
    this.previewDry = this.ctx.createGain();
    this.previewGrain = createGranularDelay(this.ctx, this.workletsReady, {
      delayMs: 190,
      grainMs: 72,
      overlap: 2.4,
      pitch: 1,
      feedback: 0.14,
      jitter: 0.28,
      spread: 0.72,
      seed: 0x53414645,
    });
    this.previewGrainWet = this.ctx.createGain();
    this.previewDenoiser = createTonalDenoiser(this.ctx, this.workletsReady, {
      amount: 0.48,
      floorDb: -15,
      lowPreserveHz: 135,
    });
    this.previewDry.gain.value = 0.94;
    this.previewGrainWet.gain.value = 0.12;
    this.stemMixBus.connect(this.previewDry);
    this.previewDry.connect(this.mixBus);
    this.stemMixBus.connect(this.previewGrain);
    this.previewGrain.connect(this.previewGrainWet);
    this.previewGrainWet.connect(this.mixBus);
    this.mixBus.connect(this.previewDenoiser.input);

    this.multiband = createMultibandMaster(this.ctx);
    this.inflator = createInflatorMaster(this.ctx);
    this.brutal = createBrutalMaster(this.ctx, this.workletsReady);
    this.multibandModeGain = this.ctx.createGain();
    this.inflatorModeGain = this.ctx.createGain();
    this.brutalModeGain = this.ctx.createGain();
    this.masterGain = this.ctx.createGain();
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 2048;
    this.analyser.smoothingTimeConstant = 0.72;
    this.masterGain.gain.value = this.outputLevel;
    this.multibandModeGain.gain.value = this.masterMode === "MULTIBAND" ? 1 : 0;
    this.inflatorModeGain.gain.value = this.masterMode === "INFLATOR" ? 1 : 0;
    this.brutalModeGain.gain.value = this.masterMode === "BRUTAL" ? 1 : 0;

    this.masterInputs = {
      MULTIBAND: this.multiband.input,
      INFLATOR: this.inflator.input,
      BRUTAL: this.brutal.input,
    };
    this.connectedMasterInput = this.masterInputs[this.masterMode];
    this.previewDenoiser.output.connect(this.connectedMasterInput);
    this.multiband.output.connect(this.multibandModeGain);
    this.inflator.output.connect(this.inflatorModeGain);
    this.brutal.output.connect(this.brutalModeGain);
    this.multibandModeGain.connect(this.masterGain);
    this.inflatorModeGain.connect(this.masterGain);
    this.brutalModeGain.connect(this.masterGain);
    this.masterGain.connect(this.analyser);
    this.recorder = createWavRecorder(this.ctx, this.analyser, {
      onLimit: () => this.onRecordLimit?.(),
    });
    this.analyser.connect(this.ctx.destination);
    this.setMasterDrive(this.masterDrive);
    this.setMasterTone(this.masterTone);
  }

  setMasterMode(mode) {
    this.masterMode = ["MULTIBAND", "INFLATOR", "BRUTAL"].includes(mode) ? mode : "BRUTAL";
    if (!this.brutalModeGain) return;
    const nextInput = this.masterInputs[this.masterMode];
    if (nextInput !== this.connectedMasterInput) {
      try { this.previewDenoiser.output.disconnect(this.connectedMasterInput); } catch (error) { /* already disconnected */ }
      this.previewDenoiser.output.connect(nextInput);
      this.connectedMasterInput = nextInput;
    }
    const time = this.ctx.currentTime;
    this.multibandModeGain.gain.setTargetAtTime(this.masterMode === "MULTIBAND" ? 1 : 0, time, 0.025);
    this.inflatorModeGain.gain.setTargetAtTime(this.masterMode === "INFLATOR" ? 1 : 0, time, 0.025);
    this.brutalModeGain.gain.setTargetAtTime(this.masterMode === "BRUTAL" ? 1 : 0, time, 0.025);
  }

  setMasterDrive(value) {
    this.masterDrive = clamp(Number(value), 0, 18);
    if (!this.brutal) return;
    const time = this.ctx.currentTime;
    this.multiband.input.gain.setTargetAtTime(dbToGain(this.masterDrive), time, 0.04);
    this.inflator.input.gain.setTargetAtTime(dbToGain(this.masterDrive), time, 0.04);
    this.brutal.input.gain.setTargetAtTime(dbToGain(this.masterDrive), time, 0.04);
  }

  setMasterTone(value) {
    this.masterTone = clamp(Number(value), 0, 1);
    if (!this.brutal) return;
    const time = this.ctx.currentTime;
    const multibandPriorities = [
      1.01 + this.masterTone * 0.1,
      1.01 + this.masterTone * 0.035,
      1.01 - this.masterTone * 0.04,
      1 + this.masterTone * 0.045,
      1.01 + this.masterTone * 0.11,
    ];
    this.multiband.priorityGains.forEach((gain, index) => {
      gain.gain.setTargetAtTime(multibandPriorities[index], time, 0.05);
    });
    this.inflator.lowShelf.gain.setTargetAtTime(0.3 + this.masterTone * 1.8, time, 0.05);
    this.inflator.bodyDip.gain.setTargetAtTime(-0.2 - this.masterTone * 1.1, time, 0.05);
    this.inflator.highShelf.gain.setTargetAtTime(0.4 + this.masterTone * 2.2, time, 0.05);
    this.inflator.inflator.curve = createInflatorCurve(
      4 + this.masterTone * 12,
      25 + this.masterTone * 24,
      false,
    );
    const brutalPriorities = [
      1.02 + this.masterTone * 0.12,
      1.01 + this.masterTone * 0.04,
      1.01 - this.masterTone * 0.055,
      1 + this.masterTone * 0.055,
      1.015 + this.masterTone * 0.13,
    ];
    this.brutal.priorityGains.forEach((gain, index) => {
      gain.gain.setTargetAtTime(brutalPriorities[index], time, 0.05);
    });
    this.brutal.lowShelf.gain.setTargetAtTime(0.6 + this.masterTone * 2.2, time, 0.05);
    this.brutal.bodyDip.gain.setTargetAtTime(-0.35 - this.masterTone * 1.35, time, 0.05);
    this.brutal.highShelf.gain.setTargetAtTime(0.7 + this.masterTone * 2.8, time, 0.05);
    this.brutal.inflator.curve = createInflatorCurve(
      7 + this.masterTone * 15,
      48 + this.masterTone * 24,
      false,
    );
    this.brutal.ottSweetener.lowShelf.gain.setTargetAtTime(0.15 + this.masterTone * 0.65, time, 0.05);
    this.brutal.ottSweetener.presence.gain.setTargetAtTime(0.3 + this.masterTone * 0.8, time, 0.05);
    this.brutal.ottSweetener.airShelf.gain.setTargetAtTime(0.35 + this.masterTone * 0.95, time, 0.05);
  }

  setOutputLevel(value) {
    this.outputLevel = clamp(Number(value), 0, 1);
    if (this.masterGain) this.masterGain.gain.setTargetAtTime(this.outputLevel, this.ctx.currentTime, 0.05);
  }

  setStemLevel(stem, value) {
    const level = clamp(Number(value), 0, 1.2);
    if (stem in this.stemLevels) this.stemLevels[stem] = level;
    const target = this.stems?.[stem];
    if (target) target.level.gain.setTargetAtTime(clamp(Number(value), 0, 1.2), this.ctx.currentTime, 0.05);
  }

  registerSource(source, stopTime) {
    const scene = this.schedulingScene;
    this.activeSources.add(source);
    scene?.sources.add(source);
    source.onended = () => {
      this.activeSources.delete(source);
      scene?.sources.delete(source);
      this.finalizeScene(scene);
    };
    source.stop(stopTime);
  }

  beginScene(sceneLimit = MAX_ACTIVE_SCENES) {
    while (this.activeScenes.length >= sceneLimit) {
      this.retireScene(this.activeScenes[0]);
    }
    const scene = {
      sources: new Set(),
      effects: new Set(),
      outputGains: new Set(),
      timers: new Set(),
      retired: false,
    };
    this.activeScenes.push(scene);
    return scene;
  }

  finalizeScene(scene) {
    if (!scene || scene.retired || scene.sources.size || scene.effects.size || scene.timers.size) return;
    scene.outputGains.clear();
    const index = this.activeScenes.indexOf(scene);
    if (index >= 0) this.activeScenes.splice(index, 1);
  }

  retireScene(scene) {
    if (!scene || scene.retired) return;
    scene.retired = true;
    const now = this.ctx?.currentTime || 0;
    const stopTime = now + 0.018;
    scene.outputGains.forEach((output) => {
      output.gain.cancelScheduledValues(now);
      output.gain.setTargetAtTime(0, now, 0.004);
    });
    scene.sources.forEach((source) => {
      try { source.stop(stopTime); } catch (error) { /* already stopped */ }
      this.activeSources.delete(source);
    });
    const effectCleanups = [...scene.effects];
    window.setTimeout(() => effectCleanups.forEach((cleanup) => cleanup()), 24);
    scene.timers.forEach((timer) => window.clearTimeout(timer));
    scene.sources.clear();
    scene.outputGains.clear();
    scene.timers.clear();
    const index = this.activeScenes.indexOf(scene);
    if (index >= 0) this.activeScenes.splice(index, 1);
  }

  registerEffectGraph(nodes, cleanupTime) {
    const scene = this.schedulingScene;
    let timer = null;
    const cleanup = () => {
      if (timer !== null) window.clearTimeout(timer);
      nodes.forEach((node) => {
        try { node.disconnect(); } catch (error) { /* already disconnected */ }
      });
      this.activeEffects.delete(cleanup);
      scene?.effects.delete(cleanup);
      this.finalizeScene(scene);
    };
    const delay = Math.max(0, (cleanupTime - this.ctx.currentTime) * 1000);
    while (this.activeEffects.size >= MAX_ACTIVE_EFFECT_RACKS) {
      const oldestCleanup = this.activeEffects.values().next().value;
      oldestCleanup?.();
    }
    this.activeEffects.add(cleanup);
    scene?.effects.add(cleanup);
    timer = window.setTimeout(cleanup, delay);
  }

  signalVoice(stem, time, intensity) {
    const scene = this.schedulingScene;
    const delay = Math.max(0, (time - this.ctx.currentTime) * 1000);
    const timer = window.setTimeout(() => {
      scene?.timers.delete(timer);
      if (!scene?.retired) this.onVoice?.({ stem, intensity, time });
      this.finalizeScene(scene);
    }, delay);
    scene?.timers.add(timer);
  }

  scheduleScene(
    settings,
    seed,
    startTime = this.ctx.currentTime + 0.035,
    sceneLimit = MAX_ACTIVE_SCENES,
  ) {
    const dna = createSceneDna(seed, settings);
    const scene = this.beginScene(sceneLimit);
    this.schedulingScene = scene;
    let sceneEffects;
    try {
      sceneEffects = createSceneEffects(this, dna, startTime);
      scene.outputGains.add(sceneEffects.titan.output);
      scene.outputGains.add(sceneEffects.kawaii.output);
      scene.outputGains.add(sceneEffects.prism.output);
      dna.triggers.forEach((trigger) => {
        const triggerTime = startTime + trigger.offset;
        const titan = spawnTitan(this, dna, triggerTime + trigger.timing.titan, trigger, sceneEffects.titan.input);
        const motif = spawnKawaii(
          this,
          dna,
          triggerTime + trigger.timing.kawaii,
          titan,
          trigger,
          sceneEffects.kawaii.input,
        );
        spawnPrism(
          this,
          dna,
          triggerTime + trigger.timing.prism,
          motif,
          trigger,
          sceneEffects.prism.input,
        );
      });
    } catch (error) {
      this.retireScene(scene);
      throw error;
    } finally {
      this.schedulingScene = null;
    }
    const primaryTrigger = dna.triggers[0];
    this.onScene?.({
      seed: dna.seed,
      scale: dna.scaleName,
      material: dna.material,
      root: dna.rootMidi,
      duration: dna.duration,
      triggerCount: dna.triggers.length,
      titanGesture: primaryTrigger.titanGesture,
      kawaiiGesture: primaryTrigger.kawaiiGesture,
      prismGesture: primaryTrigger.prismGesture,
      fx: {
        titan: sceneEffects.titan.dominant,
        kawaii: sceneEffects.kawaii.dominant,
        prism: sceneEffects.prism.dominant,
      },
    });
    return dna;
  }

  burst(settings, seed) {
    const now = performance.now();
    if (now - this.lastBurstAt < BURST_COOLDOWN_MS) return null;
    if (this.ctx.currentTime - this.lastBurstAudioTime < BURST_AUDIO_COOLDOWN_SECONDS) return null;
    this.cancelIdleSuspend();
    this.lastBurstAt = now;
    this.lastBurstAudioTime = this.ctx.currentTime;
    return this.scheduleScene(settings, seed, this.ctx.currentTime + 0.035, 1);
  }

  startDrift(settingsProvider, seed) {
    this.stopDrift();
    this.cancelIdleSuspend();
    let currentSeed = hashSeed(seed);
    let nextSceneTime = this.ctx.currentTime + 0.04;
    const tick = () => {
      while (nextSceneTime < this.ctx.currentTime + 0.6) {
        const dna = this.scheduleScene(settingsProvider(), currentSeed, nextSceneTime);
        currentSeed = hashSeed(currentSeed + 0x9e3779b9);
        nextSceneTime += Math.max(1.8, dna.duration * (0.58 + (1 - dna.density) * 0.2));
      }
    };
    tick();
    this.driftTimer = window.setInterval(tick, 100);
  }

  stopDrift() {
    if (this.driftTimer) window.clearInterval(this.driftTimer);
    this.driftTimer = null;
  }

  stopAll() {
    this.stopDrift();
    this.lastBurstAt = Number.NEGATIVE_INFINITY;
    this.lastBurstAudioTime = Number.NEGATIVE_INFINITY;
    [...this.activeScenes].forEach((scene) => this.retireScene(scene));
    const stopTime = this.ctx ? this.ctx.currentTime + 0.035 : 0;
    this.activeSources.forEach((source) => {
      try { source.stop(stopTime); } catch (error) { /* already stopped */ }
    });
    this.activeSources.clear();
    this.scheduleIdleSuspend();
  }

  cancelIdleSuspend() {
    if (this.idleSuspendTimer !== null) window.clearTimeout(this.idleSuspendTimer);
    this.idleSuspendTimer = null;
  }

  scheduleIdleSuspend() {
    this.cancelIdleSuspend();
    if (!this.ctx || this.ctx.state === "closed") return;
    this.idleSuspendTimer = window.setTimeout(() => {
      this.idleSuspendTimer = null;
      if (!this.activeSources.size && !this.driftTimer && this.ctx.state === "running") {
        this.ctx.suspend().catch(() => {});
      }
    }, 2000);
  }

  getMeterState() {
    if (!this.brutal) return { reductions: [0, 0, 0, 0, 0], limiter: 0 };
    const chain = this.masterMode === "MULTIBAND"
      ? this.multiband
      : this.masterMode === "INFLATOR" ? this.inflator : this.brutal;
    return {
      reductions: chain.compressors.map((compressor) => Math.abs(compressor.reduction || 0)),
      limiter: Math.abs(chain.limiter.reduction || 0),
    };
  }

  async startRecording() {
    await this.init();
    await this.recorder.start();
  }

  async stopRecording(filename) {
    if (!this.recorder) return null;
    return this.recorder.stop(filename);
  }

  destroy() {
    this.stopAll();
    this.cancelIdleSuspend();
    this.recorder?.destroy();
    if (this.ctx && this.ctx.state !== "closed") this.ctx.close();
  }
}

export const nextSeed = (seed) => hashSeed((Number(seed) || 1) + 0x9e3779b9);
