import assert from "node:assert/strict";
import test from "node:test";
import {
  backoffMs,
  classifyPublishError,
  composeCaption,
  findDuplicate,
  isInsideWindow,
  manualRetryPolicy,
  nextOpenInstant,
  performanceSuggestions,
  redactError,
  zonedLocalToUtc,
  type PostingRule,
} from "./queue";

const tokyoDay: PostingRule = {
  timezone: "Asia/Tokyo",
  maxPerDay: 2,
  weekdays: [0, 1, 2, 3, 4, 5, 6],
  windowStart: "09:00",
  windowEnd: "18:00",
  paused: false,
};

test("Tokyo wall clock converts to UTC", () => {
  const utc = zonedLocalToUtc("2026-10-24T18:00", "Asia/Tokyo");
  assert.equal(utc?.toISOString(), "2026-10-24T09:00:00.000Z");
});

test("posting window uses the account timezone", () => {
  const noon = new Date("2026-10-24T03:00:00.000Z");
  const night = new Date("2026-10-24T15:00:00.000Z");
  assert.equal(isInsideWindow(noon, tokyoDay), true);
  assert.equal(isInsideWindow(night, tokyoDay), false);
  const next = nextOpenInstant(night, tokyoDay);
  assert.equal(next?.toISOString(), "2026-10-25T00:00:00.000Z");
});

test("duplicate detection matches the same asset inside 24 hours", () => {
  const now = new Date("2026-10-24T03:00:00.000Z");
  const hit = findDuplicate({
    assetId: "asset-1",
    network: "tiktok",
    caption: "別の文面",
    now,
    recent: [{
      assetId: "asset-1",
      network: "tiktok",
      caption: "既存",
      status: "published",
      scheduledAt: "2026-10-24T01:00:00.000Z",
    }],
  });
  assert.ok(hit);
  const old = findDuplicate({
    assetId: "asset-1",
    network: "tiktok",
    caption: "別の文面",
    now,
    recent: [{
      assetId: "asset-1",
      network: "tiktok",
      caption: "既存",
      status: "published",
      scheduledAt: "2026-10-22T01:00:00.000Z",
    }],
  });
  assert.equal(old, null);
});

test("retry stays blocked after the provider has accepted the post", () => {
  const blocked = manualRetryPolicy({ status: "failed", publish_accepted_at: "2026-10-24T00:00:00.000Z" });
  assert.equal(blocked.allowed, false);
  const uncertain = manualRetryPolicy({ status: "failed", publish_accepted_at: null, metadata: { retry_safety: "confirm_no_duplicate" } });
  assert.equal(uncertain.allowed, true);
  assert.equal(uncertain.confirm, true);
});

test("backoff grows and secrets are removed from errors", () => {
  assert.equal(backoffMs(1), 60_000);
  assert.equal(backoffMs(3), 240_000);
  assert.equal(classifyPublishError("TikTok token refresh failed"), "reauth");
  assert.equal(classifyPublishError("rate_limit_exceeded"), "safe_retry");
  assert.equal(classifyPublishError("HTTP 503 temporarily unavailable"), "safe_retry");
  assert.equal(classifyPublishError("The operation timed out"), "uncertain");
  const redacted = redactError("failed https://cdn.example/video.mp4?token=secret bearer abc");
  assert.equal(redacted.includes("secret"), false);
  assert.equal(redacted.includes("bearer [redacted]"), true);
});

test("suggestions stay empty until a real view count exists", () => {
  const none = performanceSuggestions([{
    caption: "テスト",
    publishedAt: "2026-10-24T03:00:00.000Z",
    views: null,
    likes: null,
    metricsStatus: "unavailable",
  }], "Asia/Tokyo");
  assert.match(none[0], /推奨は出していません/);
  const some = performanceSuggestions([{
    caption: "朝の投稿",
    publishedAt: "2026-10-24T00:00:00.000Z",
    views: 12,
    likes: 1,
    metricsStatus: "available",
  }], "Asia/Tokyo");
  assert.match(some[0], /09:00台/);
  assert.match(some[0], /自動では変更しません/);
});

test("hashtags count toward the composed caption", () => {
  assert.equal(composeCaption("本文", ["tag"]), "本文\n#tag");
});
