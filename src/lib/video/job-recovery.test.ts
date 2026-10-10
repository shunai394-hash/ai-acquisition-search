import assert from "node:assert/strict";
import { mock, test } from "node:test";

mock.module("../billing.ts", {
  namedExports: {
    refundMonthlyUsage: async () => ({ refunded: true }),
  },
});

const { providerJobTimeoutMs } = await import("./job-recovery");

test("provider timeout uses a finite default when configuration is malformed", () => {
  assert.equal(providerJobTimeoutMs(undefined), 180 * 60_000);
  assert.equal(providerJobTimeoutMs(""), 180 * 60_000);
  assert.equal(providerJobTimeoutMs("not-a-number"), 180 * 60_000);
});

test("provider timeout clamps configuration to safe operational bounds", () => {
  assert.equal(providerJobTimeoutMs("10"), 30 * 60_000);
  assert.equal(providerJobTimeoutMs("45"), 45 * 60_000);
  assert.equal(providerJobTimeoutMs("99999"), 24 * 60 * 60_000);
});
