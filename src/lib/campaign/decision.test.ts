import test from "node:test";
import assert from "node:assert/strict";
import { decideNextCampaign } from "./decision";

const analysis = {
  nextPosts: [
    { concept: "A", hook: "A", format: "short", channel: "TikTok", reason: "A hypothesis", testMetric: "CTR" },
    { concept: "B", hook: "B", format: "short", channel: "Instagram", reason: "B hypothesis", testMetric: "CTR" },
  ],
  customer: { likelySegments: ["segment"] },
};

test("campaign ranking uses measured channel profit when available", () => {
  const result = decideNextCampaign({
    analysis,
    performance: [
      { platform: "TikTok", postId: "t1", metrics: { impressions: 10000, clicks: 500, conversions: 25, grossProfit: 20000, adSpend: 5000 } },
      { platform: "Instagram", postId: "i1", metrics: { impressions: 10000, clicks: 400, conversions: 20, grossProfit: 9000, adSpend: 5000 } },
    ],
  });
  const tiktok = result.nextTests.find((x) => x.channel === "TikTok");
  const instagram = result.nextTests.find((x) => x.channel === "Instagram");
  assert.ok(tiktok && instagram);
  assert.equal(tiktok.expectedCtr, 0.05);
  assert.equal(tiktok.expectedCvr, 0.05);
  assert.equal(tiktok.expectedProfit, 15000);
  assert.match(tiktok.rankReason, /粗利/);
  assert.ok(tiktok.priorityScore > instagram.priorityScore);
});

test("campaign ranking does not invent sales evidence when performance is missing", () => {
  const result = decideNextCampaign({ analysis });
  assert.equal(result.nextTests.length, 2);
  assert.equal(result.nextTests[0].expectedCtr, null);
  assert.equal(result.nextTests[0].expectedCvr, null);
  assert.equal(result.nextTests[0].expectedProfit, null);
  assert.match(result.nextTests[0].rankReason, /未知/);
});
