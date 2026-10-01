import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeMetricRows, type PostMetricRow } from "../metrics";
import { buildBaseline, evaluateTeacher } from "../teacher";

const manual = (values: Partial<PostMetricRow>, at = "2026-09-01T00:00:00Z"): PostMetricRow => ({
  id: `m-${at}`,
  measured_at: at,
  ...values,
  raw: Object.fromEntries(Object.entries(values).map(([k, v]) => [k === "gross_profit" ? "grossProfit" : k === "ad_spend" ? "adSpend" : k, v])),
});

const auto = (source: string, values: Partial<PostMetricRow>, at: string): PostMetricRow => ({
  id: `a-${at}`,
  measured_at: at,
  impressions: 0, views: 0, likes: 0, comments: 0, shares: 0, saves: 0, clicks: 0, conversions: 0, revenue: 0, gross_profit: 0, ad_spend: 0,
  ...values,
  raw: { source, data: {} },
});

test("auto SNS rows do not erase manually entered clicks and sales", () => {
  const merged = mergeMetricRows([
    manual({ clicks: 120, conversions: 6, revenue: 30000, ad_spend: 10000, impressions: 8000 }, "2026-09-01T00:00:00Z"),
    auto("tiktok", { views: 9000, likes: 400 }, "2026-09-02T00:00:00Z"),
  ]);
  assert.equal(merged.values.clicks, 120);
  assert.equal(merged.values.conversions, 6);
  assert.equal(merged.values.views, 9000);
  assert.ok(merged.known.includes("revenue"));
  assert.ok(!merged.sources.includes("unknown"));
});

test("auto rows mark unmeasured fields as unknown instead of zero", () => {
  const merged = mergeMetricRows([auto("youtube", { views: 3000, likes: 50 }, "2026-09-02T00:00:00Z")]);
  assert.ok(!merged.known.includes("clicks"));
  assert.ok(!merged.known.includes("conversions"));
});

test("no metrics -> WAIT / insufficient_data", () => {
  const r = evaluateTeacher({ network: "tiktok", ageHours: 100, metrics: mergeMetricRows([]) });
  assert.equal(r.verdict, "wait");
  assert.equal(r.status, "insufficient_data");
});

test("too young post -> WAIT even with bad numbers", () => {
  const r = evaluateTeacher({ network: "x", ageHours: 5, metrics: mergeMetricRows([manual({ impressions: 5000, clicks: 1 })]) });
  assert.equal(r.verdict, "wait");
});

test("small reach before maturity -> WAIT, after maturity -> PIVOT (never STOP)", () => {
  const metrics = mergeMetricRows([auto("tiktok", { views: 120, likes: 3 }, "2026-09-02T00:00:00Z")]);
  assert.equal(evaluateTeacher({ network: "tiktok", ageHours: 30, metrics }).verdict, "wait");
  const mature = evaluateTeacher({ network: "tiktok", ageHours: 96, metrics, pivotStreak: 5 });
  assert.equal(mature.verdict, "pivot");
  assert.equal(mature.signalTier, "reach");
});

test("profitable ROAS with enough conversions -> CONTINUE", () => {
  const r = evaluateTeacher({
    network: "instagram", ageHours: 48,
    metrics: mergeMetricRows([manual({ impressions: 10000, clicks: 200, conversions: 8, revenue: 40000, ad_spend: 10000, gross_profit: 20000 })]),
  });
  assert.equal(r.verdict, "continue");
  assert.equal(r.hypothesisMatch, "supported");
  assert.ok(r.confidence >= 0.8);
});

test("severe economic loss PIVOTs first, STOPs only after repeated pivots", () => {
  const metrics = mergeMetricRows([manual({ impressions: 20000, clicks: 300, conversions: 0, revenue: 0, ad_spend: 30000, gross_profit: 0 })]);
  const first = evaluateTeacher({ network: "x", ageHours: 80, metrics, pivotStreak: 0 });
  assert.equal(first.verdict, "pivot");
  const later = evaluateTeacher({ network: "x", ageHours: 80, metrics, pivotStreak: 2 });
  assert.equal(later.verdict, "stop");
  assert.equal(later.hypothesisMatch, "rejected");
});

test("engagement-only signals can never produce STOP", () => {
  const metrics = mergeMetricRows([auto("tiktok", { views: 50000, likes: 10 }, "2026-09-02T00:00:00Z")]);
  const baseline = buildBaseline([
    mergeMetricRows([auto("tiktok", { views: 5000, likes: 500 }, "2026-08-01T00:00:00Z")]),
    mergeMetricRows([auto("tiktok", { views: 6000, likes: 600 }, "2026-08-02T00:00:00Z")]),
    mergeMetricRows([auto("tiktok", { views: 7000, likes: 700 }, "2026-08-03T00:00:00Z")]),
  ]);
  const r = evaluateTeacher({ network: "tiktok", ageHours: 200, metrics, baseline, pivotStreak: 10 });
  assert.equal(r.verdict, "pivot");
});

test("engagement above baseline -> CONTINUE with lower confidence than sales", () => {
  const metrics = mergeMetricRows([auto("tiktok", { views: 10000, likes: 2000 }, "2026-09-02T00:00:00Z")]);
  const baseline = buildBaseline([1, 2, 3].map((i) => mergeMetricRows([auto("tiktok", { views: 5000, likes: 250 }, `2026-08-0${i}T00:00:00Z`)])));
  const r = evaluateTeacher({ network: "tiktok", ageHours: 48, metrics, baseline });
  assert.equal(r.verdict, "continue");
  assert.ok(r.confidence < 0.7);
});

test("CTR win against baseline and alternate-metric warning when primary metric unmeasured", () => {
  const metrics = mergeMetricRows([manual({ impressions: 5000, clicks: 150 })]);
  const r = evaluateTeacher({ network: "x", ageHours: 48, metrics, primaryMetric: "CVR" });
  assert.equal(r.verdict, "continue");
  assert.ok(r.checks.some((c) => c.name === "primary_metric_measured" && c.passed === false));
});

test("same input always gives the same result", () => {
  const rows = [manual({ impressions: 5000, clicks: 20 }), auto("x", { impressions: 5200, likes: 30 }, "2026-09-03T00:00:00Z")];
  const a = evaluateTeacher({ network: "x", ageHours: 90, metrics: mergeMetricRows(rows) });
  const b = evaluateTeacher({ network: "x", ageHours: 90, metrics: mergeMetricRows([...rows].reverse()) });
  assert.deepEqual(a, b);
});
