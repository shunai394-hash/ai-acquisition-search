const SAMPLE_RATE = 24_000;
const CHANNELS = 1;
const BITS_PER_SAMPLE = 16;

function clamp16(value: number) {
  return Math.max(-32768, Math.min(32767, Math.round(value)));
}

export function pcmToWav(pcm: Int16Array) {
  const dataBytes = pcm.length * 2;
  const buffer = Buffer.alloc(44 + dataBytes);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write("WAVE", 8);
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(CHANNELS, 22);
  buffer.writeUInt32LE(SAMPLE_RATE, 24);
  buffer.writeUInt32LE(SAMPLE_RATE * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(BITS_PER_SAMPLE, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < pcm.length; i++) buffer.writeInt16LE(pcm[i], 44 + i * 2);
  return new Uint8Array(buffer);
}

function readWavPcm(bytes: Uint8Array) {
  const buffer = Buffer.from(bytes);
  if (buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("ナレーション音声はWAV形式である必要があります。");
  }
  const channels = buffer.readUInt16LE(22);
  const sampleRate = buffer.readUInt32LE(24);
  const bits = buffer.readUInt16LE(34);
  if (channels !== 1 || sampleRate !== SAMPLE_RATE || bits !== BITS_PER_SAMPLE) {
    throw new Error("ナレーション音声は24kHz / mono / 16-bit WAVに統一してください。");
  }
  let offset = 12;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString("ascii", offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    if (id === "data") {
      const end = Math.min(buffer.length, offset + 8 + size);
      const count = Math.floor((end - (offset + 8)) / 2);
      const pcm = new Int16Array(count);
      for (let i = 0; i < count; i++) pcm[i] = buffer.readInt16LE(offset + 8 + i * 2);
      return pcm;
    }
    offset += 8 + size + (size % 2);
  }
  throw new Error("WAVのPCM dataチャンクが見つかりません。");
}

/**
 * Lightweight, deterministic BGM bed. It is intentionally subtle and speech-safe:
 * low-volume chord tones plus a soft pulse, generated directly as 24kHz PCM.
 * This avoids shipping a large audio binary or an unlicensed music track.
 */
export function generateBgm(durationSeconds: number, prompt = "") {
  const seconds = Math.max(2, Math.min(30, durationSeconds));
  const samples = Math.ceil(seconds * SAMPLE_RATE);
  const pcm = new Int16Array(samples);
  const lower = prompt.toLowerCase();
  const tempo = lower.includes("energetic") || lower.includes("upbeat") ? 112 : lower.includes("lofi") ? 78 : 92;
  const beat = 60 / tempo;
  const chords = lower.includes("warm") || lower.includes("acoustic")
    ? [220, 261.63, 329.63]
    : [196, 246.94, 293.66];

  for (let i = 0; i < samples; i++) {
    const t = i / SAMPLE_RATE;
    const phase = (t % (beat * 4)) / (beat * 4);
    const chordIndex = Math.floor(phase * chords.length);
    const root = chords[chordIndex];
    const pulse = Math.pow(Math.max(0, 1 - ((t % beat) / beat) * 2), 2);
    const pad = Math.sin(2 * Math.PI * root * t) * 0.20
      + Math.sin(2 * Math.PI * root * 1.5 * t) * 0.07
      + Math.sin(2 * Math.PI * root * 2 * t) * 0.035;
    const tremolo = 0.78 + 0.22 * Math.sin(2 * Math.PI * 0.18 * t);
    pcm[i] = clamp16((pad * tremolo + pulse * 0.018) * 32767 * 0.32);
  }
  return pcm;
}

export function mixNarrationWithBgm(narrationWav: Uint8Array, durationSeconds: number, bgmPrompt = "") {
  const narration = readWavPcm(narrationWav);
  const bgm = generateBgm(Math.max(durationSeconds, narration.length / SAMPLE_RATE), bgmPrompt);
  const length = Math.max(narration.length, bgm.length);
  const mixed = new Int16Array(length);

  for (let i = 0; i < length; i++) {
    const voice = i < narration.length ? narration[i] * 0.98 : 0;
    const music = i < bgm.length ? bgm[i] * 0.22 : 0;
    mixed[i] = clamp16(voice + music);
  }
  return pcmToWav(mixed);
}

export function isSupportedNarrationWav(bytes: Uint8Array) {
  try {
    readWavPcm(bytes);
    return true;
  } catch {
    return false;
  }
}
