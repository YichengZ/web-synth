import FFT from "fft.js";

const EPSILON = 1e-12;
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const dbToGain = (db) => 10 ** (db / 20);
const gainToDb = (gain) => 20 * Math.log10(Math.max(EPSILON, gain));

const finiteSample = (value, limit = 8) => Number.isFinite(value)
  ? clamp(value, -limit, limit)
  : 0;

const medianSmall = (values, length) => {
  for (let index = 1; index < length; index += 1) {
    const value = values[index];
    let cursor = index - 1;
    while (cursor >= 0 && values[cursor] > value) {
      values[cursor + 1] = values[cursor];
      cursor -= 1;
    }
    values[cursor + 1] = value;
  }
  return values[Math.floor(length / 2)];
};

const report = (id, phase, progress) => {
  self.postMessage({ id, type: "progress", phase, progress });
};

const tonalExtract = (id, left, right, sampleRate, options = {}) => {
  const fftSize = 4096;
  const hopSize = 1024;
  const binCount = fftSize / 2 + 1;
  const frameCount = Math.max(1, Math.ceil(Math.max(0, left.length - fftSize) / hopSize) + 1);
  const fft = new FFT(fftSize);
  const window = new Float64Array(fftSize);
  const frame = new Float64Array(fftSize);
  const spectrum = fft.createComplexArray();
  const magnitude = new Float32Array(frameCount * binCount);

  for (let index = 0; index < fftSize; index += 1) {
    window[index] = Math.sqrt(0.5 - 0.5 * Math.cos(2 * Math.PI * index / (fftSize - 1)));
  }

  for (let frameIndex = 0; frameIndex < frameCount; frameIndex += 1) {
    const start = frameIndex * hopSize;
    for (let channel = 0; channel < 2; channel += 1) {
      const source = channel === 0 ? left : right;
      for (let index = 0; index < fftSize; index += 1) {
        frame[index] = finiteSample(source[start + index] || 0, 4) * window[index];
      }
      fft.realTransform(spectrum, frame);
      for (let bin = 0; bin < binCount; bin += 1) {
        const real = spectrum[bin * 2];
        const imaginary = spectrum[bin * 2 + 1];
        magnitude[frameIndex * binCount + bin] += Math.hypot(real, imaginary) * 0.5;
      }
    }
    if (frameIndex % 24 === 0) report(id, "analyse", frameIndex / frameCount);
  }

  const amount = clamp(Number(options.amount) || 0.7, 0, 1);
  const floor = dbToGain(Number(options.floorDb) || -24);
  const residualMix = clamp(Number(options.residualMix) || 0.16, 0, 0.5);
  const lowProtectHz = Math.max(0, Number(options.lowProtectHz) || 120);
  const mask = new Float32Array(magnitude.length);
  const timeValues = new Float32Array(9);
  const frequencyValues = new Float32Array(7);

  for (let frameIndex = 0; frameIndex < frameCount; frameIndex += 1) {
    for (let bin = 0; bin < binCount; bin += 1) {
      let timeLength = 0;
      for (let offset = -4; offset <= 4; offset += 1) {
        const neighbor = clamp(frameIndex + offset, 0, frameCount - 1);
        timeValues[timeLength] = magnitude[neighbor * binCount + bin];
        timeLength += 1;
      }
      const tonal = medianSmall(timeValues, timeLength);
      let frequencyLength = 0;
      for (let offset = -3; offset <= 3; offset += 1) {
        const neighbor = clamp(bin + offset, 0, binCount - 1);
        frequencyValues[frequencyLength] = magnitude[frameIndex * binCount + neighbor];
        frequencyLength += 1;
      }
      const residual = medianSmall(frequencyValues, frequencyLength);
      const tonalPower = tonal * tonal;
      const residualPower = residual * residual * 1.18;
      const tonalMask = tonalPower / (tonalPower + residualPower + EPSILON);
      const transientMask = residualPower / (tonalPower + residualPower + EPSILON);
      const frequency = bin * sampleRate / fftSize;
      const lowProtection = lowProtectHz > 0
        ? clamp((lowProtectHz * 1.7 - frequency) / Math.max(1, lowProtectHz * 0.7), 0, 1)
        : 0;
      const extracted = Math.max(
        floor,
        Math.sqrt(tonalMask),
        transientMask * residualMix,
        lowProtection,
      );
      mask[frameIndex * binCount + bin] = 1 - amount * (1 - extracted);
    }
    if (frameIndex % 16 === 0) report(id, "mask", frameIndex / frameCount);
  }

  const output = [new Float32Array(left.length), new Float32Array(right.length)];
  const normalization = new Float32Array(left.length);
  const inverse = fft.createComplexArray();
  for (let frameIndex = 0; frameIndex < frameCount; frameIndex += 1) {
    const start = frameIndex * hopSize;
    for (let channel = 0; channel < 2; channel += 1) {
      const source = channel === 0 ? left : right;
      for (let index = 0; index < fftSize; index += 1) {
        frame[index] = finiteSample(source[start + index] || 0, 4) * window[index];
      }
      fft.realTransform(spectrum, frame);
      fft.completeSpectrum(spectrum);
      for (let bin = 0; bin < binCount; bin += 1) {
        const gain = mask[frameIndex * binCount + bin];
        spectrum[bin * 2] *= gain;
        spectrum[bin * 2 + 1] *= gain;
        if (bin > 0 && bin < binCount - 1) {
          const mirror = fftSize - bin;
          spectrum[mirror * 2] *= gain;
          spectrum[mirror * 2 + 1] *= gain;
        }
      }
      fft.inverseTransform(inverse, spectrum);
      for (let index = 0; index < fftSize && start + index < source.length; index += 1) {
        output[channel][start + index] += inverse[index * 2] * window[index];
        if (channel === 0) normalization[start + index] += window[index] * window[index];
      }
    }
    if (frameIndex % 16 === 0) report(id, "synthesise", frameIndex / frameCount);
  }

  for (let index = 0; index < left.length; index += 1) {
    const scale = normalization[index] > EPSILON ? 1 / normalization[index] : 0;
    output[0][index] = finiteSample(output[0][index] * scale, 4);
    output[1][index] = finiteSample(output[1][index] * scale, 4);
  }
  return output;
};

const processColorAndTransient = (left, right, sampleRate, options = {}) => {
  const drive = dbToGain(clamp(Number(options.driveDb) || 6, 0, 18));
  const colorMix = clamp(Number(options.colorMix) || 0.62, 0, 1);
  const transientAmount = clamp(Number(options.transient) || 0.8, 0, 2);
  const fastAttack = Math.exp(-1 / (sampleRate * 0.0004));
  const fastRelease = Math.exp(-1 / (sampleRate * 0.024));
  const slowAttack = Math.exp(-1 / (sampleRate * 0.018));
  const slowRelease = Math.exp(-1 / (sampleRate * 0.12));
  const fadeLength = Math.max(1, Math.floor(sampleRate * 0.035));
  let fast = 0;
  let slow = 0;
  let smoothedGain = 1;
  let peak = 0;

  for (let index = 0; index < left.length; index += 1) {
    const linked = Math.max(Math.abs(left[index]), Math.abs(right[index]));
    const fastCoefficient = linked > fast ? fastAttack : fastRelease;
    const slowCoefficient = linked > slow ? slowAttack : slowRelease;
    fast = linked + fastCoefficient * (fast - linked);
    slow = linked + slowCoefficient * (slow - linked);
    const transient = Math.max(0, fast - slow);
    const target = Math.min(2.1, 1 + transientAmount * transient / (slow + 0.06));
    smoothedGain += (target - smoothedGain) * 0.18;
    const fade = Math.min(1, index / fadeLength, (left.length - 1 - index) / fadeLength);
    for (let channel = 0; channel < 2; channel += 1) {
      const source = channel === 0 ? left[index] : right[index];
      const saturated = Math.tanh(source * drive) / Math.max(EPSILON, Math.tanh(drive));
      const value = finiteSample((source * (1 - colorMix) + saturated * colorMix) * smoothedGain * fade, 2);
      if (channel === 0) left[index] = value;
      else right[index] = value;
      peak = Math.max(peak, Math.abs(value));
    }
  }

  const trim = Math.min(1, 0.88 / Math.max(EPSILON, peak));
  if (trim < 1) {
    for (let index = 0; index < left.length; index += 1) {
      left[index] *= trim;
      right[index] *= trim;
    }
  }
};

const biquadCoefficients = (type, frequency, q, gainDb, sampleRate) => {
  const omega = 2 * Math.PI * frequency / sampleRate;
  const cosine = Math.cos(omega);
  const sine = Math.sin(omega);
  const alpha = sine / (2 * q);
  const amplitude = 10 ** (gainDb / 40);
  let b0;
  let b1;
  let b2;
  let a0;
  let a1;
  let a2;
  if (type === "highpass") {
    b0 = (1 + cosine) / 2;
    b1 = -(1 + cosine);
    b2 = (1 + cosine) / 2;
    a0 = 1 + alpha;
    a1 = -2 * cosine;
    a2 = 1 - alpha;
  } else {
    const beta = 2 * Math.sqrt(amplitude) * alpha;
    b0 = amplitude * ((amplitude + 1) + (amplitude - 1) * cosine + beta);
    b1 = -2 * amplitude * ((amplitude - 1) + (amplitude + 1) * cosine);
    b2 = amplitude * ((amplitude + 1) + (amplitude - 1) * cosine - beta);
    a0 = (amplitude + 1) - (amplitude - 1) * cosine + beta;
    a1 = 2 * ((amplitude - 1) - (amplitude + 1) * cosine);
    a2 = (amplitude + 1) - (amplitude - 1) * cosine - beta;
  }
  return [b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0];
};

const applyBiquadEnergy = (source, coefficients) => {
  const [b0, b1, b2, a1, a2] = coefficients;
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  let energy = 0;
  for (let index = 0; index < source.length; index += 1) {
    const input = source[index];
    const output = b0 * input + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1;
    x1 = input;
    y2 = y1;
    y1 = output;
    energy += output * output;
  }
  return energy / Math.max(1, source.length);
};

const measureLoudness = (left, right, sampleRate) => {
  const shelf = biquadCoefficients("highshelf", 1681.974, Math.SQRT1_2, 4, sampleRate);
  const highpass = biquadCoefficients("highpass", 38, 0.5, 0, sampleRate);
  const energy = (
    applyBiquadEnergy(left, shelf) + applyBiquadEnergy(right, shelf)
    + applyBiquadEnergy(left, highpass) + applyBiquadEnergy(right, highpass)
  ) * 0.25;
  return -0.691 + 10 * Math.log10(Math.max(EPSILON, energy));
};

const measureTruePeak = (left, right) => {
  let peak = 0;
  for (const channel of [left, right]) {
    for (let index = 1; index < channel.length - 2; index += 1) {
      const y0 = channel[index - 1];
      const y1 = channel[index];
      const y2 = channel[index + 1];
      const y3 = channel[index + 2];
      for (let phase = 0; phase < 4; phase += 1) {
        const t = phase / 4;
        const a = -0.5 * y0 + 1.5 * y1 - 1.5 * y2 + 0.5 * y3;
        const b = y0 - 2.5 * y1 + 2 * y2 - 0.5 * y3;
        const c = -0.5 * y0 + 0.5 * y2;
        peak = Math.max(peak, Math.abs(((a * t + b) * t + c) * t + y1));
      }
    }
  }
  return peak;
};

const measureSpectralFlatness = (left, right) => {
  const fftSize = 4096;
  const fft = new FFT(fftSize);
  const frame = new Float64Array(fftSize);
  const spectrum = fft.createComplexArray();
  const step = Math.max(fftSize, Math.floor(left.length / 12));
  let flatnessTotal = 0;
  let frames = 0;
  for (let start = 0; start + fftSize <= left.length; start += step) {
    for (let index = 0; index < fftSize; index += 1) {
      frame[index] = (left[start + index] + right[start + index]) * 0.5
        * (0.5 - 0.5 * Math.cos(2 * Math.PI * index / (fftSize - 1)));
    }
    fft.realTransform(spectrum, frame);
    let logTotal = 0;
    let linearTotal = 0;
    const binCount = fftSize / 2 + 1;
    for (let bin = 1; bin < binCount; bin += 1) {
      const magnitude = Math.max(
        EPSILON,
        Math.hypot(spectrum[bin * 2], spectrum[bin * 2 + 1]),
      );
      logTotal += Math.log(magnitude);
      linearTotal += magnitude;
    }
    flatnessTotal += Math.exp(logTotal / (binCount - 1))
      / Math.max(EPSILON, linearTotal / (binCount - 1));
    frames += 1;
  }
  return frames ? flatnessTotal / frames : 0;
};

const finishMaster = (left, right, sampleRate, options = {}) => {
  processColorAndTransient(left, right, sampleRate, {
    driveDb: 5 + clamp(Number(options.violence) || 0.8, 0, 1) * 7,
    colorMix: 0.68,
    transient: 0.72 + clamp(Number(options.violence) || 0.8, 0, 1) * 0.5,
  });
  const targetLufs = Number(options.targetLufs) || -8.5;
  let loudness = measureLoudness(left, right, sampleRate);
  const firstGain = dbToGain(clamp(targetLufs - loudness, -12, 12));
  for (let index = 0; index < left.length; index += 1) {
    left[index] = Math.tanh(left[index] * firstGain * 1.35) / Math.tanh(1.35);
    right[index] = Math.tanh(right[index] * firstGain * 1.35) / Math.tanh(1.35);
  }
  loudness = measureLoudness(left, right, sampleRate);
  const truePeak = measureTruePeak(left, right);
  const ceiling = dbToGain(-1);
  const finalGain = Math.min(
    dbToGain(clamp(targetLufs - loudness, -3, 3)),
    ceiling / Math.max(EPSILON, truePeak),
  );
  let dcLeft = 0;
  let dcRight = 0;
  for (let index = 0; index < left.length; index += 1) {
    left[index] = clamp(finiteSample(left[index] * finalGain), -ceiling, ceiling);
    right[index] = clamp(finiteSample(right[index] * finalGain), -ceiling, ceiling);
    dcLeft += left[index];
    dcRight += right[index];
  }
  loudness = measureLoudness(left, right, sampleRate);
  const measuredPeak = measureTruePeak(left, right);
  const dc = Math.max(Math.abs(dcLeft / left.length), Math.abs(dcRight / right.length));
  return {
    lufs: loudness,
    truePeakDb: gainToDb(measuredPeak),
    dcDb: gainToDb(dc),
    spectralFlatness: measureSpectralFlatness(left, right),
  };
};

const encodeWav24 = (left, right, sampleRate) => {
  const bytesPerFrame = 6;
  const dataLength = left.length * bytesPerFrame;
  const wav = new ArrayBuffer(44 + dataLength);
  const view = new DataView(wav);
  const writeString = (offset, value) => {
    for (let index = 0; index < value.length; index += 1) {
      view.setUint8(offset + index, value.charCodeAt(index));
    }
  };
  writeString(0, "RIFF");
  view.setUint32(4, 36 + dataLength, true);
  writeString(8, "WAVE");
  writeString(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 2, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * bytesPerFrame, true);
  view.setUint16(32, bytesPerFrame, true);
  view.setUint16(34, 24, true);
  writeString(36, "data");
  view.setUint32(40, dataLength, true);
  let cursor = 44;
  for (let index = 0; index < left.length; index += 1) {
    for (const value of [left[index], right[index]]) {
      const limited = clamp(finiteSample(value), -1, 1);
      const sample = Math.round(limited < 0 ? limited * 0x800000 : limited * 0x7fffff);
      view.setUint8(cursor, sample & 0xff);
      view.setUint8(cursor + 1, (sample >> 8) & 0xff);
      view.setUint8(cursor + 2, (sample >> 16) & 0xff);
      cursor += 3;
    }
  }
  return wav;
};

self.onmessage = (event) => {
  const { id, operation, left, right, sampleRate, options } = event.data;
  try {
    let outputLeft = left;
    let outputRight = right;
    let metrics = null;
    if (operation === "tonal") {
      [outputLeft, outputRight] = tonalExtract(id, left, right, sampleRate, options);
      processColorAndTransient(outputLeft, outputRight, sampleRate, options);
    } else if (operation === "cleanup") {
      [outputLeft, outputRight] = tonalExtract(id, left, right, sampleRate, options);
    } else if (operation === "master") {
      [outputLeft, outputRight] = tonalExtract(id, left, right, sampleRate, {
        amount: options.tonalAmount,
        floorDb: -18,
        residualMix: 0.22,
        lowProtectHz: 95,
      });
      metrics = finishMaster(outputLeft, outputRight, sampleRate, options);
    } else if (operation === "finish") {
      metrics = finishMaster(outputLeft, outputRight, sampleRate, options);
    } else if (operation === "encode") {
      const wav = encodeWav24(outputLeft, outputRight, sampleRate);
      self.postMessage({ id, type: "encoded", wav }, [wav]);
      return;
    }
    self.postMessage({
      id,
      type: "complete",
      left: outputLeft,
      right: outputRight,
      metrics,
    }, [outputLeft.buffer, outputRight.buffer]);
  } catch (error) {
    self.postMessage({ id, type: "error", message: error?.message || String(error) });
  }
};
