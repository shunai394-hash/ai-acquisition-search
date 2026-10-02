import type { getAdminSupabase } from "@/lib/billing";
import { DECISION_LEASE_TTL_MS, type DecisionReservationStore, type ReservationState } from "./idempotency";

type Db = ReturnType<typeof getAdminSupabase>;
type Row = Record<string, unknown>;

export const DECISION_RUN_TYPE = "ai_performance_verdict";

/** A reservation row: inserted before the decision runs, not yet completed. */
export function isProcessingRun(row: { output?: unknown; completed_at?: unknown } | null | undefined) {
  const output = row?.output;
  return !row?.completed_at && Boolean(output && typeof output === "object" && (output as Row).state === "processing");
}

/**
 * Lease end of a reservation. Rows reserved before lease_expires_at existed
 * fall back to started_at + TTL, so they expire too.
 */
export function reservationLeaseExpiry(row: { lease_expires_at?: unknown; started_at?: unknown; created_at?: unknown }) {
  if (row.lease_expires_at) return Date.parse(String(row.lease_expires_at));
  const started = Date.parse(String(row.started_at ?? row.created_at ?? ""));
  return Number.isFinite(started) ? started + DECISION_LEASE_TTL_MS : 0;
}

/**
 * operator_runs-backed reservation store. The unique index
 * (user_id, input->>'decision_key') for ai_performance_verdict makes the
 * insert the race arbiter; takeover, complete and release are conditional
 * updates/deletes, so two requests can never both own one row.
 */
export function operatorRunReservationStore<T extends { decision: unknown }>(
  db: Db,
  run: { userId: string; productId: string | null; socialPostId: string; input: Row },
): DecisionReservationStore<T> {
  let key = "";
  const processing = (holder: string, now: Date) => ({
    input: { ...run.input, decision_key: key },
    output: { state: "processing", holder },
    started_at: now.toISOString(),
    lease_expires_at: new Date(now.getTime() + DECISION_LEASE_TTL_MS).toISOString(),
  });

  // Expired reservations for older inputs of this post: nobody will ever ask
  // for their key again, so remove them instead of leaving them forever.
  const sweepExpired = async (now: Date) => {
    const base = () => db.from("operator_runs").delete()
      .eq("user_id", run.userId)
      .eq("run_type", DECISION_RUN_TYPE)
      .eq("input->>social_post_id", run.socialPostId)
      .neq("input->>decision_key", key)
      .eq("output->>state", "processing")
      .is("completed_at", null);
    const cutoff = new Date(now.getTime() - DECISION_LEASE_TTL_MS).toISOString();
    const results = await Promise.all([
      base().lt("lease_expires_at", now.toISOString()),
      base().is("lease_expires_at", null).lt("started_at", cutoff),
    ]);
    for (const { error } of results) if (error) console.error("decision reservation sweep failed", error);
  };

  return {
    async reserve(decisionKey, holder) {
      key = decisionKey;
      const now = new Date();
      await sweepExpired(now);
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const { data, error } = await db.from("operator_runs").insert({
          product_id: run.productId,
          user_id: run.userId,
          run_type: DECISION_RUN_TYPE,
          ...processing(holder, now),
        }).select("id").single();
        if (!error && data?.id) return { status: "acquired", id: String(data.id) };
        if (error?.code !== "23505") throw error ?? new Error("AI判定の予約に失敗しました。");

        const { data: existing, error: existingError } = await db.from("operator_runs")
          .select("id")
          .eq("user_id", run.userId)
          .eq("run_type", DECISION_RUN_TYPE)
          .eq("input->>decision_key", decisionKey)
          .limit(1)
          .maybeSingle();
        if (existingError) throw existingError;
        if (existing?.id) return { status: "existing", id: String(existing.id) };
        // The conflicting row was released in between: insert again.
      }
      throw new Error("AI判定の予約競合を解決できませんでした。");
    },

    async inspect(id): Promise<ReservationState<T>> {
      const { data, error } = await db.from("operator_runs")
        .select("id,output,completed_at,lease_expires_at,started_at,created_at")
        .eq("id", id)
        .maybeSingle();
      if (error) throw error;
      if (!data) return { state: "missing" };
      const output = data.output as Row | null;
      if (output && typeof output === "object" && "decision" in output) return { state: "completed", output: output as T };
      return { state: "processing", leaseExpiresAt: reservationLeaseExpiry(data as Row) };
    },

    async takeover(id, holder, now) {
      const patch = processing(holder, now);
      const base = () => db.from("operator_runs").update(patch)
        .eq("id", id)
        .eq("output->>state", "processing")
        .is("completed_at", null);
      const leased = await base().lt("lease_expires_at", now.toISOString()).select("id");
      if (leased.error) throw leased.error;
      if (Array.isArray(leased.data) && leased.data.length) return true;
      const legacy = await base()
        .is("lease_expires_at", null)
        .lt("started_at", new Date(now.getTime() - DECISION_LEASE_TTL_MS).toISOString())
        .select("id");
      if (legacy.error) throw legacy.error;
      return Array.isArray(legacy.data) && legacy.data.length > 0;
    },

    async complete(id, holder, output, { retryable }) {
      const { data, error } = await db.from("operator_runs")
        .update({
          status: "completed",
          output,
          completed_at: new Date().toISOString(),
          lease_expires_at: null,
          // Keep the record, but give the key back so the next call retries the LLM.
          ...(retryable ? { input: { ...run.input, released_decision_key: key } } : {}),
        })
        .eq("id", id)
        .eq("output->>holder", holder)
        .is("completed_at", null)
        .select("id");
      if (error) throw error;
      return Array.isArray(data) && data.length > 0;
    },

    async release(id, holder) {
      const { error } = await db.from("operator_runs").delete()
        .eq("id", id)
        .eq("output->>holder", holder)
        .is("completed_at", null);
      if (error) throw error;
    },
  };
}
