import assert from "node:assert/strict";
import { mock, test } from "node:test";

let fakeNow = 10_000;

mock.module("../lib/billing.ts", {
  namedExports: {
    getAdminSupabase: () => ({
      from: () => ({
        select: () => ({
          limit: async () => ({ error: null }),
        }),
      }),
      storage: {
        getBucket: async () => ({ data: { public: false }, error: null }),
      },
    }),
  },
});

mock.module("../lib/ec-pulse/client.ts", {
  namedExports: {
    ecPulseConfig: () => ({
      url: "https://ec-pulse.example",
      explicitUrl: true,
      pinnedDeployment: false,
      configured: true,
    }),
    ecPulseFetch: async () => {
      fakeNow += 42;
      return new Response(JSON.stringify({ database: "ok" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  },
});

mock.module("../lib/security/cron-auth.ts", {
  namedExports: {
    cronSecret: () => "test-secret",
    verifyCronRequest: () => ({ ok: true }),
  },
});

mock.module("../lib/decision/engine.ts", {
  namedExports: { DECISION_LOGIC_VERSION: "decision-test" },
});

const { GET } = await import("../app/api/health/route");

test("authenticated health check reports elapsed dependency time", async () => {
  const originalNow = Date.now;
  Date.now = () => fakeNow;
  try {
    const response = await GET(new Request("https://app.test/api/health", {
      headers: { authorization: "Bearer test-secret" },
    }));
    assert.equal(response.status, 200);
    const body = await response.json() as {
      checks: { ecPulse: { ok: boolean; ms: number } };
    };
    assert.equal(body.checks.ecPulse.ok, true);
    assert.equal(body.checks.ecPulse.ms, 42);
  } finally {
    Date.now = originalNow;
  }
});
