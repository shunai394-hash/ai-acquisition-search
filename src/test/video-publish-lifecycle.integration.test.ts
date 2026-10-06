// Integration tests for the second half of the loop: video job lifecycle
// (start / poll / fail / timeout / retry / manual recovery) and the automatic
// SNS publish of the finished video. Real route handlers run against the
// in-memory Supabase; Higgsfield, X and the video CDN are fetch stubs.
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

// Supabase Storage is outside the fake; the asset URL points at the stub CDN.
const CDN = "93.184.216.34";
mock.module("../lib/video/storage.ts", {
  namedExports: {
    saveVideoToStorage: async (input: { userId: string; jobId: string }) => ({
      bucket: "video-assets",
      path: `${input.userId}/${input.jobId}.mp4`,
      url: `https://${CDN}/assets/${input.jobId}.mp4`,
      bytes: 4,
      contentType: "video/mp4",
    }),
    deleteVideoFromStorage: async () => {},
  },
});

process.env.CRON_SECRET = "cron-secret";
process.env.VERCEL_PROJECT_PRODUCTION_URL = "app.test";
process.env.X_ACCESS_TOKEN = "x-token";
process.env.HF_API_KEY_ID = "hf-id";
process.env.HF_API_KEY_SECRET = "hf-secret";
delete process.env.OPENAI_API_KEY;
delete process.env.EC_PULSE_API_KEY;

const { GET: operatorLoop } = await import("../app/api/cron/operator-loop/route");
const { POST: socialPublish } = await import("../app/api/social/publish/route");
const { POST: socialMetrics } = await import("../app/api/social/metrics/route");
const { POST: aiDecision } = await import("../app/api/operator/ai-decision/route");
const { POST: nextCreative } = await import("../app/api/operator/next-creative/route");
const { GET: videoJob } = await import("../app/api/video/jobs/[id]/route");
const { GET: activity } = await import("../app/api/operator/activity/route");

const HOUR = 3600_000;
const MINUTE = 60_000;
const iso = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();
const IMAGE = "https://storage.test/product-reference.webp";

type Stub = {
  /** request_id -> provider status answer (string status or a thrown error). */
  hfStatus: Record<string, string | "error">;
  hfStarts: Array<{ path: string; body: Record<string, unknown> }>;
  hfStatusCalls: number;
  /** Called while a status request is in flight (to interleave a concurrent writer). */
  onStatus: ((requestId: string) => void) | null;
  tweets: number;
  tweetStatus: number;
  metricsStatus: number;
};
let stub: Stub;

const routes: Record<string, (req: Request) => Promise<Response>> = {
  "POST /api/social/publish": socialPublish,
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
  if (url.host === "api.higgsfield.ai") {
    const status = /^\/requests\/([^/]+)\/status$/.exec(url.pathname);
    if (status) {
      stub.hfStatusCalls++;
      const requestId = decodeURIComponent(status[1]);
      stub.onStatus?.(requestId);
      const answer = stub.hfStatus[requestId] ?? "in_progress";
      if (answer === "error") return new Response(JSON.stringify({ detail: "upstream unavailable" }), { status: 503 });
      return new Response(JSON.stringify({
        request_id: requestId,
        status: answer,
        ...(answer === "completed" ? { video: { url: `https://${CDN}/raw/${requestId}.mp4` } } : {}),
      }), { status: 200 });
    }
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
    stub.hfStarts.push({ path: url.pathname, body });
    return new Response(JSON.stringify({ request_id: `hf-new-${stub.hfStarts.length}`, status: "queued" }), { status: 200 });
  }
  if (url.host === CDN) {
    return new Response(new Uint8Array([0, 0, 0, 1]), { status: 200, headers: { "content-type": "video/mp4" } });
  }
  if (url.host === "api.x.com") {
    if (url.pathname === "/2/media/upload/initialize") return Response.json({ data: { id: "m1" } });
    if (url.pathname.endsWith("/append")) return new Response(null, { status: 204 });
    if (url.pathname.endsWith("/finalize")) return Response.json({ data: { id: "m1" } });
    if (url.pathname === "/2/tweets" && method === "POST") {
      if (stub.tweetStatus !== 200) return Response.json({ detail: "X down" }, { status: stub.tweetStatus });
      stub.tweets++;
      return Response.json({ data: { id: `tw-auto-${stub.tweets}` } });
    }
    if (url.pathname.startsWith("/2/tweets/")) {
      if (stub.metricsStatus !== 200) return Response.json({ detail: "Not Found" }, { status: stub.metricsStatus });
      return Response.json({ data: { id: url.pathname.split("/").pop(), text: "t", public_metrics: { impression_count: 5000, like_count: 10, reply_count: 1, retweet_count: 0 } } });
    }
  }
  if (url.host === "api.openai.com") throw new TypeError("OpenAI unreachable");
  return realFetch(input, init);
}) as typeof fetch;

const cronRequest = () => new Request("https://app.test/api/cron/operator-loop", { headers: { authorization: "Bearer cron-secret" } });
const internal = (path: string, body: Record<string, unknown>) => new Request(`https://app.test${path}`, {
  method: "POST",
  headers: { "content-type": "application/json", "x-internal-secret": "cron-secret", "x-internal-user-id": "u1" },
  body: JSON.stringify(body),
});
const runLoop = async () => (await operatorLoop(cronRequest())).json() as Promise<{ ok: boolean; attention: number; results: Array<Record<string, unknown>> }>;
const job = (id = "job1") => db.table("production_jobs").find((row) => row.id === id) as Record<string, unknown> & { provider_response: Record<string, unknown> };
const publishedRows = () => db.table("social_posts").filter((row) => (row.metadata as Record<string, unknown>)?.source_social_post_id === "next1");

beforeEach(() => {
  db = new FakeSupabase();
  stub = { hfStatus: {}, hfStarts: [], hfStatusCalls: 0, onStatus: null, tweets: 0, tweetStatus: 200, metricsStatus: 200 };
  process.env.HF_API_KEY_ID = "hf-id";
  process.env.HF_API_KEY_SECRET = "hf-secret";
  db.seed("products", [{ id: "prod1", user_id: "u1", name: "保冷ボトル", url: "https://shop.test/bottle", price: 3000, cost: 1200 }]);
  db.seed("creatives", [
    { id: "c1", user_id: "u1", product_id: "prod1", title: "保冷ボトル", hook: "朝の氷、夕方まで", scenario: { angle: "すぐぬるくなる", input_image_url: IMAGE } },
    { id: "c2", user_id: "u1", product_id: "prod1", title: "保冷ボトル / Iteration", hook: "結露しない", scenario: { angle: "結露", input_image_url: IMAGE } },
  ]);
  // p1 was published and judged; next1 is the scheduled post for its successor creative.
  db.seed("social_posts", [
    { id: "p1", user_id: "u1", creative_id: "c1", network: "x", status: "published", external_post_id: "tw-p1", caption: "朝の氷が夕方まで", published_at: iso(-48 * HOUR), metadata: { operator_patrol_status: "superseded" } },
    { id: "next1", user_id: "u1", creative_id: "c2", network: "x", status: "scheduled", caption: "結露しないボトル", metadata: { source_social_post_id: "p1", auto_publish: true } },
  ]);
});

function seedJob(overrides: Record<string, unknown> = {}) {
  db.seed("production_jobs", [{
    id: "job1",
    user_id: "u1",
    social_post_id: "next1",
    creative_id: "c2",
    status: "running",
    request_id: "hf-req-1",
    prompt: "product close-up",
    duration: 5,
    resolution: "1080p",
    aspect_ratio: "9:16",
    model: "alibaba/wan-3.0-prime/image-to-video",
    generate_audio: false,
    provider_response: { retry_count: 1, input_image_url: IMAGE },
    started_at: iso(-10 * MINUTE),
    created_at: iso(-15 * MINUTE),
    ...overrides,
  }]);
}

test("happy path: completed video is published once, the job is settled, later runs neither repost nor rescan it", async () => {
  seedJob();
  stub.hfStatus["hf-req-1"] = "completed";

  const first = await runLoop();
  const r = first.results.find((x) => x.jobId === "job1");
  assert.equal(r?.status, "published", JSON.stringify(first.results));
  assert.equal(stub.tweets, 1);
  const rows = publishedRows();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, "published");
  assert.equal(rows[0].external_post_id, "tw-auto-1");
  assert.equal(db.table("video_assets").length, 1);
  assert.equal(job().status, "completed");
  assert.equal(job().provider_response.loop_settled_reason, "published");
  // Status writes merge: the loop state is still there next to the provider answer.
  assert.equal(job().provider_response.input_image_url, IMAGE);
  assert.equal(job().provider_response.retry_count, 1);
  assert.equal((job().provider_response.status_response as Record<string, unknown>).status, "completed");

  const second = await runLoop();
  assert.equal(second.results.some((x) => x.jobId === "job1"), false, "settled job is not rescanned");
  assert.equal(stub.tweets, 1, "no repost");
});

test("duplicate publish: concurrent requests for the same post reach the SNS once", async () => {
  const body = { socialPostId: "next1", videoUrl: `https://${CDN}/v.mp4`, caption: "結露しないボトル", platforms: ["x"] };
  const [a, b] = await Promise.all([socialPublish(internal("/api/social/publish", body)), socialPublish(internal("/api/social/publish", body))]);
  const results = [await a.json(), await b.json()];
  assert.equal(stub.tweets, 1, JSON.stringify(results));
  assert.equal(publishedRows().length, 1);
  // The loser either sees the live reservation (not ok, no post) or the finished
  // row (ok, same post): never a second external post.
  for (const result of results) {
    if (result.results[0].ok) assert.equal(result.results[0].postId, "tw-auto-1");
    else assert.match(result.results[0].error, /予約済み/);
  }
  // A third call after completion reports the existing post instead of posting again.
  const again = await (await socialPublish(internal("/api/social/publish", body))).json();
  assert.equal(again.results[0].ok, true);
  assert.equal(again.results[0].postId, "tw-auto-1");
  assert.equal(stub.tweets, 1);
});

test("SNS success + DB failure on the result save: recovered as published, never reposted", async () => {
  seedJob({ status: "completed" });
  db.seed("video_assets", [{ production_job_id: "job1", user_id: "u1", video_url: `https://${CDN}/assets/job1.mp4` }]);
  let failedOnce = false;
  // Only the first write of the SNS result fails; the recovery write succeeds.
  db.failWhen = (table, op, payload) => {
    if (table === "social_posts" && op === "update" && !Array.isArray(payload) && payload?.status === "published" && payload.external_post_id && !failedOnce) {
      failedOnce = true;
      return "08006";
    }
    return null;
  };

  const first = await runLoop();
  assert.equal(stub.tweets, 1);
  assert.equal(first.results.find((x) => x.jobId === "job1")?.status, "published", JSON.stringify(first.results));
  const row = publishedRows()[0];
  assert.equal(row.status, "published");
  assert.equal((row.metadata as Record<string, unknown>).recovered_after_persistence_error, true);

  db.failWhen = null;
  await runLoop();
  assert.equal(stub.tweets, 1);
});

test("SNS success + DB down for every result write: manual recovery, the loop never reposts", async () => {
  seedJob({ status: "completed" });
  db.seed("video_assets", [{ production_job_id: "job1", user_id: "u1", video_url: `https://${CDN}/assets/job1.mp4` }]);
  db.failWhen = (table, op, payload) =>
    table === "social_posts" && op === "update" && !Array.isArray(payload) && payload?.status === "published" ? "08006" : null;

  const first = await runLoop();
  assert.equal(stub.tweets, 1);
  assert.equal(first.results.find((x) => x.jobId === "job1")?.status, "manual-recovery-required", JSON.stringify(first.results));
  assert.equal(first.attention, 1);
  assert.equal(job().provider_response.manual_recovery_required, true);
  assert.equal(job().provider_response.loop_settled_reason, "manual_recovery_required");
  assert.equal(publishedRows()[0].status, "publishing", "reservation stays, so no worker can claim it again");

  db.failWhen = null;
  await runLoop();
  await runLoop();
  assert.equal(stub.tweets, 1, "no repost after the DB recovers");
});

test("SNS API down before posting: retried on later runs, then stops at the publish limit", async () => {
  seedJob({ status: "completed" });
  db.seed("video_assets", [{ production_job_id: "job1", user_id: "u1", video_url: `https://${CDN}/assets/job1.mp4` }]);
  stub.tweetStatus = 503;

  const statuses: unknown[] = [];
  for (let i = 0; i < 4; i++) statuses.push((await runLoop()).results.find((x) => x.jobId === "job1")?.status);
  assert.deepEqual(statuses, ["publish-failed", "publish-failed", "publish-exhausted", undefined]);
  assert.equal(job().provider_response.loop_settled_reason, "publish_exhausted");
  assert.equal(publishedRows()[0].status, "failed");

  // A recovered SNS API after a failed (not ambiguous) attempt is safe to retry manually.
  stub.tweetStatus = 200;
  const manual = await (await socialPublish(internal("/api/social/publish", { socialPostId: "next1", videoUrl: `https://${CDN}/v.mp4`, caption: "x", platforms: ["x"] }))).json();
  assert.equal(manual.results[0].ok, true);
  assert.equal(stub.tweets, 1);
});

test("provider failure keeps the reference image and retry budget; retries stop at the limit", async () => {
  seedJob();
  stub.hfStatus["hf-req-1"] = "failed";

  await runLoop(); // poll: running -> failed
  assert.equal(job().status, "failed");
  assert.equal(job().provider_response.input_image_url, IMAGE, "image survives the failure write");
  assert.equal(job().provider_response.retry_count, 1, "retry budget survives the failure write");

  const retry = await runLoop(); // retry with the same image
  assert.equal(retry.results.find((x) => x.jobId === "job1")?.status, "running", JSON.stringify(retry.results));
  assert.equal(stub.hfStarts.length, 1);
  assert.equal(stub.hfStarts[0].path, "/alibaba/wan-3.0-prime/image-to-video");
  assert.equal(stub.hfStarts[0].body.image_url, IMAGE);
  assert.equal(job().request_id, "hf-new-1");
  assert.deepEqual(job().provider_response.previous_request_ids, ["hf-req-1"]);
  assert.equal(job().provider_response.retry_count, 2);

  stub.hfStatus["hf-new-1"] = "failed";
  await runLoop(); // poll: failed again
  const exhausted = await runLoop();
  assert.equal(exhausted.results.find((x) => x.jobId === "job1")?.status, "exhausted");
  assert.equal(job().provider_response.loop_settled_reason, "retries_exhausted");
  await runLoop();
  assert.equal(stub.hfStarts.length, 1, "no third generation");
});

test("moderation rejection (nsfw) is not retried", async () => {
  seedJob();
  stub.hfStatus["hf-req-1"] = "nsfw";
  await runLoop();
  const second = await runLoop();
  assert.equal(second.results.find((x) => x.jobId === "job1")?.status, "non-retryable");
  assert.equal(stub.hfStarts.length, 0);
  assert.equal(job().provider_response.loop_settled_reason, "non_retryable");
});

test("timeout: a job the provider never finishes is failed and retried with its image", async () => {
  seedJob({ started_at: iso(-2 * HOUR) });
  stub.hfStatus["hf-req-1"] = "in_progress";

  await runLoop();
  assert.equal(job().status, "failed");
  assert.equal(job().provider_response.timed_out_request_id, "hf-req-1");
  assert.match(String(job().error), /打ち切りました/);

  await runLoop();
  assert.equal(stub.hfStarts.length, 1);
  assert.equal(stub.hfStarts[0].body.image_url, IMAGE);
  assert.equal(job().status, "running");
});

test("timeout also applies when the provider status endpoint keeps erroring", async () => {
  seedJob({ started_at: iso(-2 * HOUR) });
  stub.hfStatus["hf-req-1"] = "error";
  await runLoop();
  assert.equal(job().status, "failed");
  assert.match(String(job().error), /upstream unavailable/);
});

test("a provider error before the timeout leaves the job running for the next poll", async () => {
  seedJob();
  stub.hfStatus["hf-req-1"] = "error";
  const body = await runLoop();
  assert.equal(job().status, "running");
  assert.equal(body.results.find((x) => x.jobId === "job1")?.status, 500);
});

test("a late status answer for an old request cannot overwrite a re-claimed job", async () => {
  seedJob();
  stub.hfStatus["hf-req-1"] = "failed";
  // While the status of hf-req-1 is in flight, the loop re-claims the job for a new attempt.
  stub.onStatus = () => {
    Object.assign(job(), { request_id: "hf-req-2", status: "running", provider_response: { ...job().provider_response, retry_count: 2 } });
  };
  const res = await videoJob(new Request("https://app.test/api/video/jobs/job1", { headers: { "x-internal-secret": "cron-secret", "x-internal-user-id": "u1" } }), { params: Promise.resolve({ id: "job1" }) });
  assert.equal(res.status, 200);
  assert.equal(job().status, "running", "the new attempt is untouched");
  assert.equal(job().request_id, "hf-req-2");
});

test("missing provider credentials: the job waits without spending its retry budget", async () => {
  delete process.env.HF_API_KEY_ID;
  delete process.env.HF_API_KEY_SECRET;
  seedJob({ status: "queued", request_id: null, provider_response: { input_image_url: IMAGE } });
  const body = await runLoop();
  assert.equal(body.results.find((x) => x.jobId === "job1")?.status, "blocked");
  assert.equal(job().status, "queued");
  assert.equal(job().provider_response.retry_count, undefined);
  assert.equal(stub.hfStarts.length, 0);
});

test("DB failure after the provider started: no duplicate generation, then manual recovery", async () => {
  seedJob({ status: "queued", request_id: null, provider_response: { input_image_url: IMAGE } });
  db.failWhen = (table, op, payload) =>
    table === "production_jobs" && op === "update" && !Array.isArray(payload) && payload?.request_id ? "08006" : null;

  const first = await runLoop();
  assert.equal(first.results.find((x) => x.jobId === "job1")?.status, "request-id-not-saved", JSON.stringify(first.results));
  assert.equal(job().status, "running", "not marked failed: a retry would generate twice");
  assert.equal(stub.hfStarts.length, 1);

  db.failWhen = null;
  await runLoop(); // still within the 15 minute window: untouched
  assert.equal(stub.hfStarts.length, 1);
  job().started_at = iso(-20 * MINUTE);
  const recovery = await runLoop();
  assert.equal(recovery.results.find((x) => x.jobId === "job1")?.status, "manual-recovery-required");
  assert.equal(job().provider_response.manual_recovery_required, true);
  await runLoop();
  assert.equal(stub.hfStarts.length, 1, "never regenerated automatically");
});

test("settled jobs never crowd out new jobs", async () => {
  // 30 older studio renders without a post: the first run settles them.
  db.seed("production_jobs", Array.from({ length: 30 }, (_, i) => ({
    id: `old-${i}`, user_id: "u1", social_post_id: null, status: "completed", request_id: `old-${i}`,
    provider_response: {}, created_at: iso(-10 * HOUR + i),
  })));
  seedJob({ status: "queued", request_id: null, provider_response: { input_image_url: IMAGE }, created_at: iso(-MINUTE) });

  await runLoop();
  assert.ok(db.table("production_jobs").filter((row) => String(row.id).startsWith("old-")).every((row) => (row.provider_response as Record<string, unknown>).loop_settled_reason === "no_social_post"));
  await runLoop();
  assert.equal(stub.hfStarts.length, 1, "the new job is reached");
  assert.equal(job().status, "running");
});

test("product image survives successive iterations (creative -> next creative -> next creative)", async () => {
  // p1 (creative c1, with image) is judged again from scratch.
  db.table("social_posts")[0].metadata = {};
  db.tables.social_posts = db.table("social_posts").filter((row) => row.id !== "next1");

  const first = await runLoop();
  const firstPost = first.results.find((x) => x.postId === "p1");
  assert.equal(firstPost?.verdict, "pivot", JSON.stringify(first.results));
  const iteration1 = db.table("creatives").find((row) => (row.scenario as Record<string, unknown>).source_creative_id === "c1") as { id: string; scenario: Record<string, unknown> };
  assert.equal(iteration1.scenario.input_image_url, IMAGE, "the next creative inherits the image");

  // Its post is published and judged in turn.
  db.seed("social_posts", [{ id: "p2", user_id: "u1", creative_id: iteration1.id, network: "x", status: "published", external_post_id: "tw-p2", caption: "2", published_at: iso(-30 * HOUR), metadata: { source_social_post_id: "p1-published" } }]);
  const res = await nextCreative(internal("/api/operator/next-creative", { socialPostId: "p2", verdict: "pivot", changedAngle: "通勤中", autoGenerate: true }));
  assert.equal(res.status, 201, JSON.stringify(await res.clone().json()));
  const iteration2Job = db.table("production_jobs").find((row) => row.social_post_id !== null && (row.provider_response as Record<string, unknown> | null)?.input_image_url && row.creative_id !== iteration1.id && db.table("creatives").find((c) => c.id === row.creative_id && (c.scenario as Record<string, unknown>).source_creative_id === iteration1.id)) as Record<string, unknown> | undefined;
  assert.ok(iteration2Job, "second iteration job keeps the image");
  assert.equal(iteration2Job!.model, "alibaba/wan-3.0-prime/image-to-video");
});

test("concluded posts leave the sweep: STOP / superseded / stalled posts are not re-evaluated", async () => {
  db.tables.social_posts = [];
  db.tables.production_jobs = [];
  // 50 older posts the loop already concluded, then one new post.
  db.seed("social_posts", Array.from({ length: 50 }, (_, i) => ({
    id: `done-${i}`, user_id: "u1", creative_id: "c1", network: "x", status: "published", external_post_id: `tw-done-${i}`,
    published_at: iso(-(100 + i) * HOUR), metadata: { operator_patrol_status: ["superseded", "stopped", "stalled"][i % 3] },
  })));
  db.seed("social_posts", [{ id: "fresh", user_id: "u1", creative_id: "c1", network: "x", status: "published", external_post_id: "tw-fresh", published_at: iso(-24 * HOUR), metadata: {} }]);

  const body = await runLoop();
  const fresh = body.results.find((x) => x.postId === "fresh");
  assert.equal(fresh?.verdict, "pivot", JSON.stringify(body.results.slice(0, 3)));
  assert.equal(fresh?.patrolStatus, "superseded");
  assert.equal(body.results.filter((x) => String(x.postId ?? "").startsWith("done-")).length, 0);
  const marked = db.table("social_posts").find((row) => row.id === "fresh")!.metadata as Record<string, unknown>;
  assert.equal(marked.operator_patrol_status, "superseded");
  assert.ok(marked.metrics_refresh_claimed_at, "metadata written by the metrics route is kept");
});

test("a deleted SNS post stalls after repeated metrics failures instead of being polled forever", async () => {
  db.tables.social_posts = [{ id: "gone", user_id: "u1", creative_id: "c1", network: "x", status: "published", external_post_id: "tw-gone", published_at: iso(-48 * HOUR), metadata: {}, created_at: iso(-48 * HOUR) }];
  stub.metricsStatus = 404;
  const statuses: unknown[] = [];
  for (let i = 0; i < 4; i++) {
    const post = db.table("social_posts")[0];
    // Let the 10 minute metrics claim expire between runs.
    (post.metadata as Record<string, unknown>).metrics_refresh_claimed_at = iso(-11 * MINUTE);
    const body = await runLoop();
    statuses.push(body.results.find((x) => x.postId === "gone")?.patrolStatus ?? body.results.find((x) => x.postId === "gone")?.step);
  }
  assert.deepEqual(statuses, ["metrics", "metrics", "stalled", undefined]);
  assert.equal((db.table("social_posts")[0].metadata as Record<string, unknown>).operator_patrol_status, "stalled");
});

test("recovering metrics resets the failure counter", async () => {
  db.tables.social_posts = [{ id: "flaky", user_id: "u1", creative_id: "c1", network: "x", status: "published", external_post_id: "tw-flaky", published_at: iso(-48 * HOUR), metadata: { operator_metrics_failures: 2 }, created_at: iso(-48 * HOUR) }];
  const body = await runLoop();
  assert.equal(body.results.find((x) => x.postId === "flaky")?.verdict, "pivot", JSON.stringify(body.results));
  assert.equal((db.table("social_posts").find((row) => row.id === "flaky")!.metadata as Record<string, unknown>).operator_metrics_failures, 0);
});

test("activity API: shows the user's own loop only, and requires auth", async () => {
  seedJob({ status: "failed", provider_response: { loop_settled_reason: "retries_exhausted" } });
  db.seed("social_posts", [{ id: "other-post", user_id: "u2", creative_id: "x", network: "x", status: "published", external_post_id: "tw-other", metadata: { operator_patrol_status: "stalled" } }]);
  db.seed("production_jobs", [{ id: "other-job", user_id: "u2", status: "failed", provider_response: { loop_settled_reason: "non_retryable" } }]);
  db.seed("operator_runs", [{ user_id: "u2", run_type: "ai_performance_verdict", completed_at: iso(-MINUTE), output: { decision: { verdict: "stop", reason: "u2 secret reason", evidence: [] } } }]);

  const unauthenticated = await activity(new Request("https://app.test/api/operator/activity"));
  assert.equal(unauthenticated.status, 401);

  const res = await activity(new Request("https://app.test/api/operator/activity", { headers: { "x-internal-secret": "cron-secret", "x-internal-user-id": "u1" } }));
  assert.equal(res.status, 200);
  const body = await res.json();
  const raw = JSON.stringify(body);
  assert.ok(!raw.includes("other-post") && !raw.includes("other-job") && !raw.includes("u2 secret reason"), raw);
  assert.equal(body.latestDecision, null);
  assert.deepEqual(body.attention.map((a: { id: string }) => a.id), ["job1"]);
});

test("activity API: a database outage returns a retryable message without internals", async () => {
  db.failures.production_jobs = "08006";
  const res = await activity(new Request("https://app.test/api/operator/activity", { headers: { "x-internal-secret": "cron-secret", "x-internal-user-id": "u1" } }));
  assert.equal(res.status, 503);
  const body = await res.json();
  assert.doesNotMatch(body.error, /08006|simulated|production_jobs/);
});

test("posts measured within the evaluation window are skipped without calling the SNS API", async () => {
  db.tables.social_posts = [
    { id: "fresh-metric", user_id: "u1", creative_id: "c1", network: "x", status: "published", external_post_id: "tw-a", published_at: iso(-48 * HOUR), metadata: {}, created_at: iso(-48 * HOUR) },
    { id: "stale-metric", user_id: "u1", creative_id: "c1", network: "x", status: "published", external_post_id: "tw-b", published_at: iso(-48 * HOUR), metadata: {}, created_at: iso(-48 * HOUR) },
  ];
  db.seed("post_metrics", [
    { social_post_id: "fresh-metric", impressions: 5000, raw: { source: "x" }, measured_at: iso(-HOUR) },
    { social_post_id: "stale-metric", impressions: 5000, raw: { source: "x" }, measured_at: iso(-24 * HOUR) },
  ]);
  const body = await runLoop();
  assert.equal(body.results.some((x) => x.postId === "fresh-metric"), false);
  assert.equal(body.results.find((x) => x.postId === "stale-metric")?.verdict, "pivot", JSON.stringify(body.results));
  assert.equal(db.table("post_metrics").filter((m) => m.social_post_id === "fresh-metric").length, 1, "no new fetch for the fresh post");
});

test("a canceled provider request is failed and retried instead of staying 'running'", async () => {
  seedJob();
  stub.hfStatus["hf-req-1"] = "canceled";
  await runLoop();
  assert.equal(job().status, "failed");
  assert.equal(job().provider_response.input_image_url, IMAGE);
  await runLoop();
  assert.equal(stub.hfStarts.length, 1, "retried once with the same image");
  assert.equal(stub.hfStarts[0].body.image_url, IMAGE);
});
