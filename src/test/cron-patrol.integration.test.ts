// Cron wiring and the AI patrol: vercel.json <-> route handlers, lease,
// stale-job repair, per-user report isolation and the patrol's time budget.
import { beforeEach, mock, test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { FakeSupabase } from "./fake-supabase";

let db = new FakeSupabase();

mock.module("../lib/billing.ts", {
  namedExports: {
    getAdminSupabase: () => db,
    getUserFromBearer: async () => null,
    consumeMonthlyUsage: async () => ({ allowed: true }),
    refundMonthlyUsage: async () => ({ refunded: true }),
  },
});

process.env.CRON_SECRET = "cron-secret";
process.env.VERCEL_PROJECT_PRODUCTION_URL = "app.test";
delete process.env.OPENAI_API_KEY;

const patrolRoute = await import("../app/api/cron/patrol-ai/route");
const loopRoute = await import("../app/api/cron/operator-loop/route");

type LoopAnswer = { status: number; body: Record<string, unknown> } | "timeout" | "network";
let loopAnswer: LoopAnswer;
let loopCalls = 0;
let openAiAnswer: string | null = null;

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  if (url.host === "app.test" && url.pathname === "/api/cron/operator-loop") {
    loopCalls++;
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer cron-secret");
    assert.ok(init?.signal, "the loop call is time-bounded");
    if (loopAnswer === "timeout") throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    if (loopAnswer === "network") throw new TypeError("fetch failed");
    return Response.json(loopAnswer.body, { status: loopAnswer.status });
  }
  if (url.host === "api.openai.com") {
    if (openAiAnswer === null) throw new TypeError("OpenAI unreachable");
    return Response.json({ choices: [{ message: { content: openAiAnswer } }] });
  }
  return realFetch(input, init);
}) as typeof fetch;

const cron = (secret = "cron-secret") => new Request("https://app.test/api/cron/patrol-ai", { headers: { authorization: `Bearer ${secret}` } });
const iso = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();

beforeEach(() => {
  db = new FakeSupabase();
  loopAnswer = { status: 200, body: { ok: true, checked: 3, processed: 2, attention: 0, results: [{ postId: "secret-post-of-u2", error: "u2 private error" }] } };
  loopCalls = 0;
  openAiAnswer = null;
  delete process.env.OPENAI_API_KEY;
  db.seed("social_posts", [
    { id: "a1", user_id: "u1", status: "published", network: "x", metadata: { operator_patrol_status: "superseded" } },
    { id: "a2", user_id: "u1", status: "published", network: "x", metadata: {} },
    { id: "b1", user_id: "u2", status: "published", network: "x", metadata: { operator_patrol_status: "stopped" } },
  ]);
});

test("vercel.json crons point at existing GET handlers that fit Vercel's limits", async () => {
  const config = JSON.parse(await readFile(path.join(process.cwd(), "vercel.json"), "utf8")) as { crons: Array<{ path: string; schedule: string }> };
  assert.deepEqual(config.crons.map((c) => c.path).sort(), ["/api/cron/operator-loop", "/api/cron/patrol-ai"]);
  for (const cronEntry of config.crons) {
    assert.ok(existsSync(path.join(process.cwd(), "src/app", cronEntry.path, "route.ts")), cronEntry.path);
    assert.match(cronEntry.schedule, /^(\S+\s+){4}\S+$/, "5-field cron expression");
  }
  for (const route of [patrolRoute, loopRoute]) {
    assert.equal(typeof route.GET, "function");
    assert.ok(route.maxDuration <= 300);
  }
  // The patrol runs after the loop's own schedule so it audits that run.
  const minuteOf = (p: string) => {
    const [minute, hour] = config.crons.find((c) => c.path === p)!.schedule.split(/\s+/).map(Number);
    return hour * 60 + minute;
  };
  assert.ok(minuteOf("/api/cron/patrol-ai") > minuteOf("/api/cron/operator-loop"));
});

test("patrol without the cron secret is rejected and does nothing", async () => {
  const res = await patrolRoute.GET(cron("wrong"));
  assert.equal(res.status, 401);
  assert.equal(loopCalls, 0);
  assert.equal(db.table("operator_runs").length, 0);
});

test("two concurrent patrols: one is skipped by the lease", async () => {
  const [a, b] = await Promise.all([patrolRoute.GET(cron()), patrolRoute.GET(cron())]);
  const bodies = [await a.json(), await b.json()];
  assert.equal(bodies.filter((x) => x.skipped).length, 1);
  assert.equal(loopCalls, 1);
  assert.equal(db.table("operator_leases").length, 0, "lease released");
});

test("each user's stored patrol report contains only that user's data", async () => {
  db.seed("production_jobs", [
    { id: "job-u1", user_id: "u1", status: "running", request_id: null, started_at: iso(-45 * 60_000), provider_response: { input_image_url: "https://img.test/a.webp" } },
    { id: "job-u2", user_id: "u2", status: "running", request_id: null, started_at: iso(-45 * 60_000), provider_response: {} },
  ]);
  const body = await (await patrolRoute.GET(cron())).json();
  assert.equal(body.repairs.filter((r: { status: string }) => r.status === "repaired").length, 2);

  const runs = db.table("operator_runs").filter((r) => r.run_type === "ai_patrol");
  assert.equal(runs.length, 2);
  const u1 = runs.find((r) => r.user_id === "u1")!;
  const stored = JSON.stringify(u1);
  assert.ok(stored.includes("job-u1"));
  assert.ok(!stored.includes("job-u2"), "no other user's job");
  assert.ok(!stored.includes("secret-post-of-u2") && !stored.includes("u2 private error"), "no other user's loop results");
  assert.deepEqual((u1.output as { patrolCounts: Record<string, number> }).patrolCounts, { active: 0, stopped: 0, superseded: 1, stalled: 0, unmanaged: 1 });
});

test("stale job without request_id becomes manual recovery and leaves the loop; with request_id it is left alone", async () => {
  db.seed("production_jobs", [
    { id: "lost", user_id: "u1", status: "running", request_id: null, started_at: iso(-45 * 60_000), provider_response: { input_image_url: "https://img.test/a.webp", retry_count: 1 } },
    { id: "rendering", user_id: "u1", status: "running", request_id: "hf-1", started_at: iso(-45 * 60_000), provider_response: {} },
  ]);
  await patrolRoute.GET(cron());
  const lost = db.table("production_jobs").find((j) => j.id === "lost")!;
  const pr = lost.provider_response as Record<string, unknown>;
  assert.equal(lost.status, "failed");
  assert.equal(pr.manual_recovery_required, true);
  assert.equal(pr.loop_settled_reason, "manual_recovery_required");
  assert.equal(pr.input_image_url, "https://img.test/a.webp", "existing job state is kept");
  assert.equal(pr.retry_count, 1);
  const rendering = db.table("production_jobs").find((j) => j.id === "rendering")!;
  assert.equal(rendering.status, "running");
});

test("a slow operator loop does not prevent the patrol report", async () => {
  loopAnswer = "timeout";
  const res = await patrolRoute.GET(cron());
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.severity, "attention", "pending, not critical: the loop keeps running on its own");
  assert.equal(body.repairs[0].status, "pending");
  assert.equal(db.table("operator_runs").filter((r) => r.run_type === "ai_patrol").length, 2);
});

test("an unreachable operator loop is reported as critical", async () => {
  loopAnswer = "network";
  const body = await (await patrolRoute.GET(cron())).json();
  assert.equal(body.severity, "critical");
  assert.equal(body.ok, false);
});

test("the AI supervisor may phrase the summary but cannot downgrade the observed severity", async () => {
  process.env.OPENAI_API_KEY = "sk-test";
  loopAnswer = "network";
  openAiAnswer = JSON.stringify({ severity: "healthy", summary: "問題ありません", next_check: "明日" });
  const body = await (await patrolRoute.GET(cron())).json();
  assert.equal(body.severity, "critical");
  assert.equal(body.summary, "問題ありません");
  assert.equal(body.summarySource, "ai");
});

test("malformed AI supervisor output falls back to the deterministic summary", async () => {
  process.env.OPENAI_API_KEY = "sk-test";
  openAiAnswer = "[1,2,3]";
  const body = await (await patrolRoute.GET(cron())).json();
  assert.equal(body.severity, "healthy");
  assert.equal(body.summarySource, "deterministic");
});
