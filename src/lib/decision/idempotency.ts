import { randomUUID } from "node:crypto";
import { OPENAI_JSON_MAX_ATTEMPTS, OPENAI_JSON_TIMEOUT_MS } from "@/lib/ai/openai-json";

/** Worst case of the LLM refinement: every openAiJson attempt runs into its timeout. */
export const DECISION_LLM_MAX_MS = OPENAI_JSON_TIMEOUT_MS * OPENAI_JSON_MAX_ATTEMPTS;
/** `maxDuration` of the ai-decision route (kept equal by a test). */
export const DECISION_ROUTE_MAX_DURATION_MS = 60_000;
/**
 * Lease of a processing reservation. Longer than the route can live, so an
 * expired lease always belongs to a request the platform has already killed.
 */
export const DECISION_LEASE_TTL_MS = DECISION_ROUTE_MAX_DURATION_MS + 10_000;
/** How long a concurrent request waits for the holder: LLM worst case plus DB writes. */
export const DECISION_WAIT_MAX_MS = DECISION_LLM_MAX_MS + 5_000;
export const DECISION_POLL_INTERVAL_MS = 500;
/** Safe waiter budget after request overhead, never negative. */
export function decisionWaitBudgetMs(requestStartedAt: number, now = Date.now()) {
  return Math.max(0, Math.min(DECISION_WAIT_MAX_MS, requestStartedAt + DECISION_ROUTE_MAX_DURATION_MS - 5_000 - now));
}

/**
 * Same input -> same key. The input hash covers everything the decision reads
 * (product, customer, market, metrics, history, lineage, Teacher rule, logic
 * version); the readable prefix only helps when inspecting rows.
 */
export function decisionKeyFor(
  postId: string,
  metricId: string | null | undefined,
  marketVersion: string,
  decision: { logic_version: string; input_hash: string },
) {
  return `${postId}:${metricId ?? "no-metric"}:${marketVersion}:${decision.logic_version}:${decision.input_hash}`;
}

/** Another request holds the reservation and did not finish within the wait budget. */
export class DecisionInProgressError extends Error {
  constructor(readonly retryAfterMs: number) {
    super("同じ入力のAI判定を処理中です。少し待ってから再実行してください。");
    this.name = "DecisionInProgressError";
  }
}

export type ReservationState<T> =
  | { state: "completed"; output: T }
  | { state: "processing"; leaseExpiresAt: number }
  | { state: "missing" };

/**
 * Persistence of one reservation row. `holder` is a per-attempt fencing token:
 * complete / release only touch the row while this attempt still owns it.
 */
export type DecisionReservationStore<T> = {
  /** Insert the processing row; a unique violation means another request has it. */
  reserve: (decisionKey: string, holder: string) => Promise<{ status: "acquired"; id: string } | { status: "existing"; id: string }>;
  inspect: (id: string) => Promise<ReservationState<T>>;
  /** Conditional update that succeeds only while the lease is expired. */
  takeover: (id: string, holder: string, now: Date) => Promise<boolean>;
  /**
   * Store the result. `retryable` (the LLM failed) keeps the record but frees
   * the decision key, so the next request runs the LLM again.
   * Returns false when this attempt no longer owns the row.
   */
  complete: (id: string, holder: string, output: T, options: { retryable: boolean }) => Promise<boolean>;
  /** Drop the reservation after an error so the next request can run. */
  release: (id: string, holder: string) => Promise<void>;
};

export type DecisionExecution<T> = { output: T; retryable: boolean };

export type DecisionReservationResult<T> = {
  /** acquired: this request executed. completed: another request's stored result. */
  status: "acquired" | "completed";
  id: string;
  output: T;
  tookOver: boolean;
  retryable: boolean;
};

export type IdempotencyOptions = {
  pollMs?: number;
  maxWaitMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function runIdempotentDecision<T>(
  store: DecisionReservationStore<T>,
  decisionKey: string,
  execute: () => Promise<DecisionExecution<T>>,
  options: IdempotencyOptions = {},
): Promise<DecisionReservationResult<T>> {
  const pollMs = options.pollMs ?? DECISION_POLL_INTERVAL_MS;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  const deadline = now() + (options.maxWaitMs ?? DECISION_WAIT_MAX_MS);

  const run = async (id: string, holder: string, tookOver: boolean): Promise<DecisionReservationResult<T>> => {
    let execution: DecisionExecution<T>;
    try {
      execution = await execute();
    } catch (error) {
      await store.release(id, holder).catch((releaseError) => {
        // The lease still expires, so a failed release only delays the retry.
        console.error("decision reservation release failed", releaseError);
      });
      throw error;
    }
    if (await store.complete(id, holder, execution.output, { retryable: execution.retryable })) {
      return { status: "acquired", id, output: execution.output, tookOver, retryable: execution.retryable };
    }
    // Lost the lease while running (only possible past the TTL): return what the new holder stored.
    const state = await store.inspect(id);
    if (state.state === "completed") return { status: "completed", id, output: state.output, tookOver: false, retryable: false };
    throw new DecisionInProgressError(pollMs);
  };

  for (;;) {
    const holder = randomUUID();
    const reservation = await store.reserve(decisionKey, holder);
    if (reservation.status === "acquired") return run(reservation.id, holder, false);

    for (;;) {
      const state = await store.inspect(reservation.id);
      if (state.state === "completed") {
        return { status: "completed", id: reservation.id, output: state.output, tookOver: false, retryable: false };
      }
      if (state.state === "missing") break; // released after an error: reserve again
      if (state.leaseExpiresAt <= now() && await store.takeover(reservation.id, holder, new Date(now()))) {
        return run(reservation.id, holder, true);
      }
      const remaining = deadline - now();
      if (remaining <= 0) throw new DecisionInProgressError(Math.max(pollMs, state.leaseExpiresAt - now()));
      await sleep(Math.min(pollMs, remaining));
    }
    if (now() >= deadline) throw new DecisionInProgressError(pollMs);
  }
}
