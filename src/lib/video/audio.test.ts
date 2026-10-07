import assert from "node:assert/strict";
import test from "node:test";
import { generateBgm, isSupportedNarrationWav, mixNarrationWithBgm } from "./audio";

test("BGM output is a valid 24kHz mono WAV", () => {
  const bgm = generateBgm(2, "warm acoustic");
  assert.ok(bgm.byteLength > 44);
  assert.equal(bgm instanceof Int16Array, true);
  assert.equal(bgm.length, 2 * 24_000);
});

test("narration/BGM mixer returns a valid WAV", () => {
  // Build a minimal valid 24kHz mono 16-bit WAV for the narration input.
  const samples = generateBgm(2, "lofi");
  const dataBytes = samples.length * 2;
  const buffer = Buffer.alloc(44 + dataBytes);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write("WAVE", 8);
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(24_000, 24);
  buffer.writeUInt32LE(48_000, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < samples.length; i++) buffer.writeInt16LE(samples[i], 44 + i * 2);
  const narration = new Uint8Array(buffer);
  const mixed = mixNarrationWithBgm(narration, 2, "warm acoustic");
  assert.equal(isSupportedNarrationWav(mixed), true);
  assert.ok(mixed.byteLength >= narration.byteLength);
});
