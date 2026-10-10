import assert from "node:assert/strict";
import { mock, test } from "node:test";

mock.module("../billing.ts", {
  namedExports: {
    refundMonthlyUsage: async () => ({ refunded: true }),
  },
});

const { providerJobTimeoutMs, redactSensitiveText } = await import("./job-recovery");

test("provider timeout uses a finite default when configuration is malformed", () => {
  assert.equal(providerJobTimeoutMs(undefined), 180 * 60_000);
  assert.equal(providerJobTimeoutMs(""), 180 * 60_000);
  assert.equal(providerJobTimeoutMs("not-a-number"), 180 * 60_000);
});

test("stored provider payloads drop signed URLs", () => {
  const redacted = redactSensitiveText({
    status: "completed",
    video: { url: "https://cdn.example/video.mp4?token=secret" },
  }) as { video: { url: string } };
  assert.equal(redacted.video.url, "[url]");
  assert.equal(JSON.stringify(redacted).includes("token=secret"), false);
});

test("provider timeout clamps configuration to safe operational bounds", () => {
  assert.equal(providerJobTimeoutMs("10"), 30 * 60_000);
  assert.equal(providerJobTimeoutMs("45"), 45 * 60_000);
  assert.equal(providerJobTimeoutMs("99999"), 24 * 60 * 60_000);
});
