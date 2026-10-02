import { NextResponse } from "next/server";
import { getAdminSupabase, getUserFromBearer } from "@/lib/billing";
import { openAiJsonResult, openAiModel } from "@/lib/ai/openai-json";
import { buildDecision, refineNextAction } from "@/lib/decision/engine";
import { collectDecisionEvidence } from "@/lib/decision/evidence";
import {
  DECISION_ROUTE_MAX_DURATION_MS,
  decisionWaitBudgetMs,
  DecisionInProgressError,
  decisionKeyFor,
  runIdempotentDecision,
} from "@/lib/decision/idempotency";
import { operatorRunReservationStore } from "@/lib/decision/reservation-store";
import type { StructuredDecision } from "@/lib/decision/types";

export const runtime = "nodejs";
// Keep equal to DECISION_ROUTE_MAX_DURATION_MS (checked by a test).
export const maxDuration = 60;

// Time this request keeps for itself after waiting on another request's decision.
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

type StoredOutput = ReturnType<typeof compatFields> & {
  aiConnected?: boolean;
  decision: StructuredDecision;
  /** Set when the LLM call failed and the deterministic wording was kept. */
  llm?: { status: "failed"; reason: string; retryable: true };
};

export async function POST(request: Request) {
  const startedAt = Date.now();
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
    // input_hash covers every input of the decision (metrics, EC-Pulse run,
    // history, lineage, product, customer, Teacher rule, logic version), so
    // any change in evidence produces a new decision.
    const evidenceVersion = evidence.market.runId ?? evidence.market.status;
    const decisionKey = decisionKeyFor(post.id, metricId, evidenceVersion, deterministic);

    const store = operatorRunReservationStore<StoredOutput>(db, {
      userId: user.id,
      productId: body.productId || creative?.product_id || null,
      socialPostId: post.id,
      input: {
        social_post_id: post.id,
        creative_id: post.creative_id,
        metric_id: metricId ?? null,
        input_hash: deterministic.input_hash,
        as_of: evidence.asOf,
        evidence,
      },
    });

    const result = await runIdempotentDecision(store, decisionKey, async () => {
      const llm: { failure: string | null } = { failure: null };
      const decision = await refineNextAction(deterministic, evidence, async (prompt) => {
        const response = await openAiJsonResult(prompt);
        if (response.status === "failed") llm.failure = response.reason;
        return response.status === "ok" ? response.text : null;
      }, openAiModel());
      const aiConnected = decision.model_version !== "deterministic";
      const output: StoredOutput = {
        ...compatFields(decision),
        aiConnected,
        decision,
        ...(llm.failure ? { llm: { status: "failed" as const, reason: llm.failure, retryable: true as const } } : {}),
      };
      return { output, retryable: Boolean(llm.failure) };
    }, {
      maxWaitMs: decisionWaitBudgetMs(startedAt),
    });

    const output = result.output;
    // The verdict is deterministic; only the LLM wording failed. The decision is
    // returned as before, but its key was released so the next call retries the LLM.
    const llmRetry = output.llm?.status === "failed" ? { llmFailed: true, retryable: true } : {};
    return NextResponse.json({
      ok: true,
      ...(result.status === "completed" ? { reused: true } : {}),
      runId: result.id,
      aiConnected: output.aiConnected === true,
      ...compatFields(output.decision),
      decision: output.decision,
      ...llmRetry,
    });
  } catch (error) {
    if (error instanceof DecisionInProgressError) {
      const retryAfterSeconds = Math.max(1, Math.ceil(error.retryAfterMs / 1000));
      return NextResponse.json(
        { error: error.message, code: "decision_in_progress", retryable: true, retryAfterSeconds },
        { status: 409, headers: { "Retry-After": String(retryAfterSeconds) } },
      );
    }
    console.error("ai decision error", error);
    return NextResponse.json({ error: error instanceof Error ? error.message : "AI判定に失敗しました。" }, { status: 500 });
  }
}
