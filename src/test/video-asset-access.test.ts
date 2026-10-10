// Generated videos are served only through short-lived signed URLs, scoped to
// the owning user, and SNS publishing receives a fresh signed URL.
import { beforeEach, mock, test } from "node:test";
import assert from "node:assert/strict";
import { FakeSupabase } from "./fake-supabase";

process.env.NEXT_PUBLIC_SUPABASE_URL = "https://proj.supabase.co";

let db = new FakeSupabase();
const signed: Array<{ bucket: string; path: string; ttl: number; download?: string }> = [];
const withStorage = () => Object.assign(db, {
  storage: {
    from: (bucket: string) => ({
      createSignedUrl: async (path: string, ttl: number, options?: { download?: string }) => {
        signed.push({ bucket, path, ttl, download: options?.download });
        return { data: { signedUrl: `https://proj.supabase.co/storage/v1/object/sign/${bucket}/${path}?token=t${signed.length}` }, error: null };
      },
    }),
  },
});

mock.module("../lib/billing.ts", {
  namedExports: {
    getAdminSupabase: () => withStorage(),
    getUserFromBearer: async (request: Request) => ({ id: request.headers.get("x-user") || "u1" }),
    refundMonthlyUsage: async () => ({ refunded: true }),
  },
});
const tiktokUrls: string[] = [];
mock.module("../lib/social/tiktok.ts", {
  namedExports: {
    getTikTokAccessToken: async () => "tt-token",
    publishTikTokVideo: async ({ videoUrl }: { videoUrl: string }) => { tiktokUrls.push(videoUrl); return { publishId: "pub-1", privacyLevel: "SELF_ONLY", creatorUsername: "me" }; },
    resolveTikTokVideoId: async () => ({ videoId: "vid-1", status: "PUBLISH_COMPLETE" }),
  },
});

const { videoAssetPathFromUrl, isOwnedVideoPath, isVideoBucketPrivate } = await import("../lib/video/asset-access");
const { GET: videoJob } = await import("../app/api/video/jobs/[id]/route");
const { POST: publish } = await import("../app/api/social/publish/route");
const { POST: recoverSocialPublish } = await import("../app/api/social/publish/recover/route");

beforeEach(() => {
  db = new FakeSupabase();
  signed.length = 0;
  tiktokUrls.length = 0;
});

test("private video bucket health gate fails closed", () => {
  assert.equal(isVideoBucketPrivate({ ok: true, known: true, public: false }), true);
  assert.equal(isVideoBucketPrivate({ ok: true, known: true, public: true }), false);
  assert.equal(isVideoBucketPrivate({ ok: false, known: false }), false);
  assert.equal(isVideoBucketPrivate({ ok: true, known: false, public: false }), false);
  assert.equal(isVideoBucketPrivate({ ok: true }), false);
});

test("only this project's video-assets URLs map to a storage path", () => {
  assert.equal(videoAssetPathFromUrl("https://proj.supabase.co/storage/v1/object/public/video-assets/u1/job.mp4"), "u1/job.mp4");
  assert.equal(videoAssetPathFromUrl("https://proj.supabase.co/storage/v1/object/sign/video-assets/u1/job.mp4?token=x"), "u1/job.mp4");
  assert.equal(videoAssetPathFromUrl("https://other.supabase.co/storage/v1/object/public/video-assets/u1/job.mp4"), null);
  assert.equal(videoAssetPathFromUrl("https://proj.supabase.co/storage/v1/object/public/video-inputs/u1/a.png"), null);
  assert.equal(videoAssetPathFromUrl("https://cdn.example.com/video.mp4"), null);
  assert.equal(isOwnedVideoPath("u1", "u1/job.mp4"), true);
  assert.equal(isOwnedVideoPath("u1", "u2/job.mp4"), false);
  assert.equal(isOwnedVideoPath("u1", "u1/../u2/job.mp4"), false);
});

test("the job API returns 1h signed playback/download URLs instead of the stored public URL", async () => {
  db.seed("production_jobs", [{ id: "job-1", user_id: "u1", status: "completed", request_id: "r", provider_response: {} }]);
  db.seed("video_assets", [{ id: "a1", production_job_id: "job-1", user_id: "u1", storage_path: "u1/job-1.mp4", video_url: "https://proj.supabase.co/storage/v1/object/public/video-assets/u1/job-1.mp4", metadata: { has_audio_track: false, requestId: "hf-secret-req" } }]);
  const res = await videoJob(new Request("https://app.test/api/video/jobs/job-1"), { params: Promise.resolve({ id: "job-1" }) } as never);
  const body = await res.json();
  assert.equal(res.status, 200, JSON.stringify(body));
  assert.match(body.asset.video_url, /\/object\/sign\/video-assets\/u1\/job-1\.mp4\?token=/);
  assert.ok(!String(body.asset.video_url).includes("/object/public/"));
  assert.match(body.asset.download_url, /token=/);
  assert.equal(body.asset.has_audio_track, false, "silent output is reported to the UI");
  assert.equal(body.asset.metadata, undefined, "provider metadata stays server-side");
  assert.deepEqual(signed.map((s) => [s.bucket, s.ttl, s.download ?? null]), [["video-assets", 3600, null], ["video-assets", 3600, "ai-acquisition-video.mp4"]]);
});

test("another user's job is not visible", async () => {
  db.seed("production_jobs", [{ id: "job-2", user_id: "u2", status: "completed", provider_response: {} }]);
  const res = await videoJob(new Request("https://app.test/api/video/jobs/job-2"), { params: Promise.resolve({ id: "job-2" }) } as never);
  assert.equal(res.status, 404);
  assert.equal(signed.length, 0);
});

function publishRequest(videoUrl: string, user = "u1") {
  return new Request("https://app.test/api/social/publish", {
    method: "POST",
    headers: { "content-type": "application/json", "x-user": user },
    body: JSON.stringify({ socialPostId: "post-1", videoUrl, caption: "caption", platforms: ["tiktok"] }),
  });
}

test("publishing our own video hands TikTok a fresh 6h signed URL, not the caller's link", async () => {
  db.seed("social_posts", [{ id: "post-1", user_id: "u1", network: "tiktok", status: "planned", metadata: {} }]);
  db.seed("tiktok_publish_consents", [{ user_id: "u1", consented_at: new Date().toISOString() }]);
  // An expired 1h playback link from the browser.
  const res = await publish(publishRequest("https://proj.supabase.co/storage/v1/object/sign/video-assets/u1/job-1.mp4?token=expired"));
  const body = await res.json();
  assert.equal(res.status, 200, JSON.stringify(body));
  assert.equal(tiktokUrls.length, 1, JSON.stringify(body));
  assert.match(tiktokUrls[0], /\/object\/sign\/video-assets\/u1\/job-1\.mp4\?token=t1$/);
  assert.equal(signed[0].ttl, 6 * 60 * 60);
});

test("manual recovery can finalize a pending social post", async () => {
  db.seed("social_posts", [{
    id: "pending-post",
    user_id: "u1",
    network: "tiktok",
    status: "pending",
    metadata: { source_social_post_id: "source-post", publishId: "pub-1" },
  }]);
  const response = await recoverSocialPublish(new Request("https://app.test/api/social/publish/recover", {
    method: "POST",
    headers: { "content-type": "application/json", "x-user": "u1" },
    body: JSON.stringify({ socialPostId: "pending-post", platform: "tiktok", externalPostId: "video-123", postUrl: "https://www.tiktok.com/@creator/video/video-123" }),
  }));
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.equal(body.recovered, true);
  assert.equal(db.table("social_posts").find((row) => row.id === "pending-post")?.status, "published");
});

test("publishing another user's stored video is refused before any SNS call", async () => {
  db.seed("social_posts", [{ id: "post-1", user_id: "u1", network: "tiktok", status: "planned", metadata: {} }]);
  db.seed("tiktok_publish_consents", [{ user_id: "u1", consented_at: new Date().toISOString() }]);
  const res = await publish(publishRequest("https://proj.supabase.co/storage/v1/object/public/video-assets/u2/secret.mp4"));
  assert.equal(res.status, 403);
  assert.equal(tiktokUrls.length, 0);
  assert.equal(signed.length, 0);
});
