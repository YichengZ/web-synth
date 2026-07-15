const FFT_SIZE = 2048;
const HOP_SIZE = FFT_SIZE / 2;
const RING_SIZE = FFT_SIZE * 4;
const BIN_COUNT = FFT_SIZE / 2 + 1;
const EPSILON = 1e-12;

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

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
        const sourceSample = sourceChannel ? sourceChannel[sample] : 0;
        this.inputRing[channel][this.writeIndex] = sourceSample;
        output[channel][sample] = this.outputRing[channel][outputIndex];
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
        linkedLevel = Math.max(linkedLevel, Math.abs((input[channel] || input[0])?.[sample] || 0));
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
        output[channel][sample] = ((input[channel] || input[0])?.[sample] || 0) * this.smoothedGain;
      }
    }

    return true;
  }
}

registerProcessor("transient-shaper", TransientShaperProcessor);
