import assert from "node:assert/strict";
import test from "node:test";
import { generateBgm, isSupportedNarrationWav, mixNarrationWithBgm } from "@/lib/video/audio";

test("generated BGM is a valid narration-compatible WAV", () => {
  const bgm = generateBgm(3, "warm acoustic");
  assert.ok(bgm.byteLength > 44);
  assert.equal(Buffer.from(bgm).toString("ascii", 0, 4), "RIFF");
  assert.equal(isSupportedNarrationWav(bgm), true);
});

test("narration + BGM mix preserves a valid WAV contract", () => {
  const source = generateBgm(2, "lofi");
  const mixed = mixNarrationWithBgm(source, 2, "warm acoustic");
  assert.ok(mixed.byteLength > source.byteLength * 0.9);
  assert.equal(isSupportedNarrationWav(mixed), true);
});
