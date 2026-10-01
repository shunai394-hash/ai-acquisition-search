import { test } from "node:test";
import assert from "node:assert/strict";
import { buildDeterministicDecision, decisionInputHash, refineDecisionWithLlm, structuredDecisionSchema } from "../decision";
import { makeContext, manualRow } from "./fixtures";

const losingRows = [manualRow({ impressions: 20000, clicks: 300, conversions: 0, revenue: 0, ad_spend: 30000, gross_profit: 0 })];

test("decision is fully structured and versioned", () => {
  const d = buildDeterministicDecision(makeContext());
  assert.ok(structuredDecisionSchema.safeParse(d).success);
  for (const key of ["action_type", "target_customer", "hypothesis", "reason", "expected_outcome", "primary_metric", "learning_objective", "priority", "evidence", "confidence", "logic_version", "prompt_version", "model_version", "generated_at"] as const) {
    assert.ok(d[key] !== undefined && d[key] !== "", key);
  }
  assert.ok(d.evidence.some((e) => e.source.startsWith("ec-pulse")), "EC-Pulse evidence is attached");
  assert.equal(d.evidence_coverage.missing.length, 0);
});

test("same input -> same hash and same conclusion; changed metrics -> new hash", () => {
  const a = buildDeterministicDecision(makeContext());
  const b = buildDeterministicDecision(makeContext({ asOf: "2026-09-05T06:00:00Z" }));
  assert.equal(a.input_hash, b.input_hash);
  assert.equal(a.verdict, b.verdict);
  const c = buildDeterministicDecision(makeContext({ rows: [manualRow({ impressions: 5000, clicks: 200 })] }));
  assert.notEqual(a.input_hash, c.input_hash);
});

test("STOP and WAIT never request creative generation", () => {
  const stop = buildDeterministicDecision(makeContext({ rows: losingRows, pivotStreak: 2 }));
  assert.equal(stop.verdict, "stop");
  assert.equal(stop.action_type, "stop_line");
  assert.equal(stop.next_action.generate_creative, false);

  const wait = buildDeterministicDecision(makeContext({ rows: [], post: { ...makeContext().post } }));
  assert.equal(wait.verdict, "wait");
  assert.equal(wait.action_type, "collect_more_data");
  assert.equal(wait.next_action.generate_creative, false);
});

test("CONTINUE keeps the hypothesis; PIVOT changes exactly one axis", () => {
  const win = buildDeterministicDecision(makeContext({ rows: [manualRow({ impressions: 5000, clicks: 200 })] }));
  assert.equal(win.verdict, "continue");
  assert.equal(win.action_type, "scale_same_hypothesis");
  assert.equal(win.hypothesis, makeContext().customer.hypothesis);
  assert.equal(win.next_action.change_axis, "none");

  const pivot = buildDeterministicDecision(makeContext({ rows: losingRows, pivotStreak: 0 }));
  assert.equal(pivot.verdict, "pivot");
  assert.equal(pivot.next_action.change_axis, "offer", "clicks without conversions points to LP/offer");

  const ctrLoss = [manualRow({ impressions: 20000, clicks: 50 })];
  const axes = [0, 1, 2].map((streak) => buildDeterministicDecision(makeContext({ rows: ctrLoss, pivotStreak: streak })).next_action.change_axis);
  assert.deepEqual(axes, ["hook", "angle", "target"]);

  const hookPivot = buildDeterministicDecision(makeContext({ rows: ctrLoss, pivotStreak: 0 }));
  assert.ok(hookPivot.next_action.hook && hookPivot.next_action.hook !== makeContext().creative.hook, "a fresh hook is proposed without the LLM");
  const nextRound = buildDeterministicDecision(makeContext({ rows: ctrLoss, pivotStreak: 0, lineage: [{ socialPostId: "p0", verdict: "continue", angle: null, hook: hookPivot.next_action.hook }] }));
  assert.notEqual(nextRound.next_action.hook, hookPivot.next_action.hook, "hooks already used in the lineage are not repeated");
});

test("angle pivot uses EC-Pulse pain points not used before", () => {
  const d = buildDeterministicDecision(makeContext({ rows: [manualRow({ impressions: 20000, clicks: 10 })], pivotStreak: 1 }));
  assert.equal(d.action_type, "change_angle");
  assert.match(d.next_action.angle ?? "", /洗いにくい/);
});

test("LLM refinement cannot change the verdict and failures fall back safely", async () => {
  process.env.OPENAI_API_KEY = "test-key";
  process.env.OPENAI_MODEL = "gpt-5-mini";
  const ctx = makeContext({ rows: [manualRow({ impressions: 20000, clicks: 10 })] });
  const draft = buildDeterministicDecision(ctx);

  let sentBody: Record<string, unknown> = {};
  const ok = (async (_url: string, init: RequestInit) => {
    sentBody = JSON.parse(String(init.body));
    return new Response(JSON.stringify({ model: "gpt-5-mini-2026", choices: [{ message: { content: JSON.stringify({ verdict: "stop", hypothesis: "新しい仮説の文章です", expected_outcome: "CTRが改善する", learning_objective: "Hookの効果を確認", hook: "その水筒、昼には冷めてない？", angle: null, instructions: "Hookだけ変える" }) } }] }), { status: 200 });
  }) as unknown as typeof fetch;
  const refined = await refineDecisionWithLlm(draft, ctx, ok);
  assert.equal(refined.verdict, draft.verdict);
  assert.equal(refined.action_type, draft.action_type);
  assert.equal(refined.ai_refined, true);
  assert.equal(refined.next_action.hook, "その水筒、昼には冷めてない？");
  assert.equal(sentBody.temperature, undefined, "gpt-5 models reject temperature");

  const failing = [
    (async () => new Response("err", { status: 500 })) as unknown as typeof fetch,
    (async () => { throw new Error("network down"); }) as unknown as typeof fetch,
    (async () => new Response(JSON.stringify({ choices: [{ message: { content: "not json" } }] }), { status: 200 })) as unknown as typeof fetch,
    (async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ hypothesis: "" }) } }] }), { status: 200 })) as unknown as typeof fetch,
  ];
  for (const f of failing) {
    const result = await refineDecisionWithLlm(draft, ctx, f);
    assert.deepEqual(result, draft);
  }
  delete process.env.OPENAI_API_KEY;
});

test("STOP/WAIT decisions are never sent to the LLM", async () => {
  process.env.OPENAI_API_KEY = "test-key";
  let called = false;
  const spy = (async () => { called = true; return new Response("{}"); }) as unknown as typeof fetch;
  const stop = buildDeterministicDecision(makeContext({ rows: losingRows, pivotStreak: 2 }));
  await refineDecisionWithLlm(stop, makeContext(), spy);
  assert.equal(called, false);
  delete process.env.OPENAI_API_KEY;
});

test("hash ignores asOf timestamp within the same age bucket", () => {
  assert.equal(decisionInputHash(makeContext({ asOf: "2026-09-05T00:00:00Z" })), decisionInputHash(makeContext({ asOf: "2026-09-06T00:00:00Z" })));
});
