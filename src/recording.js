const BIT_DEPTH = 24;
const BYTES_PER_SAMPLE = 3;
const CHANNELS = 2;
const FALLBACK_BUFFER_SIZE = 4096;
const DEFAULT_MAX_SECONDS = 5 * 60;

const workletSource = `
class WebSynthCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.recording = false;
    this.frames = 0;
    this.bufferSize = 4096;
    this.left = new Float32Array(this.bufferSize);
    this.right = new Float32Array(this.bufferSize);
    this.offset = 0;
    this.port.onmessage = (event) => {
      const message = event.data || {};
      if (message.type === "start") {
        this.frames = 0;
        this.offset = 0;
        this.recording = true;
      } else if (message.type === "stop") {
        this.recording = false;
        this.flush();
        this.port.postMessage({ type: "stopped", id: message.id, frames: this.frames });
      }
    };
  }

  flush() {
    if (!this.offset) return;
    const left = this.offset === this.bufferSize ? this.left : this.left.slice(0, this.offset);
    const right = this.offset === this.bufferSize ? this.right : this.right.slice(0, this.offset);
    this.port.postMessage({ type: "chunk", left, right }, [left.buffer, right.buffer]);
    this.left = new Float32Array(this.bufferSize);
    this.right = new Float32Array(this.bufferSize);
    this.offset = 0;
  }

  process(inputs, outputs) {
    const input = inputs[0];
    if (!input || !input[0]) return true;

    if (!this.recording) return true;
    const left = input[0];
    const right = input[1] || left;
    let inputOffset = 0;
    while (inputOffset < left.length) {
      const length = Math.min(left.length - inputOffset, this.bufferSize - this.offset);
      this.left.set(left.subarray(inputOffset, inputOffset + length), this.offset);
      this.right.set(right.subarray(inputOffset, inputOffset + length), this.offset);
      this.offset += length;
      inputOffset += length;
      this.frames += length;
      if (this.offset === this.bufferSize) this.flush();
    }
    return true;
  }
}

registerProcessor("web-synth-capture", WebSynthCaptureProcessor);
`;

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
  chunks.forEach((chunk) => {
    for (let i = 0; i < chunk.left.length; i += 1) {
      for (let channel = 0; channel < CHANNELS; channel += 1) {
        let sample = channel === 0 ? chunk.left[i] : chunk.right[i];
        sample = Math.max(-1, Math.min(1, sample));
        sample = Math.round(sample < 0 ? sample * 0x800000 : sample * 0x7fffff);
        view.setUint8(cursor, sample & 0xff);
        view.setUint8(cursor + 1, (sample >> 8) & 0xff);
        view.setUint8(cursor + 2, (sample >> 16) & 0xff);
        cursor += BYTES_PER_SAMPLE;
      }
    }
  });

  const blob = new Blob([view], { type: "audio/wav" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = sanitizeFilename(filename);
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return true;
};

export const formatDuration = (seconds) => {
  const safeSeconds = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(safeSeconds / 60).toString().padStart(2, "0");
  const remainder = (safeSeconds % 60).toString().padStart(2, "0");
  return `${minutes}:${remainder}`;
};

export const createWavRecorder = (audioContext, sourceNode, options = {}) => {
  const maxSeconds = options.maxSeconds || DEFAULT_MAX_SECONDS;
  const maxFrames = Math.floor(maxSeconds * audioContext.sampleRate);
  const chunks = [];
  let captureNode = null;
  let keepAliveSource = null;
  let usesWorklet = false;
  let workletUrl = null;
  let initPromise = null;
  let isRecording = false;
  let recordedFrames = 0;
  let reachedLimit = false;
  let stopSequence = 0;
  const pendingStops = new Map();

  const appendChunk = (left, right) => {
    if (!isRecording || reachedLimit) return;
    const available = maxFrames - recordedFrames;
    if (available <= 0) return;

    const frameLength = Math.min(left.length, available);
    chunks.push({
      left: frameLength === left.length ? left : left.slice(0, frameLength),
      right: frameLength === right.length ? right : right.slice(0, frameLength),
    });
    recordedFrames += frameLength;

    if (recordedFrames >= maxFrames) {
      reachedLimit = true;
      isRecording = false;
      captureNode?.port?.postMessage({ type: "stop", id: 0 });
      options.onLimit?.();
    }
  };

  const initialize = async () => {
    if (captureNode) return;

    if (audioContext.audioWorklet && typeof AudioWorkletNode !== "undefined") {
      try {
        workletUrl = URL.createObjectURL(new Blob([workletSource], { type: "text/javascript" }));
        await audioContext.audioWorklet.addModule(workletUrl);
        captureNode = new AudioWorkletNode(audioContext, "web-synth-capture", {
          numberOfInputs: 2,
          numberOfOutputs: 1,
          outputChannelCount: [CHANNELS],
        });
        usesWorklet = true;
        captureNode.port.onmessage = (event) => {
          const message = event.data || {};
          if (message.type === "chunk") appendChunk(message.left, message.right);
          if (message.type === "stopped" && pendingStops.has(message.id)) {
            pendingStops.get(message.id)();
            pendingStops.delete(message.id);
          }
        };
      } catch (error) {
        console.warn("AudioWorklet unavailable, using recorder fallback.", error);
        if (workletUrl) URL.revokeObjectURL(workletUrl);
        workletUrl = null;
      }
    }

    if (!captureNode) {
      captureNode = audioContext.createScriptProcessor(FALLBACK_BUFFER_SIZE, CHANNELS, CHANNELS);
      captureNode.onaudioprocess = (event) => {
        if (!isRecording) return;
        const input = event.inputBuffer;
        const left = new Float32Array(input.getChannelData(0));
        const right = new Float32Array(input.numberOfChannels > 1 ? input.getChannelData(1) : input.getChannelData(0));
        appendChunk(left, right);
      };
    }

    sourceNode.connect(captureNode, 0, 0);
    if (usesWorklet) {
      keepAliveSource = audioContext.createConstantSource();
      keepAliveSource.offset.value = 1;
      keepAliveSource.connect(captureNode, 0, 1);
      keepAliveSource.start();
    }
    // The processor emits silence; a destination connection keeps the capture graph active.
    captureNode.connect(audioContext.destination);
  };

  const ensureInitialized = () => {
    if (!initPromise) initPromise = initialize();
    return initPromise;
  };

  return {
    async start() {
      if (audioContext.state === "suspended") await audioContext.resume();
      await ensureInitialized();
      chunks.length = 0;
      recordedFrames = 0;
      reachedLimit = false;
      isRecording = true;
      captureNode.port?.postMessage({ type: "start" });
      return true;
    },

    async stop(filename) {
      await ensureInitialized();
      const wasRecording = isRecording;

      if (captureNode.port && wasRecording) {
        const id = ++stopSequence;
        await new Promise((resolve) => {
          const timeout = setTimeout(() => {
            pendingStops.delete(id);
            resolve();
          }, 500);
          pendingStops.set(id, () => {
            clearTimeout(timeout);
            resolve();
          });
          captureNode.port.postMessage({ type: "stop", id });
        });
      }
      isRecording = false;

      const saved = saveWav(chunks, audioContext.sampleRate, filename);
      chunks.length = 0;
      recordedFrames = 0;
      reachedLimit = false;
      return saved;
    },

    destroy() {
      isRecording = false;
      try { sourceNode.disconnect(captureNode); } catch (error) { }
      try { keepAliveSource?.stop(); } catch (error) { }
      try { keepAliveSource?.disconnect(); } catch (error) { }
      try { captureNode?.disconnect(); } catch (error) { }
      if (workletUrl) URL.revokeObjectURL(workletUrl);
      pendingStops.forEach((resolve) => resolve());
      pendingStops.clear();
    },

    get active() {
      return isRecording;
    },

    get duration() {
      return recordedFrames / audioContext.sampleRate;
    },

    get limitReached() {
      return reachedLimit;
    },

    get maxSeconds() {
      return maxSeconds;
    },
  };
};
