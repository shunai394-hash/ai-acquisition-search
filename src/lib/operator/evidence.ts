import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchMarketSignals, type EcPulseMonitor, type EcPulseResearchRun } from "@/lib/ec-pulse/client";
import { mergeMetricRows, type MergedMetrics, type PostMetricRow } from "./metrics";
import { buildBaseline, type Baseline } from "./teacher";

// AI Decision に渡す根拠（Evidence）。
// すべて「判定時点 asOf 以前に観測された事実」だけで構成し、未来データを混ぜない。

export type EvidenceItem = {
  category: "product" | "market" | "customer" | "performance" | "history" | "creative";
  source: string;
  key: string;
  value: string | number | boolean | null;
  observedAt?: string | null;
};

export type ProductFacts = {
  name: string | null;
  url: string | null;
  price: number | null;
  cost: number | null;
  grossProfitPerUnit: number | null;
  marginRate: number | null;
  features: string[];
  strengths: string[];
  useCases: string[];
  channels: string[];
};

export type CustomerFacts = {
  target: string | null;
  pain: string | null;
  desire: string | null;
  valueProposition: string | null;
  hypothesis: string | null;
  channel: string | null;
  format: string | null;
};

export type MarketFacts = {
  connected: boolean;
  error: string | null;
  runs: Array<{ runId: string; capturedAt: string; topPain: string | null; topPainShare: number | null; signal: string | null; emergingPains: string[] }>;
  price: { monitored: boolean; lastPrice: number | null; lastCheckedAt: string | null };
};

export type LineageEntry = { socialPostId: string; verdict: string | null; angle: string | null; hook: string | null };

export type DecisionContext = {
  asOf: string;
  productId: string | null;
  post: { id: string; network: string; publishedAt: string | null; caption: string | null; externalPostId: string | null; url: string | null };
  creative: { id: string | null; title: string | null; hook: string | null; angle: string | null; variation: string | null; testMetric: string | null };
  product: ProductFacts;
  customer: CustomerFacts;
  market: MarketFacts;
  metrics: MergedMetrics;
  baseline: Baseline;
  lineage: LineageEntry[];
  pivotStreak: number;
};

function num(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function list(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((x) => str(x)).filter((x): x is string => !!x).slice(0, 8);
  const s = str(value);
  return s ? s.split(/[\n,、]/).map((x) => x.trim()).filter(Boolean).slice(0, 8) : [];
}

function obj(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

// products テーブルは環境ごとに列が異なるため、存在する列だけを読む。
export function productFactsFromRow(row: Record<string, unknown> | null | undefined): ProductFacts {
  const r = obj(row);
  const meta = { ...obj(r.metadata), ...obj(r.attributes) };
  const pick = (...keys: string[]) => {
    for (const key of keys) {
      if (r[key] !== undefined && r[key] !== null && r[key] !== "") return r[key];
      if (meta[key] !== undefined && meta[key] !== null && meta[key] !== "") return meta[key];
    }
    return null;
  };
  const price = num(pick("price", "sale_price", "unit_price"));
  const cost = num(pick("cost", "unit_cost", "cost_price", "cogs"));
  const explicitProfit = num(pick("gross_profit", "gross_profit_per_unit", "margin"));
  const grossProfitPerUnit = explicitProfit ?? (price !== null && cost !== null ? price - cost : null);
  const marginRate = num(pick("margin_rate", "gross_margin_rate")) ?? (price && grossProfitPerUnit !== null ? grossProfitPerUnit / price : null);
  return {
    name: str(pick("name", "title")),
    url: str(pick("url", "product_url")),
    price,
    cost,
    grossProfitPerUnit,
    marginRate: marginRate !== null ? Math.round(marginRate * 1000) / 1000 : null,
    features: list(pick("features")),
    strengths: list(pick("strengths", "usp")),
    useCases: list(pick("use_cases", "useCases", "usage")),
    channels: list(pick("channels", "sales_channels")),
  };
}

export function customerFactsFromPlan(plan: Record<string, unknown> | null | undefined, postMeta?: Record<string, unknown>): CustomerFacts {
  const p = obj(plan);
  return {
    target: str(p.target),
    pain: str(p.pain),
    desire: str(p.desire),
    valueProposition: str(p.value_proposition),
    hypothesis: str(p.hypothesis) ?? str(postMeta?.hypothesis),
    channel: str(p.channel),
    format: str(p.format),
  };
}

export function marketFactsFromSignals(
  signals: Awaited<ReturnType<typeof fetchMarketSignals>> | null,
  productUrl: string | null,
  asOf: string,
): MarketFacts {
  const cutoff = new Date(asOf).getTime();
  const errors: string[] = [];
  let runs: EcPulseResearchRun[] = [];
  if (signals?.runs) {
    if (signals.runs.ok) runs = signals.runs.data?.runs ?? [];
    else errors.push(signals.runs.error);
  }
  let monitor: EcPulseMonitor | undefined;
  if (signals?.monitors) {
    if (signals.monitors.ok) {
      monitor = (signals.monitors.data?.monitors ?? []).find((m) => productUrl && m.url === productUrl);
    } else errors.push(signals.monitors.error);
  }
  const usableRuns = runs
    .filter((run) => run.captured_at && new Date(run.captured_at).getTime() <= cutoff)
    .sort((a, b) => new Date(b.captured_at).getTime() - new Date(a.captured_at).getTime())
    .slice(0, 3);
  const priceObservedBeforeCutoff = monitor?.last_checked_at ? new Date(monitor.last_checked_at).getTime() <= cutoff : false;
  return {
    connected: !!signals && (signals.runs?.ok === true || signals.monitors?.ok === true),
    error: errors.length ? [...new Set(errors)].join(" / ") : null,
    runs: usableRuns.map((run) => ({
      runId: run.run_id,
      capturedAt: run.captured_at,
      topPain: run.top_pain?.pain ?? null,
      topPainShare: run.top_pain?.share_percent ?? null,
      signal: run.trend?.signal ?? null,
      emergingPains: (run.trend?.emerging_pains ?? []).map((p) => p.pain).filter(Boolean).slice(0, 5),
    })),
    price: {
      monitored: !!monitor,
      lastPrice: priceObservedBeforeCutoff ? monitor?.last_price ?? null : null,
      lastCheckedAt: priceObservedBeforeCutoff ? monitor?.last_checked_at ?? null : null,
    },
  };
}

// Decision に添付する根拠一覧と、カテゴリ別のカバレッジ。
export function evidenceItems(ctx: DecisionContext): EvidenceItem[] {
  const items: EvidenceItem[] = [];
  const push = (item: EvidenceItem) => { if (item.value !== null && item.value !== "") items.push(item); };
  const p = ctx.product;
  push({ category: "product", source: "products", key: "name", value: p.name });
  push({ category: "product", source: "products", key: "url", value: p.url });
  push({ category: "product", source: "products", key: "price", value: p.price });
  push({ category: "product", source: "products", key: "gross_profit_per_unit", value: p.grossProfitPerUnit });
  push({ category: "product", source: "products", key: "margin_rate", value: p.marginRate });
  if (p.strengths.length) push({ category: "product", source: "products", key: "strengths", value: p.strengths.join(" / ") });
  if (p.features.length) push({ category: "product", source: "products", key: "features", value: p.features.join(" / ") });

  const c = ctx.customer;
  push({ category: "customer", source: "acquisition_plans", key: "target", value: c.target });
  push({ category: "customer", source: "acquisition_plans", key: "pain", value: c.pain });
  push({ category: "customer", source: "acquisition_plans", key: "desire", value: c.desire });
  push({ category: "customer", source: "acquisition_plans", key: "value_proposition", value: c.valueProposition });
  push({ category: "customer", source: "acquisition_plans", key: "hypothesis", value: c.hypothesis });

  for (const run of ctx.market.runs) {
    push({ category: "market", source: "ec-pulse/research", key: "top_pain", value: run.topPain, observedAt: run.capturedAt });
    push({ category: "market", source: "ec-pulse/research", key: "trend_signal", value: run.signal, observedAt: run.capturedAt });
    if (run.emergingPains.length) push({ category: "market", source: "ec-pulse/research", key: "emerging_pains", value: run.emergingPains.join(" / "), observedAt: run.capturedAt });
  }
  if (ctx.market.price.lastPrice !== null) {
    push({ category: "market", source: "ec-pulse/monitor", key: "last_price", value: ctx.market.price.lastPrice, observedAt: ctx.market.price.lastCheckedAt });
  }

  for (const field of ctx.metrics.known) {
    push({ category: "performance", source: `post_metrics(${ctx.metrics.sources.join(",")})`, key: field, value: ctx.metrics.values[field] ?? null, observedAt: ctx.metrics.measuredAt });
  }
  if (ctx.baseline.posts) {
    push({ category: "history", source: "post_metrics/baseline", key: "baseline_posts", value: ctx.baseline.posts });
    push({ category: "history", source: "post_metrics/baseline", key: "baseline_ctr", value: ctx.baseline.ctr });
    push({ category: "history", source: "post_metrics/baseline", key: "baseline_engagement_rate", value: ctx.baseline.engagementRate });
  }
  push({ category: "history", source: "social_posts/lineage", key: "pivot_streak", value: ctx.pivotStreak });

  push({ category: "creative", source: "creatives", key: "hook", value: ctx.creative.hook });
  push({ category: "creative", source: "creatives", key: "angle", value: ctx.creative.angle });
  return items;
}

export function evidenceCoverage(items: EvidenceItem[]) {
  const categories: EvidenceItem["category"][] = ["product", "market", "customer", "performance", "history", "creative"];
  const present = categories.filter((category) => items.some((item) => item.category === category));
  return { score: Math.round((present.length / categories.length) * 100) / 100, present, missing: categories.filter((c) => !present.includes(c)) };
}

// ------------------------------------------------------------------------------
// DB / EC-Pulse から DecisionContext を組み立てる。
// ------------------------------------------------------------------------------

type Db = SupabaseClient;

const METRIC_COLUMNS = "id,social_post_id,impressions,views,likes,comments,shares,saves,clicks,conversions,revenue,gross_profit,ad_spend,raw,measured_at";

export async function loadDecisionContext(
  db: Db,
  input: { userId: string; socialPostId: string; asOf?: string; includeMarket?: boolean; fetchImpl?: typeof fetch },
): Promise<DecisionContext | null> {
  const asOf = input.asOf ?? new Date().toISOString();
  const { data: post, error: postError } = await db.from("social_posts")
    .select("id,user_id,creative_id,network,caption,metadata,published_at,external_post_id")
    .eq("id", input.socialPostId).eq("user_id", input.userId).maybeSingle();
  if (postError) throw postError;
  if (!post) return null;
  const postMeta = obj(post.metadata);

  const { data: creative, error: creativeError } = post.creative_id
    ? await db.from("creatives").select("id,product_id,plan_id,title,variation,hook,scenario")
      .eq("id", post.creative_id).eq("user_id", input.userId).maybeSingle()
    : { data: null, error: null };
  if (creativeError) throw creativeError;
  const scenario = obj(creative?.scenario);

  const [productRes, planRes, metricsRes] = await Promise.all([
    creative?.product_id
      ? db.from("products").select("*").eq("id", creative.product_id).eq("user_id", input.userId).maybeSingle()
      : Promise.resolve({ data: null, error: null }),
    creative?.plan_id
      ? db.from("acquisition_plans").select("target,pain,desire,value_proposition,channel,format,angle,hypothesis")
        .eq("id", creative.plan_id).eq("user_id", input.userId).maybeSingle()
      : Promise.resolve({ data: null, error: null }),
    db.from("post_metrics").select(METRIC_COLUMNS)
      .eq("social_post_id", post.id).lte("measured_at", asOf)
      .order("measured_at", { ascending: false }).limit(20),
  ]);
  if (productRes.error) throw productRes.error;
  if (planRes.error) throw planRes.error;
  if (metricsRes.error) throw metricsRes.error;

  const product = productFactsFromRow(productRes.data as Record<string, unknown> | null);
  const customer = customerFactsFromPlan(planRes.data as Record<string, unknown> | null, postMeta);
  const metrics = mergeMetricRows((metricsRes.data ?? []) as PostMetricRow[]);
  const baseline = await loadBaseline(db, { userId: input.userId, network: post.network, excludePostId: post.id, asOf });
  const lineage = await loadLineage(db, input.userId, postMeta);

  let pivotStreak = 0;
  for (const entry of lineage) {
    if (entry.verdict === "pivot") pivotStreak++;
    else break;
  }

  const signals = input.includeMarket === false ? null : await fetchMarketSignals(product.url, input.fetchImpl);
  const market = marketFactsFromSignals(signals, product.url, asOf);

  return {
    asOf,
    productId: creative?.product_id ?? null,
    post: {
      id: post.id,
      network: post.network,
      publishedAt: post.published_at ?? null,
      caption: post.caption ?? null,
      externalPostId: post.external_post_id ?? null,
      url: str(postMeta.post_url) ?? str(postMeta.permalink) ?? null,
    },
    creative: {
      id: creative?.id ?? null,
      title: str(creative?.title),
      hook: str(creative?.hook),
      angle: str(scenario.angle) ?? str(postMeta.iteration_angle) ?? customer.valueProposition,
      variation: str(creative?.variation),
      testMetric: str(scenario.test_metric) ?? str(scenario.testMetric) ?? str(postMeta.test_metric),
    },
    product,
    customer,
    market,
    metrics,
    baseline,
    lineage,
    pivotStreak,
  };
}

// 同じユーザー・同じ媒体の過去投稿の中央値。asOf より後の計測は含めない。
async function loadBaseline(db: Db, input: { userId: string; network: string; excludePostId: string; asOf: string }): Promise<Baseline> {
  const { data: posts, error } = await db.from("social_posts")
    .select("id")
    .eq("user_id", input.userId).eq("network", input.network)
    .neq("id", input.excludePostId)
    .not("published_at", "is", null).lt("published_at", input.asOf)
    .order("published_at", { ascending: false }).limit(30);
  if (error || !posts?.length) return buildBaseline([]);
  const { data: rows, error: rowsError } = await db.from("post_metrics").select(METRIC_COLUMNS)
    .in("social_post_id", posts.map((p) => p.id)).lte("measured_at", input.asOf)
    .order("measured_at", { ascending: false }).limit(300);
  if (rowsError || !rows) return buildBaseline([]);
  const byPost = new Map<string, PostMetricRow[]>();
  for (const row of rows as Array<PostMetricRow & { social_post_id: string }>) {
    const listForPost = byPost.get(row.social_post_id) ?? [];
    listForPost.push(row);
    byPost.set(row.social_post_id, listForPost);
  }
  return buildBaseline([...byPost.values()].map(mergeMetricRows));
}

// next-creative が残した source_social_post_id を遡り、仮説系列の判定履歴を得る。
async function loadLineage(db: Db, userId: string, postMeta: Record<string, unknown>): Promise<LineageEntry[]> {
  const lineage: LineageEntry[] = [];
  let meta = postMeta;
  const seen = new Set<string>();
  for (let depth = 0; depth < 6; depth++) {
    const sourceId = str(meta.source_social_post_id);
    if (!sourceId || seen.has(sourceId)) break;
    seen.add(sourceId);
    lineage.push({
      socialPostId: sourceId,
      verdict: str(meta.operator_verdict),
      angle: str(meta.iteration_angle),
      hook: null,
    });
    const { data, error } = await db.from("social_posts").select("id,metadata,caption").eq("id", sourceId).eq("user_id", userId).maybeSingle();
    if (error || !data) break;
    lineage[lineage.length - 1].hook = str(data.caption);
    meta = obj(data.metadata);
  }
  return lineage;
}
