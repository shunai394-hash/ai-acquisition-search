import type { getAdminSupabase } from "@/lib/billing";
import { loadMarketEvidence } from "@/lib/ec-pulse/client";
import type { CustomerEvidence, DecisionEvidence, HistoricalResult, MetricSnapshot, ProductEvidence, Verdict } from "./types";

type Db = ReturnType<typeof getAdminSupabase>;
type Row = Record<string, unknown>;

const METRIC_COLUMNS = "id,social_post_id,impressions,views,likes,comments,shares,saves,clicks,conversions,revenue,gross_profit,ad_spend,ctr,cvr,raw,measured_at";

// Which normalized fields each SNS integration actually measures. Anything not
// listed is stored as 0 by /api/social/metrics but means "unknown", not zero.
const NETWORK_SIGNALS: Record<string, Array<keyof MetricSnapshot>> = {
  linkedin: ["impressions", "likes", "comments", "shares", "saves"],
  tiktok: ["views", "likes", "comments", "shares"],
  instagram: ["impressions", "views", "likes", "comments", "shares", "saves"],
  facebook: ["views", "likes", "comments", "shares"],
  youtube: ["views", "likes", "comments"],
  x: ["impressions", "likes", "comments", "shares", "saves"],
};

// /api/operator/metrics body keys -> snapshot fields.
const MANUAL_KEYS: Record<string, keyof MetricSnapshot> = {
  impressions: "impressions", views: "views", likes: "likes", comments: "comments", shares: "shares",
  saves: "saves", clicks: "clicks", conversions: "conversions", revenue: "revenue", grossProfit: "grossProfit", adSpend: "adSpend",
};

const COLUMN_FOR: Record<string, string> = {
  impressions: "impressions", views: "views", likes: "likes", comments: "comments", shares: "shares", saves: "saves",
  clicks: "clicks", conversions: "conversions", revenue: "revenue", grossProfit: "gross_profit", adSpend: "ad_spend",
};

const toNum = (v: unknown) => (v == null || v === "" ? null : Number.isFinite(Number(v)) ? Number(v) : null);
const asObj = (v: unknown): Row => (v && typeof v === "object" && !Array.isArray(v) ? (v as Row) : {});
const asStr = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
const asList = (v: unknown) => (Array.isArray(v) ? v.map((x) => String(x)).filter(Boolean) : typeof v === "string" && v.trim() ? [v.trim()] : []);

/** Normalizes a post_metrics row, turning unmeasured zeros into null. */
export function snapshotFromRow(row: Row, network: string): MetricSnapshot {
  const raw = asObj(row.raw);
  const source = asStr(raw.source) || "manual";
  const known = new Set<keyof MetricSnapshot>();
  if (source === "manual") {
    for (const [key, field] of Object.entries(MANUAL_KEYS)) if (key in raw) known.add(field);
    // Rows written before raw kept the body: fall back to non-zero columns.
    if (!known.size) for (const [field, col] of Object.entries(COLUMN_FOR)) if (toNum(row[col])) known.add(field as keyof MetricSnapshot);
  } else {
    for (const field of NETWORK_SIGNALS[network] || []) known.add(field);
    if (network === "linkedin" && row.ctr != null) known.add("clicks");
  }
  const pick = (field: keyof MetricSnapshot) => (known.has(field) ? toNum(row[COLUMN_FOR[field as string]]) ?? 0 : null);
  return {
    id: asStr(row.id),
    measuredAt: String(row.measured_at),
    impressions: pick("impressions"),
    views: pick("views"),
    likes: pick("likes"),
    comments: pick("comments"),
    shares: pick("shares"),
    saves: pick("saves"),
    clicks: pick("clicks"),
    conversions: pick("conversions"),
    revenue: pick("revenue"),
    grossProfit: pick("grossProfit"),
    adSpend: pick("adSpend"),
    source,
  };
}

function productFromRow(row: Row | null): ProductEvidence {
  const r = row || {};
  const first = (...keys: string[]) => keys.map((k) => toNum(r[k])).find((v) => v != null) ?? null;
  return {
    name: asStr(r.name),
    url: asStr(r.url),
    price: first("price", "price_jpy", "unit_price", "sale_price"),
    cost: first("cost", "unit_cost", "cost_price", "cogs"),
    features: asList(r.features),
    strengths: asList(r.strengths),
    useCases: asList(r.use_cases ?? r.usecases),
    salesChannels: asList(r.sales_channels ?? r.channels),
  };
}

function customerFromPlan(plan: Row | null, analysisDecision: Row): CustomerEvidence {
  const p = plan || {};
  return {
    target: asStr(p.target) || asStr(analysisDecision.target),
    pain: asStr(p.pain) || asStr(analysisDecision.problem),
    desire: asStr(p.desire) || asStr(analysisDecision.desire),
    valueProposition: asStr(p.value_proposition) || asStr(analysisDecision.valueProposition),
    buyingTriggers: asList(analysisDecision.buyingTriggers),
    stage: asStr(analysisDecision.stage),
  };
}

async function loadLineage(db: Db, userId: string, metadata: Row, asOf: string): Promise<Verdict[]> {
  const verdicts: Verdict[] = [];
  let parentId = asStr(metadata.source_social_post_id) || asStr(metadata.sourceSocialPostId);
  const seen = new Set<string>();

  // Do not rely on a JSON-path filter for the critical learning lineage.
  // Different Supabase mocks/clients can implement JSON operators differently;
  // the production decision must inspect the actual stored input and output.
  const { data: runs } = await db.from("operator_runs")
    .select("input,output,completed_at")
    .eq("user_id", userId)
    .eq("run_type", "ai_performance_verdict")
    .lte("completed_at", asOf)
    .order("completed_at", { ascending: false })
    .limit(100);

  const candidates = (runs || []) as Row[];
  for (let depth = 0; parentId && depth < 6 && !seen.has(parentId); depth++) {
    seen.add(parentId);
    const run = candidates.find((candidate) => {
      const input = asObj(candidate.input);
      return asStr(input.social_post_id) === parentId;
    });
    const verdict = asStr(asObj(run?.output).verdict);
    if (verdict === "continue" || verdict === "pivot" || verdict === "stop" || verdict === "wait") {
      verdicts.push(verdict);
    }

    const { data: parent } = await db.from("social_posts")
      .select("metadata")
      .eq("id", parentId)
      .eq("user_id", userId)
      .maybeSingle();
    const pm = asObj(parent?.metadata);
    parentId = asStr(pm.source_social_post_id) || asStr(pm.sourceSocialPostId);
  }
  return verdicts;
}

async function loadHistory(db: Db, userId: string, network: string, excludePostId: string, asOf: string): Promise<HistoricalResult[]> {
  const { data: posts } = await db.from("social_posts")
    .select("id,network,published_at")
    .eq("user_id", userId)
    .eq("network", network)
    .neq("id", excludePostId)
    .not("published_at", "is", null)
    .lte("published_at", asOf)
    .order("published_at", { ascending: false })
    .limit(30);
  if (!posts?.length) return [];
  const { data: metrics } = await db.from("post_metrics")
    .select(METRIC_COLUMNS)
    .in("social_post_id", posts.map((p) => p.id))
    .lte("measured_at", asOf)
    .order("measured_at", { ascending: false })
    .limit(300);
  const latest = new Map<string, Row>();
  for (const m of (metrics || []) as Row[]) {
    const id = String(m.social_post_id);
    if (!latest.has(id)) latest.set(id, m);
  }
  return posts
    .filter((p) => latest.has(p.id))
    .map((p) => ({
      socialPostId: p.id,
      network: p.network,
      publishedAt: p.published_at,
      metric: snapshotFromRow(latest.get(p.id) as Row, p.network),
    }));
}

/**
 * Collects every input the decision uses for one post, as of a point in time.
 * Throws only for missing core records (post); external sources degrade.
 *
 * With an explicit asOf (backtests) nothing measured later is read. Live calls
 * omit it: asOf becomes max(now, latest measurement) because measured_at comes
 * from the database clock, which can be ahead of the app server's clock.
 */
export async function collectDecisionEvidence(db: Db, userId: string, socialPostId: string, explicitAsOf?: string) {
  const { data: post, error: postError } = await db.from("social_posts")
    .select("id,user_id,creative_id,network,caption,metadata,published_at")
    .eq("id", socialPostId).eq("user_id", userId).maybeSingle();
  if (postError) throw postError;
  if (!post) return null;
  const metadata = asObj(post.metadata);

  let metricQuery = db.from("post_metrics").select(METRIC_COLUMNS).eq("social_post_id", post.id);
  if (explicitAsOf) metricQuery = metricQuery.lte("measured_at", explicitAsOf);
  const metricResult = await metricQuery.order("measured_at", { ascending: false }).limit(1).maybeSingle();
  if (metricResult.error) throw metricResult.error;
  const latestMetric = (metricResult.data || null) as Row | null;
  const now = new Date().toISOString();
  const measuredAt = latestMetric ? String(latestMetric.measured_at) : null;
  const asOf = explicitAsOf ?? (measuredAt && Date.parse(measuredAt) > Date.parse(now) ? new Date(Date.parse(measuredAt)).toISOString() : now);

  const { data: creative } = post.creative_id
    ? await db.from("creatives").select("id,product_id,plan_id,title,hook,scenario").eq("id", post.creative_id).eq("user_id", userId).maybeSingle()
    : { data: null };
  const scenario = asObj(creative?.scenario);

  const [planResult, productResult, analysisResult] = await Promise.all([
    creative?.plan_id
      ? db.from("acquisition_plans").select("target,pain,desire,value_proposition,channel,format,angle,hypothesis").eq("id", creative.plan_id).eq("user_id", userId).maybeSingle()
      : Promise.resolve({ data: null }),
    creative?.product_id
      ? db.from("products").select("*").eq("id", creative.product_id).eq("user_id", userId).maybeSingle()
      : Promise.resolve({ data: null }),
    creative?.product_id
      ? db.from("operator_runs").select("output").eq("user_id", userId).eq("product_id", creative.product_id).eq("run_type", "acquisition_test_plan").lte("completed_at", asOf).order("completed_at", { ascending: false }).limit(1).maybeSingle()
      : Promise.resolve({ data: null }),
  ]);

  const plan = (planResult.data || null) as Row | null;
  const product = productFromRow((productResult.data || null) as Row | null);
  const analysisDecision = asObj(asObj(analysisResult.data?.output).decision);

  const [market, history, lineageVerdicts] = await Promise.all([
    loadMarketEvidence(product.url, asOf),
    loadHistory(db, userId, post.network, post.id, asOf),
    loadLineage(db, userId, metadata, asOf),
  ]);

  const evidence: DecisionEvidence = {
    asOf,
    product,
    customer: customerFromPlan(plan, analysisDecision),
    market,
    hypothesis: {
      socialPostId: post.id,
      network: post.network,
      caption: asStr(post.caption),
      hook: asStr(creative?.hook),
      angle: asStr(scenario.angle) || asStr(metadata.iteration_angle) || asStr(plan?.angle),
      hypothesis: asStr(metadata.hypothesis) || asStr(plan?.hypothesis),
      primaryMetric: asStr(metadata.test_metric) || asStr(scenario.testMetric) || asStr(scenario.test_metric),
      publishedAt: asStr(post.published_at),
      lineageVerdicts,
    },
    current: latestMetric ? snapshotFromRow(latestMetric, post.network) : null,
    history,
  };
  return { evidence, post, creative, metricId: latestMetric?.id as string | undefined };
}
