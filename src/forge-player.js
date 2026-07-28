import { createPreviewAudioContext } from "./audio-runtime.js";
import { createWavRecorder } from "./recording.js";

const MAX_CACHE_ITEMS = 4;
const MAX_CACHE_BYTES = 128 * 1024 * 1024;

const createPlaybackGraph = (context) => {
  const input = context.createGain();
  const limiter = context.createDynamicsCompressor();
  const output = context.createGain();
  const analyser = context.createAnalyser();
  limiter.threshold.value = -1;
  limiter.knee.value = 0;
  limiter.ratio.value = 20;
  limiter.attack.value = 0.001;
  limiter.release.value = 0.08;
  output.gain.value = 0.94;
  analyser.fftSize = 2048;
  analyser.smoothingTimeConstant = 0.74;
  input.connect(limiter);
  limiter.connect(output);
  output.connect(analyser);
  analyser.connect(context.destination);
  return { input, limiter, output, analyser };
};

export class ForgeAssetPlayer {
  constructor({ onState } = {}) {
    this.onState = onState;
    this.preview = null;
    this.capture = null;
    this.recorder = null;
    this.recording = false;
    this.cache = new Map();
    this.active = new Set();
  }

  async ensurePreview() {
    if (!this.preview) {
      const context = createPreviewAudioContext();
      this.preview = { context, graph: createPlaybackGraph(context) };
    }
    if (this.preview.context.state === "suspended") await this.preview.context.resume();
    return this.preview;
  }

  async ensureCapture() {
    if (!this.capture) {
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      // REC SET only plays rendered buffers, so a small quantum is stable and
      // keeps the capture clock advancing consistently in Chromium.
      const context = new AudioContext({ sampleRate: 96000, latencyHint: "interactive" });
      const graph = createPlaybackGraph(context);
      this.capture = { context, graph };
      this.recorder = createWavRecorder(context, graph.input);
    }
    if (this.capture.context.state === "suspended") await this.capture.context.resume();
    return this.capture;
  }

  evictCache() {
    let totalBytes = [...this.cache.values()].reduce((total, entry) => total + entry.bytes, 0);
    const ordered = [...this.cache.entries()].sort((left, right) => left[1].usedAt - right[1].usedAt);
    while ((this.cache.size > MAX_CACHE_ITEMS || totalBytes > MAX_CACHE_BYTES) && ordered.length) {
      const [key, entry] = ordered.shift();
      this.cache.delete(key);
      totalBytes -= entry.bytes;
    }
  }

  async decode(asset, context, rate) {
    const key = `${rate}:${asset.id}`;
    const cached = this.cache.get(key);
    if (cached) {
      cached.usedAt = performance.now();
      return cached.buffer;
    }
    const encoded = await asset.wavBlob.arrayBuffer();
    const buffer = await context.decodeAudioData(encoded.slice(0));
    const bytes = buffer.length * buffer.numberOfChannels * 4;
    this.cache.set(key, { buffer, bytes, usedAt: performance.now() });
    this.evictCache();
    return buffer;
  }

  async play(asset, { loop = false } = {}) {
    const target = this.recording ? await this.ensureCapture() : await this.ensurePreview();
    if (!this.recording) this.stopAll();
    const buffer = await this.decode(asset, target.context, target.context.sampleRate);
    const source = target.context.createBufferSource();
    const gain = target.context.createGain();
    const now = target.context.currentTime;
    source.buffer = buffer;
    source.loop = loop;
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.linearRampToValueAtTime(1, now + 0.02);
    source.connect(gain);
    gain.connect(target.graph.input);
    const voice = { source, gain, context: target.context, assetId: asset.id };
    source.addEventListener("ended", () => {
      this.active.delete(voice);
      try { source.disconnect(); } catch (error) { /* already disconnected */ }
      try { gain.disconnect(); } catch (error) { /* already disconnected */ }
      this.onState?.({ activeIds: [...this.active].map((item) => item.assetId), recording: this.recording });
    }, { once: true });
    this.active.add(voice);
    source.start(now + 0.025);
    this.onState?.({ activeIds: [...this.active].map((item) => item.assetId), recording: this.recording });
  }

  stopAll() {
    for (const voice of this.active) {
      const now = voice.context.currentTime;
      voice.gain.gain.cancelScheduledValues(now);
      voice.gain.gain.setTargetAtTime(0, now, 0.006);
      try { voice.source.stop(now + 0.035); } catch (error) { /* already stopped */ }
    }
    this.active.clear();
    this.onState?.({ activeIds: [], recording: this.recording });
  }

  async startCapture() {
    this.stopAll();
    await this.ensureCapture();
    await this.recorder.start();
    this.recording = true;
    this.onState?.({ activeIds: [...this.active].map((item) => item.assetId), recording: true });
  }

  async stopCapture(filename) {
    if (!this.recording || !this.recorder) return false;
    this.recording = false;
    this.stopAll();
    const saved = await this.recorder.stop(filename);
    this.onState?.({ activeIds: [], recording: false });
    return saved;
  }

  clear() {
    this.stopAll();
    this.cache.clear();
  }

  getAnalyser() {
    if (this.recording) return this.capture?.graph.analyser || null;
    return this.preview?.graph.analyser || null;
  }

  destroy() {
    this.clear();
    this.recorder?.destroy();
    if (this.preview?.context.state !== "closed") this.preview?.context.close();
    if (this.capture?.context.state !== "closed") this.capture?.context.close();
  }
}
