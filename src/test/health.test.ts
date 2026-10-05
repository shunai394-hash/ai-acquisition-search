import assert from "node:assert/strict";
import { mock, test } from "node:test";

mock.module("../lib/billing.ts", {
  namedExports: {
    getAdminSupabase: () => {
      throw new Error("public health probe must not access the database");
    },
  },
});

mock.module("../lib/ec-pulse/client.ts", {
  namedExports: {
    ecPulseConfig: () => {
      throw new Error("public health probe must not access EC-Pulse");
    },
    ecPulseFetch: async () => {
      throw new Error("public health probe must not call EC-Pulse");
    },
  },
});

process.env.VERCEL_GIT_COMMIT_SHA = "test-commit";
delete process.env.CRON_SECRET;

const { GET } = await import("../app/api/health/route");

test("public health probe is lightweight and does not fan out to dependencies", async () => {
  const response = await GET(new Request("https://app.test/api/health"));
  assert.equal(response.status, 200);
  const body = await response.json() as { ok: boolean; status: string; commit: string; logicVersion: string; checkedAt: string };
  assert.equal(body.ok, true);
  assert.equal(body.status, "alive");
  assert.equal(body.commit, "test-commit");
  assert.match(body.logicVersion, /^decision-/);
  assert.doesNotThrow(() => new Date(body.checkedAt).toISOString());
});
