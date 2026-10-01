import { test } from "node:test";
import assert from "node:assert/strict";
import { snapshotFromRow } from "./evidence";

const row = { id: "m1", measured_at: "2026-09-30T00:00:00Z", impressions: 0, views: 1200, likes: 30, comments: 4, shares: 2, saves: 0, clicks: 0, conversions: 0, revenue: 0, gross_profit: 0, ad_spend: 0, ctr: null };

test("SNS zeros for unmeasured fields become null (TikTok has no clicks/sales)", () => {
  const s = snapshotFromRow({ ...row, raw: { source: "tiktok" } }, "tiktok");
  assert.equal(s.views, 1200);
  assert.equal(s.clicks, null);
  assert.equal(s.conversions, null);
  assert.equal(s.revenue, null);
  assert.equal(s.impressions, null);
});

test("LinkedIn clicks are known only when CTR was computable", () => {
  assert.equal(snapshotFromRow({ ...row, raw: { source: "linkedin" } }, "linkedin").clicks, null);
  assert.equal(snapshotFromRow({ ...row, clicks: 12, ctr: 0.01, raw: { source: "linkedin" } }, "linkedin").clicks, 12);
});

test("manual metrics: only submitted fields are known, explicit 0 stays 0", () => {
  const s = snapshotFromRow({ ...row, impressions: 2000, clicks: 0, raw: { socialPostId: "p", impressions: 2000, clicks: 0 } }, "x");
  assert.equal(s.source, "manual");
  assert.equal(s.impressions, 2000);
  assert.equal(s.clicks, 0);
  assert.equal(s.revenue, null);
});
