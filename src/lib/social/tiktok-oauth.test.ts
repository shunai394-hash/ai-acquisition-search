import assert from "node:assert/strict";
import test from "node:test";

process.env.TIKTOK_TOKEN_ENCRYPTION_KEY = "oauth-test-key";

const { createTikTokState, verifyTikTokState, getTikTokStateUserId } = await import("./tiktok");

test("TikTok OAuth state round-trips the user id", () => {
  const state = createTikTokState("user-1");
  assert.equal(verifyTikTokState(state), true);
  assert.equal(getTikTokStateUserId(state), "user-1");
});

test("a tampered TikTok OAuth state is rejected", () => {
  const state = createTikTokState("user-1");
  const [payload, signature] = state.split(".");
  const flipped = signature.slice(0, -1) + (signature.endsWith("a") ? "b" : "a");
  assert.equal(verifyTikTokState(payload + "." + flipped), false);
});

test("an expired TikTok OAuth state is rejected", () => {
  const state = createTikTokState("user-1", Date.now() - 11 * 60_000);
  assert.equal(verifyTikTokState(state), false);
  assert.equal(getTikTokStateUserId(state), "user-1");
});
