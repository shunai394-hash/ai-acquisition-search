import type { Criterion, DecisionEvidence, HistoricalResult, MetricSnapshot, TeacherResult, Verdict } from "./types";

// Deterministic Teacher. The LLM never decides CONTINUE / PIVOT / STOP / WAIT:
// the verdict is a pure function of the evidence so the same input always
// yields the same verdict, and every verdict lists the criteria it used.
export const TEACHER_LOGIC_VERSION = "teacher-2026.10.1";

export const TEACHER_THRESHOLDS = {
  /** Minimum views/impressions before anything is judged. */
  minExposure: 300,
  /** Minimum impressions before CTR is judged. */
  minImpressionsForCtr: 500,
  /** Impressions after which an inconclusive CTR is treated as final. */
  conclusiveImpressions: 3000,
  /** Minimum clicks before CVR is judged. */
  minClicksForCvr: 30,
  /** Minimum conversions before profitability is judged as a win. */
  minConversionsForProfit: 3,
  defaultCtrBenchmark: 0.01,
  defaultEngagementBenchmark: 0.03,
  defaultBreakevenRoas: 2,
  /** Prior history samples required before the user's own baseline replaces defaults. */
  minBaselineSamples: 3,
  /** Days after publish after which WAIT is no longer allowed (prevents waiting forever). */
  maxWaitDays: 7,
  /** Consecutive poor attempts in the same lineage before STOP (sales/click signal). */
  stopAfterPoorAttempts: 2,
  /** Engagement-only signals stop only after this many poor attempts. */
  stopAfterPoorAttemptsEngagementOnly: 4,
} as const;

const T = TEACHER_THRESHOLDS;
const DAY_MS = 24 * 60 * 60 * 1000;

function wilson(successes: number, trials: number, z = 1.96) {
  if (trials <= 0) return { low: 0, high: 1 };
  const p = successes / trials;
  const denom = 1 + (z * z) / trials;
  const center = (p + (z * z) / (2 * trials)) / denom;
  const margin = (z * Math.sqrt((p * (1 - p)) / trials + (z * z) / (4 * trials * trials))) / denom;
  return { low: Math.max(0, center - margin), high: Math.min(1, center + margin) };
}

function median(values: number[]) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function round(value: number | null, digits = 4) {
  if (value == null || !Number.isFinite(value)) return null;
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}

export function exposureOf(m: MetricSnapshot) {
  return Math.max(m.impressions ?? 0, m.views ?? 0);
}

function engagementOf(m: MetricSnapshot) {
  return (m.likes ?? 0) + (m.comments ?? 0) + (m.shares ?? 0) + (m.saves ?? 0);
}

/** Only history measured at or before asOf, excluding the post being judged. */
export function eligibleHistory(evidence: DecisionEvidence): HistoricalResult[] {
  const asOf = Date.parse(evidence.asOf);
  return evidence.history.filter((h) =>
    h.socialPostId !== evidence.hypothesis.socialPostId &&
    h.network === evidence.hypothesis.network &&
    Date.parse(h.metric.measuredAt) <= asOf,
  );
}

function ctrBaseline(history: HistoricalResult[]) {
  const values = history
    .filter((h) => h.metric.clicks != null && (h.metric.impressions ?? 0) >= T.minImpressionsForCtr)
    .map((h) => (h.metric.clicks as number) / (h.metric.impressions as number));
  return values.length >= T.minBaselineSamples ? median(values) : null;
}

function exposureBaseline(history: HistoricalResult[]) {
  const values = history.map((h) => exposureOf(h.metric)).filter((v) => v > 0);
  return values.length >= T.minBaselineSamples ? median(values) : null;
}

function engagementBaseline(history: HistoricalResult[]) {
  const values = history
    .filter((h) => exposureOf(h.metric) >= T.minExposure)
    .map((h) => engagementOf(h.metric) / exposureOf(h.metric));
  return values.length >= T.minBaselineSamples ? median(values) : null;
}

function consecutivePoor(lineage: Verdict[]) {
  let count = 0;
  for (const v of lineage) {
    if (v === "pivot" || v === "stop") count++;
    else break;
  }
  return count;
}

function breakevenRoas(evidence: DecisionEvidence) {
  const { price, cost } = evidence.product;
  if (price != null && cost != null && price > 0 && price > cost) return price / (price - cost);
  return T.defaultBreakevenRoas;
}

function confidenceFor(sample: number, target: number, base: number) {
  const ratio = Math.min(1, sample / Math.max(1, target));
  return round(Math.min(0.95, base * (0.6 + 0.4 * ratio)), 2) as number;
}

export function evaluateTeacher(evidence: DecisionEvidence): TeacherResult {
  const m = evidence.current;
  const criteria: Criterion[] = [];
  const missingData: string[] = [];
  const lineagePoor = consecutivePoor(evidence.hypothesis.lineageVerdicts);
  const history = eligibleHistory(evidence);

  const result = (
    verdict: Verdict,
    ruleId: string,
    reason: string,
    confidence: number,
    status: TeacherResult["status"] = "decided",
  ): TeacherResult => ({
    verdict,
    status: verdict === "wait" ? "insufficient_data" : status,
    ruleId,
    reason,
    criteria,
    sample: {
      exposure: m ? exposureOf(m) : 0,
      clicks: m?.clicks ?? null,
      conversions: m?.conversions ?? null,
    },
    confidence,
    missingData,
    logicVersion: TEACHER_LOGIC_VERSION,
  });

  if (!m || Date.parse(m.measuredAt) > Date.parse(evidence.asOf)) {
    missingData.push("post_metrics");
    return result("wait", "no_metrics", "判定時点で取得済みの投稿実績がないため、判定を保留します。", 0);
  }

  if (m.clicks == null) missingData.push("clicks");
  if (m.conversions == null) missingData.push("conversions");
  if (m.revenue == null) missingData.push("revenue");
  if (evidence.product.price == null) missingData.push("product.price");
  if (evidence.product.cost == null) missingData.push("product.cost");

  const exposure = exposureOf(m);
  const publishedAt = evidence.hypothesis.publishedAt ? Date.parse(evidence.hypothesis.publishedAt) : NaN;
  const ageDays = Number.isFinite(publishedAt) ? (Date.parse(evidence.asOf) - publishedAt) / DAY_MS : null;
  const waitExpired = ageDays != null && ageDays >= T.maxWaitDays;
  criteria.push({ name: "post_age_days", value: round(ageDays, 1), threshold: T.maxWaitDays, passed: null });
  criteria.push({ name: "lineage_consecutive_poor", value: lineagePoor, threshold: T.stopAfterPoorAttempts, passed: lineagePoor < T.stopAfterPoorAttempts });

  // 1. Paid traffic with known revenue: profitability decides first.
  if (m.adSpend != null && m.adSpend > 0 && m.revenue != null && m.conversions != null) {
    const roas = m.revenue / m.adSpend;
    const breakeven = breakevenRoas(evidence);
    const profit = m.grossProfit != null ? m.grossProfit - m.adSpend : null;
    const profitable = profit != null ? profit > 0 : roas >= breakeven;
    criteria.push({ name: "roas", value: round(roas), threshold: round(breakeven), passed: roas >= breakeven });
    if (profit != null) criteria.push({ name: "gross_profit_after_ad_cost", value: round(profit, 0), threshold: 0, passed: profit > 0 });
    criteria.push({ name: "conversions", value: m.conversions, threshold: T.minConversionsForProfit, passed: m.conversions >= T.minConversionsForProfit });

    if (m.conversions >= T.minConversionsForProfit && profitable) {
      return result("continue", "profitable_paid", "広告費を差し引いても利益が出ており、CV数も判定に十分です。同じ仮説を強化します。", confidenceFor(m.conversions, 10, 0.9));
    }
    if (m.conversions >= T.minConversionsForProfit && !profitable) {
      if (lineagePoor >= T.stopAfterPoorAttempts) {
        return result("stop", "unprofitable_repeated", `CVは発生していますが採算割れで、同系統の仮説が${lineagePoor + 1}回連続で基準未達です。この仮説を停止します。`, confidenceFor(m.conversions, 10, 0.8));
      }
      return result("pivot", "unprofitable_paid", "CVは発生していますが広告費を回収できていません。オファー・価格訴求・対象を変更して再テストします。", confidenceFor(m.conversions, 10, 0.75));
    }
    if (m.clicks != null && m.clicks >= T.minClicksForCvr && m.conversions === 0) {
      criteria.push({ name: "clicks_without_conversion", value: m.clicks, threshold: T.minClicksForCvr, passed: false });
      if (lineagePoor >= T.stopAfterPoorAttempts) {
        return result("stop", "no_conversion_repeated", `十分なクリック後もCVがなく、同系統の仮説が${lineagePoor + 1}回連続で基準未達です。この仮説を停止します。`, confidenceFor(m.clicks, 100, 0.8));
      }
      return result("pivot", "no_conversion_paid", "十分なクリックがあるのにCVが0件です。広告Hookではなく遷移先・オファーとの接続を変更します。", confidenceFor(m.clicks, 100, 0.7));
    }
  }

  // 2. Not enough exposure to judge anything.
  criteria.push({ name: "exposure", value: exposure, threshold: T.minExposure, passed: exposure >= T.minExposure });
  if (exposure < T.minExposure) {
    if (!waitExpired) {
      return result("wait", "insufficient_exposure", `表示/再生が${exposure}件で、判定に必要な${T.minExposure}件に達していません。STOP/PIVOTせず追加データを待ちます。`, 0);
    }
    if (lineagePoor >= T.stopAfterPoorAttemptsEngagementOnly) {
      return result("stop", "no_reach_repeated", `公開から${Math.floor(ageDays as number)}日経過しても露出が基準未満で、同系統の仮説が${lineagePoor + 1}回連続で基準未達です。停止します。`, 0.6);
    }
    return result("pivot", "no_reach", `公開から${Math.floor(ageDays as number)}日経過しても露出が${T.minExposure}件未満です。冒頭Hookまたは媒体適合を変更して再テストします。`, 0.5);
  }

  // 3. Click signal is known: CTR (and CVR) against the user's own baseline.
  if (m.clicks != null && m.impressions != null && m.impressions >= T.minImpressionsForCtr) {
    const ctr = m.clicks / m.impressions;
    const baseline = ctrBaseline(history);
    const benchmark = baseline ?? T.defaultCtrBenchmark;
    const ci = wilson(m.clicks, m.impressions);
    criteria.push({ name: "ctr", value: round(ctr), threshold: round(benchmark), passed: ctr >= benchmark });
    criteria.push({ name: "ctr_ci95", value: `${round(ci.low)}-${round(ci.high)}`, threshold: baseline != null ? "own_baseline_median" : "default_benchmark", passed: null });

    if (ci.low > benchmark) {
      if (m.conversions != null && m.clicks >= T.minClicksForCvr) {
        const cvr = m.conversions / m.clicks;
        criteria.push({ name: "cvr", value: round(cvr), threshold: ">0", passed: cvr > 0 });
        if (cvr === 0) {
          return result("pivot", "ctr_ok_cvr_zero", "CTRは基準を上回っていますが、十分なクリックに対してCVが0件です。遷移先・オファーとの接続を変更します。", confidenceFor(m.clicks, 100, 0.75));
        }
      }
      return result("continue", "ctr_above_benchmark", `CTR ${(ctr * 100).toFixed(2)}% は${baseline != null ? "過去実績の中央値" : "標準基準"}${(benchmark * 100).toFixed(2)}%を統計的に上回っています。同じ仮説を強化します。`, confidenceFor(m.impressions, 5000, 0.85));
    }
    if (ci.high < benchmark) {
      if (lineagePoor >= T.stopAfterPoorAttempts) {
        return result("stop", "ctr_below_repeated", `CTRが基準を統計的に下回り、同系統の仮説が${lineagePoor + 1}回連続で基準未達です。この仮説を停止します。`, confidenceFor(m.impressions, 5000, 0.8));
      }
      return result("pivot", "ctr_below_benchmark", `CTR ${(ctr * 100).toFixed(2)}% は基準${(benchmark * 100).toFixed(2)}%を統計的に下回っています。Hookまたは訴求を1つ変更して再テストします。`, confidenceFor(m.impressions, 5000, 0.75));
    }
    if (m.impressions < T.conclusiveImpressions && !waitExpired) {
      return result("wait", "ctr_inconclusive", "CTRは基準と統計的に区別できません。追加の表示データを待ってから判定します。", 0);
    }
    return ctr >= benchmark
      ? result("continue", "ctr_at_benchmark", "十分な表示数でCTRは基準水準です。同じ仮説を維持しつつHookのみ改善します。", 0.55)
      : result("pivot", "ctr_under_benchmark", "十分な表示数でCTRが基準をやや下回っています。訴求を1つ変更して再テストします。", 0.55);
  }

  // 4. Engagement-only networks (no click / sales signal). Never a confident STOP.
  const er = engagementOf(m) / exposure;
  const erBaseline = engagementBaseline(history);
  const erBenchmark = erBaseline ?? T.defaultEngagementBenchmark;
  const erCi = wilson(engagementOf(m), exposure);
  const reachBaseline = exposureBaseline(history);
  const reachRatio = reachBaseline ? exposure / reachBaseline : null;
  criteria.push({ name: "engagement_rate", value: round(er), threshold: round(erBenchmark), passed: er >= erBenchmark });
  criteria.push({ name: "reach_vs_baseline", value: round(reachRatio, 2), threshold: reachBaseline != null ? "0.5-1.5x own median" : "no_baseline", passed: reachRatio == null ? null : reachRatio >= 1 });

  const strong = (reachRatio != null && reachRatio >= 1.5) || erCi.low > erBenchmark;
  const poor = (reachRatio != null && reachRatio < 0.5) || erCi.high < erBenchmark;
  const signalNote = "（この媒体ではクリック・売上を自動取得できないため、反応指標のみで判定）";

  if (strong && !poor) {
    return result("continue", "engagement_strong", `再生/反応が基準を上回っています。同じ仮説を強化し、クリック・購入データの取得を優先します${signalNote}。`, confidenceFor(exposure, 5000, 0.6));
  }
  if (poor && !strong) {
    if (lineagePoor >= T.stopAfterPoorAttemptsEngagementOnly) {
      return result("stop", "engagement_poor_repeated", `反応指標が同系統の仮説で${lineagePoor + 1}回連続で基準未達です。この仮説を停止します${signalNote}。`, 0.55);
    }
    return result("pivot", "engagement_poor", `再生/反応が基準を下回っています。Hookまたは訴求を1つ変更して再テストします${signalNote}。`, confidenceFor(exposure, 5000, 0.5));
  }
  if (!waitExpired) {
    return result("wait", "engagement_inconclusive", `反応指標が基準と区別できません。追加データを待ちます${signalNote}。`, 0);
  }
  return er >= erBenchmark
    ? result("continue", "engagement_at_benchmark", `公開から期間が経過し、反応は基準水準です。同じ仮説でHookのみ改善します${signalNote}。`, 0.45)
    : result("pivot", "engagement_under_benchmark", `公開から期間が経過し、反応は基準をやや下回っています。訴求を1つ変更します${signalNote}。`, 0.45);
}
