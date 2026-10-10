import assert from "node:assert/strict";
import test from "node:test";
import { forgetJob, parseStoredJobId, rememberJob, userFacingClientError } from "@/lib/video/studio-session";

test("only well-formed job ids are restored from storage", () => {
  const id = "11111111-1111-4111-8111-111111111111";
  assert.equal(parseStoredJobId(JSON.stringify({ jobId: id })), id);
  assert.equal(parseStoredJobId(JSON.stringify({ jobId: "../other" })), "");
  assert.equal(parseStoredJobId("not-json"), "");
  assert.equal(parseStoredJobId(null), "");
});

test("job ids are remembered and forgotten without writing invalid values", () => {
  const saved = new Map<string, string>();
  const storage = {
    setItem(key: string, value: string) { saved.set(key, value); },
    removeItem(key: string) { saved.delete(key); },
  };
  rememberJob(storage, "studio", "not-a-uuid");
  assert.equal(saved.has("studio"), false);
  rememberJob(storage, "studio", "11111111-1111-4111-8111-111111111111");
  assert.equal(parseStoredJobId(saved.get("studio") ?? null), "11111111-1111-4111-8111-111111111111");
  forgetJob(storage, "studio");
  assert.equal(saved.has("studio"), false);
});

test("network failures become a recoverable client message", () => {
  assert.match(userFacingClientError(new TypeError("Failed to fetch"), "fallback"), /ネットワーク/);
  assert.equal(userFacingClientError(new Error("利用枠がありません。"), "fallback"), "利用枠がありません。");
  assert.equal(userFacingClientError("nope", "fallback"), "fallback");
});
