export const PREVIEW_SAMPLE_RATE = 48000;
export const PREVIEW_LATENCY_HINT = "playback";

export const createPreviewAudioContext = () => {
  const AudioContext = window.AudioContext || window.webkitAudioContext;
  return new AudioContext({
    sampleRate: PREVIEW_SAMPLE_RATE,
    latencyHint: PREVIEW_LATENCY_HINT,
  });
};
