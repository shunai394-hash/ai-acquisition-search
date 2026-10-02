import { NextResponse } from "next/server";
import { getAdminSupabase, getUserFromBearer } from "@/lib/billing";
import { openAiJson, openAiModel } from "@/lib/ai/openai-json";
import { buildDecision, refineNextAction } from "@/lib/decision/engine";
import { collectDecisionEvidence } from "@/lib/decision/evidence";
import type { StructuredDecision } from "@/lib/decision/types";

export const runtime = "nodejs";
export const maxDuration = 60;

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
    // Idempotency is scoped to the same observed metric + the same EC-Pulse research run.\n    // This avoids duplicate decisions under concurrency while still allowing a new\n    // market-evidence run to trigger a fresh decision for the same post.\n    const evidenceVersion = evidence.market.runId ?? evidence.market.status;\n    const decisionKey = `${post.id}:${metricId ?? "no-metric"}:${evidenceVersion}:${deterministic.logic_version}`;

    const findExisting = async () => {
      const { data } = await db.from("operator_runs")
        .select("id,output")
        .eq("user_id", user.id)
        .eq("run_type", "ai_performance_verdict")
        .eq("input->>decision_key", decisionKey)
        .order("created_at", { ascending: true })
        .limit(1)
        .maybeSingle();
      const stored = storedDecision(data?.output);
      return data && stored ? { id: data.id as string, ...stored } : null;
    };
    const reusedResponse = (found: NonNullable<Awaited<ReturnType<typeof findExisting>>>) =>
      NextResponse.json({ ok: true, reused: true, runId: found.id, aiConnected: found.aiConnected === true, ...compatFields(found.decision), decision: found.decision });

    const existing = await findExisting();
    if (existing) return reusedResponse(existing);

    const decision = await refineNextAction(deterministic, evidence, openAiJson, openAiModel());
    const aiConnected = decision.model_version !== "deterministic";
    const startedAt = new Date().toISOString();

    const { data: run, error: runError } = await db.from("operator_runs").insert({
      product_id: body.productId || creative?.product_id || null,
      user_id: user.id,
      run_type: "ai_performance_verdict",
      status: "completed",
      input: {
        social_post_id: post.id,
        creative_id: post.creative_id,
        metric_id: metricId ?? null,
        decision_key: decisionKey,
        input_hash: decision.input_hash,
        as_of: evidence.asOf,
        evidence,
      },
      output: { ...compatFields(decision), aiConnected, decision },
      started_at: startedAt,
      completed_at: new Date().toISOString(),
    }).select("id").single();

    if (runError?.code === "23505") {
      const winner = await findExisting();
      if (winner) return reusedResponse(winner);
    }
    if (runError) throw runError;

    return NextResponse.json({ ok: true, runId: run.id, aiConnected, ...compatFields(decision), decision });
  } catch (error) {
    console.error("ai decision error", error);
    return NextResponse.json({ error: error instanceof Error ? error.message : "AI判定に失敗しました。" }, { status: 500 });
  }
}
