export type CampaignTest = {
  id: string;
  concept: string;
  hook: string;
  channel: string;
  format: string;
  hypothesis: string;
  successMetric: string;
  expectedCtr?: number | null;
  expectedCvr?: number | null;
  expectedProfit?: number | null;
  learningValueScore: number;
  priorityScore: number;
  rankReason: string;
};

export type CampaignPerformance = {
  platform: string;
  postId: string;
  metrics: {
    views?: number | null;
    impressions?: number | null;
    likes?: number | null;
    comments?: number | null;
    shares?: number | null;
    clicks?: number | null;
    conversions?: number | null;
    revenue?: number | null;
    grossProfit?: number | null;
    adSpend?: number | null;
  };
};

export type NextCampaignDecision = {
  basedOn: string[];
  observed: string[];
  unknown: string[];
  nextTests: CampaignTest[];
  productionBrief: {
    objective: string;
    audience: string;
    angle: string;
    hook: string;
    format: string;
    cta: string;
  } | null;
};

function num(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function decideNextCampaign(input: {
  analysis: {
    customer?: { likelySegments?: string[]; needs?: string[] };
    opportunities?: string[];
    nextPosts?: Array<{ concept: string; hook: string; format: string; channel: string; reason: string; testMetric: string }>;
    decision?: { target?: string; problem?: string; desire?: string; valueProposition?: string; channel?: string; format?: string };
  };
  performance?: CampaignPerformance[];
}): NextCampaignDecision {
  const posts = input.analysis.nextPosts ?? [];
  const performance = input.performance ?? [];
  const observed: string[] = [];
  const unknown: string[] = [];
  const basedOn: string[] = [];

  for (const p of performance) {
    const m = p.metrics;
    const parts = [
      num(m.views) != null ? `views=${m.views}` : null,
      num(m.impressions) != null ? `impressions=${m.impressions}` : null,
      num(m.likes) != null ? `likes=${m.likes}` : null,
      num(m.comments) != null ? `comments=${m.comments}` : null,
      num(m.shares) != null ? `shares=${m.shares}` : null,
      num(m.clicks) != null ? `clicks=${m.clicks}` : null,
    ].filter(Boolean);
    if (parts.length) observed.push(`${p.platform}/${p.postId}: ${parts.join(", ")}`);
    else unknown.push(`${p.platform}/${p.postId}: metrics unavailable`);
  }

  if (performance.length) basedOn.push("接続済みSNSの観測実績");
  if (input.analysis.opportunities?.length) basedOn.push("商品・市場分析で抽出した機会");
  if (!performance.length) unknown.push("まだ投稿実績が接続されていないため、成果比較はできない");

  const channelStats = new Map<string, {
    impressions: number;
    clicks: number;
    conversions: number;
    grossProfit: number;
    adSpend: number;
  }>();
  for (const p of performance) {
    const key = p.platform.trim().toLowerCase();
    const s = channelStats.get(key) ?? { impressions: 0, clicks: 0, conversions: 0, grossProfit: 0, adSpend: 0 };
    if (num(p.metrics.impressions) != null) s.impressions += p.metrics.impressions!;
    if (num(p.metrics.clicks) != null) s.clicks += p.metrics.clicks!;
    if (num(p.metrics.conversions) != null) s.conversions += p.metrics.conversions!;
    if (num(p.metrics.grossProfit) != null) s.grossProfit += p.metrics.grossProfit!;
    if (num(p.metrics.adSpend) != null) s.adSpend += p.metrics.adSpend!;
    channelStats.set(key, s);
  }

  const channelEvidence = [...channelStats.entries()].map(([channel, s]) => ({
    channel,
    ctr: s.impressions > 0 ? s.clicks / s.impressions : null,
    cvr: s.clicks > 0 ? s.conversions / s.clicks : null,
    profit: (s.grossProfit !== 0 || s.adSpend !== 0) ? s.grossProfit - s.adSpend : null,
  }));
  const knownProfit = channelEvidence.map((x) => x.profit).filter((x): x is number => x != null);
  const knownCvr = channelEvidence.map((x) => x.cvr).filter((x): x is number => x != null);
  const knownCtr = channelEvidence.map((x) => x.ctr).filter((x): x is number => x != null);
  const normalizeEvidence = (value: number | null, values: number[]) => {
    if (value == null || !values.length) return null;
    const min = Math.min(...values);
    const max = Math.max(...values);
    if (max === min) return 0.5;
    return Math.max(0, Math.min(1, (value - min) / (max - min)));
  };

  const scored = posts.map((p, i) => {
    const stats = channelStats.get(p.channel.trim().toLowerCase());
    const expectedCtr = stats && stats.impressions > 0 ? stats.clicks / stats.impressions : null;
    const expectedCvr = stats && stats.clicks > 0 ? stats.conversions / stats.clicks : null;
    const expectedProfit = stats && (stats.grossProfit !== 0 || stats.adSpend !== 0)
      ? stats.grossProfit - stats.adSpend
      : null;
    const salesExpectation =
      normalizeEvidence(expectedProfit, knownProfit) ??
      normalizeEvidence(expectedCvr, knownCvr) ??
      normalizeEvidence(expectedCtr, knownCtr);
    const metricClarity = p.testMetric ? 0.7 : 0.2;
    const learningValue = Math.min(1, 0.45 + (2 - i) * 0.2);
    const productionEase = p.format ? 0.7 : 0.3;
    const weightedComponents = [
      salesExpectation != null ? { value: salesExpectation, weight: 0.35 } : null,
      { value: learningValue, weight: 0.35 },
      { value: productionEase, weight: 0.15 },
      { value: metricClarity, weight: 0.15 },
    ].filter((x): x is { value: number; weight: number } => x != null);
    const totalWeight = weightedComponents.reduce((sum, x) => sum + x.weight, 0);
    const priorityScore = weightedComponents.reduce((sum, x) => sum + x.value * x.weight, 0) / totalWeight;
    const rankReason = expectedProfit != null
      ? "同媒体の実績粗利（広告費控除後）を最優先の売上根拠として、学習価値・制作容易性・成功指標の明確さを合成"
      : expectedCvr != null
        ? "同媒体の実績CVRを売上期待の根拠として、学習価値・制作容易性・成功指標の明確さを合成"
        : expectedCtr != null
          ? "同媒体の実績CTRを売上期待の代替根拠として、学習価値・制作容易性・成功指標の明確さを合成"
          : "売上実績が未接続のため売上期待は未知。学習価値・制作容易性・成功指標の明確さを中心に優先順位を算出";
    return { p, i, learningValue, priorityScore, expectedCtr, expectedCvr, expectedProfit, rankReason };
  }).sort((a, b) => b.priorityScore - a.priorityScore);

  const selected = scored.slice(0, 3);
  const target = input.analysis.decision?.target || input.analysis.customer?.likelySegments?.[0] || "分析で特定した主要顧客";
  const angle = input.analysis.decision?.valueProposition || input.analysis.decision?.desire || "商品価値を具体的な顧客課題に接続する";

  const nextTests: CampaignTest[] = selected.map(({ p, learningValue, priorityScore, expectedCtr, expectedCvr, expectedProfit, rankReason }, i) => ({
    id: `test-${Date.now()}-${i + 1}`,
    concept: p.concept,
    hook: p.hook,
    channel: p.channel,
    format: p.format,
    hypothesis: p.reason,
    successMetric: p.testMetric,
    expectedCtr,
    expectedCvr,
    expectedProfit,
    learningValueScore: Number(learningValue.toFixed(3)),
    priorityScore: Number(priorityScore.toFixed(3)),
    rankReason,
  }));

  return {
    basedOn,
    observed,
    unknown,
    nextTests,
    productionBrief: nextTests[0] ? {
      objective: "次の集客テストを実施し、仮説の反応を測定する",
      audience: target,
      angle,
      hook: nextTests[0].hook,
      format: nextTests[0].format,
      cta: "商品・サービスの次の行動を明確に促す",
    } : null,
  };
}
