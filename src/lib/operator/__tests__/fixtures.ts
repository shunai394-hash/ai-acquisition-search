import type { DecisionContext } from "../evidence";
import { mergeMetricRows, type PostMetricRow } from "../metrics";
import { buildBaseline } from "../teacher";

export function manualRow(values: Partial<PostMetricRow>, at = "2026-09-02T00:00:00Z"): PostMetricRow {
  const rawKey = (k: string) => (k === "gross_profit" ? "grossProfit" : k === "ad_spend" ? "adSpend" : k);
  return { id: `m-${at}`, measured_at: at, ...values, raw: Object.fromEntries(Object.entries(values).map(([k, v]) => [rawKey(k), v])) };
}

export function makeContext(overrides: Partial<DecisionContext> & { rows?: PostMetricRow[] } = {}): DecisionContext {
  const { rows, ...rest } = overrides;
  return {
    asOf: "2026-09-05T00:00:00Z",
    productId: "prod-1",
    post: { id: "post-1", network: "x", publishedAt: "2026-09-01T00:00:00Z", caption: "前の投稿", externalPostId: "ext-1", url: null },
    creative: { id: "cr-1", title: "保温ボトル", hook: "朝のコーヒーが昼まで熱い", angle: "長時間保温", variation: "A", testMetric: "CTR" },
    product: { name: "保温ボトル", url: "https://shop.example.com/bottle", price: 3000, cost: 1200, grossProfitPerUnit: 1800, marginRate: 0.6, features: ["12時間保温"], strengths: ["軽い"], useCases: ["通勤"], channels: ["自社EC"] },
    customer: { target: "通勤する会社員", pain: "飲み物がすぐ冷める", desire: "温かいまま飲みたい", valueProposition: "12時間保温", hypothesis: "通勤する会社員は保温時間を示すと購入に近づく", channel: "x", format: "short video" },
    market: { connected: true, error: null, runs: [{ runId: "run-1", capturedAt: "2026-09-01T00:00:00Z", topPain: "重い", topPainShare: 32, signal: "emerging_pain_detected", emergingPains: ["洗いにくい"] }], price: { monitored: true, lastPrice: 2980, lastCheckedAt: "2026-09-01T00:00:00Z" } },
    metrics: mergeMetricRows(rows ?? [manualRow({ impressions: 5000, clicks: 20 })]),
    baseline: buildBaseline([]),
    lineage: [],
    pivotStreak: 0,
    ...rest,
  };
}
