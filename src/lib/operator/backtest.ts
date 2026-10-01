import { buildDeterministicDecision, type StructuredDecision } from "./decision";
import type { DecisionContext } from "./evidence";

// AI Decision のバックテスト。
// 各エピソードは「判定時点 asOf までに観測されたデータだけで作った Context」と、
// 「その後に観測された同じ投稿の最終データで作った Context（答え合わせ用）」の組。
// 判定には前者だけを使い、後者は評価にのみ使う（未来データのリーク防止）。

export type BacktestEpisode = {
  postId: string;
  lineageKey: string;            // 同じ仮説系列（元投稿を遡った根）の識別子
  atDecision: DecisionContext;   // asOf 時点のデータのみ
  hindsight: DecisionContext;    // 評価用（後から観測されたデータを含む）
};

export type BacktestReport = {
  episodes: number;
  leakageViolations: number;
  decisionConsistency: number;          // 同じ入力（行順を入れ替えても）で同じ結論になった割合
  actionRelevance: number;              // 判定と行動種別・変更軸が根拠と整合している割合
  hypothesisQuality: number;            // 仮説が対象顧客・測定可能な主要指標を持つ割合
  evidenceCoverage: number;             // Evidence カテゴリの平均カバレッジ
  duplicateRecommendationRate: number;  // 同じ系列内で同じ次アクションを繰り返した割合
  falseStop: number;                    // STOP だが、後のデータでは CONTINUE だった数
  falseContinue: number;                // CONTINUE だが、後のデータでは PIVOT/STOP だった数
  unnecessaryPivot: number;             // PIVOT だが、後のデータでは CONTINUE だった数
  decidedRate: number;                  // WAIT ではなく結論を出せた割合
  learningEfficiency: number;           // 結論を出した判定のうち、後のデータでも同じ結論だった割合
  verdicts: Record<string, number>;
  details: Array<{ postId: string; asOf: string; verdict: string; hindsightVerdict: string; actionType: string; agreement: boolean }>;
};

function ratio(n: number, d: number) {
  return d === 0 ? 0 : Math.round((n / d) * 1000) / 1000;
}

function hasLeak(ep: BacktestEpisode) {
  const cutoff = new Date(ep.atDecision.asOf).getTime();
  const measured = ep.atDecision.metrics.measuredAt ? new Date(ep.atDecision.metrics.measuredAt).getTime() : 0;
  const marketLeak = ep.atDecision.market.runs.some((r) => new Date(r.capturedAt).getTime() > cutoff);
  return measured > cutoff || marketLeak;
}

function shuffledContext(ctx: DecisionContext): DecisionContext {
  // 結論が入力の並び順に依存しないことを確かめる。
  return {
    ...ctx,
    metrics: { ...ctx.metrics, sourceRowIds: [...ctx.metrics.sourceRowIds].reverse().sort(), sources: [...ctx.metrics.sources].reverse().sort() },
    lineage: [...ctx.lineage],
  };
}

function relevant(decision: StructuredDecision, ctx: DecisionContext) {
  const known = new Set(ctx.metrics.known);
  switch (decision.action_type) {
    case "fix_offer_or_lp": return known.has("clicks") && known.has("conversions");
    case "scale_same_hypothesis": return decision.teacher.hypothesis_match === "supported";
    case "stop_line": return decision.teacher.hypothesis_match === "rejected" && ctx.pivotStreak > 0;
    case "collect_more_data": return decision.status === "insufficient_data";
    default: return decision.verdict === "pivot";
  }
}

function hypothesisOk(decision: StructuredDecision) {
  return decision.hypothesis.trim().length >= 8
    && decision.target_customer.trim().length > 0
    && decision.primary_metric.trim().length > 0
    && decision.learning_objective.trim().length > 0;
}

export function runBacktest(episodes: BacktestEpisode[]): BacktestReport {
  const verdicts: Record<string, number> = {};
  const details: BacktestReport["details"] = [];
  let leaks = 0, consistent = 0, relevantCount = 0, hypothesisCount = 0, coverageSum = 0;
  let falseStop = 0, falseContinue = 0, unnecessaryPivot = 0, decided = 0, agreed = 0;
  let duplicates = 0, generating = 0;
  const seenActions = new Map<string, Set<string>>();

  for (const ep of episodes) {
    if (hasLeak(ep)) { leaks++; continue; }
    const d = buildDeterministicDecision(ep.atDecision);
    const again = buildDeterministicDecision(shuffledContext(ep.atDecision));
    const truth = buildDeterministicDecision(ep.hindsight);

    verdicts[d.verdict] = (verdicts[d.verdict] ?? 0) + 1;
    if (again.verdict === d.verdict && again.action_type === d.action_type && again.input_hash === d.input_hash) consistent++;
    if (relevant(d, ep.atDecision)) relevantCount++;
    if (hypothesisOk(d)) hypothesisCount++;
    coverageSum += d.evidence_coverage.score;

    const decidedNow = d.verdict !== "wait";
    const truthDecided = truth.verdict !== "wait";
    if (d.verdict === "stop" && truth.verdict === "continue") falseStop++;
    if (d.verdict === "continue" && (truth.verdict === "pivot" || truth.verdict === "stop")) falseContinue++;
    if (d.verdict === "pivot" && truth.verdict === "continue") unnecessaryPivot++;
    if (decidedNow) {
      decided++;
      if (truthDecided && truth.verdict === d.verdict) agreed++;
    }

    if (d.next_action.generate_creative) {
      generating++;
      const signature = [d.action_type, d.next_action.change_axis, d.next_action.angle ?? "", d.next_action.hook ?? ""].join("|");
      const seen = seenActions.get(ep.lineageKey) ?? new Set<string>();
      if (seen.has(signature)) duplicates++;
      seen.add(signature);
      seenActions.set(ep.lineageKey, seen);
    }

    details.push({ postId: ep.postId, asOf: ep.atDecision.asOf, verdict: d.verdict, hindsightVerdict: truth.verdict, actionType: d.action_type, agreement: d.verdict === truth.verdict });
  }

  const evaluated = episodes.length - leaks;
  return {
    episodes: evaluated,
    leakageViolations: leaks,
    decisionConsistency: ratio(consistent, evaluated),
    actionRelevance: ratio(relevantCount, evaluated),
    hypothesisQuality: ratio(hypothesisCount, evaluated),
    evidenceCoverage: ratio(coverageSum, evaluated),
    duplicateRecommendationRate: ratio(duplicates, generating),
    falseStop,
    falseContinue,
    unnecessaryPivot,
    decidedRate: ratio(decided, evaluated),
    learningEfficiency: ratio(agreed, decided),
    verdicts,
    details,
  };
}
