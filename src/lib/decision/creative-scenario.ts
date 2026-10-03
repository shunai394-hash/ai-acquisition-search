import type { CreativeScenario, DecisionEvidence, StructuredDecision } from "./types";

const ALLOWED_DURATIONS = [15, 30, 45, 60, 90, 180, 300] as const;
type Duration = CreativeScenario["durationSeconds"];

function isDuration(value: number): value is Duration {
  return (ALLOWED_DURATIONS as readonly number[]).includes(value);
}

function automaticDuration(evidence: DecisionEvidence): Duration {
  const density = evidence.product.features.length + evidence.product.strengths.length + evidence.product.useCases.length + evidence.customer.buyingTriggers.length + evidence.market.topPains.length + evidence.market.emergingPains.length + [evidence.customer.pain, evidence.customer.desire, evidence.customer.valueProposition].filter(Boolean).length;
  if (density <= 5) return 15;
  if (density <= 10) return 30;
  if (density <= 16) return 45;
  if (density <= 22) return 60;
  if (density <= 32) return 90;
  if (density <= 48) return 180;
  return 300;
}

function normalizeDuration(value: number | undefined, evidence: DecisionEvidence): Duration {
  if (value != null && isDuration(value)) return value;
  return automaticDuration(evidence);
}

function splitDuration(duration: Duration) {
  if (duration === 15) return { hook: 3, problem: 3, proof: 3, solution: 3, cta: 3 };
  if (duration === 30) return { hook: 3, problem: 6, proof: 7, solution: 9, cta: 5 };
  if (duration === 45) return { hook: 3, problem: 8, proof: 10, solution: 15, cta: 9 };
  if (duration === 60) return { hook: 3, problem: 12, proof: 15, solution: 20, cta: 10 };
  if (duration === 90) return { hook: 3, problem: 17, proof: 20, solution: 35, cta: 15 };\n  const hook = 5;\n  const cta = Math.round(duration * 0.08);\n  const remaining = duration - hook - cta;\n  return { hook, problem: Math.round(remaining * 0.22), proof: Math.round(remaining * 0.28), solution: remaining - Math.round(remaining * 0.22) - Math.round(remaining * 0.28), cta };
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
  const d = splitDuration(duration);
  const target = evidence.customer.target || decision.target_customer;
  const product = evidence.product.name || "商品";
  const hook = decision.next_action.hook || evidence.hypothesis.hook || "最初の3秒で課題を提示";
  const angle = decision.next_action.angle || evidence.hypothesis.angle || evidence.customer.pain || "顧客課題";
  const ctaStart = duration - d.cta;
  const proofStart = d.hook + d.problem;
  const solutionStart = proofStart + d.proof;

  return {
    durationSeconds: duration,
    objective: variable === "hook" ? "test_hook" : variable === "angle" ? "test_angle" : "test_offer",
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
