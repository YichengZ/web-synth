const CHANNELS = 2;
const BYTES_PER_SAMPLE = 3;

const writeString = (view, offset, value) => {
  for (let index = 0; index < value.length; index += 1) {
    view.setUint8(offset + index, value.charCodeAt(index));
  }
};

const writePcm24 = (view, offset, value) => {
  const limited = Math.max(-1, Math.min(1, Number.isFinite(value) ? value : 0));
  const sample = Math.round(limited < 0 ? limited * 0x800000 : limited * 0x7fffff);
  view.setUint8(offset, sample & 0xff);
  view.setUint8(offset + 1, (sample >> 8) & 0xff);
  view.setUint8(offset + 2, (sample >> 16) & 0xff);
};

export const encodePcm24Wav = ({ left, right = left, sampleRate }) => {
  const frameCount = Math.min(left.length, right.length);
  const dataLength = frameCount * CHANNELS * BYTES_PER_SAMPLE;
  const wav = new ArrayBuffer(44 + dataLength);
  const view = new DataView(wav);

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
  view.setUint16(34, 24, true);
  writeString(view, 36, "data");
  view.setUint32(40, dataLength, true);

  let cursor = 44;
  for (let frame = 0; frame < frameCount; frame += 1) {
    writePcm24(view, cursor, left[frame]);
    writePcm24(view, cursor + BYTES_PER_SAMPLE, right[frame]);
    cursor += CHANNELS * BYTES_PER_SAMPLE;
  }

  return new Blob([wav], { type: "audio/wav" });
};

export const audioBufferToWavBlob = (buffer) => encodePcm24Wav({
  left: buffer.getChannelData(0),
  right: buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : buffer.getChannelData(0),
  sampleRate: buffer.sampleRate,
});

export const createAudioBuffer = (left, right, sampleRate) => {
  const length = Math.min(left.length, right.length);
  const buffer = new AudioBuffer({ numberOfChannels: 2, length, sampleRate });
  buffer.copyToChannel(left.subarray(0, length), 0);
  buffer.copyToChannel(right.subarray(0, length), 1);
  return buffer;
};

export const downloadBlob = (blob, filename) => {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename.replace(/[^a-z0-9_.-]+/gi, "_");
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1500);
};
