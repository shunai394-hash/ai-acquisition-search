import { test } from "node:test";
import assert from "node:assert/strict";
import { buildDecision, refineNextAction } from "./engine";
import { evidence, metric } from "./__fixtures__/evidence";

const REQUIRED = ["action_type", "target_customer", "hypothesis", "reason", "expected_outcome", "primary_metric", "learning_objective", "priority", "evidence", "confidence", "logic_version", "prompt_version", "model_version", "generated_at"] as const;

test("decision is fully structured", () => {
  const d = buildDecision(evidence({ current: metric({ impressions: 4000, clicks: 120 }) }));
  for (const key of REQUIRED) assert.ok(d[key] !== undefined && d[key] !== "", `missing ${key}`);
  assert.equal(d.action_type, "reinforce_hypothesis");
  assert.equal(d.next_action.generate_creative, true);
  assert.equal(d.next_action.change_variable, "hook");
});

test("evidence includes product, customer, EC-Pulse and metrics", () => {
  const d = buildDecision(evidence({ current: metric({ impressions: 4000, clicks: 120 }) }));
  const sources = new Set(d.evidence.map((e) => e.source));
  for (const s of ["product", "customer", "ec_pulse", "post_metrics", "hypothesis"]) assert.ok(sources.has(s as never), s);
  assert.ok(d.evidence.some((e) => e.key === "gross_margin_rate" && e.value === 0.6));
});

test("STOP and WAIT never request a creative", () => {
  const stop = buildDecision(evidence({ current: metric({ impressions: 6000, clicks: 10 }) }, { lineageVerdicts: ["pivot", "pivot"] }));
  assert.equal(stop.verdict, "stop");
  assert.equal(stop.next_action.generate_creative, false);
  const wait = buildDecision(evidence({ current: metric({ impressions: 50 }) }));
  assert.equal(wait.verdict, "wait");
  assert.equal(wait.action_type, "wait_for_data");
  assert.equal(wait.next_action.generate_creative, false);
});

test("PIVOT uses an EC-Pulse pain that differs from the current angle", () => {
  const d = buildDecision(evidence({ current: metric({ impressions: 6000, clicks: 10 }) }));
  assert.equal(d.verdict, "pivot");
  assert.equal(d.next_action.angle, "結露でカバンが濡れる");
  assert.notEqual(d.next_action.angle, "飲み物がすぐぬるくなる");
});

test("PIVOT without EC-Pulse data still produces a changed hypothesis", () => {
  const e = evidence({ current: metric({ impressions: 6000, clicks: 10 }), market: { status: "unavailable", topPains: [], emergingPains: [] } });
  const d = buildDecision(e);
  assert.equal(d.verdict, "pivot");
  assert.ok(d.evidence.some((x) => x.source === "ec_pulse" && x.value === "unavailable"));
});

test("input_hash is stable across asOf and generated_at for identical data", () => {
  const a = buildDecision(evidence({ current: metric({ impressions: 4000, clicks: 120 }) }), new Date("2026-10-01T00:00:00Z"));
  const b = buildDecision(evidence({ asOf: "2026-10-01T06:00:00.000Z", current: metric({ impressions: 4000, clicks: 120 }) }), new Date("2026-10-01T06:00:00Z"));
  assert.equal(a.input_hash, b.input_hash);
  const c = buildDecision(evidence({ current: metric({ impressions: 4000, clicks: 121 }) }));
  assert.notEqual(a.input_hash, c.input_hash);
});

test("WAIT expiring into a verdict changes the hash (no stale cached WAIT)", () => {
  const fresh = buildDecision(evidence({ current: metric({ impressions: 100 }) }));
  const expired = buildDecision(evidence({ asOf: "2026-10-10T00:00:00.000Z", current: metric({ impressions: 100 }) }));
  assert.equal(fresh.verdict, "wait");
  assert.equal(expired.verdict, "pivot");
  assert.notEqual(fresh.input_hash, expired.input_hash);
});

test("LLM refinement cannot change the verdict and ignores invalid output", async () => {
  const e = evidence({ current: metric({ impressions: 4000, clicks: 120 }) });
  const d = buildDecision(e);
  const refined = await refineNextAction(d, e, async () => JSON.stringify({ verdict: "stop", hook: "新しいHook", angle: "別訴求" }), "test-model");
  assert.equal(refined.verdict, "continue");
  assert.equal(refined.next_action.hook, "新しいHook");
  assert.equal(refined.next_action.angle, d.next_action.angle, "CONTINUE keeps the angle");
  assert.equal(refined.model_version, "test-model");
  const broken = await refineNextAction(d, e, async () => "not json", "test-model");
  assert.deepEqual(broken, d);
  const failed = await refineNextAction(d, e, async () => { throw new Error("AI API down"); }, "test-model");
  assert.deepEqual(failed, d);
});

test("refinement is skipped for STOP", async () => {
  const e = evidence({ current: metric({ impressions: 6000, clicks: 10 }) }, { lineageVerdicts: ["pivot", "pivot"] });
  const d = buildDecision(e);
  let called = false;
  const r = await refineNextAction(d, e, async () => { called = true; return "{}"; }, "m");
  assert.equal(called, false);
  assert.equal(r.next_action.generate_creative, false);
});


test("invalid evidence always waits instead of making a business decision", () => {
  const cases = [
    metric({ impressions: -1 }),
    metric({ impressions: 1000, clicks: 1001 }),
    metric({ impressions: 1000, views: 1001 }),
    metric({ impressions: 1000, clicks: 100, conversions: 101 }),
  ];
  for (const current of cases.slice(0, 4)) {
    const d = buildDecision(evidence({ current }));
    assert.equal(d.verdict, "wait");
    assert.equal(d.teacher.ruleId, "evidence_quality");
    assert.equal(d.next_action.generate_creative, false);
  }
});

test("metric measured after decision time is rejected", () => {
  const d = buildDecision(evidence({
    asOf: "2026-10-01T00:00:00.000Z",
    current: metric({ impressions: 4000, clicks: 120, measuredAt: "2026-10-01T00:00:01.000Z" }),
  }));
  assert.equal(d.verdict, "wait");
  assert.ok(d.teacher.missingData.includes("metric_after_decision_time"));
});

test("EC-Pulse evidence captured after decision time is rejected", () => {
  const d = buildDecision(evidence({
    asOf: "2026-10-01T00:00:00.000Z",
    market: {
      status: "ok",
      capturedAt: "2026-10-01T00:00:01.000Z",
      topPains: [],
      emergingPains: [],
    },
    current: metric({ impressions: 4000, clicks: 120 }),
  }));
  assert.equal(d.verdict, "wait");
  assert.ok(d.teacher.missingData.includes("market_evidence_after_decision_time"));
});

test("invalid product economics are rejected", () => {
  const d = buildDecision(evidence({
    product: {
      name: "テスト商品", url: "https://example.com/product", price: 1000, cost: 1200,
      features: [], strengths: [], useCases: [], salesChannels: [],
    },
    current: metric({ impressions: 4000, clicks: 120 }),
  }));
  assert.equal(d.verdict, "wait");
  assert.ok(d.teacher.missingData.includes("product_cost_exceeds_price"));
});

test("valid evidence keeps the normal deterministic verdict", () => {
  const d = buildDecision(evidence({ current: metric({ impressions: 4000, clicks: 120 }) }));
  assert.equal(d.verdict, "continue");
  assert.notEqual(d.teacher.ruleId, "evidence_quality");
});


test("LLM refinement enforces documented field length limits", async () => {
  const e = evidence({ current: metric({ impressions: 4000, clicks: 120 }) });
  const d = buildDecision(e);
  const refined = await refineNextAction(
    d,
    e,
    async () => JSON.stringify({
      hook: "あ".repeat(61),
      angle: "い".repeat(81),
      description: "う".repeat(121),
    }),
    "test-model",
  );
  assert.equal(refined.next_action.hook, d.next_action.hook);
  assert.equal(refined.next_action.angle, d.next_action.angle);
  assert.equal(refined.next_action.description, d.next_action.description);
});

test("LLM refinement cannot change hook when the decision variable is offer", async () => {
  const e = evidence({ current: metric({ impressions: 5000, clicks: 40, conversions: 0, revenue: 0, adSpend: 1000 }) });
  const d = buildDecision(e);
  assert.equal(d.verdict, "pivot");
  assert.equal(d.next_action.change_variable, "offer");
  const refined = await refineNextAction(
    d,
    e,
    async () => JSON.stringify({ hook: "不正なHook変更", angle: "不正な訴求変更", description: "説明だけ変更" }),
    "test-model",
  );
  assert.equal(refined.next_action.hook, d.next_action.hook);
  assert.equal(refined.next_action.angle, d.next_action.angle);
  assert.equal(refined.next_action.description, "説明だけ変更");
});


test("LLM refinement for hook cannot change angle", async () => {
  const e = evidence({ current: metric({ impressions: 4000, clicks: 120 }) });
  const d = buildDecision(e);
  assert.equal(d.verdict, "continue");
  assert.equal(d.next_action.change_variable, "hook");
  const refined = await refineNextAction(
    d,
    e,
    async () => JSON.stringify({ hook: "新しいHook", angle: "不正な訴求変更", description: "説明変更" }),
    "test-model",
  );
  assert.equal(refined.next_action.hook, "新しいHook");
  assert.equal(refined.next_action.angle, d.next_action.angle);
  assert.equal(refined.next_action.description, "説明変更");
});

test("LLM refinement for angle cannot change hook", async () => {
  const e = evidence({ current: metric({ impressions: 6000, clicks: 10 }) });
  const d = buildDecision(e);
  assert.equal(d.verdict, "pivot");
  assert.equal(d.next_action.change_variable, "angle");
  const refined = await refineNextAction(
    d,
    e,
    async () => JSON.stringify({ hook: "不正なHook変更", angle: "新しい訴求変更", description: "説明変更" }),
    "test-model",
  );
  assert.equal(refined.next_action.hook, d.next_action.hook);
  assert.equal(refined.next_action.angle, "新しい訴求変更");
  assert.equal(refined.next_action.description, "説明変更");
});

test("next action has exactly one mutable creative variable when generating", () => {
  const cases = [
    {
      name: "continue",
      decision: buildDecision(evidence({ current: metric({ impressions: 4000, clicks: 120 }) })),
    },
    {
      name: "pivot-angle",
      decision: buildDecision(evidence({ current: metric({ impressions: 6000, clicks: 10 }) })),
    },
    {
      name: "pivot-offer",
      decision: buildDecision(
        evidence({ current: metric({ impressions: 5000, clicks: 40, conversions: 0, revenue: 0, adSpend: 1000 }) }),
      ),
    },
  ];

  for (const { name, decision } of cases) {
    assert.equal(decision.next_action.generate_creative, true, name);
    assert.ok(["hook", "angle", "offer"].includes(decision.next_action.change_variable ?? ""), name);
  }

  const stop = buildDecision(
    evidence({ current: metric({ impressions: 6000, clicks: 10 }) }, { lineageVerdicts: ["pivot", "pivot"] }),
  );
  const wait = buildDecision(evidence({ current: metric({ impressions: 50 }) }));
  for (const decision of [stop, wait]) {
    assert.equal(decision.next_action.generate_creative, false);
    assert.equal(decision.next_action.change_variable, null);
    assert.equal(decision.next_action.hook, null);
    assert.equal(decision.next_action.angle, null);
  }
});
