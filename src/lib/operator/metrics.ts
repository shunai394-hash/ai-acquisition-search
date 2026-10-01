// post_metrics の行を Teacher / Decision が扱える形にまとめる。
//
// SNS API の自動取得行は媒体が返さない指標（クリック・購入・売上など）を 0 で
// 保存している。最新行だけを読むと、手入力した売上やクリックが後から来た
// 自動取得行の 0 で上書きされたように見えてしまうため、指標ごとに
// 「その指標を実際に計測している最新の行」から値を採用する。

export type MetricField =
  | "impressions" | "views" | "likes" | "comments" | "shares" | "saves"
  | "clicks" | "conversions" | "revenue" | "grossProfit" | "adSpend";

export const METRIC_FIELDS: MetricField[] = [
  "impressions", "views", "likes", "comments", "shares", "saves",
  "clicks", "conversions", "revenue", "grossProfit", "adSpend",
];

export type PostMetricRow = {
  id?: string | null;
  measured_at?: string | null;
  impressions?: number | string | null;
  views?: number | string | null;
  likes?: number | string | null;
  comments?: number | string | null;
  shares?: number | string | null;
  saves?: number | string | null;
  clicks?: number | string | null;
  conversions?: number | string | null;
  revenue?: number | string | null;
  gross_profit?: number | string | null;
  ad_spend?: number | string | null;
  raw?: unknown;
};

export type MergedMetrics = {
  values: Partial<Record<MetricField, number>>;
  known: MetricField[];
  measuredAt: string | null;
  sourceRowIds: string[];
  sources: string[];
  snapshots: number;
};

// 各媒体の自動取得で実際に計測している指標。ここに無い指標は「未計測」として扱う。
const AUTO_FIELDS: Record<string, MetricField[]> = {
  linkedin: ["impressions", "likes", "comments", "shares", "saves", "clicks"],
  tiktok: ["views", "likes", "comments", "shares"],
  instagram: ["impressions", "views", "likes", "comments", "shares", "saves"],
  facebook: ["views", "likes", "comments", "shares"],
  youtube: ["views", "likes", "comments"],
  x: ["impressions", "likes", "comments", "shares", "saves"],
};

const COLUMN: Record<MetricField, keyof PostMetricRow> = {
  impressions: "impressions",
  views: "views",
  likes: "likes",
  comments: "comments",
  shares: "shares",
  saves: "saves",
  clicks: "clicks",
  conversions: "conversions",
  revenue: "revenue",
  grossProfit: "gross_profit",
  adSpend: "ad_spend",
};

function toNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

function rawObject(row: PostMetricRow): Record<string, unknown> {
  return row.raw && typeof row.raw === "object" ? row.raw as Record<string, unknown> : {};
}

export function metricRowSource(row: PostMetricRow): string {
  const source = rawObject(row).source;
  return typeof source === "string" && source ? source : "manual";
}

// 行が実際に計測している指標の一覧。
export function measuredFields(row: PostMetricRow): MetricField[] {
  const source = metricRowSource(row);
  if (source === "manual") {
    // 手入力は送信された項目だけを計測済みとみなす。
    // 旧データ（raw に入力値が無い）は全項目を計測済みとして扱う。
    const raw = rawObject(row);
    const rawKeys: Record<MetricField, string> = {
      impressions: "impressions", views: "views", likes: "likes", comments: "comments",
      shares: "shares", saves: "saves", clicks: "clicks", conversions: "conversions",
      revenue: "revenue", grossProfit: "grossProfit", adSpend: "adSpend",
    };
    const submitted = METRIC_FIELDS.filter((field) => raw[rawKeys[field]] !== undefined && raw[rawKeys[field]] !== null && raw[rawKeys[field]] !== "");
    return submitted.length ? submitted : [...METRIC_FIELDS];
  }
  const auto = AUTO_FIELDS[source] ?? [];
  if (source !== "linkedin") return auto;
  // LinkedIn のクリックは応答に LINK_CLICKS がある時だけ計測済み。
  const data = rawObject(row).data as Record<string, unknown> | undefined;
  const elements = Array.isArray(data?.elements) ? data?.elements as Array<Record<string, unknown>> : null;
  const metric = (elements ? (elements[0]?.total ?? elements[0]) : (data?.total ?? data)) as Record<string, unknown> | undefined;
  const hasClicks = !!metric && ("LINK_CLICKS" in metric || "linkClicks" in metric);
  return hasClicks ? auto : auto.filter((field) => field !== "clicks");
}

// rows は measured_at の新しい順でも古い順でもよい。
export function mergeMetricRows(rows: PostMetricRow[]): MergedMetrics {
  const sorted = [...rows].sort((a, b) => timeOf(b.measured_at) - timeOf(a.measured_at));
  const values: Partial<Record<MetricField, number>> = {};
  const known = new Set<MetricField>();
  const sourceRowIds = new Set<string>();
  const sources = new Set<string>();

  for (const field of METRIC_FIELDS) {
    for (const row of sorted) {
      if (!measuredFields(row).includes(field)) continue;
      const value = toNumber(row[COLUMN[field]]);
      if (value === null || value < 0) continue;
      values[field] = value;
      known.add(field);
      if (row.id) sourceRowIds.add(String(row.id));
      sources.add(metricRowSource(row));
      break;
    }
  }

  return {
    values,
    known: METRIC_FIELDS.filter((field) => known.has(field)),
    measuredAt: sorted[0]?.measured_at ?? null,
    sourceRowIds: [...sourceRowIds].sort(),
    sources: [...sources].sort(),
    snapshots: rows.length,
  };
}

function timeOf(value: string | null | undefined) {
  const t = value ? new Date(value).getTime() : 0;
  return Number.isFinite(t) ? t : 0;
}

export type DerivedRates = {
  reach: number;
  ctr: number | null;
  cvr: number | null;
  roas: number | null;
  cpa: number | null;
  contribution: number | null;
  engagementRate: number | null;
};

export function deriveRates(merged: MergedMetrics): DerivedRates {
  const v = merged.values;
  const has = (field: MetricField) => merged.known.includes(field);
  const reach = Math.max(v.impressions ?? 0, v.views ?? 0);
  const clicks = v.clicks ?? 0;
  const conversions = v.conversions ?? 0;
  const adSpend = v.adSpend ?? 0;
  const engagement = (v.likes ?? 0) + (v.comments ?? 0) + (v.shares ?? 0) + (v.saves ?? 0);
  const engagementKnown = has("likes") || has("comments") || has("shares") || has("saves");
  return {
    reach,
    ctr: has("clicks") && has("impressions") && (v.impressions ?? 0) > 0 ? clicks / (v.impressions as number) : null,
    cvr: has("conversions") && has("clicks") && clicks > 0 ? conversions / clicks : null,
    roas: has("revenue") && has("adSpend") && adSpend > 0 ? (v.revenue ?? 0) / adSpend : null,
    cpa: has("conversions") && has("adSpend") && conversions > 0 && adSpend > 0 ? adSpend / conversions : null,
    contribution: has("grossProfit") ? (v.grossProfit ?? 0) - (has("adSpend") ? adSpend : 0) : null,
    engagementRate: engagementKnown && reach > 0 ? engagement / reach : null,
  };
}
