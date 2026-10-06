const SAMPLE_RATE = 24_000;
const CHANNELS = 1;
const BITS_PER_SAMPLE = 16;

function clamp16(value: number) {
  return Math.max(-32768, Math.min(32767, Math.round(value)));
}

function pcmWav(pcm: Int16Array) {
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
      const count = Math.floor((end - offset - 8) / 2);
      const pcm = new Int16Array(count);
      for (let i = 0; i < count; i++) pcm[i] = buffer.readInt16LE(offset + 8 + i * 2);
      return pcm;
    }
    offset += 8 + size + (size % 2);
  }
  throw new Error("WAVのPCM dataチャンクが見つかりません。");
}

export function generateBgm(durationSeconds: number, prompt = "") {
  const seconds = Math.max(2, Math.min(30, durationSeconds));
  const samples = Math.ceil(seconds * SAMPLE_RATE);
  const pcm = new Int16Array(samples);
  const lower = prompt.toLowerCase();
  const energetic = lower.includes("energetic") || lower.includes("upbeat") || lower.includes("dynamic");
  const warm = lower.includes("warm") || lower.includes("acoustic") || lower.includes("organic");
  const lofi = lower.includes("lofi") || lower.includes("chill");
  const tempo = energetic ? 116 : lofi ? 82 : 96;
  const beat = 60 / tempo;
  const bars = beat * 4;
  const chords = warm
    ? [220, 261.63, 329.63, 293.66]
    : [196, 246.94, 293.66, 246.94];

  for (let i = 0; i < samples; i++) {
    const t = i / SAMPLE_RATE;
    const beatPhase = (t % beat) / beat;
    const barPhase = (t % bars) / bars;
    const chordIndex = Math.floor(barPhase * chords.length) % chords.length;
    const root = chords[chordIndex];
    const intro = Math.min(1, t / 0.8);
    const outro = Math.min(1, Math.max(0, (seconds - t) / 1.0));
    const envelope = intro * outro;

    const pad =
      Math.sin(2 * Math.PI * root * t) * 0.15 +
      Math.sin(2 * Math.PI * root * 1.5 * t) * 0.055 +
      Math.sin(2 * Math.PI * root * 2 * t) * 0.025;

    const bass = Math.sin(2 * Math.PI * (root / 2) * t) * 0.09;
    const arpRate = beat / 2;
    const arpIndex = Math.floor(t / arpRate) % 4;
    const arpRatios = [1, 1.25, 1.5, 2];
    const arp = Math.sin(2 * Math.PI * root * arpRatios[arpIndex] * t) * 0.025;

    const kickPhase = t % beat;
    const kickEnv = Math.exp(-kickPhase * 24);
    const kick = Math.sin(2 * Math.PI * (52 - 22 * Math.min(1, kickPhase * 9)) * kickPhase) * kickEnv * (energetic ? 0.075 : 0.04);

    const hatPhase = (t % (beat / 2));
    const hatEnv = Math.exp(-hatPhase * 90);
    const hat = Math.sin(2 * Math.PI * 7000 * t) * hatEnv * (energetic ? 0.018 : 0.009);

    const pulse = Math.max(0, 1 - beatPhase * 3) ** 2;
    const tremolo = 0.86 + 0.14 * Math.sin(2 * Math.PI * 0.2 * t);
    pcm[i] = clamp16((pad + bass + arp + kick * pulse + hat) * tremolo * envelope * 32767 * 0.48);
  }
  return pcm;
}

function createNarrationPresence(pcm: Int16Array) {
  const radius = Math.max(1, Math.floor(SAMPLE_RATE * 0.018));
  const absolute = new Float64Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) absolute[i] = Math.abs(pcm[i]) / 32768;

  let sum = 0;
  let count = 0;
  for (let i = 0; i <= Math.min(radius, pcm.length - 1); i++) {
    sum += absolute[i];
    count++;
  }

  return (index: number) => {
    const addIndex = index + radius;
    if (addIndex < pcm.length) {
      sum += absolute[addIndex];
      count++;
    }
    const removeIndex = index - radius - 1;
    if (removeIndex >= 0) {
      sum -= absolute[removeIndex];
      count--;
    }
    return Math.min(1, (sum / Math.max(1, count)) * 3.2);
  };
}

export function mixNarrationWithBgm(narrationWav: Uint8Array, durationSeconds: number, bgmPrompt = "") {
  const narration = readWavPcm(narrationWav);
  const bgm = generateBgm(Math.max(durationSeconds, narration.length / SAMPLE_RATE), bgmPrompt);
  const length = Math.max(narration.length, bgm.length);
  const mixed = new Int16Array(length);
  let duck = 1;
  const presenceAt = createNarrationPresence(narration);

  for (let i = 0; i < length; i++) {
    const voice = i < narration.length ? narration[i] * 0.96 : 0;
    const presence = i < narration.length ? presenceAt(i) : 0;
    const targetDuck = 1 - presence * 0.78;
    duck += (targetDuck - duck) * (targetDuck < duck ? 0.035 : 0.008);
    const music = i < bgm.length ? bgm[i] * 0.20 * duck : 0;
    mixed[i] = clamp16(voice + music);
  }
  return pcmWav(mixed);
}

export function isSupportedNarrationWav(bytes: Uint8Array) {
  try {
    readWavPcm(bytes);
    return true;
  } catch {
    return false;
  }
}
