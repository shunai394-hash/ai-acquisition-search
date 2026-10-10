import { refundMonthlyUsage } from "@/lib/billing";

/**
 * Shared rules for production_jobs failure handling.
 *
 * provider_response keys used here:
 * - usage_event_id / narration_usage_event_id: quota units charged for this job
 * - provider_start_attempted: false while the external provider has definitely
 *   not been called yet; true from just before the provider call. Older rows
 *   without the key are treated as "unknown" (manual recovery, no auto refund).
 * - terminal: true once the job must never be retried automatically
 *   (quota refunded, provider rejected the content, retries exhausted, ...).
 */

export const PROVIDER_JOB_TIMEOUT_MS = Math.max(
  30,
  Number(process.env.VIDEO_JOB_TIMEOUT_MINUTES || 180),
) * 60_000;

export function jobMeta(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export function providerDefinitelyNotStarted(meta: Record<string, unknown>) {
  return meta.provider_start_attempted === false;
}

/**
 * Refund every quota unit charged for a job. The refund RPC deletes the usage
 * event by id, so repeated calls (polling, cron, patrol) cannot double-refund.
 * Throws when the RPC itself fails so callers keep the job retryable.
 */
export async function refundJobUsage(userId: string, meta: Record<string, unknown>) {
  const result: { video?: boolean; narration?: boolean } = {};
  const videoEventId = typeof meta.usage_event_id === "string" ? meta.usage_event_id : "";
  const narrationEventId = typeof meta.narration_usage_event_id === "string" ? meta.narration_usage_event_id : "";
  if (videoEventId) {
    const refund = await refundMonthlyUsage(userId, "video_generation", videoEventId);
    result.video = refund.refunded;
  }
  if (narrationEventId) {
    const refund = await refundMonthlyUsage(userId, "narration_generation", narrationEventId);
    result.narration = refund.refunded;
  }
  return result;
}

const PROVIDER_FAILURE_MESSAGES: Record<string, string> = {
  nsfw: "動画生成サービスの安全フィルタにより生成が拒否されました。プロンプトや画像の表現を変えて再試行してください。",
  failed: "動画生成サービス側で生成に失敗しました。時間を置いて再試行するか、プロンプトを短く具体的にしてください。",
  cancelled: "動画生成がキャンセルされました。もう一度生成してください。",
  canceled: "動画生成がキャンセルされました。もう一度生成してください。",
  timeout: "動画生成が長時間完了しなかったため停止しました。利用回数は返却済みです。もう一度生成してください。",
};

/** User-facing failure text. Never echoes raw provider payloads (they can contain signed URLs). */
export function providerFailureMessage(status: string) {
  return PROVIDER_FAILURE_MESSAGES[status] ?? PROVIDER_FAILURE_MESSAGES.failed;
}

/** Short, secret-free summary of a provider payload for logs and job rows. */
export function summarizeProviderPayload(payload: Record<string, unknown>) {
  const detail = payload.error ?? payload.detail ?? payload.message ?? payload.status;
  const text = typeof detail === "string" ? detail : JSON.stringify(detail ?? null);
  return text.replace(/https?:\/\/\S+/g, "[url]").slice(0, 300);
}
