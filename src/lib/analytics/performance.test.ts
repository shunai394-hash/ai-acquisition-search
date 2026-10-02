import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeFacebookPerformance,
  normalizeInstagramPerformance,
  normalizeTikTokPerformance,
  normalizeXPerformance,
  normalizeYouTubePerformance,
} from "./performance";

test("normalizes X public metrics into the shared shape", async () => {
  const r = await normalizeXPerformance({ postId: "123", publicMetrics: { impression_count: 10, like_count: 2, reply_count: 1, retweet_count: 3, url_link_clicks: 4 } });
  assert.equal(r.platform, "x");
  assert.equal(r.postId, "123");
  assert.deepEqual(r.metrics, { impressions: 10, likes: 2, comments: 1, shares: 3, clicks: 4 });
});

test("normalizes YouTube string counters as numbers", async () => {
  const r = await normalizeYouTubePerformance({ videoId: "abc", statistics: { viewCount: "100", likeCount: "7", commentCount: "2" } });
  assert.equal(r.platform, "youtube");
  assert.deepEqual(r.metrics, { views: 100, likes: 7, comments: 2 });
});

test("normalizes TikTok metrics and preserves share URL", async () => {
  const r = await normalizeTikTokPerformance({ id: "tt1", share_url: "https://tiktok.com/x", view_count: 1000, like_count: 80, comment_count: 4, share_count: 9 });
  assert.equal(r.platform, "tiktok");
  assert.equal(r.url, "https://tiktok.com/x");
  assert.deepEqual(r.metrics, { views: 1000, likes: 80, comments: 4, shares: 9 });
});

test("normalizes Instagram data-array metrics", async () => {
  const r = await normalizeInstagramPerformance({ id: "ig1", data: [
    { name: "views", values: [{ value: 10 }, { value: 25 }] },
    { name: "likes", values: [{ value: 3 }] },
  ]});
  assert.equal(r.postId, "ig1");
  assert.equal(r.metrics.views, 25);
  assert.equal(r.metrics.likes, 3);
  assert.equal(r.metrics.comments, null);
});

test("normalizes Facebook nested reaction/comment/share metrics", async () => {
  const r = await normalizeFacebookPerformance({
    id: "fb1",
    permalink_url: "https://facebook.com/p/1",
    statistics: { views: 200, reactions: { summary: { total_count: 12 } }, comments_count: 4, share_count: 6 },
  });
  assert.equal(r.platform, "facebook");
  assert.equal(r.metrics.views, 200);
  assert.equal(r.metrics.likes, 12);
  assert.equal(r.metrics.comments, 4);
  assert.equal(r.metrics.shares, 6);
});
