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

  const tempo = lower.includes("energetic") || lower.includes("upbeat") || lower.includes("dance")
    ? 118
    : lower.includes("lofi") || lower.includes("calm")
      ? 78
      : lower.includes("luxury") || lower.includes("cinematic")
        ? 84
        : 96;
  const beat = 60 / tempo;
  const bars = [
    [196, 246.94, 293.66],
    [174.61, 220, 261.63],
    [146.83, 196, 246.94],
    [164.81, 220, 277.18],
  ];

  const note = (freq: number, t: number, gain: number) =>
    Math.sin(2 * Math.PI * freq * t) * gain
    + Math.sin(2 * Math.PI * freq * 2 * t) * gain * 0.16
    + Math.sin(2 * Math.PI * freq * 3 * t) * gain * 0.045;

  for (let i = 0; i < samples; i++) {
    const t = i / SAMPLE_RATE;
    const beatIndex = Math.floor(t / beat);
    const barIndex = Math.floor(beatIndex / 4) % bars.length;
    const beatPhase = (t % beat) / beat;
    const chord = bars[barIndex];
    const leadFreq = chord[(beatIndex + Math.floor(beatPhase * 2)) % chord.length];

    const pad = note(chord[0], t, 0.17)
      + note(chord[1], t, 0.075)
      + note(chord[2], t, 0.05);

    const pulseEnvelope = Math.pow(Math.max(0, 1 - beatPhase * 3.5), 3);
    const pulse = Math.sin(2 * Math.PI * (tempo / 60 > 105 ? 110 : 92) * t) * pulseEnvelope * 0.035;
    const lead = Math.sin(2 * Math.PI * leadFreq * 2 * t) * Math.exp(-beatPhase * 5) * 0.018;

    const fadeIn = Math.min(1, t / 0.35);
    const fadeOut = Math.min(1, (seconds - t) / 0.65);
    const movement = 0.86 + 0.14 * Math.sin(2 * Math.PI * 0.11 * t);
    const level = 0.24 * fadeIn * fadeOut * movement;

    pcm[i] = clamp16((pad + pulse + lead) * 32767 * level);
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
