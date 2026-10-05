import { createHash } from "node:crypto";
import { buildCreativeScenario } from "./creative-scenario";
import { TEACHER_LOGIC_VERSION, TEACHER_THRESHOLDS, eligibleHistory, evaluateTeacher } from "./teacher";
import type { DecisionEvidence, EvidenceItem, StructuredDecision, TeacherResult } from "./types";

export const DECISION_LOGIC_VERSION = `decision-2026.10.2+${TEACHER_LOGIC_VERSION}`;
export const DECISION_PROMPT_VERSION = "next-action-refine-v1";

function evidenceQuality(evidence: DecisionEvidence): { ok: boolean; issues: string[] } {
  const issues: string[] = [];
  const asOf = Date.parse(evidence.asOf);
  if (!Number.isFinite(asOf)) issues.push("decision_as_of_invalid");
  const metricAt = evidence.current ? Date.parse(evidence.current.measuredAt) : null;
  if (metricAt != null && !Number.isFinite(metricAt)) issues.push("metric_measured_at_invalid");
  if (metricAt != null && Number.isFinite(asOf) && Number.isFinite(metricAt) && metricAt > asOf) issues.push("metric_after_decision_time");
  const marketAt = evidence.market.capturedAt ? Date.parse(evidence.market.capturedAt) : null;
  if (marketAt != null && !Number.isFinite(marketAt)) issues.push("market_evidence_captured_at_invalid");
  if (marketAt != null && Number.isFinite(asOf) && Number.isFinite(marketAt) && marketAt > asOf) issues.push("market_evidence_after_decision_time");
  const m = evidence.current;
  if (m) {
    const keys = ["impressions","views","likes","comments","shares","saves","clicks","conversions","revenue","grossProfit","adSpend"] as const;
    for (const key of keys) if (m[key] != null && (!Number.isFinite(m[key]) || m[key] < 0)) issues.push(`metric_invalid_${key}`);
    if (m.clicks != null && m.impressions != null && m.clicks > m.impressions) issues.push("clicks_exceed_impressions");
    if (m.views != null && m.impressions != null && m.views > m.impressions) issues.push("views_exceed_impressions");
    if (m.conversions != null && m.clicks != null && m.conversions > m.clicks) issues.push("conversions_exceed_clicks");
    const exposure = Math.max(m.impressions ?? 0, m.views ?? 0);
    for (const key of ["likes", "comments", "shares", "saves"] as const) {
      if (m[key] != null && exposure > 0 && m[key] > exposure) issues.push(`${key}_exceed_exposure`);
    }
  }
  const p = evidence.product;
  if (p.price != null && (!Number.isFinite(p.price) || p.price < 0)) issues.push("product_price_invalid");
  if (p.cost != null && (!Number.isFinite(p.cost) || p.cost < 0)) issues.push("product_cost_invalid");
  if (p.price != null && p.cost != null && p.cost > p.price) issues.push("product_cost_exceeds_price");
  if (p.price === 0 && p.cost != null && p.cost > 0) issues.push("product_zero_price_with_cost");
  return { ok: issues.length === 0, issues };
}

const OFFER_RULES = new Set(["no_conversion_paid", "ctr_ok_cvr_zero", "unprofitable_paid"]);

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}

/**
 * Hash of everything the decision depends on. The raw asOf is excluded so the
 * same observed data maps to the same hash (and the same stored decision); the
 * only asOf-dependent outcome (WAIT expiring into a verdict) is included via
 * the teacher rule.
 */
export function evidenceHash(evidence: DecisionEvidence, teacher: Pick<TeacherResult, "verdict" | "ruleId">) {
  const { asOf: _asOf, ...rest } = evidence;
  void _asOf;
  const material = {
    logic: DECISION_LOGIC_VERSION,
    ...rest,
    history: eligibleHistory(evidence),
    teacher: { verdict: teacher.verdict, ruleId: teacher.ruleId },
  };
  return createHash("sha256").update(stableStringify(material)).digest("hex");
}

function nextPain(evidence: DecisionEvidence) {
  const used = new Set(
    [evidence.hypothesis.angle, evidence.hypothesis.hook, evidence.customer.pain]
      .filter((x): x is string => Boolean(x)),
  );
  const isUsed = (pain: string) => [...used].some((u) => u.includes(pain));
  const emerging = evidence.market.emergingPains.find((p) => !isUsed(p.pain));
  if (emerging) return { pain: emerging.pain, source: "ec_pulse.emerging_pain" };
  const top = evidence.market.topPains.find((p) => !isUsed(p.pain));
  if (top) return { pain: top.pain, source: "ec_pulse.top_pain" };
  if (evidence.customer.pain && evidence.customer.pain !== evidence.hypothesis.angle) {
    return { pain: evidence.customer.pain, source: "customer.pain" };
  }
  return null;
}

function primaryMetric(evidence: DecisionEvidence, teacher: TeacherResult) {
  const m = evidence.current;
  if (m?.adSpend != null && m.adSpend > 0 && m.revenue != null) return "粗利（広告費控除後）/ ROAS";
  if (OFFER_RULES.has(teacher.ruleId)) return "CVR";
  if (m?.clicks != null) return "CTR";
  return evidence.hypothesis.primaryMetric || "再生数・エンゲージメント率";
}

function buildEvidenceItems(evidence: DecisionEvidence, teacher: TeacherResult): EvidenceItem[] {
  const items: EvidenceItem[] = [];
  const push = (source: EvidenceItem["source"], key: string, value: EvidenceItem["value"], asOf?: string | null) => {
    if (value === null || value === undefined || value === "") return;
    items.push({ source, key, value, ...(asOf ? { asOf } : {}) });
  };
  const p = evidence.product;
  push("product", "name", p.name);
  push("product", "url", p.url);
  push("product", "price", p.price);
  push("product", "cost", p.cost);
  if (p.price != null && p.cost != null && p.price > 0) {
    push("product", "gross_margin_rate", Math.round(((p.price - p.cost) / p.price) * 1000) / 1000);
  }
  if (p.strengths.length) push("product", "strengths", p.strengths.slice(0, 3).join(" / "));
  const c = evidence.customer;
  push("customer", "target", c.target);
  push("customer", "pain", c.pain);
  push("customer", "desire", c.desire);
  push("customer", "value_proposition", c.valueProposition);
  const mk = evidence.market;
  push("ec_pulse", "status", mk.status, mk.capturedAt);
  if (mk.status === "ok") {
    push("ec_pulse", "comments_analyzed", mk.commentsCount ?? null, mk.capturedAt);
    mk.topPains.slice(0, 3).forEach((x, i) => push("ec_pulse", `top_pain_${i + 1}`, `${x.pain} (${x.sharePercent}%)`, mk.capturedAt));
    mk.emergingPains.slice(0, 2).forEach((x, i) => push("ec_pulse", `emerging_pain_${i + 1}`, `${x.pain} (${x.status}, ${x.shareDeltaPercent >= 0 ? "+" : ""}${x.shareDeltaPercent}pt)`, mk.capturedAt));
    push("ec_pulse", "trend_signal", mk.trendSignal ?? null, mk.capturedAt);
  }
  const h = evidence.hypothesis;
  push("hypothesis", "network", h.network);
  push("hypothesis", "hook", h.hook);
  push("hypothesis", "angle", h.angle);
  push("hypothesis", "statement", h.hypothesis);
  push("hypothesis", "previous_attempts", h.lineageVerdicts.length);
  const m = evidence.current;
  if (m) {
    for (const key of ["impressions", "views", "clicks", "conversions", "revenue", "grossProfit", "adSpend"] as const) {
      push("post_metrics", key, m[key], m.measuredAt);
    }
  }
  push("history", "comparable_posts", eligibleHistory(evidence).length);
  for (const criterion of teacher.criteria) {
    if (criterion.value != null) push("post_metrics", `criterion.${criterion.name}`, criterion.value);
  }
  return items;
}

/** Deterministic structured decision. Same evidence -> same decision. */
export function buildDecision(evidence: DecisionEvidence, now = new Date()): StructuredDecision {
  const quality = evidenceQuality(evidence);
  const baseTeacher = evaluateTeacher(evidence);
  const teacher: TeacherResult = quality.ok
    ? baseTeacher
    : {
        ...baseTeacher,
        verdict: "wait",
        status: "insufficient_data",
        ruleId: "evidence_quality",
        reason: `証拠の整合性を確認できないため判定を保留: ${quality.issues.join(", ")}`,
        confidence: 0.1,
        missingData: [...baseTeacher.missingData, ...quality.issues],
      };
  const h = evidence.hypothesis;
  const target = evidence.customer.target || "分析で特定した主要顧客";
  const metric = primaryMetric(evidence, teacher);
  const currentHypothesis = h.hypothesis || h.angle || evidence.customer.valueProposition || "現在の訴求";

  let decision: Pick<StructuredDecision, "action_type" | "hypothesis" | "expected_outcome" | "learning_objective" | "priority" | "next_action">;

  if (teacher.verdict === "continue") {
    decision = {
      action_type: "reinforce_hypothesis",
      hypothesis: currentHypothesis,
      expected_outcome: `同じ仮説で${metric}が前回以上を再現する`,
      learning_objective: "勝ち仮説の再現性を確認し、Hook差分だけで改善幅を測る",
      priority: teacher.confidence >= 0.7 ? "high" : "medium",
      next_action: {
        generate_creative: true,
        description: "訴求・対象は維持し、冒頭Hookだけを変えた次の投稿を作る",
        hook: h.hook,
        angle: h.angle,
        change_variable: "hook",
      },
    };
  } else if (teacher.verdict === "pivot") {
    const offer = OFFER_RULES.has(teacher.ruleId);
    const pain = offer ? null : nextPain(evidence);
    const angle = offer ? h.angle : pain?.pain ?? null;
    decision = {
      action_type: "pivot_hypothesis",
      hypothesis: offer
        ? `${target}は興味を持っているが、提示しているオファー/遷移先が購入理由になっていない`
        : pain
          ? `${target}は「${pain.pain}」を解決する訴求の方が反応する`
          : `${target}には現在とは異なる顧客課題の訴求が必要`,
      expected_outcome: offer ? "クリックからのCVRが0%を脱する" : `${metric}が前回を上回る`,
      learning_objective: offer
        ? "広告ではなくオファー・遷移先が購入のボトルネックかを切り分ける"
        : `変更した訴求（${pain?.source ?? "新しい顧客課題"}）が${metric}を改善するか検証する`,
      priority: "medium",
      next_action: {
        generate_creative: true,
        description: offer
          ? "広告のHookは維持し、オファー・遷移先との接続を変更して再テストする"
          : "変更点を訴求1つに絞り、それ以外は前回と同条件で再テストする",
        hook: pain ? `「${pain.pain}」で困っていませんか？` : null,
        angle,
        change_variable: offer ? "offer" : "angle",
      },
    };
  } else if (teacher.verdict === "stop") {
    decision = {
      action_type: "stop_hypothesis",
      hypothesis: currentHypothesis,
      expected_outcome: "この仮説への追加制作・投稿コストを止める",
      learning_objective: "停止した仮説を学習記録に残し、別の顧客課題・商品で次のテストを計画する",
      priority: "medium",
      next_action: { generate_creative: false, description: "次のクリエイティブは生成しない", hook: null, angle: null, change_variable: null },
    };
  } else {
    decision = {
      action_type: "wait_for_data",
      hypothesis: currentHypothesis,
      expected_outcome: `判定に必要な露出（${TEACHER_THRESHOLDS.minExposure}件以上）・指標が揃う`,
      learning_objective: "データ不足のまま結論を出さず、次回巡回で再判定する",
      priority: "low",
      next_action: { generate_creative: false, description: "追加データを待つ（次回巡回で再判定）", hook: null, angle: null, change_variable: null },
    };
  }

  const structured: StructuredDecision = {
    ...decision,
    verdict: teacher.verdict,
    target_customer: target,
    reason: teacher.reason,
    primary_metric: metric,
    evidence: buildEvidenceItems(evidence, teacher),
    confidence: teacher.confidence,
    teacher,
    logic_version: DECISION_LOGIC_VERSION,
    prompt_version: DECISION_PROMPT_VERSION,
    model_version: "deterministic",
    generated_at: now.toISOString(),
    input_hash: evidenceHash(evidence, teacher),
  };
  structured.next_action.scenario = buildCreativeScenario(structured, evidence);
  return structured;
}

type Refiner = (prompt: { system: string; user: string }) => Promise<string | null>;

/**
 * Optional LLM pass that only rewrites the creative wording of the next action.
 * It cannot change verdict, action_type, metrics or evidence. Any invalid output
 * keeps the deterministic decision.
 */
export async function refineNextAction(decision: StructuredDecision, evidence: DecisionEvidence, refiner: Refiner, model: string) {
  if (!decision.next_action.generate_creative) return decision;
  const user = JSON.stringify({
    verdict: decision.verdict,
    change_variable: decision.next_action.change_variable,
    hypothesis: decision.hypothesis,
    target_customer: decision.target_customer,
    current_hook: evidence.hypothesis.hook,
    current_angle: evidence.hypothesis.angle,
    proposed_hook: decision.next_action.hook,
    proposed_angle: decision.next_action.angle,
    product: { name: evidence.product.name, strengths: evidence.product.strengths },
    market_pains: evidence.market.topPains.slice(0, 3),
    output: { hook: "string (<=60 chars)", angle: "string (<=80 chars)", description: "string (<=120 chars)" },
  });
  try {
    const text = await refiner({
      system: "あなたは広告クリエイティブの文言だけを作る担当です。判定（verdict）や変更する変数は変えません。continueなら訴求は維持してHookだけを変え、pivotなら指定されたchange_variableだけを変えます。誇大表現・事実でない主張は禁止。JSONのみ返してください。",
      user,
    });
    if (!text) return decision;
    const raw: unknown = JSON.parse(text);
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return decision;
    const parsed = raw as { hook?: unknown; angle?: unknown; description?: unknown };
    const clean = (v: unknown, max: number) => (typeof v === "string" && v.trim() && v.length <= max ? v.trim() : null);
    const llmHook = decision.next_action.change_variable === "hook" ? clean(parsed.hook, 60) : null;
    const llmAngle = decision.next_action.change_variable === "angle" ? clean(parsed.angle, 80) : null;
    const llmDescription = clean(parsed.description, 120);
    // Credit the model only when it actually contributed wording; output that was
    // entirely rejected leaves a purely deterministic decision.
    if (llmHook === null && llmAngle === null && llmDescription === null) return decision;
    const refined: StructuredDecision = {
      ...decision,
      next_action: {
        ...decision.next_action,
        hook: llmHook ?? decision.next_action.hook,
        angle: llmAngle ?? decision.next_action.angle,
        description: llmDescription ?? decision.next_action.description,
      },
      model_version: model,
    };
    refined.next_action.scenario = buildCreativeScenario(refined, evidence);
    return refined;
  } catch {
    return decision;
  }
}
