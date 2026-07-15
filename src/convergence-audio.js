import { createWavRecorder } from "./recording.js";

const TAU = Math.PI * 2;
const SCALES = {
  DORIAN: [0, 2, 3, 5, 7, 9, 10],
  LYDIAN: [0, 2, 4, 6, 7, 9, 11],
  MINOR: [0, 2, 3, 5, 7, 8, 10],
  PENTATONIC: [0, 2, 4, 7, 9],
};

const MATERIALS = ["GLASS", "RUBBER", "PLASMA", "DUST"];
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

const createStemBuses = (ctx, mixBus) => {
  const createStem = (name, filters = []) => {
    const input = ctx.createGain();
    const duck = ctx.createGain();
    const level = ctx.createGain();
    const nodes = [input, ...filters, duck, level, mixBus];
    connectSeries(nodes);
    return { name, input, duck, level };
  };

  const titan = createStem("titan", [createFilter(ctx, "lowpass", 420, 0.65)]);
  const kawaiiInput = ctx.createGain();
  const kawaiiHigh = createFilter(ctx, "highpass", 130, 0.65);
  const kawaiiLow = createFilter(ctx, "lowpass", 7200, 0.65);
  const kawaiiDuck = ctx.createGain();
  const kawaiiLevel = ctx.createGain();
  const kawaiiDelay = ctx.createDelay(1);
  const kawaiiFeedback = ctx.createGain();
  const kawaiiDelayFilter = createFilter(ctx, "lowpass", 3600, 0.7);
  const kawaiiWet = ctx.createGain();
  kawaiiDelay.delayTime.value = 0.23;
  kawaiiFeedback.gain.value = 0.22;
  kawaiiWet.gain.value = 0.18;
  connectSeries([kawaiiInput, kawaiiHigh, kawaiiLow, kawaiiDuck, kawaiiLevel, mixBus]);
  kawaiiLow.connect(kawaiiDelay);
  kawaiiDelay.connect(kawaiiDelayFilter);
  kawaiiDelayFilter.connect(kawaiiFeedback);
  kawaiiFeedback.connect(kawaiiDelay);
  kawaiiDelayFilter.connect(kawaiiWet);
  kawaiiWet.connect(kawaiiDuck);

  const prismInput = ctx.createGain();
  const prismHigh = createFilter(ctx, "highpass", 430, 0.65);
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
  prismDry.connect(prismDuck);
  prismConvolver.connect(prismWet);
  prismWet.connect(prismDuck);
  connectSeries([prismDuck, prismLevel, mixBus]);

  return {
    titan,
    kawaii: { name: "kawaii", input: kawaiiInput, duck: kawaiiDuck, level: kawaiiLevel },
    prism: { name: "prism", input: prismInput, duck: prismDuck, level: prismLevel },
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

const createNoiseBuffer = (ctx, duration, rng) => {
  const buffer = ctx.createBuffer(1, Math.max(1, Math.floor(ctx.sampleRate * duration)), ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let index = 0; index < data.length; index += 1) data[index] = rng() * 2 - 1;
  return buffer;
};

const createSceneDna = (seed, settings) => {
  const rng = createRandom(seed);
  const scaleName = SCALE_NAMES[Math.floor(rng() * SCALE_NAMES.length)];
  const rootMidi = 41 + Math.floor(rng() * 10);
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
  const duration = 1.3 + dna.energy * 1.5 + rng() * 0.45;
  const fundamental = ctx.createOscillator();
  const harmonic = ctx.createOscillator();
  const fundamentalGain = ctx.createGain();
  const harmonicGain = ctx.createGain();
  const shaper = ctx.createWaveShaper();
  const merger = ctx.createGain();
  const impact = ctx.createBufferSource();
  const impactFilter = createFilter(ctx, "lowpass", 240 + dna.tension * 520, 0.9);
  const impactGain = ctx.createGain();

  fundamental.type = "sine";
  harmonic.type = dna.material === "RUBBER" ? "triangle" : "sine";
  fundamental.frequency.setValueAtTime(baseFrequency * (2.1 + dna.tension * 0.8), time);
  fundamental.frequency.exponentialRampToValueAtTime(baseFrequency, time + 0.45 + dna.energy * 0.7);
  harmonic.frequency.setValueAtTime(baseFrequency * 2.03, time);
  harmonic.frequency.exponentialRampToValueAtTime(baseFrequency * 1.01, time + duration * 0.65);
  scheduleEnvelope(fundamentalGain.gain, time, 0.008, 0.36 + dna.energy * 0.17, duration);
  scheduleEnvelope(harmonicGain.gain, time, 0.006, 0.06 + dna.tension * 0.05, duration * 0.72);
  shaper.curve = createInflatorCurve(0, 18 + dna.energy * 20, false);
  shaper.oversample = "2x";
  impact.buffer = createNoiseBuffer(ctx, 0.28, rng);
  scheduleEnvelope(impactGain.gain, time, 0.002, 0.1 + dna.energy * 0.1, 0.16);

  fundamental.connect(fundamentalGain);
  harmonic.connect(harmonicGain);
  fundamentalGain.connect(merger);
  harmonicGain.connect(merger);
  merger.connect(shaper);
  shaper.connect(stems.titan.input);
  impact.connect(impactFilter);
  impactFilter.connect(impactGain);
  impactGain.connect(stems.titan.input);
  fundamental.start(time);
  harmonic.start(time);
  impact.start(time);
  engine.registerSource(fundamental, time + duration + 0.2);
  engine.registerSource(harmonic, time + duration + 0.2);
  engine.registerSource(impact, time + 0.3);
  scheduleDuck(stems.kawaii.duck.gain, time, 0.76, 0.22 + dna.energy * 0.18);
  scheduleDuck(stems.prism.duck.gain, time, 0.68, 0.28 + dna.energy * 0.22);
  engine.signalVoice("titan", time, dna.energy);
  return { baseFrequency, duration };
};

const spawnKawaii = (engine, dna, time, titan) => {
  const { ctx, stems } = engine;
  const rng = dna.rng;
  const count = 2 + Math.floor(dna.density * 4);
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
    const fm = ctx.createOscillator();
    const fmGain = ctx.createGain();
    const filter = createFilter(ctx, "lowpass", 1600 + dna.energy * 4200 + rng() * 1200, 2 + dna.tension * 8);
    const envelope = ctx.createGain();
    const panner = ctx.createStereoPanner();
    const targetRatio = 2 ** ((dna.contour * (1 + dna.tension * 4)) / 12);

    oscillator.type = dna.material === "GLASS" ? "sine" : index % 2 ? "triangle" : "sine";
    oscillator.frequency.setValueAtTime(frequency, onset);
    oscillator.frequency.exponentialRampToValueAtTime(frequency * targetRatio, onset + duration * 0.72);
    fm.frequency.value = 25 + dna.motion * 120 + rng() * 60;
    fmGain.gain.setValueAtTime((18 + dna.tension * 150) * (0.7 + titan.baseFrequency / 180), onset);
    fmGain.gain.exponentialRampToValueAtTime(0.01, onset + duration);
    scheduleEnvelope(envelope.gain, onset, 0.006, 0.075 + dna.energy * 0.055, duration);
    panner.pan.value = clamp((index / Math.max(1, count - 1)) * 1.4 - 0.7 + (rng() - 0.5) * 0.3, -1, 1);
    fm.connect(fmGain);
    fmGain.connect(oscillator.frequency);
    oscillator.connect(filter);
    filter.connect(envelope);
    envelope.connect(panner);
    panner.connect(stems.kawaii.input);
    fm.start(onset);
    oscillator.start(onset);
    engine.registerSource(fm, onset + duration + 0.1);
    engine.registerSource(oscillator, onset + duration + 0.1);
    notes.push({ frequency, onset, duration, degree });
    engine.signalVoice("kawaii", onset, dna.energy * 0.82);
  }

  return notes;
};

const spawnPrism = (engine, dna, time, motif) => {
  const { ctx, stems } = engine;
  const rng = dna.rng;
  const count = 4 + Math.floor(dna.density * 9);
  const sourceNotes = motif.length ? motif : [{ frequency: midiToFrequency(dna.rootMidi + 24), onset: time }];

  for (let index = 0; index < count; index += 1) {
    const parent = sourceNotes[index % sourceNotes.length];
    const relation = [1.5, 2, 2.5, 3, 4][Math.floor(rng() * 5)];
    const frequency = clamp(parent.frequency * relation * (1 + (rng() - 0.5) * (1 - dna.affinity) * 0.08), 520, 15000);
    const onset = Math.max(time + 0.18, parent.onset + 0.12 + rng() * (0.5 + dna.space * 1.3));
    const duration = 0.2 + rng() * (0.5 + dna.space * 1.25);
    const oscillator = ctx.createOscillator();
    const envelope = ctx.createGain();
    const panner = ctx.createStereoPanner();
    const highpass = createFilter(ctx, "highpass", Math.min(6000, frequency * 0.45), 0.7);

    oscillator.type = "sine";
    oscillator.frequency.setValueAtTime(frequency, onset);
    oscillator.detune.setValueAtTime((rng() - 0.5) * (8 + dna.motion * 34), onset);
    oscillator.detune.linearRampToValueAtTime((rng() - 0.5) * 60 * dna.motion, onset + duration);
    scheduleEnvelope(envelope.gain, onset, 0.008 + rng() * 0.03, 0.025 + dna.energy * 0.028, duration);
    panner.pan.value = clamp((rng() * 2 - 1) * (0.45 + dna.motion * 0.5), -1, 1);
    oscillator.connect(highpass);
    highpass.connect(envelope);
    envelope.connect(panner);
    panner.connect(stems.prism.input);
    oscillator.start(onset);
    engine.registerSource(oscillator, onset + duration + 0.2);
    engine.signalVoice("prism", onset, dna.energy * 0.65);
  }

  if (dna.space > 0.42) {
    const air = ctx.createBufferSource();
    const airFilter = createFilter(ctx, "bandpass", 6500 + dna.tension * 4500, 0.8 + dna.tension * 2);
    const airEnvelope = ctx.createGain();
    const onset = time + 0.35 + rng() * 0.5;
    const duration = 1 + dna.space * 2.2;
    air.buffer = createNoiseBuffer(ctx, duration, rng);
    scheduleEnvelope(airEnvelope.gain, onset, 0.18, 0.018 + dna.energy * 0.02, duration);
    air.connect(airFilter);
    airFilter.connect(airEnvelope);
    airEnvelope.connect(stems.prism.input);
    air.start(onset);
    engine.registerSource(air, onset + duration + 0.1);
  }
};

export class ConvergenceEngine {
  constructor({ onScene, onVoice, onRecordLimit } = {}) {
    this.onScene = onScene;
    this.onVoice = onVoice;
    this.onRecordLimit = onRecordLimit;
    this.activeSources = new Set();
    this.driftTimer = null;
    this.masterMode = "MULTIBAND";
    this.masterDrive = 4.5;
    this.masterTone = 0.55;
  }

  init() {
    if (this.ctx) {
      if (this.ctx.state === "suspended") this.ctx.resume();
      return this;
    }

    const AudioContext = window.AudioContext || window.webkitAudioContext;
    this.ctx = new AudioContext({ sampleRate: 96000, latencyHint: "interactive" });
    this.mixBus = this.ctx.createGain();
    this.mixBus.gain.value = 0.78;
    this.stems = createStemBuses(this.ctx, this.mixBus);
    this.stems.titan.level.gain.value = 0.92;
    this.stems.kawaii.level.gain.value = 0.86;
    this.stems.prism.level.gain.value = 0.84;

    this.multiband = createMultibandMaster(this.ctx);
    this.inflator = createInflatorMaster(this.ctx);
    this.multibandModeGain = this.ctx.createGain();
    this.inflatorModeGain = this.ctx.createGain();
    this.masterGain = this.ctx.createGain();
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 4096;
    this.analyser.smoothingTimeConstant = 0.72;
    this.masterGain.gain.value = 1;
    this.multibandModeGain.gain.value = 1;
    this.inflatorModeGain.gain.value = 0;

    this.mixBus.connect(this.multiband.input);
    this.mixBus.connect(this.inflator.input);
    this.multiband.output.connect(this.multibandModeGain);
    this.inflator.output.connect(this.inflatorModeGain);
    this.multibandModeGain.connect(this.masterGain);
    this.inflatorModeGain.connect(this.masterGain);
    this.masterGain.connect(this.analyser);
    this.recorder = createWavRecorder(this.ctx, this.analyser, {
      onLimit: () => this.onRecordLimit?.(),
    });
    this.analyser.connect(this.ctx.destination);
    this.setMasterDrive(this.masterDrive);
    this.setMasterTone(this.masterTone);
    return this;
  }

  setMasterMode(mode) {
    this.init();
    this.masterMode = mode === "INFLATOR" ? "INFLATOR" : "MULTIBAND";
    const time = this.ctx.currentTime;
    this.multibandModeGain.gain.setTargetAtTime(this.masterMode === "MULTIBAND" ? 1 : 0, time, 0.025);
    this.inflatorModeGain.gain.setTargetAtTime(this.masterMode === "INFLATOR" ? 1 : 0, time, 0.025);
  }

  setMasterDrive(value) {
    this.masterDrive = clamp(Number(value), 0, 9);
    if (!this.ctx) return;
    const time = this.ctx.currentTime;
    this.multiband.input.gain.setTargetAtTime(dbToGain(this.masterDrive), time, 0.04);
    this.inflator.input.gain.setTargetAtTime(dbToGain(this.masterDrive), time, 0.04);
  }

  setMasterTone(value) {
    this.masterTone = clamp(Number(value), 0, 1);
    if (!this.ctx) return;
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
  }

  setOutputLevel(value) {
    this.init();
    this.masterGain.gain.setTargetAtTime(clamp(Number(value), 0, 1), this.ctx.currentTime, 0.05);
  }

  setStemLevel(stem, value) {
    this.init();
    const target = this.stems[stem];
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
    this.init();
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
    this.init();
    return this.scheduleScene(settings, seed);
  }

  startDrift(settingsProvider, seed) {
    this.init();
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
    if (!this.ctx) return { reductions: [0, 0, 0, 0, 0], limiter: 0 };
    const chain = this.masterMode === "MULTIBAND" ? this.multiband : this.inflator;
    return {
      reductions: chain.compressors.map((compressor) => Math.abs(compressor.reduction || 0)),
      limiter: Math.abs(chain.limiter.reduction || 0),
    };
  }

  async startRecording() {
    this.init();
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
