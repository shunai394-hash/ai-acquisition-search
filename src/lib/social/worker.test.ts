import assert from "node:assert/strict";
import test from "node:test";
import { FakeSupabase } from "../../test/fake-supabase";
import { processDueJobs } from "./worker";

const now = new Date("2026-10-24T03:00:00.000Z");

function seedReady(db: FakeSupabase, job: Record<string, unknown> = {}) {
  db.seed("media_assets", [{
    id: "asset-1",
    user_id: "user-1",
    kind: "video",
    upload_status: "ready",
    storage_bucket: "library-assets",
    storage_path: "user-1/video.mp4",
  }]);
  db.seed("tiktok_accounts", [{
    user_id: "user-1",
    scope: "user.info.basic,video.publish",
    refresh_token_expires_at: "2026-12-01T00:00:00.000Z",
  }]);
  db.seed("tiktok_publish_consents", [{ user_id: "user-1", consented_at: "2026-10-01T00:00:00.000Z" }]);
  db.seed("post_jobs", [{
    id: "job-1",
    user_id: "user-1",
    asset_id: "asset-1",
    network: "tiktok",
    caption: "本文",
    status: "queued",
    scheduled_at: "2026-10-24T02:00:00.000Z",
    timezone: "Asia/Tokyo",
    attempt_count: 0,
    next_attempt_at: null,
    publish_accepted_at: null,
    external_post_id: null,
    metadata: {},
    priority: 0,
    ...job,
  }]);
}

test("a due TikTok job is published once", async () => {
  const db = new FakeSupabase();
  seedReady(db);
  let calls = 0;
  const summary = await processDueJobs(db, {
    now,
    publish: async (_job, _asset, hooks) => {
      calls += 1;
      await hooks.markAccepted("pub-1");
      return { outcome: "published", externalPostId: "100", postUrl: "https://www.tiktok.com/@a/video/100" };
    },
  });
  assert.equal(calls, 1);
  assert.equal(summary.published, 1);
  assert.equal(db.table("post_jobs")[0].status, "published");
  assert.equal(db.table("post_jobs")[0].external_post_id, "100");
  assert.equal(db.table("post_jobs")[0].publish_accepted_at != null, true);
});

test("two workers cannot publish the same job", async () => {
  const db = new FakeSupabase();
  seedReady(db);
  let calls = 0;
  const publish = async (_job: unknown, _asset: unknown, hooks: { markAccepted: (id: string) => Promise<void> }) => {
    calls += 1;
    await hooks.markAccepted("pub-1");
    return { outcome: "published" as const, externalPostId: "100", postUrl: null };
  };
  await Promise.all([
    processDueJobs(db, { now, publish }),
    processDueJobs(db, { now, publish }),
  ]);
  assert.equal(calls, 1);
  assert.equal(db.table("post_jobs").filter((row) => row.status === "published").length, 1);
});

test("future and paused jobs are not sent", async () => {
  const db = new FakeSupabase();
  seedReady(db, { scheduled_at: "2026-10-25T00:00:00.000Z" });
  db.seed("post_jobs", [{
    id: "job-2",
    user_id: "user-1",
    asset_id: "asset-1",
    network: "tiktok",
    caption: "停止中",
    status: "paused",
    scheduled_at: "2026-10-24T02:00:00.000Z",
    timezone: "Asia/Tokyo",
    attempt_count: 0,
    metadata: {},
    priority: 0,
  }]);
  let calls = 0;
  await processDueJobs(db, {
    now,
    publish: async () => {
      calls += 1;
      return { outcome: "published", externalPostId: "1", postUrl: null };
    },
  });
  assert.equal(calls, 0);
});

test("a paused rule returns the job to the queue without publishing", async () => {
  const db = new FakeSupabase();
  seedReady(db);
  db.seed("posting_rules", [{
    user_id: "user-1",
    network: "tiktok",
    timezone: "Asia/Tokyo",
    max_per_day: 10,
    weekdays: [0, 1, 2, 3, 4, 5, 6],
    window_start: "00:00",
    window_end: "23:59",
    paused: true,
  }]);
  let calls = 0;
  await processDueJobs(db, {
    now,
    publish: async () => {
      calls += 1;
      return { outcome: "published", externalPostId: "1", postUrl: null };
    },
  });
  assert.equal(calls, 0);
  assert.equal(db.table("post_jobs")[0].status, "queued");
  assert.match(String(db.table("post_jobs")[0].last_error), /一時停止/);
});

test("provider acceptance is not retried when the follow-up poll fails", async () => {
  const db = new FakeSupabase();
  seedReady(db);
  const summary = await processDueJobs(db, {
    now,
    publish: async (_job, _asset, hooks) => {
      await hooks.markAccepted("pub-1");
      throw new Error("The operation timed out");
    },
  });
  assert.equal(summary.results[0]?.status, "pending");
  assert.equal(db.table("post_jobs")[0].status, "pending");
  assert.equal(db.table("post_jobs")[0].external_post_id, "pub-1");
});

test("a rejected publish can be queued again with backoff", async () => {
  const db = new FakeSupabase();
  seedReady(db);
  const summary = await processDueJobs(db, {
    now,
    publish: async () => {
      const error = new Error("HTTP 503 temporarily unavailable") as Error & { errorClass: "safe_retry" };
      error.errorClass = "safe_retry";
      throw error;
    },
  });
  assert.equal(summary.results[0]?.status, "queued");
  assert.equal(db.table("post_jobs")[0].status, "queued");
  assert.ok(Date.parse(String(db.table("post_jobs")[0].next_attempt_at)) > now.getTime());
});

test("missing TikTok consent does not call the provider", async () => {
  const db = new FakeSupabase();
  seedReady(db);
  db.tables.tiktok_publish_consents = [];
  let calls = 0;
  const summary = await processDueJobs(db, {
    now,
    publish: async () => {
      calls += 1;
      return { outcome: "published", externalPostId: "1", postUrl: null };
    },
  });
  assert.equal(calls, 0);
  assert.equal(summary.results[0]?.status, "failed");
});

test("an expired TikTok refresh token is not sent to the provider", async () => {
  const db = new FakeSupabase();
  seedReady(db);
  db.table("tiktok_accounts")[0].refresh_token_expires_at = "2020-01-01T00:00:00.000Z";
  let calls = 0;
  const summary = await processDueJobs(db, {
    now,
    publish: async () => {
      calls += 1;
      return { outcome: "published", externalPostId: "1", postUrl: null };
    },
  });
  assert.equal(calls, 0);
  assert.equal(summary.results[0]?.status, "needs_reauth");
});

test("Instagram stays unsent and explains that user OAuth is not connected", async () => {
  const db = new FakeSupabase();
  seedReady(db, { network: "instagram" });
  let calls = 0;
  const summary = await processDueJobs(db, {
    now,
    publish: async () => {
      calls += 1;
      return { outcome: "published", externalPostId: "1", postUrl: null };
    },
  });
  assert.equal(calls, 0);
  assert.match(summary.results[0]?.error || "", /OAuth/);
});

test("an interrupted job is not published again automatically", async () => {
  const db = new FakeSupabase();
  seedReady(db, { status: "processing", locked_at: "2026-10-24T02:00:00.000Z", locked_by: "old" });
  let calls = 0;
  await processDueJobs(db, {
    now,
    publish: async () => {
      calls += 1;
      return { outcome: "published", externalPostId: "1", postUrl: null };
    },
  });
  assert.equal(calls, 0);
  assert.equal(db.table("post_jobs")[0].status, "failed");
  assert.equal((db.table("post_jobs")[0].metadata as { retry_safety?: string }).retry_safety, "confirm_no_duplicate");
});
