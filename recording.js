(function () {
  const BUFFER_SIZE = 4096;
  const BIT_DEPTH = 24;
  const BYTES_PER_SAMPLE = 3;
  const CHANNELS = 2;

  const writeString = (view, offset, value) => {
    for (let i = 0; i < value.length; i += 1) {
      view.setUint8(offset + i, value.charCodeAt(i));
    }
  };

  const sanitizeFilename = (name) => {
    return name.replace(/[^a-z0-9_.-]+/gi, "_").replace(/^_+|_+$/g, "");
  };

  const saveWav = (chunks, sampleRate, filename) => {
    if (!chunks.length) return false;

    const frameCount = chunks.reduce((total, chunk) => total + chunk.left.length, 0);
    const leftBuffer = new Float32Array(frameCount);
    const rightBuffer = new Float32Array(frameCount);

    let offset = 0;
    chunks.forEach((chunk) => {
      leftBuffer.set(chunk.left, offset);
      rightBuffer.set(chunk.right, offset);
      offset += chunk.left.length;
    });

    const dataLength = frameCount * CHANNELS * BYTES_PER_SAMPLE;
    const wavBuffer = new ArrayBuffer(44 + dataLength);
    const view = new DataView(wavBuffer);

    writeString(view, 0, "RIFF");
    view.setUint32(4, 36 + dataLength, true);
    writeString(view, 8, "WAVE");
    writeString(view, 12, "fmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, CHANNELS, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * CHANNELS * BYTES_PER_SAMPLE, true);
    view.setUint16(32, CHANNELS * BYTES_PER_SAMPLE, true);
    view.setUint16(34, BIT_DEPTH, true);
    writeString(view, 36, "data");
    view.setUint32(40, dataLength, true);

    let cursor = 44;
    for (let i = 0; i < frameCount; i += 1) {
      for (let channel = 0; channel < CHANNELS; channel += 1) {
        let sample = channel === 0 ? leftBuffer[i] : rightBuffer[i];
        sample = Math.max(-1, Math.min(1, sample));
        sample = Math.round(sample < 0 ? sample * 0x800000 : sample * 0x7fffff);
        view.setUint8(cursor, sample & 0xff);
        view.setUint8(cursor + 1, (sample >> 8) & 0xff);
        view.setUint8(cursor + 2, (sample >> 16) & 0xff);
        cursor += BYTES_PER_SAMPLE;
      }
    }

    const blob = new Blob([view], { type: "audio/wav" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = sanitizeFilename(filename);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return true;
  };

  const createWavRecorder = (audioContext, sourceNode) => {
    const processor = audioContext.createScriptProcessor(BUFFER_SIZE, CHANNELS, CHANNELS);
    const chunks = [];
    let isRecording = false;

    sourceNode.connect(processor);
    processor.connect(audioContext.destination);

    processor.onaudioprocess = (event) => {
      if (!isRecording) return;

      const input = event.inputBuffer;
      const left = input.getChannelData(0);
      const right = input.numberOfChannels > 1 ? input.getChannelData(1) : left;

      chunks.push({
        left: new Float32Array(left),
        right: new Float32Array(right),
      });
    };

    return {
      start() {
        chunks.length = 0;
        isRecording = true;
      },
      stop(filename) {
        isRecording = false;
        return saveWav(chunks, audioContext.sampleRate, filename);
      },
      get active() {
        return isRecording;
      },
    };
  };

  window.WebSynthRecorder = { createWavRecorder };
})();
