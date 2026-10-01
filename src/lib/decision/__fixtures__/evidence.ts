import type { DecisionEvidence, HistoricalResult, MetricSnapshot } from "../types";

export const AS_OF = "2026-10-01T00:00:00.000Z";

export function metric(overrides: Partial<MetricSnapshot> = {}): MetricSnapshot {
  return {
    id: "m-1",
    measuredAt: "2026-09-30T12:00:00.000Z",
    impressions: null,
    views: null,
    likes: null,
    comments: null,
    shares: null,
    saves: null,
    clicks: null,
    conversions: null,
    revenue: null,
    grossProfit: null,
    adSpend: null,
    source: "manual",
    ...overrides,
  };
}

export function past(id: string, overrides: Partial<MetricSnapshot>, network = "linkedin"): HistoricalResult {
  return {
    socialPostId: id,
    network,
    publishedAt: "2026-09-01T00:00:00.000Z",
    metric: metric({ id: `m-${id}`, measuredAt: "2026-09-05T00:00:00.000Z", ...overrides }),
  };
}

export function evidence(overrides: Partial<DecisionEvidence> = {}, hypothesis: Partial<DecisionEvidence["hypothesis"]> = {}): DecisionEvidence {
  return {
    asOf: AS_OF,
    product: { name: "保冷ボトル", url: "https://example.com/p/1", price: 3000, cost: 1200, features: [], strengths: ["24時間保冷"], useCases: [], salesChannels: [] },
    customer: { target: "通勤する会社員", pain: "飲み物がすぐぬるくなる", desire: "一日中冷たい飲み物", valueProposition: "朝入れた氷が夕方まで残る", buyingTriggers: [], stage: null },
    market: {
      status: "ok",
      runId: "run-1",
      capturedAt: "2026-09-20T00:00:00.000Z",
      commentsCount: 420,
      topPains: [{ pain: "飲み物がすぐぬるくなる", count: 80, sharePercent: 19 }, { pain: "結露でカバンが濡れる", count: 40, sharePercent: 9.5 }],
      emergingPains: [{ pain: "結露でカバンが濡れる", status: "rising", shareDeltaPercent: 3.2 }],
      trendSignal: "emerging_pain_detected",
    },
    hypothesis: {
      socialPostId: "post-1",
      network: "linkedin",
      caption: "朝の氷が夕方まで",
      hook: "朝入れた氷、夕方まで残ります",
      angle: "飲み物がすぐぬるくなる",
      hypothesis: "通勤者は保冷時間の長さに反応する",
      primaryMetric: "CTR",
      publishedAt: "2026-09-29T00:00:00.000Z",
      lineageVerdicts: [],
      ...hypothesis,
    },
    current: metric(),
    history: [],
    ...overrides,
  };
}
