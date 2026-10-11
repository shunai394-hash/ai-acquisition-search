import assert from "node:assert/strict";
import testCase from "node:test";
import { validatePromptVideoDraft } from "./prompt-video-draft";

const valid = {
  prompt: "A cinematic shot of a rainy Tokyo street at night",
  caption: "A city after dark",
  network: "youtube",
  draftKey: "draft-123",
};

testCase("prompt-video draft trims accepted values", () => {
  const result = validatePromptVideoDraft({
    ...valid,
    prompt: "  A cinematic shot of a rainy Tokyo street at night  ",
    caption: "  A city after dark  ",
    network: " youtube ",
    draftKey: " draft-123 ",
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.prompt, "A cinematic shot of a rainy Tokyo street at night");
  assert.equal(result.value.caption, "A city after dark");
  assert.equal(result.value.network, "youtube");
  assert.equal(result.value.draftKey, "draft-123");
});

testCase("prompt-video draft rejects malformed bodies and short prompts", () => {
  assert.equal(validatePromptVideoDraft(null).ok, false);
  assert.equal(validatePromptVideoDraft([]).ok, false);
  assert.equal(validatePromptVideoDraft({ ...valid, prompt: "short" }).ok, false);
});

testCase("prompt-video draft rejects unsupported networks and invalid keys", () => {
  assert.equal(validatePromptVideoDraft({ ...valid, network: "telegram" }).ok, false);
  assert.equal(validatePromptVideoDraft({ ...valid, draftKey: "" }).ok, false);
  assert.equal(validatePromptVideoDraft({ ...valid, draftKey: "x".repeat(101) }).ok, false);
});

testCase("prompt-video draft enforces prompt and caption limits", () => {
  assert.equal(validatePromptVideoDraft({ ...valid, prompt: "x".repeat(10001) }).ok, false);
  assert.equal(validatePromptVideoDraft({ ...valid, caption: "x".repeat(2201) }).ok, false);
  assert.equal(validatePromptVideoDraft({ ...valid, prompt: "x".repeat(10000) }).ok, true);
  assert.equal(validatePromptVideoDraft({ ...valid, caption: "x".repeat(2200) }).ok, true);
});
