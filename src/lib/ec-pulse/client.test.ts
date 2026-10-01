import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { ecPulseConfig, loadMarketEvidence } from "./client";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

const runs = {
  runs: [
    { run_id: "future", captured_at: "2026-10-05T00:00:00Z", comments_count: 9, top_pain: { pain: "未来の痛点", count: 9, share_percent: 50 }, trend: { signal: "x", emerging_pains: [] } },
    { run_id: "past", captured_at: "2026-09-20T00:00:00Z", comments_count: 300, top_pain: { pain: "すぐぬるくなる", count: 60, share_percent: 20 }, trend: { signal: "emerging_pain_detected", emerging_pains: [{ pain: "結露", status: "rising", share_delta_percent: 2.5, current_count: 30, current_share_percent: 10 }] } },
  ],
};

test("only research captured before asOf is used", async () => {
  process.env.EC_PULSE_API_KEY = "k";
  globalThis.fetch = (async () => new Response(JSON.stringify(runs), { status: 200 })) as typeof fetch;
  const m = await loadMarketEvidence("https://example.com/p", "2026-10-01T00:00:00Z");
  assert.equal(m.status, "ok");
  assert.equal(m.runId, "past");
  assert.deepEqual(m.topPains.map((p) => p.pain), ["すぐぬるくなる", "結露"]);
  assert.equal(m.emergingPains[0].pain, "結露");
});

test("EC-Pulse outage degrades to unavailable instead of throwing", async () => {
  process.env.EC_PULSE_API_KEY = "k";
  globalThis.fetch = (async () => { throw new TypeError("fetch failed"); }) as typeof fetch;
  assert.equal((await loadMarketEvidence("https://example.com/p", "2026-10-01T00:00:00Z")).status, "unavailable");
  globalThis.fetch = (async () => new Response(JSON.stringify({ detail: { database: "unavailable" } }), { status: 503 })) as typeof fetch;
  const m = await loadMarketEvidence("https://example.com/p", "2026-10-01T00:00:00Z");
  assert.equal(m.status, "unavailable");
  assert.equal(m.error, "HTTP 503");
});

test("missing key / product URL are reported, not thrown", async () => {
  delete process.env.EC_PULSE_API_KEY;
  assert.equal((await loadMarketEvidence("https://example.com/p", "2026-10-01T00:00:00Z")).status, "not_configured");
  assert.equal((await loadMarketEvidence(null, "2026-10-01T00:00:00Z")).status, "no_data");
});

test("pinned deployment URL is detected", () => {
  delete process.env.EC_PULSE_API_URL;
  assert.equal(ecPulseConfig().pinnedDeployment, true);
  process.env.EC_PULSE_API_URL = "https://ec-pulse.example.com/";
  assert.equal(ecPulseConfig().pinnedDeployment, false);
  assert.equal(ecPulseConfig().url, "https://ec-pulse.example.com");
  delete process.env.EC_PULSE_API_URL;
});
