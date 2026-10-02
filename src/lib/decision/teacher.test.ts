import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateTeacher, eligibleHistory } from "./teacher";
import { evidence, metric, past } from "./__fixtures__/evidence";

test("no metrics -> WAIT (insufficient_data)", () => {
  const r = evaluateTeacher(evidence({ current: null }));
  assert.equal(r.verdict, "wait");
  assert.equal(r.status, "insufficient_data");
});

test("metric measured after asOf is never used (no data leakage)", () => {
  const r = evaluateTeacher(evidence({ current: metric({ measuredAt: "2026-10-02T00:00:00.000Z", impressions: 5000, clicks: 200 }) }));
  assert.equal(r.verdict, "wait");
  assert.equal(r.ruleId, "no_metrics");
});

test("low exposure on a fresh post -> WAIT, not STOP/PIVOT", () => {
  const r = evaluateTeacher(evidence({ current: metric({ impressions: 120, clicks: 0 }) }));
  assert.equal(r.verdict, "wait");
  assert.equal(r.ruleId, "insufficient_exposure");
});

test("low exposure after the wait window -> PIVOT (no infinite wait)", () => {
  const r = evaluateTeacher(evidence({ current: metric({ impressions: 120, clicks: 0 }) }, { publishedAt: "2026-09-20T00:00:00.000Z" }));
  assert.equal(r.verdict, "pivot");
  assert.equal(r.ruleId, "no_reach");
});

test("CTR clearly above benchmark -> CONTINUE", () => {
  const r = evaluateTeacher(evidence({ current: metric({ impressions: 4000, clicks: 120 }) }));
  assert.equal(r.verdict, "continue");
  assert.equal(r.ruleId, "ctr_above_benchmark");
  assert.ok(r.confidence > 0.6);
});

test("CTR clearly below benchmark on first attempt -> PIVOT, not STOP", () => {
  const r = evaluateTeacher(evidence({ current: metric({ impressions: 6000, clicks: 10 }) }));
  assert.equal(r.verdict, "pivot");
  assert.equal(r.ruleId, "ctr_below_benchmark");
});

test("CTR below benchmark after two poor attempts in the lineage -> STOP", () => {
  const r = evaluateTeacher(evidence({ current: metric({ impressions: 6000, clicks: 10 }) }, { lineageVerdicts: ["pivot", "pivot"] }));
  assert.equal(r.verdict, "stop");
});

test("own baseline replaces the default benchmark once enough history exists", () => {
  const history = [past("a", { impressions: 2000, clicks: 100 }), past("b", { impressions: 2000, clicks: 110 }), past("c", { impressions: 2000, clicks: 90 })];
  // 2% CTR beats the 1% default but is clearly below the user's own 5% baseline.
  const r = evaluateTeacher(evidence({ current: metric({ impressions: 5000, clicks: 100 }), history }));
  assert.equal(r.verdict, "pivot");
  assert.ok(r.criteria.some((c) => c.name === "ctr" && c.threshold === 0.05));
});

test("history measured after asOf is excluded from the baseline", () => {
  const future = [past("a", { impressions: 2000, clicks: 100, measuredAt: "2026-10-05T00:00:00.000Z" }), past("b", { impressions: 2000, clicks: 110, measuredAt: "2026-10-05T00:00:00.000Z" }), past("c", { impressions: 2000, clicks: 90, measuredAt: "2026-10-05T00:00:00.000Z" })];
  const r = evaluateTeacher(evidence({ current: metric({ impressions: 5000, clicks: 100 }), history: future }));
  assert.equal(r.verdict, "continue");
});

test("good CTR but zero conversions after enough clicks -> PIVOT on offer", () => {
  const r = evaluateTeacher(evidence({ current: metric({ impressions: 4000, clicks: 120, conversions: 0 }) }));
  assert.equal(r.verdict, "pivot");
  assert.equal(r.ruleId, "ctr_ok_cvr_zero");
});

test("profitable paid traffic -> CONTINUE", () => {
  const r = evaluateTeacher(evidence({ current: metric({ impressions: 3000, clicks: 90, conversions: 5, revenue: 15000, grossProfit: 9000, adSpend: 4000 }) }));
  assert.equal(r.verdict, "continue");
  assert.equal(r.ruleId, "profitable_paid");
});

test("conversions but unprofitable -> PIVOT; repeated -> STOP", () => {
  const m = metric({ impressions: 3000, clicks: 90, conversions: 4, revenue: 12000, grossProfit: 4800, adSpend: 9000 });
  assert.equal(evaluateTeacher(evidence({ current: m })).verdict, "pivot");
  assert.equal(evaluateTeacher(evidence({ current: m }, { lineageVerdicts: ["pivot", "stop"] })).verdict, "stop");
});

test("engagement-only network never STOPs on a single weak result", () => {
  const m = metric({ source: "tiktok", views: 5000, likes: 10, comments: 1, shares: 0 });
  const r = evaluateTeacher(evidence({ current: m }, { network: "tiktok", lineageVerdicts: ["pivot"] }));
  assert.equal(r.verdict, "pivot");
  assert.ok(r.missingData.includes("clicks"));
});

test("engagement-only network STOPs only after repeated weak results", () => {
  const m = metric({ source: "tiktok", views: 5000, likes: 10, comments: 1, shares: 0 });
  const r = evaluateTeacher(evidence({ current: m }, { network: "tiktok", lineageVerdicts: ["pivot", "pivot", "pivot", "pivot"] }));
  assert.equal(r.verdict, "stop");
});

test("strong engagement -> CONTINUE", () => {
  const m = metric({ source: "tiktok", views: 5000, likes: 400, comments: 50, shares: 60 });
  assert.equal(evaluateTeacher(evidence({ current: m }, { network: "tiktok" })).verdict, "continue");
});

test("same evidence always yields the same verdict (consistency)", () => {
  const e = evidence({ current: metric({ impressions: 1800, clicks: 22 }) });
  const first = JSON.stringify(evaluateTeacher(e));
  for (let i = 0; i < 20; i++) assert.equal(JSON.stringify(evaluateTeacher(e)), first);
});

test("exposure exactly at the minimum enters decision logic instead of remaining insufficient", () => {
  const r = evaluateTeacher(evidence({ current: metric({ impressions: 300, clicks: null }) }));
  assert.notEqual(r.ruleId, "insufficient_exposure");
});

test("paid traffic with enough clicks but zero conversions pivots on the offer path", () => {
  const r = evaluateTeacher(evidence({
    current: metric({ impressions: 5000, clicks: 40, conversions: 0, revenue: 0, adSpend: 1000 }),
  }));
  assert.equal(r.verdict, "pivot");
  assert.equal(r.ruleId, "no_conversion_paid");
});

test("repeated paid zero-conversion failures stop after the lineage threshold", () => {
  const r = evaluateTeacher(evidence({
    current: metric({ impressions: 5000, clicks: 40, conversions: 0, revenue: 0, adSpend: 1000 }),
  }, { lineageVerdicts: ["pivot", "pivot"] }));
  assert.equal(r.verdict, "stop");
  assert.equal(r.ruleId, "no_conversion_repeated");
});

test("eligibleHistory excludes the current post, other networks, and future measurements", () => {
  const e = evidence({
    history: [
      past("post-1", { impressions: 1000, clicks: 20 }, "linkedin"),
      past("other-network", { impressions: 1000, clicks: 20 }, "instagram"),
      past("future", { impressions: 1000, clicks: 20, measuredAt: "2026-10-02T00:00:00.000Z" }, "linkedin"),
      past("valid", { impressions: 1000, clicks: 20 }, "linkedin"),
    ],
  });
  const result = eligibleHistory(e);
  assert.deepEqual(result.map((x) => x.socialPostId), ["valid"]);
});

test("teacher output includes criteria for the actual rule used", () => {
  const r = evaluateTeacher(evidence({ current: metric({ impressions: 5000, clicks: 0 }) }));
  assert.equal(r.ruleId, "ctr_below_benchmark");
  assert.ok(r.criteria.some((x) => x.name === "ctr"));
  assert.ok(r.criteria.some((x) => x.name === "ctr_ci95"));
});


test("unknown conversion data never behaves like zero conversions", () => {
  const r = evaluateTeacher(evidence({
    current: metric({ impressions: 5000, clicks: 40, conversions: null, revenue: null, adSpend: 1000 }),
  }));
  assert.equal(r.sample.conversions, null);
  assert.ok(r.missingData.includes("conversions"));
  assert.notEqual(r.ruleId, "no_conversion_paid");
  assert.notEqual(r.ruleId, "no_conversion_repeated");
});

test("unknown click data remains null instead of becoming zero", () => {
  const r = evaluateTeacher(evidence({
    current: metric({ impressions: 5000, clicks: null, conversions: null }),
  }));
  assert.equal(r.sample.clicks, null);
  assert.ok(r.missingData.includes("clicks"));
});
