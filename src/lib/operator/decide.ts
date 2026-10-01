import type { SupabaseClient } from "@supabase/supabase-js";
import { buildDeterministicDecision, decisionInputHash, refineDecisionWithLlm, type StructuredDecision } from "./decision";
import { loadDecisionContext, type DecisionContext } from "./evidence";

export const DECISION_RUN_TYPE = "ai_performance_verdict";

export type DecideResult =
  | { ok: true; runId: string; reused: boolean; decision: StructuredDecision; context: DecisionContext }
  | { ok: false; status: number; error: string };

// 旧クライアント（画面・operator-loop・MCP）が読むフラットな形式も併せて返す。
export function legacyFields(decision: StructuredDecision) {
  return {
    verdict: decision.verdict,
    reason: decision.reason,
    nextAction: decision.next_action.instructions,
    ...(decision.next_action.angle ? { changedAngle: decision.next_action.angle } : {}),
    ...(decision.next_action.hook ? { changedHook: decision.next_action.hook } : {}),
    testMetric: decision.primary_metric,
    aiConnected: decision.ai_refined,
  };
}

function idempotencyKey(postId: string, inputHash: string) {
  return `${postId}:${inputHash}`;
}

async function findExistingRun(db: SupabaseClient, userId: string, key: string) {
  const { data, error } = await db.from("operator_runs")
    .select("id,output")
    .eq("user_id", userId)
    .eq("run_type", DECISION_RUN_TYPE)
    .eq("input->>idempotency_key", key)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  const decision = (data?.output as Record<string, unknown> | null)?.decision as StructuredDecision | undefined;
  return data && decision ? { id: String(data.id), decision } : null;
}

export async function decideForPost(
  db: SupabaseClient,
  input: { userId: string; socialPostId: string; productId?: string | null; fetchImpl?: typeof fetch },
): Promise<DecideResult> {
  const ctx = await loadDecisionContext(db, { userId: input.userId, socialPostId: input.socialPostId, fetchImpl: input.fetchImpl });
  if (!ctx) return { ok: false, status: 404, error: "対象投稿が見つかりません。" };
  if (ctx.metrics.snapshots === 0) return { ok: false, status: 400, error: "先に実績を取得してください。" };

  const inputHash = decisionInputHash(ctx);
  const key = idempotencyKey(ctx.post.id, inputHash);

  // 同じ入力（同じ実績・同じ根拠・同じロジック版）なら保存済み Decision を返す。
  const existing = await findExistingRun(db, input.userId, key);
  if (existing) {
    await markPostDecision(db, input.userId, ctx.post.id, existing.id, existing.decision);
    return { ok: true, runId: existing.id, reused: true, decision: existing.decision, context: ctx };
  }

  const draft = buildDeterministicDecision(ctx);
  const decision = await refineDecisionWithLlm(draft, ctx, input.fetchImpl);

  const now = new Date().toISOString();
  const { data: run, error: runError } = await db.from("operator_runs").insert({
    product_id: input.productId || ctx.productId || null,
    user_id: input.userId,
    run_type: DECISION_RUN_TYPE,
    status: "completed",
    input: {
      social_post_id: ctx.post.id,
      creative_id: ctx.creative.id,
      idempotency_key: key,
      input_hash: inputHash,
      as_of: ctx.asOf,
      metrics: { values: ctx.metrics.values, known: ctx.metrics.known, rows: ctx.metrics.sourceRowIds, measured_at: ctx.metrics.measuredAt },
      baseline: ctx.baseline,
      pivot_streak: ctx.pivotStreak,
      market: { connected: ctx.market.connected, error: ctx.market.error, runs: ctx.market.runs.map((r) => r.runId) },
    },
    output: { ...legacyFields(decision), decision },
    started_at: now,
    completed_at: new Date().toISOString(),
  }).select("id").single();

  if (runError) {
    // 同時実行で別リクエストが先に保存した場合（一意制約）は、そちらを採用する。
    if (runError.code === "23505") {
      const winner = await findExistingRun(db, input.userId, key);
      if (winner) {
        await markPostDecision(db, input.userId, ctx.post.id, winner.id, winner.decision);
        return { ok: true, runId: winner.id, reused: true, decision: winner.decision, context: ctx };
      }
    }
    throw runError;
  }

  await markPostDecision(db, input.userId, ctx.post.id, String(run.id), decision);
  return { ok: true, runId: String(run.id), reused: false, decision, context: ctx };
}

// 投稿に最新判定を記録する。STOP は以後の巡回対象から外す。
async function markPostDecision(db: SupabaseClient, userId: string, postId: string, runId: string, decision: StructuredDecision) {
  const { data: current } = await db.from("social_posts").select("metadata").eq("id", postId).eq("user_id", userId).maybeSingle();
  const metadata = current?.metadata && typeof current.metadata === "object" ? current.metadata as Record<string, unknown> : {};
  const status = String(metadata.operator_patrol_status || "");
  // 既に次の投稿へ引き継いだ（superseded）投稿は状態を戻さない。
  const nextStatus = status === "superseded" ? "superseded" : decision.verdict === "stop" ? "stopped" : "active";
  const last = metadata.operator_last_decision as Record<string, unknown> | undefined;
  if (last?.run_id === runId && status === nextStatus) return;
  await db.from("social_posts").update({
    metadata: {
      ...metadata,
      operator_patrol_status: nextStatus,
      operator_last_decision: {
        run_id: runId,
        verdict: decision.verdict,
        action_type: decision.action_type,
        input_hash: decision.input_hash,
        logic_version: decision.logic_version,
        decided_at: decision.generated_at,
      },
    },
    updated_at: new Date().toISOString(),
  }).eq("id", postId).eq("user_id", userId);
}
