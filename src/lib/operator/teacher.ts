import { deriveRates, type DerivedRates, type MergedMetrics } from "./metrics";

// Teacher: 投稿実績から CONTINUE / PIVOT / STOP / WAIT を決める決定論的ルール。
// LLM の感覚ではなく、サンプル数・実測指標・過去比較・仮説の主要指標で判断する。
// LLM は判定結果を覆せない（文章化と次案の具体化だけを担当する）。

export const TEACHER_LOGIC_VERSION = "teacher-v2.0.0";

export type TeacherVerdict = "continue" | "pivot" | "stop" | "wait";
export type TeacherStatus = "decided" | "insufficient_data";
export type SignalTier = "profit" | "conversion" | "click" | "engagement" | "reach" | "none";

export type TeacherThresholds = {
  minAgeHours: number;          // 公開からこの時間未満は判定しない
  matureAgeHours: number;       // この時間を過ぎても露出が少なければ「配信が伸びない」こと自体を結果とみなす
  minReach: number;             // 判定に必要な最小露出（impressions / views）
  minClicksForCvr: number;      // CVR を評価する最小クリック数
  minConversions: number;       // 売上系指標で CONTINUE するための最小CV数
  minImpressionsForCtr: number; // CTR を評価する最小インプレッション
  continueRoas: number;
  stopRoas: number;
  continueCtr: number;          // 過去比較が無い時の CTR 基準
  baselineLift: number;         // 過去中央値に対してこの倍率以上なら勝ち
  baselineDrop: number;         // 過去中央値に対してこの倍率未満なら負け
  minBaselinePosts: number;     // 過去比較に必要な投稿数
  stopAfterPivots: number;      // 連続 PIVOT がこの回数に達してなお負けなら STOP
};

export const DEFAULT_THRESHOLDS: TeacherThresholds = {
  minAgeHours: 24,
  matureAgeHours: 72,
  minReach: 500,
  minClicksForCvr: 30,
  minConversions: 3,
  minImpressionsForCtr: 1000,
  continueRoas: 1.5,
  stopRoas: 0.5,
  continueCtr: 0.01,
  baselineLift: 1.2,
  baselineDrop: 0.6,
  minBaselinePosts: 3,
  stopAfterPivots: 2,
};

export type Baseline = {
  posts: number;
  ctr: number | null;
  cvr: number | null;
  roas: number | null;
  engagementRate: number | null;
  reach: number | null;
};

export type TeacherInput = {
  network: string;
  ageHours: number | null;
  metrics: MergedMetrics;
  baseline?: Baseline | null;
  primaryMetric?: string | null;   // 仮説で定めた主要指標（例: "CTR", "CVR", "ROAS"）
  pivotStreak?: number;            // 直前まで連続した PIVOT 回数（仮説系列の学習量）
  thresholds?: Partial<TeacherThresholds>;
};

export type TeacherCheck = {
  name: string;
  value: number | string | null;
  threshold: number | string | null;
  passed: boolean | null;          // null = 評価できない（データ未取得）
  note?: string;
};

export type TeacherResult = {
  logicVersion: string;
  verdict: TeacherVerdict;
  status: TeacherStatus;
  signalTier: SignalTier;
  confidence: number;
  reasons: string[];
  checks: TeacherCheck[];
  rates: DerivedRates;
  sample: { reach: number; clicks: number | null; conversions: number | null; ageHours: number | null; snapshots: number };
  hypothesisMatch: "supported" | "rejected" | "untested";
  missingSignals: string[];
};

function round(value: number | null, digits = 4) {
  if (value === null || !Number.isFinite(value)) return null;
  const p = 10 ** digits;
  return Math.round(value * p) / p;
}

function normalizeMetricName(value?: string | null): "ctr" | "cvr" | "roas" | "profit" | "engagement" | null {
  const v = String(value || "").toLowerCase();
  if (!v) return null;
  if (v.includes("roas") || v.includes("売上") || v.includes("revenue")) return "roas";
  if (v.includes("profit") || v.includes("粗利") || v.includes("利益")) return "profit";
  if (v.includes("cvr") || v.includes("cv") || v.includes("conversion") || v.includes("購入")) return "cvr";
  if (v.includes("ctr") || v.includes("click") || v.includes("クリック")) return "ctr";
  if (v.includes("engagement") || v.includes("like") || v.includes("保存") || v.includes("いいね") || v.includes("視聴") || v.includes("view")) return "engagement";
  return null;
}

export function evaluateTeacher(input: TeacherInput): TeacherResult {
  const t = { ...DEFAULT_THRESHOLDS, ...(input.thresholds || {}) };
  const m = input.metrics;
  const v = m.values;
  const known = (field: keyof typeof v) => m.known.includes(field);
  const rates = deriveRates(m);
  const baseline = input.baseline && input.baseline.posts >= t.minBaselinePosts ? input.baseline : null;
  const pivotStreak = Math.max(0, input.pivotStreak ?? 0);
  const checks: TeacherCheck[] = [];
  const reasons: string[] = [];
  const missingSignals: string[] = [];

  const clicks = known("clicks") ? (v.clicks ?? 0) : null;
  const conversions = known("conversions") ? (v.conversions ?? 0) : null;
  const sample = { reach: rates.reach, clicks, conversions, ageHours: input.ageHours, snapshots: m.snapshots };

  if (!known("clicks")) missingSignals.push("clicks");
  if (!known("conversions")) missingSignals.push("conversions");
  if (!known("revenue")) missingSignals.push("revenue");
  if (!known("grossProfit")) missingSignals.push("gross_profit");
  if (!known("adSpend")) missingSignals.push("ad_spend");

  const result = (
    verdict: TeacherVerdict,
    status: TeacherStatus,
    signalTier: SignalTier,
    confidence: number,
    hypothesisMatch: TeacherResult["hypothesisMatch"],
  ): TeacherResult => ({
    logicVersion: TEACHER_LOGIC_VERSION,
    verdict,
    status,
    signalTier,
    confidence: round(Math.max(0, Math.min(1, confidence)), 2) ?? 0,
    reasons,
    checks,
    rates: {
      reach: rates.reach,
      ctr: round(rates.ctr),
      cvr: round(rates.cvr),
      roas: round(rates.roas, 3),
      cpa: round(rates.cpa, 2),
      contribution: round(rates.contribution, 2),
      engagementRate: round(rates.engagementRate),
    },
    sample,
    hypothesisMatch,
    missingSignals,
  });

  // 1. データ量の確認 ---------------------------------------------------------
  if (m.snapshots === 0 || m.known.length === 0) {
    checks.push({ name: "metrics_available", value: 0, threshold: 1, passed: false });
    reasons.push("実績データがまだ1件もありません。");
    return result("wait", "insufficient_data", "none", 0.9, "untested");
  }

  const ageKnown = input.ageHours !== null && Number.isFinite(input.ageHours);
  checks.push({ name: "age_hours", value: ageKnown ? round(input.ageHours, 1) : null, threshold: t.minAgeHours, passed: ageKnown ? (input.ageHours as number) >= t.minAgeHours : null });
  if (ageKnown && (input.ageHours as number) < t.minAgeHours) {
    reasons.push(`公開から${t.minAgeHours}時間未満のため、配信が安定するまで判定しません。`);
    return result("wait", "insufficient_data", "none", 0.85, "untested");
  }

  // 売上・利益系（最も強いシグナル） -------------------------------------------
  const hasProfitSignal = rates.contribution !== null && (conversions ?? 0) >= t.minConversions;
  const hasRoasSignal = rates.roas !== null && known("conversions") && ((conversions ?? 0) >= t.minConversions || (clicks ?? 0) >= t.minClicksForCvr);
  const hasCvrSignal = rates.cvr !== null && (clicks ?? 0) >= t.minClicksForCvr;
  const hasCtrSignal = rates.ctr !== null && (v.impressions ?? 0) >= t.minImpressionsForCtr;
  const hasEngagementSignal = rates.engagementRate !== null && rates.reach >= t.minReach;

  checks.push({ name: "reach", value: rates.reach, threshold: t.minReach, passed: rates.reach >= t.minReach });

  const primary = normalizeMetricName(input.primaryMetric);
  let tier: SignalTier = "none";
  let win: boolean | null = null;      // true=勝ち, false=負け, null=判定不能
  let strongLoss = false;              // 経済的に明確な負け（STOP 候補）

  if (hasProfitSignal || hasRoasSignal) {
    tier = hasProfitSignal ? "profit" : "conversion";
    const roas = rates.roas;
    const contribution = rates.contribution;
    if (roas !== null) checks.push({ name: "roas", value: round(roas, 3), threshold: t.continueRoas, passed: roas >= t.continueRoas });
    if (contribution !== null) checks.push({ name: "contribution_profit", value: round(contribution, 2), threshold: 0, passed: contribution > 0 });
    const roasWin = roas !== null && roas >= t.continueRoas && (conversions ?? 0) >= t.minConversions;
    const profitWin = contribution !== null && contribution > 0 && (conversions ?? 0) >= t.minConversions;
    win = roasWin || profitWin;
    strongLoss = (roas !== null && roas < t.stopRoas) || (contribution !== null && contribution < 0 && (roas === null || roas < 1));
    reasons.push(win
      ? "売上・粗利の実測で広告費を上回る成果を確認しました。"
      : "売上・粗利の実測が広告費に対して基準に届いていません。");
  } else if (hasCvrSignal) {
    tier = "conversion";
    const cvr = rates.cvr as number;
    const threshold = baseline?.cvr ?? null;
    checks.push({ name: "cvr", value: round(cvr), threshold: threshold !== null ? round(threshold * t.baselineLift) : "baseline unavailable", passed: threshold !== null ? cvr >= threshold * t.baselineLift : null });
    if ((conversions ?? 0) === 0) {
      win = false;
      strongLoss = (clicks ?? 0) >= t.minClicksForCvr * 3;
      reasons.push(`クリック${clicks}件に対して購入・CVが0件です。`);
    } else if (threshold !== null) {
      win = cvr >= threshold * t.baselineLift ? true : cvr < threshold * t.baselineDrop ? false : null;
      reasons.push(`CVR ${(cvr * 100).toFixed(2)}% を過去中央値 ${(threshold * 100).toFixed(2)}% と比較しました。`);
    } else {
      win = (conversions ?? 0) >= t.minConversions;
      reasons.push(`CV ${conversions}件を確認しました（過去比較データなし）。`);
    }
  } else if (hasCtrSignal) {
    tier = "click";
    const ctr = rates.ctr as number;
    const winLine = baseline?.ctr != null ? Math.max(baseline.ctr * t.baselineLift, t.continueCtr * 0.5) : t.continueCtr;
    const loseLine = baseline?.ctr != null ? baseline.ctr * t.baselineDrop : t.continueCtr * 0.3;
    checks.push({ name: "ctr", value: round(ctr), threshold: round(winLine), passed: ctr >= winLine });
    win = ctr >= winLine ? true : ctr < loseLine ? false : null;
    strongLoss = win === false && (v.impressions ?? 0) >= t.minImpressionsForCtr * 3 && ctr < loseLine * 0.5;
    reasons.push(`CTR ${(ctr * 100).toFixed(2)}%（インプレッション${v.impressions}件）を基準 ${(winLine * 100).toFixed(2)}% と比較しました。`);
  } else if (hasEngagementSignal) {
    tier = "engagement";
    const er = rates.engagementRate as number;
    const base = baseline?.engagementRate ?? null;
    checks.push({ name: "engagement_rate", value: round(er), threshold: base !== null ? round(base * t.baselineLift) : "baseline unavailable", passed: base !== null ? er >= base * t.baselineLift : null });
    if (base !== null && base > 0) {
      win = er >= base * t.baselineLift ? true : er < base * t.baselineDrop ? false : null;
      reasons.push(`エンゲージメント率 ${(er * 100).toFixed(2)}% を過去中央値 ${(base * 100).toFixed(2)}% と比較しました。`);
    } else {
      win = null;
      reasons.push(`エンゲージメント率 ${(er * 100).toFixed(2)}% を取得しましたが、比較できる過去投稿がまだ不足しています。`);
    }
    // エンゲージメントだけでは売上への寄与が分からないため STOP の根拠にしない。
    strongLoss = false;
  } else {
    // 露出不足 --------------------------------------------------------------
    const mature = ageKnown && (input.ageHours as number) >= t.matureAgeHours;
    if (!mature) {
      reasons.push(`露出が${rates.reach}件で判定に必要な${t.minReach}件に届いていません。追加データを待ちます。`);
      return result("wait", "insufficient_data", "none", 0.75, "untested");
    }
    tier = "reach";
    win = false;
    strongLoss = false; // 配信が伸びないのは Hook/形式の問題の可能性が高く、商品・仮説そのものの否定ではない
    reasons.push(`公開から${Math.round(input.ageHours as number)}時間経過しても露出が${rates.reach}件にとどまっています。Hookまたは形式を変更します。`);
  }

  // 仮説の主要指標と、今回評価できた指標の一致 -----------------------------------
  const evaluated: Record<SignalTier, string | null> = { profit: "profit", conversion: rates.roas !== null ? "roas" : "cvr", click: "ctr", engagement: "engagement", reach: null, none: null };
  if (primary && evaluated[tier] && primary !== evaluated[tier] && !(primary === "roas" && tier === "profit")) {
    checks.push({ name: "primary_metric_measured", value: evaluated[tier], threshold: primary, passed: false, note: "仮説の主要指標ではなく代替指標で評価" });
    reasons.push(`仮説の主要指標（${input.primaryMetric}）は未計測のため、代替指標で評価しています。`);
  } else if (primary) {
    checks.push({ name: "primary_metric_measured", value: evaluated[tier], threshold: primary, passed: evaluated[tier] !== null });
  }

  const tierConfidence: Record<SignalTier, number> = { profit: 0.85, conversion: 0.75, click: 0.6, engagement: 0.45, reach: 0.4, none: 0.3 };
  let confidence = tierConfidence[tier];
  if (baseline) confidence += 0.05;
  if (m.snapshots >= 2) confidence += 0.03;
  if (primary && evaluated[tier] && primary !== evaluated[tier]) confidence -= 0.1;

  checks.push({ name: "pivot_streak", value: pivotStreak, threshold: t.stopAfterPivots, passed: pivotStreak < t.stopAfterPivots });

  if (win === true) {
    reasons.push("仮説は支持されました。同じ仮説を強化して継続します。");
    return result("continue", "decided", tier, confidence, "supported");
  }

  if (win === null) {
    // 勝ち負けが判定できる差が出ていない。データが揃うまで待つか、学習を進めるかを分ける。
    const mature = ageKnown && (input.ageHours as number) >= t.matureAgeHours;
    if (!mature) {
      reasons.push("勝ち負けを判断できる差がまだ出ていないため、追加データを待ちます。");
      return result("wait", "insufficient_data", tier, Math.min(confidence, 0.6), "untested");
    }
    reasons.push("十分な期間を経ても明確な差が出ていないため、変更点を1つに絞って次の仮説をテストします。");
    return result("pivot", "decided", tier, Math.min(confidence, 0.55), "untested");
  }

  // win === false
  if (strongLoss && pivotStreak >= t.stopAfterPivots) {
    reasons.push(`同じ商品・仮説系列で${pivotStreak}回PIVOTしても実測が基準を大きく下回ったため、この系列の追加制作を停止します。`);
    return result("stop", "decided", tier, confidence, "rejected");
  }
  if (strongLoss) {
    reasons.push("実測は基準を大きく下回っていますが、仮説系列としての学習回数が不足しているため STOP ではなく PIVOT します。");
  } else {
    reasons.push("仮説は支持されませんでした。訴求・Hook・対象のいずれかを変更して再テストします。");
  }
  return result("pivot", "decided", tier, confidence, "rejected");
}

// 過去投稿の実績から中央値ベースラインを作る。未来のデータを混ぜないよう、
// 呼び出し側で「判定時点より前に計測された行」だけを渡すこと。
export function buildBaseline(entries: MergedMetrics[], minReach = DEFAULT_THRESHOLDS.minReach): Baseline {
  const usable = entries.map(deriveRates).filter((r) => r.reach >= minReach);
  const median = (values: Array<number | null>) => {
    const xs = values.filter((x): x is number => x !== null && Number.isFinite(x)).sort((a, b) => a - b);
    if (!xs.length) return null;
    const mid = Math.floor(xs.length / 2);
    return xs.length % 2 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2;
  };
  return {
    posts: usable.length,
    ctr: median(usable.map((r) => r.ctr)),
    cvr: median(usable.map((r) => r.cvr)),
    roas: median(usable.map((r) => r.roas)),
    engagementRate: median(usable.map((r) => r.engagementRate)),
    reach: median(usable.map((r) => r.reach)),
  };
}
