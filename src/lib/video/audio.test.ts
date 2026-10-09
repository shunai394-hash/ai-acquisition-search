import assert from "node:assert/strict";
import test from "node:test";
import { generateBgm, isSupportedNarrationWav, mixNarrationWithBgm, fitWavToDuration } from "@/lib/video/audio";

function pcmToWav(pcm: Int16Array, sampleRate = 24_000, channels = 1) {
  const dataBytes = pcm.length * 2;
  const buffer = Buffer.alloc(44 + dataBytes);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write("WAVE", 8);
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * channels * 2, 28);
  buffer.writeUInt16LE(channels * 2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < pcm.length; i++) buffer.writeInt16LE(pcm[i], 44 + i * 2);
  return new Uint8Array(buffer);
}

function toneWav(durationSeconds: number, frequency = 440) {
  const samples = durationSeconds * 24_000;
  const pcm = new Int16Array(samples);
  for (let i = 0; i < samples; i++) {
    pcm[i] = Math.round(Math.sin((2 * Math.PI * frequency * i) / 24_000) * 6_000);
  }
  return pcmToWav(pcm);
}

function readPcm(bytes: Uint8Array) {
  const buffer = Buffer.from(bytes);
  const count = buffer.readUInt32LE(40) / 2;
  return Int16Array.from({ length: count }, (_, i) => buffer.readInt16LE(44 + i * 2));
}

test("generated BGM can be wrapped as a narration-compatible WAV", () => {
  const bgm = pcmToWav(generateBgm(3, "warm acoustic"));
  assert.ok(bgm.byteLength > 44);
  assert.equal(Buffer.from(bgm).toString("ascii", 0, 4), "RIFF");
  assert.equal(isSupportedNarrationWav(bgm), true);
});

test("narration + BGM mix preserves the speech signal and valid WAV duration", () => {
  // A stable speech-band test signal is more meaningful than using generated BGM as narration.
  const source = toneWav(2);
  const mixed = mixNarrationWithBgm(source, 2, "warm acoustic");
  assert.equal(isSupportedNarrationWav(mixed), true);

  const originalPcm = readPcm(source);
  const mixedPcm = readPcm(mixed);
  assert.equal(mixedPcm.length, 24_000 * 2);

  let dot = 0;
  let originalPower = 0;
  let mixedPower = 0;
  for (let i = 0; i < originalPcm.length; i++) {
    dot += originalPcm[i] * mixedPcm[i];
    originalPower += originalPcm[i] * originalPcm[i];
    mixedPower += mixedPcm[i] * mixedPcm[i];
  }
  const correlation = dot / Math.sqrt(originalPower * mixedPower);
  assert.ok(correlation > 0.9, `speech signal correlation should remain high, got ${correlation}`);
});

test("duration fitting trims long narration with a valid WAV and expected sample count", () => {
  const source = toneWav(5);
  const fitted = fitWavToDuration(source, 2);
  assert.equal(isSupportedNarrationWav(fitted), true);
  const sampleRate = Buffer.from(fitted).readUInt32LE(24);
  const dataBytes = Buffer.from(fitted).readUInt32LE(40);
  assert.equal(sampleRate, 24_000);
  assert.equal(dataBytes / 2, 24_000 * 2);
});

test("audio helpers reject non-finite durations instead of returning empty audio", () => {
  assert.throws(() => generateBgm(Number.NaN, "test"), /有限の数値/);
  assert.throws(() => fitWavToDuration(toneWav(2), Number.POSITIVE_INFINITY), /有限の数値/);
  assert.throws(() => mixNarrationWithBgm(toneWav(2), Number.NaN), /有限の数値/);
});

test("raw PCM from TTS is wrapped into a mixable WAV; WAV input is kept as-is", async () => {
  const { ensureWavBase64 } = await import("@/lib/video/gemini-tts");
  const pcm = Buffer.alloc(24_000 * 2);
  for (let i = 0; i < 24_000; i++) pcm.writeInt16LE(Math.round(Math.sin(i / 10) * 8000), i * 2);
  const wrapped = Buffer.from(ensureWavBase64(pcm.toString("base64")), "base64");
  assert.equal(wrapped.toString("ascii", 0, 4), "RIFF");
  assert.equal(isSupportedNarrationWav(new Uint8Array(wrapped)), true);
  const already = wrapped.toString("base64");
  assert.equal(ensureWavBase64(already), already);
  assert.throws(() => ensureWavBase64(""), /空の音声/);
});

test("BGM ducks under narration and stays audible where nobody speaks", () => {
  const rmsDb = (pcm: Int16Array) => {
    let sum = 0;
    for (const value of pcm) sum += value * value;
    return 20 * Math.log10(Math.sqrt(sum / pcm.length) / 32768);
  };
  const mixed = readPcm(mixNarrationWithBgm(toneWav(3), 8, "calm"));
  const bgmOnly = mixed.subarray(24_000 * 4, 24_000 * 7);
  const bgmLevel = rmsDb(bgmOnly);
  assert.ok(bgmLevel > -30 && bgmLevel < -18, `BGM after narration should be audible but moderate, got ${bgmLevel.toFixed(1)} dBFS`);

  // Under speech the music contribution must be clearly below the voice.
  const speechPart = mixed.subarray(24_000 * 1, 24_000 * 2);
  const voice = readPcm(toneWav(3)).subarray(24_000 * 1, 24_000 * 2);
  const residual = Int16Array.from(speechPart, (value, i) => value - Math.round(voice[i] * 0.98));
  assert.ok(rmsDb(voice) - rmsDb(residual) >= 9, `music under speech should be ≥9 dB below voice, got ${(rmsDb(voice) - rmsDb(residual)).toFixed(1)} dB`);
});
