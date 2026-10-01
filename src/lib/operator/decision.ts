import { createHash } from "node:crypto";
import { z } from "zod";
import { evidenceCoverage, evidenceItems, type DecisionContext, type EvidenceItem } from "./evidence";
import { evaluateTeacher, TEACHER_LOGIC_VERSION, type TeacherResult, type TeacherVerdict } from "./teacher";

// AI Decision: Teacher の決定論的判定 + Evidence から、次に何をするかを構造化して決める。
// 判定（verdict / action_type / priority）はルールで決め、LLM は文章の具体化だけを行う。
// 同じ入力なら input_hash が一致し、保存済みの Decision を再利用するため結論がぶれない。

export const DECISION_LOGIC_VERSION = `decision-v2.0.0+${TEACHER_LOGIC_VERSION}`;
export const DECISION_PROMPT_VERSION = "decision-prompt-v2.0.0";

export type ActionType =
  | "scale_same_hypothesis"   // CONTINUE: 同じ仮説を強化
  | "iterate_hook"            // PIVOT: Hook を変更
  | "change_angle"            // PIVOT: 訴求（顧客課題）を変更
  | "change_target"           // PIVOT: 対象顧客を変更
  | "fix_offer_or_lp"         // PIVOT: クリック後（LP・オファー）を変更
  | "stop_line"               // STOP: この仮説系列の制作を停止
  | "collect_more_data";      // WAIT: 追加データ取得

export const structuredDecisionSchema = z.object({
  verdict: z.enum(["continue", "pivot", "stop", "wait"]),
  status: z.enum(["decided", "insufficient_data"]),
  action_type: z.enum(["scale_same_hypothesis", "iterate_hook", "change_angle", "change_target", "fix_offer_or_lp", "stop_line", "collect_more_data"]),
  target_customer: z.string(),
  hypothesis: z.string(),
  reason: z.string(),
  expected_outcome: z.string(),
  primary_metric: z.string(),
  learning_objective: z.string(),
  priority: z.enum(["high", "medium", "low"]),
  confidence: z.number().min(0).max(1),
  evidence: z.array(z.object({
    category: z.string(),
    source: z.string(),
    key: z.string(),
    value: z.union([z.string(), z.number(), z.boolean(), z.null()]),
    observedAt: z.string().nullable().optional(),
  })),
  evidence_coverage: z.object({ score: z.number(), present: z.array(z.string()), missing: z.array(z.string()) }),
  next_action: z.object({
    generate_creative: z.boolean(),
    change_axis: z.enum(["none", "hook", "angle", "target", "offer"]),
    hook: z.string().nullable(),
    angle: z.string().nullable(),
    instructions: z.string(),
  }),
  teacher: z.object({
    verdict: z.string(),
    status: z.string(),
    signal_tier: z.string(),
    checks: z.array(z.unknown()),
    reasons: z.array(z.string()),
    missing_signals: z.array(z.string()),
    hypothesis_match: z.string(),
  }),
  logic_version: z.string(),
  prompt_version: z.string(),
  model_version: z.string(),
  ai_refined: z.boolean(),
  generated_at: z.string(),
  input_hash: z.string(),
});

export type StructuredDecision = z.infer<typeof structuredDecisionSchema>;

// LLM が書き換えてよいのは文章フィールドだけ。
const refinementSchema = z.object({
  hypothesis: z.string().min(4).max(400),
  expected_outcome: z.string().min(4).max(300),
  learning_objective: z.string().min(4).max(300),
  hook: z.string().min(2).max(120).nullable().optional(),
  angle: z.string().min(2).max(200).nullable().optional(),
  instructions: z.string().min(4).max(500),
});

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}

// 判定に効く入力だけをハッシュ化する（asOf の時刻そのものは含めない）。
export function decisionInputHash(ctx: DecisionContext) {
  const material = {
    logic: DECISION_LOGIC_VERSION,
    prompt: DECISION_PROMPT_VERSION,
    post: { id: ctx.post.id, network: ctx.post.network, publishedAt: ctx.post.publishedAt },
    metrics: { values: ctx.metrics.values, known: ctx.metrics.known, rows: ctx.metrics.sourceRowIds },
    baseline: ctx.baseline,
    pivotStreak: ctx.pivotStreak,
    product: ctx.product,
    customer: ctx.customer,
    creative: ctx.creative,
    market: { runs: ctx.market.runs.map((r) => r.runId), price: ctx.market.price.lastPrice },
    ageBucket: ageBucket(ctx),
  };
  return createHash("sha256").update(stableStringify(material)).digest("hex");
}

function ageHours(ctx: DecisionContext) {
  if (!ctx.post.publishedAt) return null;
  const h = (new Date(ctx.asOf).getTime() - new Date(ctx.post.publishedAt).getTime()) / 3_600_000;
  return Number.isFinite(h) ? h : null;
}

// 経過時間は Teacher の閾値境界だけを区別する（毎時ハッシュが変わらないように）。
function ageBucket(ctx: DecisionContext) {
  const h = ageHours(ctx);
  if (h === null) return "unknown";
  if (h < 24) return "<24h";
  if (h < 72) return "24-72h";
  return ">=72h";
}

const PIVOT_AXES: Array<"hook" | "angle" | "target"> = ["hook", "angle", "target"];

function pickPivotAxis(teacher: TeacherResult, ctx: DecisionContext): "hook" | "angle" | "target" | "offer" {
  // クリックは取れているのに CV しない → 広告ではなくクリック後の問題
  if (teacher.signalTier === "conversion" && teacher.rates.ctr !== null && teacher.rates.cvr !== null && teacher.checks.some((c) => c.name === "cvr" && c.passed === false)) return "offer";
  if (teacher.signalTier === "conversion" && (teacher.sample.clicks ?? 0) > 0 && (teacher.sample.conversions ?? 0) === 0) return "offer";
  // 配信が伸びない → まず Hook
  if (teacher.signalTier === "reach") return "hook";
  // それ以外は系列内の PIVOT 回数で Hook → 訴求 → 対象 の順に変更点を1つずつ回す
  return PIVOT_AXES[ctx.pivotStreak % PIVOT_AXES.length];
}

function pickNewAngle(ctx: DecisionContext): string | null {
  const used = new Set([ctx.creative.angle, ...ctx.lineage.map((l) => l.angle)].filter(Boolean).map((x) => String(x)));
  const candidates = [
    ...ctx.market.runs.flatMap((r) => r.emergingPains),
    ...ctx.market.runs.map((r) => r.topPain),
    ctx.customer.pain,
    ...ctx.product.strengths,
    ...ctx.product.useCases,
  ].filter((x): x is string => !!x);
  const fresh = candidates.find((c) => ![...used].some((u) => u.includes(c)));
  return fresh ? `「${fresh}」を解決する訴求` : null;
}

// LLM が無くても、系列内で使っていない根拠から Hook を作り、同じ Hook の繰り返しを避ける。
function pickNewHook(ctx: DecisionContext): string | null {
  const used = [ctx.creative.hook, ctx.post.caption, ...ctx.lineage.map((l) => l.hook)].filter(Boolean).map((x) => String(x));
  const templates: Array<(x: string) => string> = [
    (x) => `「${x}」、まだ我慢していますか？`,
    (x) => `${x}が気になる人へ。`,
    (x) => `${x}、これで解決しました。`,
  ];
  const sources = [
    ...ctx.market.runs.flatMap((r) => r.emergingPains),
    ...ctx.market.runs.map((r) => r.topPain),
    ctx.customer.pain,
    ctx.customer.desire,
    ...ctx.product.strengths,
  ].filter((x): x is string => !!x);
  for (const template of templates) {
    for (const source of sources) {
      const hook = template(source);
      if (!used.some((u) => u.includes(source) || u === hook)) return hook;
    }
  }
  return null;
}

function actionTypeFor(verdict: TeacherVerdict, axis: ReturnType<typeof pickPivotAxis> | "none"): ActionType {
  if (verdict === "continue") return "scale_same_hypothesis";
  if (verdict === "stop") return "stop_line";
  if (verdict === "wait") return "collect_more_data";
  return axis === "hook" ? "iterate_hook" : axis === "angle" ? "change_angle" : axis === "target" ? "change_target" : "fix_offer_or_lp";
}

function primaryMetricFor(teacher: TeacherResult, ctx: DecisionContext) {
  if (ctx.creative.testMetric) return ctx.creative.testMetric;
  switch (teacher.signalTier) {
    case "profit": return "粗利 - 広告費";
    case "conversion": return teacher.rates.roas !== null ? "ROAS" : "CVR";
    case "click": return "CTR";
    case "engagement": return "エンゲージメント率";
    default: return teacher.missingSignals.includes("clicks") ? "CTR（クリック計測を追加）" : "CTR";
  }
}

export function buildDeterministicDecision(ctx: DecisionContext, options: { thresholds?: Parameters<typeof evaluateTeacher>[0]["thresholds"] } = {}): StructuredDecision {
  const teacher = evaluateTeacher({
    network: ctx.post.network,
    ageHours: ageHours(ctx),
    metrics: ctx.metrics,
    baseline: ctx.baseline,
    primaryMetric: ctx.creative.testMetric,
    pivotStreak: ctx.pivotStreak,
    thresholds: options.thresholds,
  });
  const items: EvidenceItem[] = evidenceItems(ctx);
  const coverage = evidenceCoverage(items);
  const axis = teacher.verdict === "pivot" ? pickPivotAxis(teacher, ctx) : "none";
  const actionType = actionTypeFor(teacher.verdict, axis);
  const target = ctx.customer.target || "分析で特定した主要顧客（未確定）";
  const productName = ctx.product.name || ctx.creative.title || "対象商品";
  const baseHypothesis = ctx.customer.hypothesis || (ctx.customer.pain ? `${target}は「${ctx.customer.pain}」を解決できると分かれば購入に近づく` : `${target}に${productName}の価値が伝われば購入に近づく`);
  const primaryMetric = primaryMetricFor(teacher, ctx);
  const newAngle = axis === "angle" || axis === "target" ? pickNewAngle(ctx) : null;

  let hypothesis = baseHypothesis;
  let hook: string | null = null;
  let angle: string | null = ctx.creative.angle;
  let instructions = "";
  let expected = "";
  let learning = "";
  let priority: StructuredDecision["priority"] = "medium";

  switch (teacher.verdict) {
    case "continue":
      hook = ctx.creative.hook;
      instructions = "勝った仮説・訴求は変えず、Hookの言い回しまたは冒頭3秒の見せ方だけを変えた派生を作る。";
      expected = `${primaryMetric}が今回と同等以上を維持する`;
      learning = "勝ち仮説が再現するか（偶然の当たりでないか）を確認する";
      priority = "high";
      break;
    case "pivot":
      if (axis === "hook") {
        hook = pickNewHook(ctx);
        instructions = "訴求・対象は維持し、冒頭のHookだけを別の切り口に変える。変更点は1つに絞る。";
        learning = "反応が悪かった原因がHook（最初の数秒）かどうかを切り分ける";
      } else if (axis === "angle") {
        angle = newAngle || "前回と異なる顧客課題";
        hypothesis = `${target}は${angle}の方が反応する`;
        instructions = `訴求を「${angle}」に変更する。対象顧客と商品は維持する。`;
        learning = "訴求（解決する課題）の違いで反応が変わるかを確認する";
      } else if (axis === "target") {
        angle = newAngle || ctx.creative.angle;
        hypothesis = `${productName}は別の顧客層の方が反応する（現対象: ${target}）`;
        instructions = "対象顧客を変更する。商品と主要訴求は維持し、誰に向けた話かを冒頭で明示する。";
        learning = "対象顧客の違いで反応が変わるかを確認する";
      } else {
        instructions = "広告のHookは維持し、遷移先（LP・オファー・価格表示）との接続を変更する。";
        learning = "クリック後の離脱がオファー・LPに起因するかを確認する";
      }
      expected = `${primaryMetric}が今回の値を上回る`;
      priority = teacher.confidence >= 0.6 ? "high" : "medium";
      break;
    case "stop":
      instructions = "この仮説系列の追加クリエイティブは生成しない。商品・市場分析（EC-Pulse Research）からやり直す。";
      expected = "無駄な制作費・広告費を止める";
      learning = "この商品×仮説系列では成果が出ないことを記録する";
      priority = "low";
      break;
    case "wait":
      instructions = teacher.missingSignals.includes("clicks")
        ? "次回巡回まで待つ。クリック・購入など媒体APIで取れない指標は実績入力で追加する。"
        : "次回巡回まで待ち、追加データで再判定する。";
      expected = "判定に必要なサンプル数に到達する";
      learning = "判定に必要なデータを揃える";
      priority = teacher.missingSignals.includes("clicks") ? "medium" : "low";
      break;
  }

  return {
    verdict: teacher.verdict,
    status: teacher.status,
    action_type: actionType,
    target_customer: target,
    hypothesis,
    reason: teacher.reasons.join(" "),
    expected_outcome: expected,
    primary_metric: primaryMetric,
    learning_objective: learning,
    priority,
    confidence: teacher.confidence,
    evidence: items,
    evidence_coverage: coverage,
    next_action: {
      generate_creative: teacher.verdict === "continue" || teacher.verdict === "pivot",
      change_axis: axis,
      hook,
      angle,
      instructions,
    },
    teacher: {
      verdict: teacher.verdict,
      status: teacher.status,
      signal_tier: teacher.signalTier,
      checks: teacher.checks,
      reasons: teacher.reasons,
      missing_signals: teacher.missingSignals,
      hypothesis_match: teacher.hypothesisMatch,
    },
    logic_version: DECISION_LOGIC_VERSION,
    prompt_version: DECISION_PROMPT_VERSION,
    model_version: "rules",
    ai_refined: false,
    generated_at: new Date().toISOString(),
    input_hash: decisionInputHash(ctx),
  };
}

function modelAcceptsTemperature(model: string) {
  // GPT-5 / o 系の推論モデルは temperature の指定を受け付けない。
  return !/^(gpt-5|o\d)/i.test(model);
}

// 文章フィールドだけを LLM で具体化する。失敗しても決定論的 Decision をそのまま返す。
export async function refineDecisionWithLlm(
  decision: StructuredDecision,
  ctx: DecisionContext,
  fetchImpl: typeof fetch = fetch,
): Promise<StructuredDecision> {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey || decision.verdict === "stop" || decision.verdict === "wait") return decision;
  const model = process.env.OPENAI_MODEL || "gpt-5-mini";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await fetchImpl("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      signal: controller.signal,
      body: JSON.stringify({
        model,
        ...(modelAcceptsTemperature(model) ? { temperature: 0 } : {}),
        seed: 7,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content: "あなたは集客テストの設計者です。判定（verdict・変更軸）は既に決まっており変更できません。与えられた根拠だけを使い、誇張・虚偽の効能を書かず、JSONのみで回答してください。",
          },
          {
            role: "user",
            content: JSON.stringify({
              output_schema: { hypothesis: "string", expected_outcome: "string", learning_objective: "string", hook: "string|null（change_axisがhookの時は必ず新しいHook）", angle: "string|null", instructions: "string" },
              fixed: { verdict: decision.verdict, action_type: decision.action_type, change_axis: decision.next_action.change_axis, primary_metric: decision.primary_metric, target_customer: decision.target_customer },
              draft: { hypothesis: decision.hypothesis, hook: decision.next_action.hook, angle: decision.next_action.angle, instructions: decision.next_action.instructions },
              previous: { hook: ctx.creative.hook, angle: ctx.creative.angle, lineage: ctx.lineage },
              evidence: decision.evidence,
              teacher_reasons: decision.teacher.reasons,
            }),
          },
        ],
      }),
    });
    if (!response.ok) return decision;
    const payload = await response.json();
    const content = payload?.choices?.[0]?.message?.content;
    if (typeof content !== "string") return decision;
    const parsed = refinementSchema.safeParse(JSON.parse(content));
    if (!parsed.success) return decision;
    const r = parsed.data;
    return {
      ...decision,
      hypothesis: r.hypothesis,
      expected_outcome: r.expected_outcome,
      learning_objective: r.learning_objective,
      next_action: {
        ...decision.next_action,
        hook: r.hook ?? decision.next_action.hook,
        angle: decision.next_action.change_axis === "none" || decision.next_action.change_axis === "hook" ? decision.next_action.angle : (r.angle ?? decision.next_action.angle),
        instructions: r.instructions,
      },
      model_version: String(payload?.model || model),
      ai_refined: true,
    };
  } catch {
    return decision;
  } finally {
    clearTimeout(timer);
  }
}
