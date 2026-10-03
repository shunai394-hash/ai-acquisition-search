import type { CreativeScenario, DecisionEvidence, StructuredDecision } from "./types";

// MVP production contract: one Scenario must map to one finished 9:16 video.
// Long-form (45s+) requires an explicit multi-clip/stitch contract and is intentionally not inferred here.
const ALLOWED_DURATIONS = [15, 30] as const;
type Duration = CreativeScenario["durationSeconds"];

function isDuration(value: number): value is Duration {
  return (ALLOWED_DURATIONS as readonly number[]).includes(value);
}

function automaticDuration(evidence: DecisionEvidence): Duration {
  const density = evidence.product.features.length + evidence.product.strengths.length + evidence.product.useCases.length + evidence.customer.buyingTriggers.length + evidence.market.topPains.length + evidence.market.emergingPains.length + [evidence.customer.pain, evidence.customer.desire, evidence.customer.valueProposition].filter(Boolean).length;
  return density <= 10 ? 15 : 30;
}

function normalizeDuration(value: number | undefined, evidence: DecisionEvidence): Duration | null {
  if (value == null) return automaticDuration(evidence);
  return isDuration(value) ? value : null;
}

function splitDuration(duration: Duration) {
  if (duration === 15) return { hook: 3, problem: 3, proof: 3, solution: 3, cta: 3 };
  if (duration === 30) return { hook: 3, problem: 6, proof: 7, solution: 9, cta: 5 };
  return { hook: 3, problem: 6, proof: 7, solution: 9, cta: 5 };
}

/** Builds a deterministic production scaffold from a locked decision. */
export function buildCreativeScenario(
  decision: StructuredDecision,
  evidence: DecisionEvidence,
  durationSeconds?: number,
): CreativeScenario | null {
  if (!decision.next_action.generate_creative) return null;
  const variable = decision.next_action.change_variable;
  if (variable !== "hook" && variable !== "angle" && variable !== "offer") return null;

  const duration = normalizeDuration(durationSeconds, evidence);
  if (duration == null) return null;
  const d = splitDuration(duration);
  const target = evidence.customer.target || decision.target_customer;
  const product = evidence.product.name || "商品";
  const hook = decision.next_action.hook || evidence.hypothesis.hook || "最初の3秒で課題を提示";
  const angle = decision.next_action.angle || evidence.hypothesis.angle || evidence.customer.pain || "顧客課題";
  const ctaStart = duration - d.cta;
  const proofStart = d.hook + d.problem;
  const solutionStart = proofStart + d.proof;

  const objective = variable === "hook" ? "test_hook" : variable === "angle" ? "test_angle" : "test_offer";
  return {
    scenarioVersion: "creative-scenario-1",
    targetCustomer: target,
    productName: product,
    hypothesis: evidence.hypothesis.hypothesis || decision.hypothesis,
    primaryMetric: evidence.hypothesis.primaryMetric || decision.primary_metric,
    learningObjective: decision.learning_objective,
    durationSeconds: duration,
    objective,
    changeVariable: variable,
    scenes: [
      { id: "hook", startSecond: 0, endSecond: d.hook, purpose: "hook", instruction: "冒頭で" + hook + "を提示。対象は" + target + "。" },
      { id: "problem", startSecond: d.hook, endSecond: proofStart, purpose: "problem", instruction: target + "の課題「" + (evidence.customer.pain || angle) + "」を具体的な使用場面で見せる。" },
      { id: "proof", startSecond: proofStart, endSecond: solutionStart, purpose: "proof", instruction: product + "について、確認済みの特徴・強みだけを根拠付きで見せる。" },
      { id: "solution", startSecond: solutionStart, endSecond: ctaStart, purpose: "solution", instruction: "訴求「" + angle + "」が課題解決につながる流れを、1つの因果で説明する。" },
      { id: "cta", startSecond: ctaStart, endSecond: duration, purpose: "cta", instruction: variable === "offer" ? "変更したオファーと次の行動を明示する。" : "同じオファーを維持し、次の行動だけを明示する。" },
    ],
    continuity: {
      keep: ["target customer", "product facts", "primary metric", "learning objective"],
      change: variable === "hook" ? ["冒頭Hook"] : variable === "angle" ? ["顧客課題・訴求角度"] : ["オファー・遷移先との接続"],
    },
  };
}
