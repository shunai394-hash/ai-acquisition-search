// Integration tests: real route handlers (metrics -> ai-decision -> next-creative
// -> operator-loop) against an in-memory Supabase, with SNS / EC-Pulse /
// Higgsfield / OpenAI replaced by fetch stubs.
import { beforeEach, mock, test } from "node:test";
import assert from "node:assert/strict";
import { FakeSupabase } from "./fake-supabase";
import { secretMatches } from "../lib/security/cron-auth";

let db = new FakeSupabase();

mock.module("../lib/billing.ts", {
  namedExports: {
    getAdminSupabase: () => db,
    getUserFromBearer: async (request: Request) => {
      const id = request.headers.get("x-internal-user-id");
      return id && secretMatches(request.headers.get("x-internal-secret")) ? { id } : null;
    },
    consumeMonthlyUsage: async () => ({ allowed: true }),
    refundMonthlyUsage: async () => ({ refunded: true }),
  },
});

process.env.CRON_SECRET = "cron-secret\n";
process.env.VERCEL_PROJECT_PRODUCTION_URL = "app.test";
process.env.X_ACCESS_TOKEN = "x-token";
process.env.HF_API_KEY_ID = "hf-id";
process.env.HF_API_KEY_SECRET = "hf-secret";
process.env.EC_PULSE_API_KEY = "ecp-key";
process.env.EC_PULSE_API_URL = "https://ecp.test";
delete process.env.OPENAI_API_KEY;

const { GET: operatorLoop } = await import("../app/api/cron/operator-loop/route");
const { POST: socialMetrics } = await import("../app/api/social/metrics/route");
const { POST: aiDecision } = await import("../app/api/operator/ai-decision/route");
const { POST: nextCreative } = await import("../app/api/operator/next-creative/route");
const { GET: videoJob } = await import("../app/api/video/jobs/[id]/route");

const HOUR = 3600_000;
const iso = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();

type Stub = {
  tweet: { status: number; metrics?: Record<string, number> };
  ecPulse: { status: number } | "down";
  higgsfieldCalls: number;
  openai: "absent" | "down";
};
let stub: Stub;

const routes: Record<string, (req: Request) => Promise<Response>> = {
  "POST /api/social/metrics": socialMetrics,
  "POST /api/operator/ai-decision": aiDecision,
  "POST /api/operator/next-creative": nextCreative,
};

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  const method = (init?.method || "GET").toUpperCase();
  if (url.host === "app.test") {
    const request = new Request(url, init);
    if (url.pathname.startsWith("/api/video/jobs/")) {
      return videoJob(request, { params: Promise.resolve({ id: url.pathname.split("/").pop() as string }) } as never);
    }
    const handler = routes[`${method} ${url.pathname}`];
    if (!handler) return new Response(JSON.stringify({ error: "no route" }), { status: 404 });
    return handler(request);
  }
  if (url.host === "api.x.com") {
    if (stub.tweet.status !== 200) return new Response(JSON.stringify({ detail: "X down" }), { status: stub.tweet.status });
    const id = url.pathname.split("/").pop();
    return new Response(JSON.stringify({ data: { id, text: "t", public_metrics: stub.tweet.metrics } }), { status: 200 });
  }
  if (url.host === "ecp.test") {
    if (stub.ecPulse === "down") throw new TypeError("fetch failed");
    if (stub.ecPulse.status !== 200) return new Response(JSON.stringify({ detail: "db unavailable" }), { status: stub.ecPulse.status });
    return new Response(JSON.stringify({ runs: [{ run_id: "r1", captured_at: "2026-09-30T00:00:00.000Z", comments_count: 200, top_pain: { pain: "すぐぬるくなる", count: 50, share_percent: 25 }, trend: { signal: "emerging_pain_detected", emerging_pains: [{ pain: "結露でカバンが濡れる", status: "rising", share_delta_percent: 4, current_count: 20, current_share_percent: 10 }] } }] }), { status: 200 });
  }
  if (url.host === "api.higgsfield.ai") {
    stub.higgsfieldCalls++;
    return new Response(JSON.stringify({ request_id: `hf-${stub.higgsfieldCalls}`, status: "queued" }), { status: 200 });
  }
  if (url.host === "api.openai.com") {
    throw new TypeError("OpenAI unreachable");
  }
  return realFetch(input, init);
}) as typeof fetch;

const cronRequest = (secret = "cron-secret") => new Request("https://app.test/api/cron/operator-loop", { headers: { authorization: `Bearer ${secret}` } });
const internal = (path: string, body: Record<string, unknown>) => new Request(`https://app.test${path}`, {
  method: "POST",
  headers: { "content-type": "application/json", "x-internal-secret": "cron-secret", "x-internal-user-id": "u1" },
  body: JSON.stringify(body),
});

function seedPost(id: string, opts: { publishedAgoMs?: number; metadata?: Record<string, unknown> } = {}) {
  db.seed("social_posts", [{
    id, user_id: "u1", creative_id: "c1", network: "x", status: "published", external_post_id: `tw-${id}`,
    caption: "朝の氷が夕方まで", published_at: iso(-(opts.publishedAgoMs ?? 48 * HOUR)), metadata: opts.metadata ?? { hypothesis: "通勤者は保冷時間に反応する" },
  }]);
}

beforeEach(() => {
  db = new FakeSupabase();
  stub = { tweet: { status: 200, metrics: { impression_count: 5000, like_count: 10, reply_count: 1, retweet_count: 0 } }, ecPulse: { status: 200 }, higgsfieldCalls: 0, openai: "absent" };
  delete process.env.OPENAI_API_KEY;
  db.seed("products", [{ id: "prod1", user_id: "u1", name: "保冷ボトル", url: "https://shop.test/bottle", price: 3000, cost: 1200 }]);
  db.seed("acquisition_plans", [{ id: "plan1", user_id: "u1", product_id: "prod1", target: "通勤する会社員", pain: "すぐぬるくなる", desire: "冷たいまま", value_proposition: "夕方まで氷が残る", angle: "すぐぬるくなる", hypothesis: "通勤者は保冷時間に反応する" }]);
  db.seed("creatives", [{ id: "c1", user_id: "u1", product_id: "prod1", plan_id: "plan1", title: "保冷ボトル", hook: "朝の氷、夕方まで", scenario: { angle: "すぐぬるくなる" } }]);
});

test("cron without the right secret is rejected with a reason (auth is never disabled)", async () => {
  const res = await operatorLoop(cronRequest("wrong"));
  assert.equal(res.status, 401);
  assert.equal((await res.json()).reason, "authorization_mismatch");
});

test("full loop: SNS metrics -> Results -> Teacher PIVOT -> next creative -> video job", async () => {
  seedPost("p1");
  const res = await operatorLoop(cronRequest());
  const body = await res.json();
  assert.equal(res.status, 200, JSON.stringify(body));
  const r = body.results.find((x: { postId?: string }) => x.postId === "p1");
  assert.equal(r.verdict, "pivot", JSON.stringify(body.results));
  assert.equal(r.nextCreative, true);

  assert.equal(db.table("post_metrics").length, 1);
  const run = db.table("operator_runs").find((x) => x.run_type === "ai_performance_verdict") as { output: { decision: Record<string, unknown> } };
  const d = run.output.decision as { action_type: string; evidence: Array<{ source: string; key: string; value: unknown }>; next_action: { angle: string }; logic_version: string; model_version: string };
  assert.equal(d.action_type, "pivot_hypothesis");
  assert.ok(d.logic_version && d.model_version === "deterministic");
  assert.ok(d.evidence.some((e) => e.source === "ec_pulse" && e.key === "status" && e.value === "ok"));
  assert.ok(d.evidence.some((e) => e.source === "product" && e.key === "gross_margin_rate"));
  assert.equal(d.next_action.angle, "結露でカバンが濡れる", "pivot angle comes from EC-Pulse");

  const child = db.table("social_posts").find((x) => (x.metadata as Record<string, unknown>)?.source_social_post_id === "p1");
  assert.ok(child, "next post created");
  assert.equal((child!.metadata as Record<string, unknown>).operator_decision_run_id, (run as unknown as { id: string }).id);
  const job = db.table("production_jobs")[0];
  assert.equal(job.status, "running");
  assert.equal(job.request_id, "hf-1");
  assert.equal(stub.higgsfieldCalls, 1);
});

test("two concurrent cron runs: one is skipped, nothing is duplicated", async () => {
  seedPost("p1");
  const [a, b] = await Promise.all([operatorLoop(cronRequest()), operatorLoop(cronRequest())]);
  const bodies = [await a.json(), await b.json()];
  assert.equal(bodies.filter((x) => x.skipped).length, 1, JSON.stringify(bodies));
  assert.equal(db.table("post_metrics").length, 1);
  assert.equal(db.table("operator_runs").filter((x) => x.run_type === "ai_performance_verdict").length, 1);
  assert.equal(db.table("social_posts").length, 2);
  assert.equal(db.table("production_jobs").length, 1);
  assert.equal(stub.higgsfieldCalls, 1);
  assert.equal(db.table("operator_leases").length, 0, "lease released");
});

test("duplicate ai-decision requests reuse one stored decision; duplicate next-creative reuses one creative", async () => {
  seedPost("p1");
  db.seed("post_metrics", [{ social_post_id: "p1", impressions: 5000, likes: 10, comments: 1, shares: 0, raw: { source: "x" }, measured_at: iso(-HOUR) }]);
  const [a, b] = await Promise.all([aiDecision(internal("/api/operator/ai-decision", { socialPostId: "p1" })), aiDecision(internal("/api/operator/ai-decision", { socialPostId: "p1" }))]);
  const [ja, jb] = [await a.json(), await b.json()];
  assert.equal(ja.verdict, jb.verdict);
  assert.equal(ja.runId, jb.runId);
  assert.equal(db.table("operator_runs").filter((x) => x.run_type === "ai_performance_verdict").length, 1);

  const [n1, n2] = await Promise.all([
    nextCreative(internal("/api/operator/next-creative", { socialPostId: "p1", verdict: ja.verdict, autoGenerate: false })),
    nextCreative(internal("/api/operator/next-creative", { socialPostId: "p1", verdict: ja.verdict, autoGenerate: false })),
  ]);
  assert.deepEqual([n1.status, n2.status].sort(), [201, 202]);
  assert.equal(db.table("creatives").length, 2);
  const again = await (await nextCreative(internal("/api/operator/next-creative", { socialPostId: "p1", verdict: ja.verdict, autoGenerate: false }))).json();
  assert.equal(again.reused, true);
  assert.equal(db.table("creatives").length, 2);
});

test("WAIT (insufficient data): no creative, no video", async () => {
  seedPost("p1");
  stub.tweet.metrics = { impression_count: 80, like_count: 1, reply_count: 0, retweet_count: 0 };
  const body = await (await operatorLoop(cronRequest())).json();
  const r = body.results.find((x: { postId?: string }) => x.postId === "p1");
  assert.equal(r.verdict, "wait");
  assert.equal(r.nextCreative, false);
  assert.equal(db.table("social_posts").length, 1);
  assert.equal(stub.higgsfieldCalls, 0);
});

test("STOP after repeated poor results: no creative, and next-creative refuses even if the client says PIVOT", async () => {
  // Lineage p0 <- pa <- pb <- pc <- p1, each previously judged PIVOT.
  const chain = ["p0", "pa", "pb", "pc"];
  chain.forEach((id, i) => {
    seedPost(id, { publishedAgoMs: (30 - i) * 24 * HOUR, metadata: i ? { source_social_post_id: chain[i - 1] } : {} });
    db.seed("operator_runs", [{ user_id: "u1", run_type: "ai_performance_verdict", input: { social_post_id: id }, output: { verdict: "pivot" }, completed_at: iso(-(20 - i) * 24 * HOUR) }]);
  });
  seedPost("p1", { metadata: { source_social_post_id: "pc" } });
  // Old posts already have fresh metrics so only p1 is processed.
  for (const id of chain) db.seed("post_metrics", [{ social_post_id: id, impressions: 5000, likes: 10, raw: { source: "x" }, measured_at: iso(-HOUR) }]);

  const body = await (await operatorLoop(cronRequest())).json();
  const r = body.results.find((x: { postId?: string }) => x.postId === "p1");
  assert.equal(r.verdict, "stop", JSON.stringify(body.results));
  assert.equal(r.nextCreative, false);
  assert.equal(db.table("social_posts").filter((x) => (x.metadata as Record<string, unknown>)?.source_social_post_id === "p1").length, 0);
  assert.equal(stub.higgsfieldCalls, 0);

  const forced = await nextCreative(internal("/api/operator/next-creative", { socialPostId: "p1", verdict: "pivot" }));
  assert.equal(forced.status, 409);
  assert.equal((await forced.json()).verdict, "stop");
});

test("CONTINUE keeps the angle and only changes the hook", async () => {
  seedPost("p1");
  stub.tweet.metrics = { impression_count: 5000, like_count: 400, reply_count: 60, retweet_count: 80 };
  const body = await (await operatorLoop(cronRequest())).json();
  const r = body.results.find((x: { postId?: string }) => x.postId === "p1");
  assert.equal(r.verdict, "continue");
  const child = db.table("social_posts").find((x) => (x.metadata as Record<string, unknown>)?.source_social_post_id === "p1");
  assert.equal((child!.metadata as Record<string, unknown>).iteration_angle, "すぐぬるくなる");
});

test("EC-Pulse down / AI API down: decision still made from remaining evidence", async () => {
  seedPost("p1");
  stub.ecPulse = "down";
  process.env.OPENAI_API_KEY = "sk-test";
  const body = await (await operatorLoop(cronRequest())).json();
  const r = body.results.find((x: { postId?: string }) => x.postId === "p1");
  assert.equal(r.verdict, "pivot");
  const run = db.table("operator_runs").find((x) => x.run_type === "ai_performance_verdict") as { output: { aiConnected: boolean; decision: { evidence: Array<{ source: string; value: unknown }> } } };
  assert.equal(run.output.aiConnected, false);
  assert.ok(run.output.decision.evidence.some((e) => e.source === "ec_pulse" && e.value === "unavailable"));
});

test("SNS API failure: no decision, then a later run retries safely", async () => {
  seedPost("p1");
  stub.tweet = { status: 503 };
  const first = await (await operatorLoop(cronRequest())).json();
  assert.equal(first.results[0].step, "metrics");
  assert.equal(db.table("post_metrics").length, 0);
  assert.equal(db.table("operator_runs").filter((x) => x.run_type === "ai_performance_verdict").length, 0);

  // Claim is held for 10 minutes; simulate expiry and recovery of the SNS API.
  const post = db.table("social_posts")[0];
  (post.metadata as Record<string, unknown>).metrics_refresh_claimed_at = iso(-11 * 60_000);
  stub.tweet = { status: 200, metrics: { impression_count: 5000, like_count: 10, reply_count: 1, retweet_count: 0 } };
  const second = await (await operatorLoop(cronRequest())).json();
  assert.equal(second.results[0].verdict, "pivot", JSON.stringify(second.results));
  assert.equal(db.table("post_metrics").length, 1);
});

test("temporary DB failure: run fails cleanly, lease is released, next run succeeds", async () => {
  seedPost("p1");
  db.failures.social_posts = "08006";
  const failed = await operatorLoop(cronRequest());
  assert.equal(failed.status, 500);
  assert.equal(db.table("operator_leases").length, 0);
  delete db.failures.social_posts;
  const ok = await (await operatorLoop(cronRequest())).json();
  assert.equal(ok.ok, true);
  assert.equal(ok.results[0].verdict, "pivot");
});

test("empty product information still yields a structured decision", async () => {
  db.tables.products = [];
  db.tables.acquisition_plans = [];
  seedPost("p1");
  const body = await (await operatorLoop(cronRequest())).json();
  const r = body.results.find((x: { postId?: string }) => x.postId === "p1");
  assert.ok(["pivot", "wait", "continue"].includes(r.verdict), JSON.stringify(body));
  const run = db.table("operator_runs").find((x) => x.run_type === "ai_performance_verdict") as { output: { decision: { target_customer: string; teacher: { missingData: string[] } } } };
  assert.ok(run.output.decision.target_customer);
  assert.ok(run.output.decision.teacher.missingData.includes("product.price"));
});
