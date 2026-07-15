import { createWavRecorder } from "./recording.js";

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

const createBandPath = (ctx, input, bandIndex) => {
  const filters = [];
  if (bandIndex > 0) {
    filters.push(
      createFilter(ctx, "highpass", CROSSOVERS[bandIndex - 1]),
      createFilter(ctx, "highpass", CROSSOVERS[bandIndex - 1]),
    );
  }
  if (bandIndex < CROSSOVERS.length) {
    filters.push(
      createFilter(ctx, "lowpass", CROSSOVERS[bandIndex]),
      createFilter(ctx, "lowpass", CROSSOVERS[bandIndex]),
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

const createTransientShaper = (ctx, workletsReady, amount = 1.2) => {
  if (!workletsReady) return ctx.createGain();
  return new AudioWorkletNode(ctx, "transient-shaper", {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [2],
    channelCount: 2,
    channelCountMode: "explicit",
    processorOptions: { amount },
  });
};

const createBrutalMaster = (ctx, workletsReady) => {
  const input = ctx.createGain();
  const dcFilter = createFilter(ctx, "highpass", 18, 0.7);
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
  hardCeiling.oversample = "4x";

  input.connect(dcFilter);
  thresholds.forEach((threshold, bandIndex) => {
    const bandOutput = createBandPath(ctx, dcFilter, bandIndex);
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
    transientShaper,
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
    transientShaper,
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
  if (!workletsReady) return ctx.createGain();
  return new AudioWorkletNode(ctx, "tonal-denoiser", {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [2],
    channelCount: 2,
    channelCountMode: "explicit",
    processorOptions: settings,
  });
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
    titanDenoiser,
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
    kawaiiDenoiser,
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
    prismDenoiser,
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
      denoiser: titanDenoiser,
    },
    kawaii: {
      name: "kawaii",
      input: kawaiiInput,
      duck: kawaiiDuck,
      level: kawaiiLevel,
      denoiser: kawaiiDenoiser,
    },
    prism: {
      name: "prism",
      input: prismInput,
      duck: prismDuck,
      level: prismLevel,
      denoiser: prismDenoiser,
    },
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
  const duration = 3.2 + density * 3.8 + rng() * 1.4;
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
    affinity: clamp(settings.affinity, 0, 1),
    motion: clamp(settings.motion, 0, 1),
    space: clamp(settings.space, 0, 1),
    tension: clamp(settings.tension, 0, 1),
    duration,
  };
};

const pickScaleMidi = (dna, degreeIndex, octave = 0) => {
  const scaleLength = dna.scale.length;
  const wrapped = ((degreeIndex % scaleLength) + scaleLength) % scaleLength;
  const octaveOffset = Math.floor(degreeIndex / scaleLength) * 12;
  return dna.rootMidi + dna.scale[wrapped] + octaveOffset + octave * 12;
};

const spawnTitan = (engine, dna, time) => {
  const { ctx, stems } = engine;
  const rng = dna.rng;
  const baseFrequency = midiToFrequency(dna.rootMidi - 12);
  const duration = 1.7 + dna.energy * 1.8 + rng() * 0.55;
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
  const dropStart = baseFrequency * (1.22 + dna.tension * 0.38);
  const settleTime = time + 0.28 + dna.energy * 0.32;

  fundamental.type = "sine";
  bodyLeft.type = dna.material === "RUBBER" ? "triangle" : "sine";
  bodyRight.type = dna.material === "PLASMA" ? "sawtooth" : "triangle";
  upper.type = dna.material === "GLASS" ? "sine" : "triangle";
  pitchedImpact.type = "sine";
  modulator.type = "sine";
  fundamental.frequency.setValueAtTime(dropStart, time);
  fundamental.frequency.exponentialRampToValueAtTime(baseFrequency * 0.985, settleTime);
  fundamental.frequency.exponentialRampToValueAtTime(baseFrequency, time + duration * 0.72);
  bodyLeft.frequency.setValueAtTime(baseFrequency * 2.12, time);
  bodyLeft.frequency.exponentialRampToValueAtTime(baseFrequency * 2.002, settleTime + 0.08);
  bodyRight.frequency.setValueAtTime(baseFrequency * 2.16, time);
  bodyRight.frequency.exponentialRampToValueAtTime(baseFrequency * 1.998, settleTime + 0.11);
  upper.frequency.setValueAtTime(baseFrequency * (3.02 + dna.tension * 0.15), time);
  upper.frequency.exponentialRampToValueAtTime(baseFrequency * 3.001, time + duration * 0.62);
  pitchedImpact.frequency.setValueAtTime(baseFrequency * (6.5 + dna.tension * 1.8), time);
  pitchedImpact.frequency.exponentialRampToValueAtTime(baseFrequency * 2.4, time + 0.13);
  modulator.frequency.value = baseFrequency * (0.48 + dna.motion * 0.34);
  modulatorGain.gain.value = 2.5 + dna.tension * 10;
  scheduleEnvelope(fundamentalGain.gain, time, 0.006, 0.25 + dna.energy * 0.13, duration);
  scheduleEnvelope(bodyLeftGain.gain, time, 0.005, 0.062 + dna.energy * 0.035, duration * 0.84);
  scheduleEnvelope(bodyRightGain.gain, time, 0.007, 0.052 + dna.tension * 0.032, duration * 0.78);
  scheduleEnvelope(upperGain.gain, time, 0.004, 0.026 + dna.energy * 0.024, duration * 0.62);
  scheduleEnvelope(impactGain.gain, time, 0.0015, 0.085 + dna.energy * 0.06, 0.15);
  bodyLeftPan.pan.value = -0.18 - dna.motion * 0.08;
  bodyRightPan.pan.value = 0.18 + dna.motion * 0.08;
  bodyColor.curve = createSaturationCurve(2.1, -0.035, 0.54);
  bodyColor.oversample = "4x";

  fundamental.connect(fundamentalGain);
  fundamentalGain.connect(stems.titan.input);
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
  bodyColor.connect(stems.titan.input);
  pitchedImpact.connect(impactFilter);
  impactFilter.connect(impactGain);
  impactGain.connect(stems.titan.input);
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
  engine.signalVoice("titan", time, dna.energy);
  return { baseFrequency, duration };
};

const spawnKawaii = (engine, dna, time, titan) => {
  const { ctx, stems } = engine;
  const rng = dna.rng;
  const count = 3 + Math.floor(dna.density * 7);
  const notes = [];
  let previousDegree = dna.contour > 0 ? 0 : dna.scale.length - 1;

  for (let index = 0; index < count; index += 1) {
    const inheritedStep = dna.contour * (index % 2 === 0 ? 1 : 2);
    const mutation = rng() > dna.affinity ? Math.floor(rng() * 5) - 2 : 0;
    const degree = previousDegree + inheritedStep + mutation;
    previousDegree = degree;
    const midi = pickScaleMidi(dna, degree, 1 + (index % 3 === 2 ? 1 : 0));
    const frequency = midiToFrequency(midi);
    const onset = time + 0.07 + index * (0.11 + (1 - dna.motion) * 0.1) + rng() * 0.055;
    const duration = 0.18 + rng() * (0.32 + dna.space * 0.34);
    const oscillator = ctx.createOscillator();
    const harmonic = ctx.createOscillator();
    const fm = ctx.createOscillator();
    const fmGain = ctx.createGain();
    const oscillatorGain = ctx.createGain();
    const harmonicGain = ctx.createGain();
    const voiceSum = ctx.createGain();
    const filter = createFilter(ctx, "lowpass", 1900 + dna.energy * 5600 + rng() * 1800, 1.6 + dna.tension * 6);
    const envelope = ctx.createGain();
    const panner = ctx.createStereoPanner();
    const targetRatio = 2 ** ((dna.contour * (1 + dna.tension * 4)) / 12);
    const harmonicRatio = index % 3 === 0 ? 1.5 : 2;

    oscillator.type = dna.material === "GLASS" ? "sine" : index % 2 ? "triangle" : "sine";
    harmonic.type = index % 4 === 0 ? "triangle" : "sine";
    oscillator.frequency.setValueAtTime(frequency, onset);
    oscillator.frequency.exponentialRampToValueAtTime(frequency * targetRatio, onset + duration * 0.72);
    harmonic.frequency.setValueAtTime(frequency * harmonicRatio, onset);
    harmonic.frequency.exponentialRampToValueAtTime(frequency * harmonicRatio * targetRatio, onset + duration * 0.72);
    fm.frequency.value = titan.baseFrequency * [0.5, 1, 1.5, 2][index % 4] * (0.98 + rng() * 0.04);
    fmGain.gain.setValueAtTime(4 + dna.tension * 62 + dna.motion * 22, onset);
    fmGain.gain.exponentialRampToValueAtTime(0.01, onset + duration);
    oscillatorGain.gain.value = 0.72;
    harmonicGain.gain.value = 0.16 + dna.tension * 0.12;
    scheduleEnvelope(envelope.gain, onset, 0.006, 0.058 + dna.energy * 0.044, duration);
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
    panner.connect(stems.kawaii.input);
    fm.start(onset);
    oscillator.start(onset);
    harmonic.start(onset);
    engine.registerSource(fm, onset + duration + 0.1);
    engine.registerSource(oscillator, onset + duration + 0.1);
    engine.registerSource(harmonic, onset + duration + 0.1);
    notes.push({ frequency, onset, duration, degree });
    engine.signalVoice("kawaii", onset, dna.energy * 0.82);
  }

  return notes;
};

const spawnPrism = (engine, dna, time, motif) => {
  const { ctx, stems } = engine;
  const rng = dna.rng;
  const count = 6 + Math.floor(dna.density * 12);
  const sourceNotes = motif.length ? motif : [{ frequency: midiToFrequency(dna.rootMidi + 24), onset: time }];

  for (let index = 0; index < count; index += 1) {
    const parent = sourceNotes[index % sourceNotes.length];
    const relation = [1.5, 2, 2.5, 3, 4, 5][(index + Math.floor(rng() * 3)) % 6];
    const frequency = clamp(parent.frequency * relation * (1 + (rng() - 0.5) * (1 - dna.affinity) * 0.055), 480, 18000);
    const onset = Math.max(time + 0.18, parent.onset + 0.12 + rng() * (0.5 + dna.space * 1.3));
    const duration = 0.2 + rng() * (0.5 + dna.space * 1.25);
    const oscillator = ctx.createOscillator();
    const envelope = ctx.createGain();
    const panner = ctx.createStereoPanner();
    const highpass = createFilter(ctx, "highpass", Math.min(6000, frequency * 0.45), 0.7);

    oscillator.type = index % 5 === 0 ? "triangle" : "sine";
    oscillator.frequency.setValueAtTime(frequency, onset);
    oscillator.detune.setValueAtTime((rng() - 0.5) * (8 + dna.motion * 34), onset);
    oscillator.detune.linearRampToValueAtTime((rng() - 0.5) * 60 * dna.motion, onset + duration);
    scheduleEnvelope(envelope.gain, onset, 0.008 + rng() * 0.03, 0.018 + dna.energy * 0.022, duration);
    panner.pan.value = clamp((rng() * 2 - 1) * (0.45 + dna.motion * 0.5), -1, 1);
    oscillator.connect(highpass);
    highpass.connect(envelope);
    envelope.connect(panner);
    panner.connect(stems.prism.input);
    oscillator.start(onset);
    engine.registerSource(oscillator, onset + duration + 0.2);
    engine.signalVoice("prism", onset, dna.energy * 0.65);
  }

  if (dna.space > 0.34) {
    const bloomCount = 3 + Math.floor(dna.density * 3);
    for (let index = 0; index < bloomCount; index += 1) {
      const parent = sourceNotes[index % sourceNotes.length];
      const oscillator = ctx.createOscillator();
      const envelope = ctx.createGain();
      const panner = ctx.createStereoPanner();
      const onset = time + 0.3 + index * 0.075 + rng() * 0.18;
      const duration = 0.9 + dna.space * 2 + rng() * 0.45;
      const ratio = [2, 3, 4, 5, 6][index % 5];
      const frequency = clamp(parent.frequency * ratio, 1200, 17500);
      oscillator.type = index % 3 === 0 ? "triangle" : "sine";
      oscillator.frequency.setValueAtTime(frequency, onset);
      oscillator.detune.setValueAtTime((index - bloomCount / 2) * (2 + dna.motion * 5), onset);
      oscillator.detune.linearRampToValueAtTime((rng() - 0.5) * 22 * dna.motion, onset + duration);
      scheduleEnvelope(envelope.gain, onset, 0.1 + rng() * 0.14, 0.009 + dna.energy * 0.012, duration);
      panner.pan.value = clamp((index / Math.max(1, bloomCount - 1)) * 1.6 - 0.8, -1, 1);
      oscillator.connect(envelope);
      envelope.connect(panner);
      panner.connect(stems.prism.input);
      oscillator.start(onset);
      engine.registerSource(oscillator, onset + duration + 0.1);
      engine.signalVoice("prism", onset, dna.energy * 0.48);
    }
  }
};

export class ConvergenceEngine {
  constructor({ onScene, onVoice, onRecordLimit } = {}) {
    this.onScene = onScene;
    this.onVoice = onVoice;
    this.onRecordLimit = onRecordLimit;
    this.activeSources = new Set();
    this.driftTimer = null;
    this.masterMode = "BRUTAL";
    this.masterDrive = 12;
    this.masterTone = 0.62;
    this.outputLevel = 1;
    this.stemLevels = { titan: 0.88, kawaii: 0.82, prism: 0.8 };
    this.workletsReady = false;
  }

  async init() {
    if (!this.ctx) {
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      this.ctx = new AudioContext({ sampleRate: 96000, latencyHint: "interactive" });
      if (this.ctx.state === "suspended") this.ctx.resume().catch(() => {});
      this.readyPromise = this.buildGraph();
    }

    await this.readyPromise;
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

    this.mixBus = this.ctx.createGain();
    this.mixBus.gain.value = 0.68;
    this.stems = createStemBuses(this.ctx, this.mixBus, this.workletsReady);
    Object.entries(this.stemLevels).forEach(([stem, level]) => {
      this.stems[stem].level.gain.value = level;
    });

    this.multiband = createMultibandMaster(this.ctx);
    this.inflator = createInflatorMaster(this.ctx);
    this.brutal = createBrutalMaster(this.ctx, this.workletsReady);
    this.multibandModeGain = this.ctx.createGain();
    this.inflatorModeGain = this.ctx.createGain();
    this.brutalModeGain = this.ctx.createGain();
    this.masterGain = this.ctx.createGain();
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 4096;
    this.analyser.smoothingTimeConstant = 0.72;
    this.masterGain.gain.value = this.outputLevel;
    this.multibandModeGain.gain.value = this.masterMode === "MULTIBAND" ? 1 : 0;
    this.inflatorModeGain.gain.value = this.masterMode === "INFLATOR" ? 1 : 0;
    this.brutalModeGain.gain.value = this.masterMode === "BRUTAL" ? 1 : 0;

    this.mixBus.connect(this.multiband.input);
    this.mixBus.connect(this.inflator.input);
    this.mixBus.connect(this.brutal.input);
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
    this.activeSources.add(source);
    source.onended = () => this.activeSources.delete(source);
    source.stop(stopTime);
  }

  signalVoice(stem, time, intensity) {
    const delay = Math.max(0, (time - this.ctx.currentTime) * 1000);
    window.setTimeout(() => this.onVoice?.({ stem, intensity, time }), delay);
  }

  scheduleScene(settings, seed, startTime = this.ctx.currentTime + 0.035) {
    const dna = createSceneDna(seed, settings);
    const titan = spawnTitan(this, dna, startTime);
    const motif = spawnKawaii(this, dna, startTime, titan);
    spawnPrism(this, dna, startTime, motif);
    this.onScene?.({
      seed: dna.seed,
      scale: dna.scaleName,
      material: dna.material,
      root: dna.rootMidi,
      duration: dna.duration,
    });
    return dna;
  }

  burst(settings, seed) {
    return this.scheduleScene(settings, seed);
  }

  startDrift(settingsProvider, seed) {
    this.stopDrift();
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
    const stopTime = this.ctx ? this.ctx.currentTime + 0.035 : 0;
    this.activeSources.forEach((source) => {
      try { source.stop(stopTime); } catch (error) { /* already stopped */ }
    });
    this.activeSources.clear();
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
    this.recorder?.destroy();
    if (this.ctx && this.ctx.state !== "closed") this.ctx.close();
  }
}

export const nextSeed = (seed) => hashSeed((Number(seed) || 1) + 0x9e3779b9);
