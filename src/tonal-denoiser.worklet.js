const FFT_SIZE = 2048;
const HOP_SIZE = FFT_SIZE / 2;
const RING_SIZE = FFT_SIZE * 4;
const BIN_COUNT = FFT_SIZE / 2 + 1;
const EPSILON = 1e-12;

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const finiteSample = (value, limit = 8) => Number.isFinite(value) ? clamp(value, -limit, limit) : 0;

const fft = (real, imaginary, inverse = false) => {
  const length = real.length;
  for (let index = 1, reversed = 0; index < length; index += 1) {
    let bit = length >> 1;
    while (reversed & bit) {
      reversed ^= bit;
      bit >>= 1;
    }
    reversed ^= bit;
    if (index < reversed) {
      const realValue = real[index];
      const imaginaryValue = imaginary[index];
      real[index] = real[reversed];
      imaginary[index] = imaginary[reversed];
      real[reversed] = realValue;
      imaginary[reversed] = imaginaryValue;
    }
  }

  for (let size = 2; size <= length; size <<= 1) {
    const angle = (inverse ? 2 : -2) * Math.PI / size;
    const phaseReal = Math.cos(angle);
    const phaseImaginary = Math.sin(angle);
    for (let start = 0; start < length; start += size) {
      let rotationReal = 1;
      let rotationImaginary = 0;
      for (let offset = 0; offset < size / 2; offset += 1) {
        const even = start + offset;
        const odd = even + size / 2;
        const oddReal = real[odd] * rotationReal - imaginary[odd] * rotationImaginary;
        const oddImaginary = real[odd] * rotationImaginary + imaginary[odd] * rotationReal;
        real[odd] = real[even] - oddReal;
        imaginary[odd] = imaginary[even] - oddImaginary;
        real[even] += oddReal;
        imaginary[even] += oddImaginary;
        const nextRotationReal = rotationReal * phaseReal - rotationImaginary * phaseImaginary;
        rotationImaginary = rotationReal * phaseImaginary + rotationImaginary * phaseReal;
        rotationReal = nextRotationReal;
      }
    }
  }

  if (inverse) {
    for (let index = 0; index < length; index += 1) {
      real[index] /= length;
      imaginary[index] /= length;
    }
  }
};

class TonalDenoiserProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const settings = options.processorOptions || {};
    this.amount = clamp(Number(settings.amount) || 0.55, 0, 1);
    this.floor = 10 ** ((Number(settings.floorDb) || -16) / 20);
    this.lowPreserveHz = Math.max(0, Number(settings.lowPreserveHz) || 0);
    this.inputRing = [new Float32Array(FFT_SIZE), new Float32Array(FFT_SIZE)];
    this.outputRing = [new Float32Array(RING_SIZE), new Float32Array(RING_SIZE)];
    this.real = [new Float32Array(FFT_SIZE), new Float32Array(FFT_SIZE)];
    this.imaginary = [new Float32Array(FFT_SIZE), new Float32Array(FFT_SIZE)];
    this.power = new Float32Array(BIN_COUNT);
    this.previousPower = new Float32Array(BIN_COUNT);
    this.smoothedPower = new Float32Array(BIN_COUNT);
    this.noisePower = new Float32Array(BIN_COUNT);
    this.gain = new Float32Array(BIN_COUNT).fill(1);
    this.window = new Float32Array(FFT_SIZE);
    this.writeIndex = 0;
    this.sampleIndex = 0;
    this.frameCount = 0;

    for (let index = 0; index < FFT_SIZE; index += 1) {
      this.window[index] = Math.sin(Math.PI * (index + 0.5) / FFT_SIZE);
    }
  }

  processFrame() {
    for (let channel = 0; channel < 2; channel += 1) {
      const real = this.real[channel];
      const imaginary = this.imaginary[channel];
      for (let index = 0; index < FFT_SIZE; index += 1) {
        real[index] = this.inputRing[channel][(this.writeIndex + index) % FFT_SIZE] * this.window[index];
        imaginary[index] = 0;
      }
      fft(real, imaginary);
    }

    for (let bin = 0; bin < BIN_COUNT; bin += 1) {
      const leftPower = this.real[0][bin] ** 2 + this.imaginary[0][bin] ** 2;
      const rightPower = this.real[1][bin] ** 2 + this.imaginary[1][bin] ** 2;
      this.power[bin] = (leftPower + rightPower) * 0.5;
    }

    // One stereo-linked mask combines a rising minimum tracker, Wiener gain, and tonal persistence.
    for (let bin = 0; bin < BIN_COUNT; bin += 1) {
      const power = this.power[bin];
      const previous = Math.max(
        this.previousPower[Math.max(0, bin - 1)],
        this.previousPower[bin],
        this.previousPower[Math.min(BIN_COUNT - 1, bin + 1)],
      );
      const neighbors = (
        this.power[Math.max(0, bin - 2)]
        + this.power[Math.max(0, bin - 1)]
        + this.power[Math.min(BIN_COUNT - 1, bin + 1)]
        + this.power[Math.min(BIN_COUNT - 1, bin + 2)]
      ) * 0.25;
      const peakStrength = clamp((power / (neighbors + EPSILON) - 1.08) / 3.2, 0, 1);
      const persistence = Math.sqrt(Math.min(power, previous) / (Math.max(power, previous) + EPSILON));
      const tonality = peakStrength * (0.32 + persistence * 0.68);
      const smoothed = this.frameCount === 0
        ? power
        : this.smoothedPower[bin] * 0.84 + power * 0.16;
      const noise = this.frameCount === 0
        ? Math.max(EPSILON, smoothed)
        : Math.min(smoothed, this.noisePower[bin] * 1.0045 + EPSILON);
      const wiener = Math.sqrt(Math.max(0, 1 - noise * 1.18 / (power + EPSILON)));
      const frequency = bin * sampleRate / FFT_SIZE;
      const lowProtection = this.lowPreserveHz > 0
        ? clamp((this.lowPreserveHz * 1.65 - frequency) / (this.lowPreserveHz * 0.65), 0, 1)
        : 0;
      const tonalGain = Math.max(this.floor, wiener, tonality, lowProtection);
      const target = 1 - this.amount * (1 - tonalGain);
      const smoothing = target < this.gain[bin] ? 0.58 : 0.18;

      this.gain[bin] += (target - this.gain[bin]) * smoothing;
      this.smoothedPower[bin] = smoothed;
      this.noisePower[bin] = noise;
    }
    this.previousPower.set(this.power);

    for (let channel = 0; channel < 2; channel += 1) {
      const real = this.real[channel];
      const imaginary = this.imaginary[channel];
      for (let bin = 0; bin < BIN_COUNT; bin += 1) {
        const mirrored = bin === 0 ? 0 : FFT_SIZE - bin;
        const gain = this.gain[bin];
        real[bin] *= gain;
        imaginary[bin] *= gain;
        if (mirrored !== bin && mirrored < FFT_SIZE) {
          real[mirrored] *= gain;
          imaginary[mirrored] *= gain;
        }
      }
      fft(real, imaginary, true);

      const outputStart = this.sampleIndex % RING_SIZE;
      for (let index = 0; index < FFT_SIZE; index += 1) {
        const outputIndex = (outputStart + index) % RING_SIZE;
        this.outputRing[channel][outputIndex] += real[index] * this.window[index];
      }
    }

    this.frameCount += 1;
  }

  process(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];
    const frameLength = output[0]?.length || 128;

    for (let sample = 0; sample < frameLength; sample += 1) {
      const outputIndex = this.sampleIndex % RING_SIZE;
      for (let channel = 0; channel < output.length; channel += 1) {
        const sourceChannel = input[channel] || input[0];
        const sourceSample = finiteSample(sourceChannel ? sourceChannel[sample] : 0, 4);
        this.inputRing[channel][this.writeIndex] = sourceSample;
        output[channel][sample] = finiteSample(this.outputRing[channel][outputIndex]);
        this.outputRing[channel][outputIndex] = 0;
      }

      this.writeIndex = (this.writeIndex + 1) % FFT_SIZE;
      this.sampleIndex += 1;
      if (this.sampleIndex >= FFT_SIZE && (this.sampleIndex - FFT_SIZE) % HOP_SIZE === 0) {
        this.processFrame();
      }
    }

    return true;
  }
}

registerProcessor("tonal-denoiser", TonalDenoiserProcessor);

class TransientShaperProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const settings = options.processorOptions || {};
    this.amount = clamp(Number(settings.amount) || 1.1, 0, 2.5);
    this.fastEnvelope = 0;
    this.slowEnvelope = 0;
    this.smoothedGain = 1;
    this.fastAttack = Math.exp(-1 / (sampleRate * 0.00035));
    this.fastRelease = Math.exp(-1 / (sampleRate * 0.026));
    this.slowAttack = Math.exp(-1 / (sampleRate * 0.018));
    this.slowRelease = Math.exp(-1 / (sampleRate * 0.12));
  }

  process(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];
    const frameLength = output[0]?.length || 128;

    for (let sample = 0; sample < frameLength; sample += 1) {
      let linkedLevel = 0;
      for (let channel = 0; channel < output.length; channel += 1) {
        linkedLevel = Math.max(
          linkedLevel,
          Math.abs(finiteSample((input[channel] || input[0])?.[sample] || 0, 4)),
        );
      }

      const fastCoefficient = linkedLevel > this.fastEnvelope ? this.fastAttack : this.fastRelease;
      const slowCoefficient = linkedLevel > this.slowEnvelope ? this.slowAttack : this.slowRelease;
      this.fastEnvelope = linkedLevel + fastCoefficient * (this.fastEnvelope - linkedLevel);
      this.slowEnvelope = linkedLevel + slowCoefficient * (this.slowEnvelope - linkedLevel);
      // The fast/slow envelope difference isolates attack energy before the final clipper.
      const transient = Math.max(0, this.fastEnvelope - this.slowEnvelope);
      const targetGain = 1 + this.amount * transient / (this.slowEnvelope + 0.055);
      this.smoothedGain += (Math.min(2.4, targetGain) - this.smoothedGain) * 0.22;

      for (let channel = 0; channel < output.length; channel += 1) {
        const sourceSample = finiteSample((input[channel] || input[0])?.[sample] || 0, 4);
        output[channel][sample] = finiteSample(sourceSample * this.smoothedGain);
      }
    }

    return true;
  }
}

registerProcessor("transient-shaper", TransientShaperProcessor);

class GranularDelayProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const settings = options.processorOptions || {};
    this.bufferLength = Math.ceil(sampleRate * 1.5);
    this.buffer = [new Float32Array(this.bufferLength), new Float32Array(this.bufferLength)];
    this.delaySamples = clamp(Number(settings.delayMs) || 180, 25, 1200) * sampleRate / 1000;
    this.grainSamples = clamp(Number(settings.grainMs) || 65, 12, 180) * sampleRate / 1000;
    this.overlap = clamp(Number(settings.overlap) || 3, 1.5, 6);
    this.intervalSamples = Math.max(32, this.grainSamples / this.overlap);
    this.pitch = clamp(Number(settings.pitch) || 1, 0.4, 2.5);
    this.feedback = clamp(Number(settings.feedback) || 0.2, 0, 0.62);
    this.jitter = clamp(Number(settings.jitter) || 0.35, 0, 1);
    this.spread = clamp(Number(settings.spread) || 0.7, 0, 1);
    this.randomState = (Number(settings.seed) || 1) >>> 0;
    this.writeIndex = 0;
    this.samplesUntilGrain = 0;
    this.lastWet = [0, 0];
    this.grains = [];
    this.windowTable = new Float32Array(1024);
    for (let index = 0; index < this.windowTable.length; index += 1) {
      this.windowTable[index] = Math.sin(Math.PI * index / (this.windowTable.length - 1)) ** 2;
    }
  }

  random() {
    this.randomState ^= this.randomState << 13;
    this.randomState ^= this.randomState >>> 17;
    this.randomState ^= this.randomState << 5;
    return (this.randomState >>> 0) / 4294967296;
  }

  read(channel, position) {
    const wrapped = ((position % this.bufferLength) + this.bufferLength) % this.bufferLength;
    const first = Math.floor(wrapped);
    const second = (first + 1) % this.bufferLength;
    const fraction = wrapped - first;
    return finiteSample(
      this.buffer[channel][first] * (1 - fraction) + this.buffer[channel][second] * fraction,
      2,
    );
  }

  spawnGrain() {
    const length = Math.max(32, Math.floor(this.grainSamples * (0.78 + this.random() * 0.44)));
    const jitter = (this.random() * 2 - 1) * this.delaySamples * this.jitter * 0.55;
    const pan = (this.random() * 2 - 1) * this.spread;
    const angle = (pan + 1) * Math.PI * 0.25;
    this.grains.push({
      age: 0,
      length,
      position: this.writeIndex - this.delaySamples + jitter,
      rate: this.pitch * (0.97 + this.random() * 0.06),
      leftGain: Math.cos(angle),
      rightGain: Math.sin(angle),
    });
  }

  process(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];
    const frameLength = output[0]?.length || 128;
    const normalization = 1 / Math.sqrt(this.overlap);

    for (let sample = 0; sample < frameLength; sample += 1) {
      if (this.samplesUntilGrain <= 0) {
        this.spawnGrain();
        this.samplesUntilGrain += this.intervalSamples * (0.82 + this.random() * 0.36);
      }
      this.samplesUntilGrain -= 1;

      let wetLeft = 0;
      let wetRight = 0;
      for (let index = this.grains.length - 1; index >= 0; index -= 1) {
        const grain = this.grains[index];
        const phase = grain.age / grain.length;
        const windowIndex = Math.min(this.windowTable.length - 1, Math.floor(phase * this.windowTable.length));
        const windowValue = this.windowTable[windowIndex];
        const readPosition = grain.position + grain.age * grain.rate;
        const grainSample = (this.read(0, readPosition) + this.read(1, readPosition)) * 0.5 * windowValue;
        wetLeft += grainSample * grain.leftGain;
        wetRight += grainSample * grain.rightGain;
        grain.age += 1;
        if (grain.age >= grain.length) {
          this.grains[index] = this.grains[this.grains.length - 1];
          this.grains.pop();
        }
      }

      wetLeft = finiteSample(wetLeft * normalization, 2);
      wetRight = finiteSample(wetRight * normalization, 2);
      const inputLeft = finiteSample(input[0]?.[sample] || 0, 2);
      const inputRight = finiteSample((input[1] || input[0])?.[sample] || 0, 2);
      this.buffer[0][this.writeIndex] = finiteSample(inputLeft + this.lastWet[0] * this.feedback, 1.5);
      this.buffer[1][this.writeIndex] = finiteSample(inputRight + this.lastWet[1] * this.feedback, 1.5);
      output[0][sample] = wetLeft;
      if (output[1]) output[1][sample] = wetRight;
      this.lastWet[0] = wetLeft;
      this.lastWet[1] = wetRight;
      this.writeIndex = (this.writeIndex + 1) % this.bufferLength;
    }

    return true;
  }
}

registerProcessor("granular-delay", GranularDelayProcessor);
