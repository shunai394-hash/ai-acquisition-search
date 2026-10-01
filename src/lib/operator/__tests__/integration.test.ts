import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeDb } from "./fake-db";
import { decideForPost } from "../decide";
import { acquireLease } from "../lease";
import { runBacktest } from "../backtest";
import { ecPulseRequest, fetchMarketSignals } from "@/lib/ec-pulse/client";
import { marketFactsFromSignals } from "../evidence";
import { isAuthorizedCron } from "@/lib/security/cron-auth";
import { makeContext, manualRow } from "./fixtures";

const USER = "user-1";

function seed(rows: Array<Record<string, unknown>>, postMeta: Record<string, unknown> = {}) {
  return new FakeDb({
    social_posts: [{ id: "post-1", user_id: USER, creative_id: "cr-1", network: "x", caption: "hook", status: "published", external_post_id: "ext", published_at: "2026-09-01T00:00:00Z", metadata: postMeta }],
    creatives: [{ id: "cr-1", user_id: USER, product_id: "prod-1", plan_id: "plan-1", title: "保温ボトル", hook: "朝のコーヒーが昼まで熱い", variation: "A", scenario: { test_metric: "CTR" } }],
    products: [{ id: "prod-1", user_id: USER, name: "保温ボトル", url: "https://shop.example.com/bottle", price: 3000, cost: 1200 }],
    acquisition_plans: [{ id: "plan-1", user_id: USER, target: "通勤する会社員", pain: "冷める", desire: "温かい", value_proposition: "12時間保温", channel: "x", format: "video", hypothesis: "保温時間を示すと買う" }],
    post_metrics: rows.map((r, i) => ({ id: `pm-${i}`, social_post_id: "post-1", ...r })),
    operator_runs: [],
  }, { operator_runs: [["user_id", "run_type", "input->>idempotency_key"]], operator_leases: [["name"]] });
}

const noEcPulse = (async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch;

test("decision is saved once and reused for the same input (duplicate request)", async () => {
  delete process.env.OPENAI_API_KEY;
  process.env.EC_PULSE_API_KEY = "k";
  const db = seed([manualRow({ impressions: 5000, clicks: 200 }, "2026-09-02T00:00:00Z")]);
  const first = await decideForPost(db.asClient(), { userId: USER, socialPostId: "post-1", fetchImpl: noEcPulse });
  const second = await decideForPost(db.asClient(), { userId: USER, socialPostId: "post-1", fetchImpl: noEcPulse });
  assert.ok(first.ok && second.ok);
  if (!first.ok || !second.ok) return;
  assert.equal(first.reused, false);
  assert.equal(second.reused, true);
  assert.equal(first.runId, second.runId);
  assert.equal(db.tables.operator_runs.length, 1);
  assert.equal(first.decision.verdict, "continue");
  const meta = db.tables.social_posts[0].metadata as Record<string, unknown>;
  assert.equal(meta.operator_patrol_status, "active");
});

test("concurrent decisions for the same post store a single run", async () => {
  process.env.EC_PULSE_API_KEY = "k";
  const db = seed([manualRow({ impressions: 5000, clicks: 200 }, "2026-09-02T00:00:00Z")]);
  const results = await Promise.all([1, 2, 3].map(() => decideForPost(db.asClient(), { userId: USER, socialPostId: "post-1", fetchImpl: noEcPulse })));
  assert.ok(results.every((r) => r.ok));
  assert.equal(db.tables.operator_runs.length, 1);
  assert.equal(new Set(results.map((r) => (r.ok ? r.runId : ""))).size, 1);
});

test("EC-Pulse outage does not break the decision; it is recorded as missing market evidence", async () => {
  process.env.EC_PULSE_API_KEY = "k";
  const db = seed([manualRow({ impressions: 5000, clicks: 200 }, "2026-09-02T00:00:00Z")]);
  const r = await decideForPost(db.asClient(), { userId: USER, socialPostId: "post-1", fetchImpl: noEcPulse });
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.equal(r.context.market.connected, false);
  assert.match(r.context.market.error ?? "", /ECONNREFUSED/);
  assert.ok(r.decision.evidence_coverage.missing.includes("market"));
});

test("STOP marks the post stopped so the loop stops re-processing it", async () => {
  process.env.EC_PULSE_API_KEY = "k";
  const db = seed(
    [manualRow({ impressions: 20000, clicks: 300, conversions: 0, revenue: 0, ad_spend: 30000, gross_profit: 0 }, "2026-09-04T00:00:00Z")],
    { source_social_post_id: "p0", operator_verdict: "pivot" },
  );
  db.tables.social_posts.push(
    { id: "p0", user_id: USER, network: "x", metadata: { source_social_post_id: "pp", operator_verdict: "pivot" } },
    { id: "pp", user_id: USER, network: "x", metadata: {} },
  );
  const r = await decideForPost(db.asClient(), { userId: USER, socialPostId: "post-1", fetchImpl: noEcPulse });
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.equal(r.context.pivotStreak, 2);
  assert.equal(r.decision.verdict, "stop");
  assert.equal((db.tables.social_posts[0].metadata as Record<string, unknown>).operator_patrol_status, "stopped");
});

test("missing post / missing metrics return explicit errors", async () => {
  const db = seed([]);
  const none = await decideForPost(db.asClient(), { userId: USER, socialPostId: "nope", fetchImpl: noEcPulse });
  assert.deepEqual(none, { ok: false, status: 404, error: "対象投稿が見つかりません。" });
  const noMetrics = await decideForPost(db.asClient(), { userId: USER, socialPostId: "post-1", fetchImpl: noEcPulse });
  assert.equal(noMetrics.ok, false);
  if (!noMetrics.ok) assert.equal(noMetrics.status, 400);
});

test("run lease: only one concurrent holder; expired lease can be taken over; missing table degrades", async () => {
  const db = new FakeDb({}, { operator_leases: [["name"]] });
  const [a, b] = await Promise.all([acquireLease(db.asClient(), "operator-loop", 60), acquireLease(db.asClient(), "operator-loop", 60)]);
  assert.equal([a.acquired, b.acquired].filter(Boolean).length, 1);
  const winner = a.acquired ? a : b;
  if (winner.acquired) await winner.release();
  const c = await acquireLease(db.asClient(), "operator-loop", 60);
  assert.equal(c.acquired, true);

  db.tables.operator_leases[0].expires_at = "2000-01-01T00:00:00Z";
  const d = await acquireLease(db.asClient(), "operator-loop", 60);
  assert.equal(d.acquired, true);

  const legacy = new FakeDb();
  legacy.missingTables.add("operator_leases");
  const e = await acquireLease(legacy.asClient(), "operator-loop", 60);
  assert.equal(e.acquired, true);
  if (e.acquired) assert.equal(e.enforced, false);
});

test("EC-Pulse client: missing key, HTTP error and timeout are returned, not thrown", async () => {
  delete process.env.EC_PULSE_API_KEY;
  const noKey = await ecPulseRequest("/v1/monitors");
  assert.equal(noKey.ok, false);
  if (!noKey.ok) assert.equal(noKey.configured, false);

  process.env.EC_PULSE_API_KEY = "k";
  const http503 = await ecPulseRequest("/v1/monitors", {}, (async () => new Response(JSON.stringify({ detail: "DATABASE_URL is not configured" }), { status: 503 })) as unknown as typeof fetch);
  assert.equal(http503.ok, false);
  if (!http503.ok) assert.match(http503.error, /DATABASE_URL/);

  const hang = ((_u: string, init: RequestInit) => new Promise((_, reject) => init.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }))))) as unknown as typeof fetch;
  const timeout = await ecPulseRequest("/v1/monitors", { timeoutMs: 20 }, hang);
  assert.equal(timeout.ok, false);
  if (!timeout.ok) assert.match(timeout.error, /タイムアウト/);
});

test("market evidence excludes research captured after the decision time (no leakage)", async () => {
  process.env.EC_PULSE_API_KEY = "k";
  const fake = (async (url: string) => {
    if (url.includes("/v1/research/runs")) {
      return new Response(JSON.stringify({ runs: [
        { run_id: "old", url: "u", captured_at: "2026-08-01T00:00:00Z", top_pain: { pain: "重い", count: 3, share_percent: 30 }, trend: { signal: "no_previous_run", emerging_pains: [] } },
        { run_id: "future", url: "u", captured_at: "2026-12-01T00:00:00Z", top_pain: { pain: "未来", count: 3, share_percent: 30 }, trend: { signal: "x", emerging_pains: [] } },
      ] }), { status: 200 });
    }
    return new Response(JSON.stringify({ monitors: [{ id: "m", url: "u", last_price: 2000, last_checked_at: "2026-12-01T00:00:00Z", created_at: "2026-08-01T00:00:00Z" }] }), { status: 200 });
  }) as unknown as typeof fetch;
  const signals = await fetchMarketSignals("u", fake);
  const facts = marketFactsFromSignals(signals, "u", "2026-09-01T00:00:00Z");
  assert.deepEqual(facts.runs.map((r) => r.runId), ["old"]);
  assert.equal(facts.price.lastPrice, null, "price observed after asOf is not used");
});

test("cron auth tolerates surrounding whitespace in CRON_SECRET but never disables auth", () => {
  const req = (h?: string) => new Request("https://x/api/cron/operator-loop", { headers: h ? { authorization: h } : {} });
  process.env.CRON_SECRET = "s3cret\n";
  assert.equal(isAuthorizedCron(req("Bearer s3cret")), true);
  assert.equal(isAuthorizedCron(req("Bearer wrong")), false);
  assert.equal(isAuthorizedCron(req()), false);
  delete process.env.CRON_SECRET;
  assert.equal(isAuthorizedCron(req("Bearer ")), false);
  assert.equal(isAuthorizedCron(req("Bearer s3cret")), false);
});

test("backtest metrics: leakage is rejected, false STOP / unnecessary PIVOT are counted", () => {
  const losing = [manualRow({ impressions: 20000, clicks: 300, conversions: 0, revenue: 0, ad_spend: 30000, gross_profit: 0 }, "2026-09-03T00:00:00Z")];
  const winningLater = [...losing, manualRow({ impressions: 40000, clicks: 900, conversions: 30, revenue: 150000, ad_spend: 40000, gross_profit: 90000 }, "2026-09-10T00:00:00Z")];
  const report = runBacktest([
    { postId: "a", lineageKey: "L", atDecision: makeContext({ rows: losing, pivotStreak: 2 }), hindsight: makeContext({ rows: winningLater, asOf: "2026-09-11T00:00:00Z", pivotStreak: 2 }) },
    { postId: "b", lineageKey: "L2", atDecision: makeContext({ rows: losing, pivotStreak: 0 }), hindsight: makeContext({ rows: winningLater, asOf: "2026-09-11T00:00:00Z" }) },
    { postId: "leak", lineageKey: "L3", atDecision: makeContext({ rows: winningLater, asOf: "2026-09-05T00:00:00Z" }), hindsight: makeContext({ rows: winningLater }) },
  ]);
  assert.equal(report.leakageViolations, 1);
  assert.equal(report.episodes, 2);
  assert.equal(report.falseStop, 1);
  assert.equal(report.unnecessaryPivot, 1);
  assert.equal(report.decisionConsistency, 1);
});
