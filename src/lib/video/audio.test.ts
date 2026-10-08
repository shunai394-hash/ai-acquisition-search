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

test("generated BGM can be wrapped as a narration-compatible WAV", () => {
  const bgm = pcmToWav(generateBgm(3, "warm acoustic"));
  assert.ok(bgm.byteLength > 44);
  assert.equal(Buffer.from(bgm).toString("ascii", 0, 4), "RIFF");
  assert.equal(isSupportedNarrationWav(bgm), true);
});

test("narration + BGM mix preserves a valid WAV contract", () => {
  const source = pcmToWav(generateBgm(2, "lofi"));
  const mixed = mixNarrationWithBgm(source, 2, "warm acoustic");
  assert.ok(mixed.byteLength > source.byteLength * 0.9);
  assert.equal(isSupportedNarrationWav(mixed), true);
});


test("duration fitting trims long narration with a valid WAV and expected sample count", () => {
  const source = pcmToWav(generateBgm(5, "speech bed"));
  const fitted = fitWavToDuration(source, 2);
  assert.equal(isSupportedNarrationWav(fitted), true);
  const sampleRate = Buffer.from(fitted).readUInt32LE(24);
  const dataBytes = Buffer.from(fitted).readUInt32LE(40);
  assert.equal(sampleRate, 24_000);
  assert.equal(dataBytes / 2, 24_000 * 2);
});
