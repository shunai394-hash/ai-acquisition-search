import { NextResponse } from "next/server";
import { getAdminSupabase, getUserFromBearer } from "@/lib/billing";
import { openAiJson, openAiModel } from "@/lib/ai/openai-json";
import { buildDecision, refineNextAction } from "@/lib/decision/engine";
import { collectDecisionEvidence } from "@/lib/decision/evidence";
import { runIdempotentDecision } from "@/lib/decision/idempotency";
import type { StructuredDecision } from "@/lib/decision/types";

export const runtime = "nodejs";
export const maxDuration = 120;

const PROCESSING_STALE_MS = 90_000;

// Fields kept for existing clients (UI, operator-loop, MCP).
function compatFields(decision: StructuredDecision) {
  return {
    verdict: decision.verdict,
    reason: decision.reason,
    nextAction: decision.next_action.description,
    ...(decision.next_action.angle ? { changedAngle: decision.next_action.angle } : {}),
    ...(decision.next_action.hook ? { changedHook: decision.next_action.hook } : {}),
    testMetric: decision.primary_metric,
    generateCreative: decision.next_action.generate_creative,
  };
}

type StoredOutput = { aiConnected?: boolean; decision: StructuredDecision };

function storedDecision(output: unknown): StoredOutput | null {
  return output && typeof output === "object" && "decision" in output ? output as StoredOutput : null;
}

export async function POST(request: Request) {
  try {
    const user = await getUserFromBearer(request);
    if (!user) return NextResponse.json({ error: "ログインが必要です。" }, { status: 401 });
    const body = await request.json() as { socialPostId?: string; productId?: string };
    if (!body.socialPostId) return NextResponse.json({ error: "socialPostIdが必要です。" }, { status: 400 });

    const db = getAdminSupabase();
    const collected = await collectDecisionEvidence(db, user.id, body.socialPostId);
    if (!collected) return NextResponse.json({ error: "対象投稿が見つかりません。" }, { status: 404 });
    const { evidence, post, creative, metricId } = collected;
    if (!evidence.current) return NextResponse.json({ error: "先に実績を取得してください。" }, { status: 400 });

    const deterministic = buildDecision(evidence);
    // Same evidence -> same decision key -> the stored decision is reused, so
    // concurrent or repeated calls neither re-run the LLM nor insert duplicates.
    // Idempotency is scoped to the same observed metric + the same EC-Pulse research run.
    // This avoids duplicate decisions under concurrency while still allowing a new
    // market-evidence run to trigger a fresh decision for the same post.
    const evidenceVersion = evidence.market.runId ?? evidence.market.status;
    const decisionKey = `${post.id}:${metricId ?? "no-metric"}:${evidenceVersion}:${deterministic.logic_version}`;

    const store = {
      async reserve(decisionKey: string) {
        const { data, error } = await db.from("operator_runs").insert({
          product_id: body.productId || creative?.product_id || null,
          user_id: user.id,
          run_type: "ai_performance_verdict",
          input: {
            social_post_id: post.id,
            creative_id: post.creative_id,
            metric_id: metricId ?? null,
            decision_key: decisionKey,
            input_hash: deterministic.input_hash,
            as_of: evidence.asOf,
            evidence,
          },
          output: { state: "processing" },
          started_at: new Date().toISOString(),
        }).select("id").single();

        if (!error && data?.id) return { status: "acquired" as const, id: data.id as string };
        if (error?.code !== "23505") throw error ?? new Error("AI判定の予約に失敗しました。");

        const { data: existing, error: existingError } = await db.from("operator_runs")
          .select("id, output, started_at")
          .eq("user_id", user.id)
          .eq("run_type", "ai_performance_verdict")
          .eq("input->>decision_key", decisionKey)
          .order("created_at", { ascending: true })
          .limit(1)
          .maybeSingle();
        if (existingError) throw existingError;
        if (!existing?.id) throw new Error("AI判定の予約競合を解決できませんでした。");

        const output = existing.output;
        const startedAt = Date.parse(String(existing.started_at ?? ""));
        const processing = output && typeof output === "object" && (output as Record<string, unknown>).state === "processing";
        const stale = processing && Number.isFinite(startedAt) && Date.now() - startedAt >= PROCESSING_STALE_MS;
        if (stale) {
          const { error: reclaimError } = await db.from("operator_runs").delete().eq("id", existing.id);
          if (reclaimError) throw reclaimError;
          return this.reserve(decisionKey);
        }

        return { status: "existing" as const, id: existing.id as string };
      },
      async getCompleted(id: string) {
        const { data, error } = await db.from("operator_runs")
          .select("id,output")
          .eq("id", id)
          .maybeSingle();
        if (error) throw error;
        const stored = storedDecision(data?.output);
        return stored ? { id: data?.id as string, ...stored } : null;
      },
      async complete(id: string, output: StoredOutput) {
        const { error } = await db.from("operator_runs")
          .update({
            status: "completed",
            output,
            completed_at: new Date().toISOString(),
          })
          .eq("id", id);
        if (error) throw error;
      },
      async release(id: string) {
        const { error } = await db.from("operator_runs").delete().eq("id", id);
        if (error) throw error;
      },
    };

    const result = await runIdempotentDecision(store, decisionKey, async () => {
      const decision = await refineNextAction(deterministic, evidence, openAiJson, openAiModel());
      const aiConnected = decision.model_version !== "deterministic";
      return {
        output: { ...compatFields(decision), aiConnected, decision },
        // A deterministic fallback is still returned to the caller, but it must
        // not become the cached "completed" result. A later request should be
        // allowed to retry the LLM once it is available.
        persist: aiConnected,
      };
    });

    if (result.status === "completed") {
      return NextResponse.json({
        ok: true,
        reused: true,
        runId: result.id,
        aiConnected: result.output.aiConnected === true,
        ...compatFields(result.output.decision),
        decision: result.output.decision,
      });
    }

    const runId = result.id;
    const output = result.output;
    return NextResponse.json({
      ok: true,
      runId,
      reused: result.status === "completed",
      persisted: result.status !== "transient",
      aiConnected: output.aiConnected,
      ...compatFields(output.decision),
      decision: output.decision,
    }, { status: result.status === "transient" ? 200 : 200 });
  } catch (error) {
    console.error("ai decision error", error);
    return NextResponse.json({ error: error instanceof Error ? error.message : "AI判定に失敗しました。" }, { status: 500 });
  }
}
