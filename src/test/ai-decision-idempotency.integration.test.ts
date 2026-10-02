// /api/operator/ai-decision idempotency against the in-memory Supabase:
// concurrent requests, slow / failing LLM, abandoned reservations, takeover
// races, user isolation, evidence changes and the next-creative guard.
import { beforeEach, mock, test } from "node:test";
import assert from "node:assert/strict";
import { FakeSupabase } from "./fake-supabase";
import { DECISION_LEASE_TTL_MS, DECISION_ROUTE_MAX_DURATION_MS } from "../lib/decision/idempotency";
import { operatorRunReservationStore } from "../lib/decision/reservation-store";

let db = new FakeSupabase();

mock.module("../lib/billing.ts", {
  namedExports: {
    getAdminSupabase: () => db,
    getUserFromBearer: async (request: Request) => {
      const id = request.headers.get("x-test-user");
      return id ? { id } : null;
    },
    consumeMonthlyUsage: async () => ({ allowed: true }),
    refundMonthlyUsage: async () => ({ refunded: true }),
  },
});

process.env.EC_PULSE_API_KEY = "ecp-key";
process.env.EC_PULSE_API_URL = "https://ecp.test";
process.env.OPENAI_API_KEY = "sk-test";

const route = await import("../app/api/operator/ai-decision/route");
const { POST: nextCreative } = await import("../app/api/operator/next-creative/route");

const HOUR = 3600_000;
const iso = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type OpenAiMode = { delayMs: number; fail: boolean };
let openai: OpenAiMode;
let llmCalls = 0;

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  if (url.host === "ecp.test") {
    return new Response(JSON.stringify({ runs: [{ run_id: "r1", captured_at: "2026-09-30T00:00:00.000Z", comments_count: 200, top_pain: { pain: "すぐぬるくなる", count: 50, share_percent: 25 }, trend: { signal: "emerging_pain_detected", emerging_pains: [{ pain: "結露でカバンが濡れる", status: "rising", share_delta_percent: 4, current_count: 20, current_share_percent: 10 }] } }] }), { status: 200 });
  }
  if (url.host === "api.openai.com") {
    llmCalls += 1;
    if (openai.delayMs) await sleep(openai.delayMs);
    if (openai.fail) return new Response(JSON.stringify({ error: { message: "overloaded" } }), { status: 503 });
    const content = JSON.stringify({ hook: "結露ゼロで鞄も安心", angle: "結露でカバンが濡れる", description: "結露の悩みに切り替えて検証する" });
    return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });
  }
  return realFetch(input, init);
}) as typeof fetch;

const decide = (user = "u1", socialPostId = "p1") => route.POST(new Request("https://app.test/api/operator/ai-decision", {
  method: "POST",
  headers: { "content-type": "application/json", "x-test-user": user },
  body: JSON.stringify({ socialPostId }),
}));

function seedUser(user: string, postId: string) {
  db.seed("products", [{ id: `prod-${user}`, user_id: user, name: "保冷ボトル", url: "https://shop.test/bottle", price: 3000, cost: 1200 }]);
  db.seed("acquisition_plans", [{ id: `plan-${user}`, user_id: user, product_id: `prod-${user}`, target: "通勤する会社員", pain: "すぐぬるくなる", desire: "冷たいまま", value_proposition: "夕方まで氷が残る", angle: "すぐぬるくなる", hypothesis: "通勤者は保冷時間に反応する" }]);
  db.seed("creatives", [{ id: `c-${user}`, user_id: user, product_id: `prod-${user}`, plan_id: `plan-${user}`, title: "保冷ボトル", hook: "朝の氷、夕方まで", scenario: { angle: "すぐぬるくなる" } }]);
  db.seed("social_posts", [{
    id: postId, user_id: user, creative_id: `c-${user}`, network: "x", status: "published", external_post_id: `tw-${postId}`,
    caption: "朝の氷が夕方まで", published_at: iso(-48 * HOUR), metadata: { hypothesis: "通勤者は保冷時間に反応する" },
  }]);
  // Weak engagement on enough impressions -> PIVOT, which asks the LLM for new wording.
  db.seed("post_metrics", [{ id: `m-${postId}`, social_post_id: postId, impressions: 5000, likes: 10, comments: 1, shares: 0, raw: { source: "x" }, measured_at: iso(-HOUR) }]);
}

const verdictRuns = (user?: string) => db.table("operator_runs")
  .filter((r) => r.run_type === "ai_performance_verdict" && (!user || r.user_id === user));

beforeEach(() => {
  db = new FakeSupabase();
  openai = { delayMs: 0, fail: false };
  llmCalls = 0;
  seedUser("u1", "p1");
});

test("route maxDuration matches the constant the wait budget is derived from", () => {
  assert.equal(route.maxDuration * 1000, DECISION_ROUTE_MAX_DURATION_MS);
});

test("two simultaneous requests: one execution, one stored run, same runId and decision", async () => {
  openai.delayMs = 50;
  const [a, b] = await Promise.all([decide(), decide()]);
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  const [ja, jb] = [await a.json(), await b.json()];
  assert.equal(llmCalls, 1, "LLM called once");
  assert.equal(verdictRuns().length, 1, "one operator_runs row");
  assert.equal(ja.runId, jb.runId);
  assert.deepEqual(ja.decision, jb.decision);
  assert.equal(ja.verdict, "pivot");
  assert.equal(ja.aiConnected, true);
  assert.deepEqual([ja.reused === true, jb.reused === true].sort(), [false, true]);
  const row = verdictRuns()[0];
  assert.equal(row.status, "completed");
  assert.ok(row.completed_at);
  assert.equal(row.lease_expires_at, null);
});

test("slow LLM (>5s): the second request waits and reuses instead of failing early", async () => {
  openai.delayMs = 5_200;
  const started = Date.now();
  const [a, b] = await Promise.all([decide(), sleep(100).then(() => decide())]);
  assert.ok(Date.now() - started >= 5_000);
  assert.equal(a.status, 200);
  assert.equal(b.status, 200, JSON.stringify(await b.clone().json()));
  const [ja, jb] = [await a.json(), await b.json()];
  assert.equal(jb.reused, true);
  assert.equal(ja.runId, jb.runId);
  assert.deepEqual(ja.decision, jb.decision);
  assert.equal(llmCalls, 1);
  assert.equal(verdictRuns().length, 1);
});

test("abandoned reservation (crash / timeout) expires and is taken over by the next request", async () => {
  const first = await (await decide()).json();
  // Simulate a request that reserved the row and was killed mid-flight.
  const row = verdictRuns()[0];
  Object.assign(row, { status: "running", output: { state: "processing", holder: "dead-request" }, completed_at: null, lease_expires_at: iso(-1_000) });
  llmCalls = 0;

  const res = await decide();
  const body = await res.json();
  assert.equal(res.status, 200, JSON.stringify(body));
  assert.equal(body.runId, first.runId, "same row reused, not a duplicate");
  assert.equal(llmCalls, 1, "decision executed again");
  assert.equal(verdictRuns().length, 1);
  assert.equal(verdictRuns()[0].status, "completed");
  assert.ok((verdictRuns()[0].output as Record<string, unknown>).decision);
});

test("reservation from before the lease column (lease_expires_at null) also expires via started_at", async () => {
  const first = await (await decide()).json();
  Object.assign(verdictRuns()[0], { output: { state: "processing" }, completed_at: null, lease_expires_at: null, started_at: iso(-DECISION_LEASE_TTL_MS - 1_000) });
  llmCalls = 0;
  const body = await (await decide()).json();
  assert.equal(body.runId, first.runId);
  assert.equal(llmCalls, 1);
  assert.equal(verdictRuns().length, 1);
});

test("a live reservation is not stolen: requests wait for it instead", async () => {
  await decide();
  Object.assign(verdictRuns()[0], { output: { state: "processing", holder: "live-request" }, completed_at: null, lease_expires_at: iso(60_000) });
  llmCalls = 0;
  const pending = decide();
  await sleep(300);
  // The live holder finishes.
  Object.assign(verdictRuns()[0], { output: { verdict: "pivot", aiConnected: false, decision: { verdict: "pivot", next_action: { description: "held", generate_creative: true }, primary_metric: "CTR" } }, completed_at: iso(0), lease_expires_at: null });
  const res = await pending;
  const body = await res.json();
  assert.equal(res.status, 200, JSON.stringify(body));
  assert.equal(body.reused, true);
  assert.equal(body.nextAction, "held");
  assert.equal(llmCalls, 0);
});

test("two requests race to take over the same expired reservation: one executes, the other reuses", async () => {
  const first = await (await decide()).json();
  Object.assign(verdictRuns()[0], { output: { state: "processing", holder: "dead-request" }, completed_at: null, lease_expires_at: iso(-1_000) });
  llmCalls = 0;
  openai.delayMs = 50;
  const [a, b] = await Promise.all([decide(), decide()]);
  const [ja, jb] = [await a.json(), await b.json()];
  assert.equal(a.status, 200, JSON.stringify(ja));
  assert.equal(b.status, 200, JSON.stringify(jb));
  assert.equal(llmCalls, 1);
  assert.equal(ja.runId, first.runId);
  assert.equal(jb.runId, first.runId);
  assert.deepEqual(ja.decision, jb.decision);
  assert.equal(verdictRuns().length, 1);
});

test("expired reservations for an older input of the same post are cleaned up", async () => {
  db.seed("operator_runs", [{
    id: "stale", user_id: "u1", run_type: "ai_performance_verdict",
    input: { social_post_id: "p1", decision_key: "p1:old-input" }, output: { state: "processing" }, started_at: iso(-HOUR), lease_expires_at: iso(-HOUR),
  }]);
  await decide();
  assert.equal(verdictRuns().some((r) => r.id === "stale"), false);
  assert.equal(verdictRuns().length, 1);
});

test("LLM failure: the deterministic decision is returned but not locked in; the next call retries the LLM", async () => {
  openai.fail = true;
  const failedRes = await decide();
  const failed = await failedRes.json();
  assert.equal(failedRes.status, 200, "decision still made from deterministic logic");
  assert.equal(failed.verdict, "pivot");
  assert.equal(failed.aiConnected, false);
  assert.equal(failed.llmFailed, true);
  assert.equal(failed.retryable, true);
  assert.equal(llmCalls, 1);
  const fallbackRow = verdictRuns()[0];
  assert.equal((fallbackRow.input as Record<string, unknown>).decision_key, undefined, "key released");
  assert.ok((fallbackRow.input as Record<string, unknown>).released_decision_key);

  openai.fail = false;
  llmCalls = 0;
  const retried = await (await decide()).json();
  assert.equal(llmCalls, 1, "LLM ran again for the same input");
  assert.notEqual(retried.runId, failed.runId);
  assert.equal(retried.aiConnected, true);
  assert.equal(retried.llmFailed, undefined);
  assert.equal(retried.reused, undefined);

  llmCalls = 0;
  const reused = await (await decide()).json();
  assert.equal(reused.reused, true, "the successful decision is now the stored one");
  assert.equal(reused.runId, retried.runId);
  assert.equal(llmCalls, 0);
});

test("no OpenAI key is intentional deterministic mode: stored and reused, not retried", async () => {
  delete process.env.OPENAI_API_KEY;
  try {
    const first = await (await decide()).json();
    assert.equal(first.aiConnected, false);
    assert.equal(first.llmFailed, undefined);
    const second = await (await decide()).json();
    assert.equal(second.reused, true);
    assert.equal(second.runId, first.runId);
    assert.equal(llmCalls, 0);
  } finally {
    process.env.OPENAI_API_KEY = "sk-test";
  }
});

test("user A and user B with the same decision key do not collide", async () => {
  const input = { social_post_id: "shared", input_hash: "h" };
  const storeA = operatorRunReservationStore<{ decision: unknown }>(db as never, { userId: "uA", productId: null, socialPostId: "shared", input });
  const storeB = operatorRunReservationStore<{ decision: unknown }>(db as never, { userId: "uB", productId: null, socialPostId: "shared", input });
  const a1 = await storeA.reserve("key-X", "holder-a1");
  const a2 = await storeA.reserve("key-X", "holder-a2");
  const b1 = await storeB.reserve("key-X", "holder-b1");
  assert.equal(a1.status, "acquired");
  assert.equal(a2.status, "existing");
  assert.equal(a2.id, a1.id);
  assert.equal(b1.status, "acquired");
  assert.notEqual(b1.id, a1.id);
});

test("two users run their own decisions independently", async () => {
  seedUser("u2", "p2");
  const [a, b] = await Promise.all([decide("u1", "p1"), decide("u2", "p2")]);
  const [ja, jb] = [await a.json(), await b.json()];
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  assert.notEqual(ja.runId, jb.runId);
  assert.equal(llmCalls, 2);
  assert.equal(verdictRuns("u1").length, 1);
  assert.equal(verdictRuns("u2").length, 1);
});

test("changed evidence (product, history, lineage) never reuses the old decision", async () => {
  const first = await (await decide()).json();

  // Product data changes, metric id and EC-Pulse run stay the same.
  (db.table("products")[0] as Record<string, unknown>).price = 4500;
  const second = await (await decide()).json();
  assert.notEqual(second.runId, first.runId);
  assert.equal(second.reused, undefined);

  // A comparable post gets measured: history changes.
  db.seed("social_posts", [{ id: "hist1", user_id: "u1", network: "x", status: "published", published_at: iso(-72 * HOUR), metadata: {} }]);
  db.seed("post_metrics", [{ social_post_id: "hist1", impressions: 8000, likes: 300, comments: 20, shares: 10, raw: { source: "x" }, measured_at: iso(-2 * HOUR) }]);
  const third = await (await decide()).json();
  assert.notEqual(third.runId, second.runId);

  // Unchanged evidence: reused.
  const fourth = await (await decide()).json();
  assert.equal(fourth.reused, true);
  assert.equal(fourth.runId, third.runId);
  assert.equal(verdictRuns().length, 3);
  assert.equal(new Set(verdictRuns().map((r) => (r.input as Record<string, unknown>).decision_key)).size, 3);
});

const creativeRequest = () => nextCreative(new Request("https://app.test/api/operator/next-creative", {
  method: "POST",
  headers: { "content-type": "application/json", "x-test-user": "u1" },
  body: JSON.stringify({ socialPostId: "p1", verdict: "pivot", autoGenerate: false }),
}));

test("next-creative does not proceed while a decision for the post is still processing", async () => {
  db.seed("operator_runs", [{
    id: "older", user_id: "u1", run_type: "ai_performance_verdict", input: { social_post_id: "p1" },
    output: { verdict: "pivot" }, status: "completed", completed_at: iso(-HOUR), created_at: iso(-HOUR),
  }]);
  db.seed("operator_runs", [{
    id: "inflight", user_id: "u1", run_type: "ai_performance_verdict", input: { social_post_id: "p1", decision_key: "k" },
    output: { state: "processing", holder: "h" }, started_at: iso(0), lease_expires_at: iso(60_000),
  }]);
  const res = await creativeRequest();
  const body = await res.json();
  assert.equal(res.status, 409, JSON.stringify(body));
  assert.equal(body.code, "decision_in_progress");
  assert.equal(body.retryable, true);
  assert.equal(db.table("social_posts").length, 1, "no creative generated");
});

test("next-creative: an abandoned reservation does not hide the latest STOP verdict", async () => {
  db.seed("operator_runs", [{
    id: "stop", user_id: "u1", run_type: "ai_performance_verdict", input: { social_post_id: "p1" },
    output: { verdict: "stop" }, status: "completed", completed_at: iso(-HOUR), created_at: iso(-HOUR),
  }]);
  db.seed("operator_runs", [{
    id: "dead", user_id: "u1", run_type: "ai_performance_verdict", input: { social_post_id: "p1", decision_key: "k" },
    output: { state: "processing", holder: "h" }, started_at: iso(-HOUR), lease_expires_at: iso(-HOUR + DECISION_LEASE_TTL_MS),
  }]);
  const res = await creativeRequest();
  const body = await res.json();
  assert.equal(res.status, 409);
  assert.equal(body.verdict, "stop");
  assert.equal(body.decisionRunId, "stop");
});
