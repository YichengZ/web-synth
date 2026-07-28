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

const applyEdgeFade = (left, right, sampleRate, milliseconds = 35) => {
  const fadeLength = Math.min(
    Math.floor(left.length / 2),
    Math.max(1, Math.floor(sampleRate * milliseconds / 1000)),
  );
  for (let index = 0; index < fadeLength; index += 1) {
    const phase = (index + 1) / fadeLength;
    const gain = Math.sin(phase * Math.PI * 0.5) ** 2;
    const end = left.length - 1 - index;
    left[index] *= gain;
    right[index] *= gain;
    left[end] *= gain;
    right[end] *= gain;
  }
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

  const amount = clamp(Number(options.amount) || 0.78, 0, 1);
  const floor = dbToGain(Number(options.floorDb) || -32);
  const residualMix = clamp(Number(options.residualMix) || 0.12, 0, 0.5);
  const lowProtectHz = Math.max(0, Number(options.lowProtectHz) || 120);
  const timeRadius = clamp(Math.round(Number(options.timeRadius) || 8), 4, 16);
  const frequencyRadius = clamp(Math.round(Number(options.frequencyRadius) || 5), 3, 10);
  const maskPower = clamp(Number(options.maskPower) || 4, 2, 6);
  const residualBias = clamp(Number(options.residualBias) || 1.35, 1, 2.5);
  const rawMask = new Float32Array(magnitude.length);
  const timeValues = new Float32Array(timeRadius * 2 + 1);
  const frequencyValues = new Float32Array(frequencyRadius * 2 + 1);

  for (let frameIndex = 0; frameIndex < frameCount; frameIndex += 1) {
    for (let bin = 0; bin < binCount; bin += 1) {
      let timeLength = 0;
      for (let offset = -timeRadius; offset <= timeRadius; offset += 1) {
        const neighbor = clamp(frameIndex + offset, 0, frameCount - 1);
        timeValues[timeLength] = magnitude[neighbor * binCount + bin];
        timeLength += 1;
      }
      const tonal = medianSmall(timeValues, timeLength);
      let frequencyLength = 0;
      for (let offset = -frequencyRadius; offset <= frequencyRadius; offset += 1) {
        const neighbor = clamp(bin + offset, 0, binCount - 1);
        frequencyValues[frequencyLength] = magnitude[frameIndex * binCount + neighbor];
        frequencyLength += 1;
      }
      const residual = medianSmall(frequencyValues, frequencyLength);
      const tonalPower = tonal ** maskPower;
      const residualPower = (residual * residualBias) ** maskPower;
      const tonalMask = tonalPower / (tonalPower + residualPower + EPSILON);
      const transientMask = residualPower / (tonalPower + residualPower + EPSILON);
      const frequency = bin * sampleRate / fftSize;
      const lowProtection = lowProtectHz > 0
        ? clamp((lowProtectHz * 1.7 - frequency) / Math.max(1, lowProtectHz * 0.7), 0, 1)
        : 0;
      const extracted = Math.max(
        floor,
        tonalMask ** (1 / maskPower),
        transientMask ** (1 / maskPower) * residualMix,
        lowProtection,
      );
      rawMask[frameIndex * binCount + bin] = 1 - amount * (1 - extracted);
    }
    if (frameIndex % 16 === 0) report(id, "mask", frameIndex / frameCount);
  }

  const mask = new Float32Array(rawMask.length);
  for (let frameIndex = 0; frameIndex < frameCount; frameIndex += 1) {
    const previousFrame = Math.max(0, frameIndex - 1);
    const nextFrame = Math.min(frameCount - 1, frameIndex + 1);
    for (let bin = 0; bin < binCount; bin += 1) {
      const previousBin = Math.max(0, bin - 1);
      const nextBin = Math.min(binCount - 1, bin + 1);
      mask[frameIndex * binCount + bin] = (
        rawMask[frameIndex * binCount + bin] * 0.5
        + rawMask[previousFrame * binCount + bin] * 0.16
        + rawMask[nextFrame * binCount + bin] * 0.16
        + rawMask[frameIndex * binCount + previousBin] * 0.09
        + rawMask[frameIndex * binCount + nextBin] * 0.09
      );
    }
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
  applyEdgeFade(output[0], output[1], sampleRate, 28);
  return output;
};

const processColorAndTransient = (left, right, sampleRate, options = {}) => {
  const drive = dbToGain(clamp(Number(options.driveDb) || 4, 0, 12));
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
    const target = Math.min(1.38, 1 + transientAmount * transient / (slow + 0.09));
    smoothedGain += (target - smoothedGain) * 0.08;
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

const removeDc = (left, right) => {
  let meanLeft = 0;
  let meanRight = 0;
  for (let index = 0; index < left.length; index += 1) {
    meanLeft += left[index];
    meanRight += right[index];
  }
  meanLeft /= Math.max(1, left.length);
  meanRight /= Math.max(1, right.length);
  for (let index = 0; index < left.length; index += 1) {
    left[index] = finiteSample(left[index] - meanLeft, 2);
    right[index] = finiteSample(right[index] - meanRight, 2);
  }
};

const applyLookaheadLimiter = (left, right, sampleRate, {
  ceilingDb = -1.3,
  lookaheadMs = 3,
  releaseMs = 95,
} = {}) => {
  const ceiling = dbToGain(ceilingDb);
  const lookahead = Math.max(1, Math.floor(sampleRate * lookaheadMs / 1000));
  const release = Math.exp(-1 / Math.max(1, sampleRate * releaseMs / 1000));
  const linked = new Float32Array(left.length);
  const deque = new Int32Array(left.length);
  let head = 0;
  let tail = 0;
  for (let index = 0; index < left.length; index += 1) {
    linked[index] = Math.max(Math.abs(left[index]), Math.abs(right[index]));
  }
  const push = (index) => {
    while (tail > head && linked[deque[tail - 1]] <= linked[index]) tail -= 1;
    deque[tail] = index;
    tail += 1;
  };
  for (let index = 0; index <= Math.min(left.length - 1, lookahead); index += 1) push(index);
  let gain = 1;
  for (let index = 0; index < left.length; index += 1) {
    while (tail > head && deque[head] < index) head += 1;
    const entering = index + lookahead;
    if (entering < left.length && entering > lookahead) push(entering);
    const peak = tail > head ? linked[deque[head]] : linked[index];
    const target = Math.min(1, ceiling / Math.max(EPSILON, peak));
    gain = target < gain ? target : target + release * (gain - target);
    left[index] = finiteSample(left[index] * gain, 2);
    right[index] = finiteSample(right[index] * gain, 2);
  }
};

const applyLinkedCompressor = (left, right, sampleRate, {
  thresholdDb = -20,
  ratio = 3.4,
  attackMs = 0.35,
  releaseMs = 135,
  makeupDb = 6,
  mix = 0.34,
} = {}) => {
  const attack = Math.exp(-1 / Math.max(1, sampleRate * attackMs / 1000));
  const release = Math.exp(-1 / Math.max(1, sampleRate * releaseMs / 1000));
  let envelope = 0;
  let gain = 1;
  for (let index = 0; index < left.length; index += 1) {
    const linked = Math.max(Math.abs(left[index]), Math.abs(right[index]));
    const coefficient = linked > envelope ? attack : release;
    envelope = linked + coefficient * (envelope - linked);
    const overDb = Math.max(0, gainToDb(envelope) - thresholdDb);
    const reductionDb = overDb * (1 - 1 / ratio);
    const targetGain = dbToGain(-reductionDb);
    gain += (targetGain - gain) * (targetGain < gain ? 0.42 : 0.008);
    const parallelGain = gain * dbToGain(makeupDb);
    const mixedGain = 1 - mix + parallelGain * mix;
    left[index] = finiteSample(left[index] * mixedGain, 2);
    right[index] = finiteSample(right[index] * mixedGain, 2);
  }
};

const measureDiscontinuity = (left, right) => {
  let maxSampleDelta = 0;
  let clickCount = 0;
  for (const channel of [left, right]) {
    for (let index = 1; index < channel.length - 1; index += 1) {
      const incoming = channel[index] - channel[index - 1];
      const outgoing = channel[index + 1] - channel[index];
      maxSampleDelta = Math.max(maxSampleDelta, Math.abs(incoming));
      if (
        Math.abs(incoming) > 0.32
        && Math.abs(incoming + outgoing) < Math.abs(incoming) * 0.3
      ) {
        clickCount += 1;
      }
    }
  }
  return { maxSampleDelta, clickCount };
};

const finishMaster = (left, right, sampleRate, options = {}) => {
  const violence = clamp(Number(options.violence) || 0.8, 0, 1);
  processColorAndTransient(left, right, sampleRate, {
    driveDb: 1.5 + violence * 2.5,
    colorMix: 0.18 + violence * 0.12,
    transient: 0.16 + violence * 0.16,
  });
  removeDc(left, right);
  applyLinkedCompressor(left, right, sampleRate);
  const targetLufs = Number(options.targetLufs) || -9.5;
  let loudness = measureLoudness(left, right, sampleRate);
  const firstGain = dbToGain(clamp(targetLufs - loudness, -6, 18));
  for (let index = 0; index < left.length; index += 1) {
    left[index] = finiteSample(left[index] * firstGain, 2);
    right[index] = finiteSample(right[index] * firstGain, 2);
  }
  applyLookaheadLimiter(left, right, sampleRate, { ceilingDb: -1.3 });
  loudness = measureLoudness(left, right, sampleRate);
  const truePeak = measureTruePeak(left, right);
  const ceiling = dbToGain(-1.2);
  const finalGain = Math.min(
    dbToGain(clamp(targetLufs - loudness, -1.5, 1.5)),
    ceiling / Math.max(EPSILON, truePeak),
  );
  for (let index = 0; index < left.length; index += 1) {
    left[index] = finiteSample(left[index] * finalGain, 2);
    right[index] = finiteSample(right[index] * finalGain, 2);
  }
  applyLookaheadLimiter(left, right, sampleRate, { ceilingDb: -1.2, releaseMs: 120 });
  const safetyPeak = measureTruePeak(left, right);
  const safetyTrim = Math.min(1, ceiling / Math.max(EPSILON, safetyPeak));
  if (safetyTrim < 1) {
    for (let index = 0; index < left.length; index += 1) {
      left[index] *= safetyTrim;
      right[index] *= safetyTrim;
    }
  }
  applyEdgeFade(left, right, sampleRate, 45);
  loudness = measureLoudness(left, right, sampleRate);
  const measuredPeak = measureTruePeak(left, right);
  let dcLeft = 0;
  let dcRight = 0;
  for (let index = 0; index < left.length; index += 1) {
    dcLeft += left[index];
    dcRight += right[index];
  }
  const dc = Math.max(Math.abs(dcLeft / left.length), Math.abs(dcRight / right.length));
  const discontinuity = measureDiscontinuity(left, right);
  return {
    lufs: loudness,
    truePeakDb: gainToDb(measuredPeak),
    dcDb: gainToDb(dc),
    spectralFlatness: measureSpectralFlatness(left, right),
    ...discontinuity,
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
    } else if (operation === "color") {
      processColorAndTransient(outputLeft, outputRight, sampleRate, options);
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
