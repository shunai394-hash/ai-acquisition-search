import test from "node:test";
import assert from "node:assert/strict";
import { buildCreativeScenario } from "./creative-scenario";
import type { DecisionEvidence, StructuredDecision } from "./types";

const evidence = {
  asOf: "2026-10-03T00:00:00.000Z",
  product: { name: "Test商品", url: null, price: 4000, cost: 1600, features: [], strengths: ["時短"], useCases: [], salesChannels: [] },
  customer: { target: "共働き世帯", pain: "家事に時間がない", desire: "時短したい", valueProposition: "5分で使える", buyingTriggers: [], stage: null },
  market: { status: "ok" as const, topPains: [], emergingPains: [] },
  hypothesis: { socialPostId: "p1", network: "tiktok", caption: null, hook: "5分で終わる", angle: "時短", hypothesis: "時短に反応する", primaryMetric: "CTR", publishedAt: null, lineageVerdicts: [] },
  current: null,
  history: [],
} satisfies DecisionEvidence;

const decision = {
  action_type: "reinforce_hypothesis", verdict: "continue", target_customer: "共働き世帯", hypothesis: "時短に反応する", reason: "ok", expected_outcome: "CTR", primary_metric: "CTR", learning_objective: "Hookを検証", priority: "high", evidence: [], confidence: 0.8,
  next_action: { generate_creative: true, description: "Hook変更", hook: "5分で終わる", angle: "時短", change_variable: "hook" }, 
  teacher: {} as StructuredDecision["teacher"], logic_version: "v", prompt_version: "v", model_version: "deterministic", generated_at: "2026-10-03T00:00:00.000Z", input_hash: "x",
} satisfies StructuredDecision;

test("scenario uses exact supported duration and contiguous scenes", () => {
  const scenario = buildCreativeScenario(decision, evidence, 30);
  assert.ok(scenario);
  assert.equal(scenario.durationSeconds, 30);
  assert.equal(scenario.scenes[0].startSecond, 0);
  assert.equal(scenario.scenes.at(-1)?.endSecond, 30);
  for (let i = 1; i < scenario.scenes.length; i++) assert.equal(scenario.scenes[i].startSecond, scenario.scenes[i - 1].endSecond);
  assert.equal(scenario.changeVariable, "hook");
  assert.equal(scenario.scenarioVersion, "creative-scenario-1");
  assert.equal(scenario.targetCustomer, "共働き世帯");
  assert.equal(scenario.productName, "Test商品");
  assert.equal(scenario.hypothesis, "時短に反応する");
  assert.equal(scenario.primaryMetric, "CTR");
  assert.equal(scenario.learningObjective, "Hookを検証");
  assert.deepEqual(scenario.continuity.keep, ["target customer", "product facts", "primary metric", "learning objective"]);
  assert.deepEqual(scenario.continuity.change, ["冒頭Hook"]);
});

test("scenario refuses to generate when decision says wait or stop", () => {
  const blocked = { ...decision, next_action: { ...decision.next_action, generate_creative: false, change_variable: null } };
  assert.equal(buildCreativeScenario(blocked, evidence, 30), null);
});

test("invalid duration falls back to deterministic default", () => {
  const scenario = buildCreativeScenario(decision, evidence, 31);
  assert.ok(scenario);
  assert.equal(scenario.durationSeconds, 15);
});

test("scenario is rejected when the decision requests an uncontrolled variable", () => {
  const invalid = {
    ...decision,
    next_action: { ...decision.next_action, change_variable: "target" as const },
  } as unknown as StructuredDecision;
  assert.equal(buildCreativeScenario(invalid, evidence, 30), null);
});

test("scenario exposes one causal chain from hook through CTA", () => {
  const scenario = buildCreativeScenario(decision, evidence, 30);
  assert.ok(scenario);
  assert.deepEqual(scenario.scenes.map((scene) => scene.purpose), ["hook", "problem", "proof", "solution", "cta"]);
  assert.equal(scenario.scenes.reduce((sum, scene) => sum + (scene.endSecond - scene.startSecond), 0), scenario.durationSeconds);
});

test("single-video production contract caps unsupported long requests", () => {
  const scenario = buildCreativeScenario(decision, evidence, 60);
  assert.ok(scenario);
  assert.equal(scenario.durationSeconds, 15);
});
