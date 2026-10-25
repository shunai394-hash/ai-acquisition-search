import assert from "node:assert/strict";
import test from "node:test";
import { FakeSupabase } from "../../test/fake-supabase";
import { enqueueCompletedVideo } from "./from-video";

const input = {
  userId: "user-1",
  productionJobId: "job-9",
  storageBucket: "video-assets",
  storagePath: "user-1/job-9.mp4",
  caption: "完成した広告",
  byteSize: 1024,
  durationSeconds: 5,
  consented: true,
};

test("a completed video is queued once for TikTok", async () => {
  const db = new FakeSupabase();
  const first = await enqueueCompletedVideo(db, input);
  const second = await enqueueCompletedVideo(db, input);
  assert.equal(first.ok, true);
  assert.equal(first.existing, false);
  assert.equal(second.ok, true);
  assert.equal(second.existing, true);
  assert.equal(db.table("post_jobs").length, 1);
  assert.equal(db.table("post_jobs")[0].status, "queued");
  assert.equal(db.table("media_assets")[0].ai_generated, true);
});

test("a completed video is not queued without publish consent", async () => {
  const db = new FakeSupabase();
  const result = await enqueueCompletedVideo(db, { ...input, consented: false });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "CONSENT_REQUIRED");
  assert.equal(db.table("post_jobs").length, 0);
});

test("another user's video path is rejected", async () => {
  const db = new FakeSupabase();
  const result = await enqueueCompletedVideo(db, { ...input, storagePath: "user-2/job-9.mp4" });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "NOT_OWNER");
});
