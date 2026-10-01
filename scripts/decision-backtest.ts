// Decision backtest / evaluation.
//
//   npm run backtest:decision                 # labelled scenario set (offline)
//   npm run backtest:decision -- --supabase   # replay real history from Supabase (read-only)
//
// Every decision is computed only from data measured at or before its asOf
// (no future leakage). Labels come from what happened afterwards.
import { createClient } from "@supabase/supabase-js";
import { buildDecision } from "../src/lib/decision/engine";
import { collectDecisionEvidence } from "../src/lib/decision/evidence";
import type { DecisionEvidence, MetricSnapshot, StructuredDecision } from "../src/lib/decision/types";

type Outcome = "winning" | "losing" | "recoverable" | "unknown";
type Case = { name: string; evidence: DecisionEvidence; outcome: Outcome; nextImproved?: boolean | null };

const AS_OF = "2026-09-15T00:00:00.000Z";

function m(o: Partial<MetricSnapshot>): MetricSnapshot {
  return { id: "m", measuredAt: "2026-09-14T00:00:00.000Z", impressions: null, views: null, likes: null, comments: null, shares: null, saves: null, clicks: null, conversions: null, revenue: null, grossProfit: null, adSpend: null, source: "manual", ...o };
}

function ev(name: string, current: MetricSnapshot | null, opts: { network?: string; lineage?: DecisionEvidence["hypothesis"]["lineageVerdicts"]; publishedAt?: string; history?: DecisionEvidence["history"]; market?: boolean } = {}): DecisionEvidence {
  return {
    asOf: AS_OF,
    product: { name, url: `https://shop.test/${name}`, price: 4000, cost: 1600, features: [], strengths: [], useCases: [], salesChannels: [] },
    customer: { target: "30代共働き世帯", pain: "時間がない", desire: "家事を減らしたい", valueProposition: "5分で終わる", buyingTriggers: [], stage: null },
    market: opts.market === false
      ? { status: "unavailable", topPains: [], emergingPains: [] }
      : { status: "ok", runId: "r", capturedAt: "2026-09-01T00:00:00.000Z", commentsCount: 300, topPains: [{ pain: "時間がない", count: 60, sharePercent: 20 }, { pain: "片付けが面倒", count: 30, sharePercent: 10 }], emergingPains: [{ pain: "片付けが面倒", status: "rising", shareDeltaPercent: 3 }], trendSignal: "emerging_pain_detected" },
    hypothesis: { socialPostId: `post-${name}`, network: opts.network ?? "linkedin", caption: null, hook: "5分で終わる", angle: "時間がない", hypothesis: "共働き世帯は時短に反応する", primaryMetric: "CTR", publishedAt: opts.publishedAt ?? "2026-09-12T00:00:00.000Z", lineageVerdicts: opts.lineage ?? [] },
    current,
    history: opts.history ?? [],
  };
}

const futureHistory = ["a", "b", "c"].map((id) => ({ socialPostId: id, network: "linkedin", publishedAt: "2026-09-01T00:00:00.000Z", metric: m({ measuredAt: "2026-09-20T00:00:00.000Z", impressions: 2000, clicks: 200 }) }));

export const SCENARIOS: Case[] = [
  { name: "strong-ctr", evidence: ev("strong-ctr", m({ impressions: 4000, clicks: 120 })), outcome: "winning", nextImproved: true },
  { name: "profitable-paid", evidence: ev("profitable-paid", m({ impressions: 3000, clicks: 90, conversions: 6, revenue: 24000, grossProfit: 14400, adSpend: 6000 })), outcome: "winning", nextImproved: true },
  { name: "weak-ctr-first", evidence: ev("weak-ctr-first", m({ impressions: 6000, clicks: 12 })), outcome: "recoverable", nextImproved: true },
  { name: "weak-ctr-third", evidence: ev("weak-ctr-third", m({ impressions: 6000, clicks: 12 }), { lineage: ["pivot", "pivot"] }), outcome: "losing", nextImproved: false },
  { name: "clicks-no-cv", evidence: ev("clicks-no-cv", m({ impressions: 4000, clicks: 120, conversions: 0 })), outcome: "recoverable", nextImproved: true },
  { name: "unprofitable", evidence: ev("unprofitable", m({ impressions: 3000, clicks: 90, conversions: 4, revenue: 16000, grossProfit: 6400, adSpend: 12000 })), outcome: "recoverable", nextImproved: null },
  { name: "tiny-sample", evidence: ev("tiny-sample", m({ impressions: 90, clicks: 3 })), outcome: "unknown" },
  { name: "tiny-sample-old", evidence: ev("tiny-sample-old", m({ impressions: 90, clicks: 1 }), { publishedAt: "2026-09-01T00:00:00.000Z" }), outcome: "recoverable", nextImproved: true },
  { name: "tiktok-strong", evidence: ev("tiktok-strong", m({ source: "tiktok", views: 8000, likes: 600, comments: 80, shares: 90 }), { network: "tiktok" }), outcome: "winning", nextImproved: true },
  { name: "tiktok-weak", evidence: ev("tiktok-weak", m({ source: "tiktok", views: 8000, likes: 20, comments: 2, shares: 1 }), { network: "tiktok", lineage: ["pivot"] }), outcome: "recoverable", nextImproved: true },
  { name: "tiktok-dead", evidence: ev("tiktok-dead", m({ source: "tiktok", views: 8000, likes: 20, comments: 2, shares: 1 }), { network: "tiktok", lineage: ["pivot", "pivot", "pivot", "pivot"] }), outcome: "losing", nextImproved: false },
  { name: "no-metrics", evidence: ev("no-metrics", null), outcome: "unknown" },
  { name: "ec-pulse-down", evidence: ev("ec-pulse-down", m({ impressions: 6000, clicks: 12 }), { market: false }), outcome: "recoverable", nextImproved: true },
  // Leakage guard: baseline that only exists in the future must be ignored.
  { name: "future-baseline", evidence: ev("future-baseline", m({ impressions: 4000, clicks: 120 }), { history: futureHistory }), outcome: "winning", nextImproved: true },
];

type Scored = { name: string; decision: StructuredDecision; outcome: Outcome; nextImproved?: boolean | null; consistent: boolean; evidence: DecisionEvidence };

function shuffle<T>(xs: T[]) {
  return [...xs].reverse();
}

function score(cases: Array<{ name: string; evidence: DecisionEvidence; outcome: Outcome; nextImproved?: boolean | null }>): Scored[] {
  return cases.map((c) => {
    const decision = buildDecision(c.evidence, new Date(c.evidence.asOf));
    const variants = [
      buildDecision(c.evidence, new Date(Date.parse(c.evidence.asOf) + 3600_000)),
      buildDecision({ ...c.evidence, history: shuffle(c.evidence.history) }, new Date(c.evidence.asOf)),
      buildDecision(structuredClone(c.evidence), new Date(c.evidence.asOf)),
    ];
    const consistent = variants.every((v) => v.verdict === decision.verdict && v.input_hash === decision.input_hash && v.next_action.angle === decision.next_action.angle);
    return { ...c, decision, consistent };
  });
}

function report(scored: Scored[]) {
  const n = scored.length || 1;
  const rate = (x: number, d: number) => (d ? `${((100 * x) / d).toFixed(1)}% (${x}/${d})` : "n/a (0)");
  const verdicts = scored.reduce<Record<string, number>>((acc, s) => ({ ...acc, [s.decision.verdict]: (acc[s.decision.verdict] || 0) + 1 }), {});
  const coverage = scored.map((s) => ["product", "customer", "ec_pulse", "post_metrics", "hypothesis"].filter((src) => s.decision.evidence.some((e) => e.source === src && !(e.key === "status" && e.value !== "ok"))).length / 5);
  const pivots = scored.filter((s) => s.decision.verdict === "pivot");
  const duplicateRecs = pivots.filter((s) => s.decision.next_action.change_variable === "angle" && (s.decision.next_action.angle === s.evidence.hypothesis.angle || s.decision.next_action.hook === s.evidence.hypothesis.hook));
  const stops = scored.filter((s) => s.decision.verdict === "stop");
  const continues = scored.filter((s) => s.decision.verdict === "continue");
  const decisive = scored.filter((s) => s.decision.verdict !== "wait");
  const labelled = (xs: Scored[]) => xs.filter((s) => s.outcome !== "unknown");
  const actionable = scored.filter((s) => s.decision.next_action.generate_creative);
  const improvedKnown = actionable.filter((s) => s.nextImproved != null);

  const rows: Array<[string, string]> = [
    ["cases", String(scored.length)],
    ["verdicts", JSON.stringify(verdicts)],
    ["decision consistency (same input -> same verdict/hash)", rate(scored.filter((s) => s.consistent).length, scored.length)],
    ["evidence coverage (avg of 5 sources)", `${((100 * coverage.reduce((a, b) => a + b, 0)) / n).toFixed(1)}%`],
    ["duplicate recommendation rate (pivot repeats current angle/hook)", rate(duplicateRecs.length, pivots.length)],
    ["false STOP (stopped a winning/recoverable hypothesis)", rate(labelled(stops).filter((s) => s.outcome !== "losing").length, labelled(stops).length)],
    ["false CONTINUE (continued a losing hypothesis)", rate(labelled(continues).filter((s) => s.outcome === "losing").length, labelled(continues).length)],
    ["unnecessary PIVOT (pivoted a winning hypothesis)", rate(labelled(pivots).filter((s) => s.outcome === "winning").length, labelled(pivots).length)],
    ["missed STOP (losing hypothesis still gets a creative)", rate(scored.filter((s) => s.outcome === "losing" && s.decision.next_action.generate_creative).length, scored.filter((s) => s.outcome === "losing").length)],
    ["action relevance (next action improved the metric, where known)", rate(improvedKnown.filter((s) => s.nextImproved).length, improvedKnown.length)],
    ["learning efficiency (decisive, single-variable change)", rate(decisive.filter((s) => s.decision.verdict !== "pivot" || s.decision.next_action.change_variable !== null).length, scored.length)],
    ["hypothesis quality (decisions with hypothesis+metric+objective)", rate(scored.filter((s) => s.decision.hypothesis && s.decision.primary_metric && s.decision.learning_objective).length, scored.length)],
  ];
  const width = Math.max(...rows.map(([k]) => k.length));
  for (const [k, v] of rows) console.log(`${k.padEnd(width)}  ${v}`);
  console.log("\nper case:");
  for (const s of scored) {
    console.log(`  ${s.name.padEnd(28)} ${s.decision.verdict.padEnd(9)} rule=${s.decision.teacher.ruleId.padEnd(26)} conf=${s.decision.confidence} label=${s.outcome}${s.consistent ? "" : "  INCONSISTENT"}`);
  }
}

async function fromSupabase() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required for --supabase");
  const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: posts, error } = await db.from("social_posts").select("id,user_id,network,metadata").eq("status", "published").not("published_at", "is", null).limit(500);
  if (error) throw error;
  const cases: Case[] = [];
  for (const post of posts || []) {
    const { data: metrics } = await db.from("post_metrics").select("measured_at,clicks,impressions,views,likes,comments,shares,saves").eq("social_post_id", post.id).order("measured_at", { ascending: true });
    if (!metrics?.length) continue;
    const asOf = String(metrics[metrics.length - 1].measured_at);
    const collected = await collectDecisionEvidence(db as never, post.user_id, post.id, asOf);
    if (!collected) continue;
    // Label: did the follow-up post (created from this one) perform better?
    const { data: child } = await db.from("social_posts").select("id").eq("user_id", post.user_id).eq("metadata->>source_social_post_id", post.id).limit(1).maybeSingle();
    let nextImproved: boolean | null = null;
    if (child) {
      const { data: cm } = await db.from("post_metrics").select("impressions,views,likes,comments,shares,saves,clicks").eq("social_post_id", child.id).order("measured_at", { ascending: false }).limit(1).maybeSingle();
      const rate = (x: Record<string, number | null> | null) => {
        if (!x) return null;
        const exposure = Math.max(Number(x.impressions || 0), Number(x.views || 0));
        return exposure ? (Number(x.likes || 0) + Number(x.comments || 0) + Number(x.shares || 0) + Number(x.saves || 0) + Number(x.clicks || 0)) / exposure : null;
      };
      const a = rate(metrics[metrics.length - 1] as never);
      const b = rate(cm as never);
      nextImproved = a != null && b != null ? b > a : null;
    }
    cases.push({ name: post.id.slice(0, 8), evidence: collected.evidence, outcome: "unknown", nextImproved });
  }
  return cases;
}

const useDb = process.argv.includes("--supabase");
const cases = useDb ? await fromSupabase() : SCENARIOS;
console.log(`Decision backtest (${useDb ? "Supabase replay" : "labelled scenarios"})\n`);
report(score(cases));
