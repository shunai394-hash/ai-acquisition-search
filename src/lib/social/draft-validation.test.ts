import assert from "node:assert/strict";
import test from "node:test";
import { validateSocialDraftInput } from "@/lib/social/draft-validation";

const valid = { prompt: "Make a cinematic product video", caption: "Try this", network: "tiktok", draftKey: "draft-001" };

test("trims valid prompt, caption, network, and draft key", () => {
  const result = validateSocialDraftInput({ ...valid, prompt: "  Make a cinematic product video  ", caption: " Try this ", network: " tiktok ", draftKey: " draft-001 " });
  assert.equal(result.ok, true);
  if (result.ok) assert.deepEqual(result.value, { prompt: "Make a cinematic product video", caption: "Try this", network: "tiktok", draftKey: "draft-001" });
});

test("rejects null, arrays, and primitive request bodies", () => {
  for (const body of [null, [], "video", 4, true]) assert.equal(validateSocialDraftInput(body).ok, false);
});

test("rejects prompt shorter than 8 or longer than 10000 characters", () => {
  assert.equal(validateSocialDraftInput({ ...valid, prompt: "short" }).ok, false);
  assert.equal(validateSocialDraftInput({ ...valid, prompt: "x".repeat(10001) }).ok, false);
  assert.equal(validateSocialDraftInput({ ...valid, prompt: "x".repeat(10000) }).ok, true);
});

test("rejects captions above 2200 characters and permits an empty caption", () => {
  assert.equal(validateSocialDraftInput({ ...valid, caption: "x".repeat(2201) }).ok, false);
  assert.equal(validateSocialDraftInput({ ...valid, caption: "" }).ok, true);
});

test("rejects unsupported platforms and malformed draft keys", () => {
  assert.equal(validateSocialDraftInput({ ...valid, network: "threads" }).ok, false);
  assert.equal(validateSocialDraftInput({ ...valid, draftKey: "" }).ok, false);
  assert.equal(validateSocialDraftInput({ ...valid, draftKey: "x".repeat(101) }).ok, false);
});

test("does not coerce non-string fields into accepted values", () => {
  assert.equal(validateSocialDraftInput({ ...valid, prompt: 123 }).ok, false);
  assert.equal(validateSocialDraftInput({ ...valid, caption: 123 }).ok, false);
  assert.equal(validateSocialDraftInput({ ...valid, draftKey: 123 }).ok, false);
});
