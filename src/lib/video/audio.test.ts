import assert from "node:assert/strict";
import test from "node:test";
import { generateBgm, isSupportedNarrationWav, mixNarrationWithBgm } from "./audio";

test("BGM output is a valid 24kHz mono WAV", () => {
  const bgm = generateBgm(2, "warm acoustic");
  assert.ok(bgm.byteLength > 44);
  assert.equal(Buffer.from(bgm).toString("ascii", 0, 4), "RIFF");
  assert.equal(isSupportedNarrationWav(bgm), true);
});

test("narration/BGM mixer returns a valid WAV", () => {
  const narration = generateBgm(2, "lofi");
  const mixed = mixNarrationWithBgm(narration, 2, "warm acoustic");
  assert.equal(isSupportedNarrationWav(mixed), true);
  assert.ok(mixed.byteLength >= narration.byteLength);
});
