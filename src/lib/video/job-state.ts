// Shared rules for production_jobs.provider_response and job lifecycle.
//
// provider_response carries loop state that must survive every status change:
// the product reference image, the retry counter and recovery markers. Status
// writes therefore merge into it instead of replacing it; otherwise a failed
// job loses its image (retry falls back to text-to-video) and its retry_count
// (the loop retries it forever).

type JsonRecord = Record<string, unknown>;

export const asRecord = (value: unknown): JsonRecord =>
  value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};

export function mergeProviderResponse(existing: unknown, patch: JsonRecord): JsonRecord {
  return { ...asRecord(existing), ...patch };
}

/** Operator-initiated provider attempts per job (the first start counts as 1). */
export const MAX_VIDEO_ATTEMPTS = 2;
/** Failed SNS publishes of a completed video before the loop stops retrying it. */
export const MAX_PUBLISH_ATTEMPTS = 3;

/** A running job whose provider has not finished within this window is failed so it can be retried. */
export function videoJobTimeoutMs() {
  const minutes = Number(process.env.VIDEO_JOB_TIMEOUT_MINUTES || 60);
  return (Number.isFinite(minutes) && minutes >= 10 ? minutes : 60) * 60_000;
}

export function isVideoJobTimedOut(startedAt: unknown, now = Date.now()) {
  const started = Date.parse(String(startedAt ?? ""));
  return Number.isFinite(started) && now - started > videoJobTimeoutMs();
}

/**
 * Reasons a job no longer needs the operator loop. Settled jobs are excluded
 * from the loop's job query so finished rows cannot crowd out new ones.
 */
export type SettleReason =
  | "published"
  | "no_social_post"
  | "retries_exhausted"
  | "non_retryable"
  | "manual_recovery_required"
  | "publish_exhausted"
  | "social_post_missing";

export function settledPatch(existing: unknown, reason: SettleReason, extra: JsonRecord = {}) {
  return mergeProviderResponse(existing, { ...extra, loop_settled_at: new Date().toISOString(), loop_settled_reason: reason });
}
