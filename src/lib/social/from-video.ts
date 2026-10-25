import { isOwnedVideoPath, VIDEO_BUCKET } from "@/lib/video/asset-access";
import { LIBRARY_BUCKET } from "@/lib/social/library";
import { composeCaption } from "@/lib/social/queue";

type Row = Record<string, unknown>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = { from: (table: string) => any };

export async function enqueueCompletedVideo(db: Db, input: {
  userId: string;
  productionJobId: string;
  storageBucket: string;
  storagePath: string;
  caption: string;
  durationSeconds?: number | null;
  byteSize?: number | null;
  consented: boolean;
}) {
  if (!input.consented) return { ok: false as const, code: "CONSENT_REQUIRED", error: "TikTok自動投稿には公開同意が必要です。" };
  if (input.storageBucket !== VIDEO_BUCKET && input.storageBucket !== LIBRARY_BUCKET) {
    return { ok: false as const, code: "UNSUPPORTED_BUCKET", error: "この動画バケットは投稿キューに渡せません。" };
  }
  if (!isOwnedVideoPath(input.userId, input.storagePath)) {
    return { ok: false as const, code: "NOT_OWNER", error: "この動画を投稿する権限がありません。" };
  }
  if (typeof input.byteSize === "number" && input.byteSize > 100 * 1024 * 1024) {
    return { ok: false as const, code: "TOO_LARGE", error: "TikTokへ送る動画は100MB以下にしてください。動画自体は保存されています。" };
  }
  const caption = composeCaption(input.caption, []).slice(0, 2200);
  if (!caption) return { ok: false as const, code: "CAPTION_REQUIRED", error: "投稿文が必要です。" };
  const idempotencyKey = `video-${input.productionJobId}-tiktok`;
  const existing = await db.from("post_jobs").select("id,status,external_post_id,post_url,last_error").eq("user_id", input.userId).eq("idempotency_key", idempotencyKey).maybeSingle();
  if (existing.error) throw existing.error;
  if (existing.data) return { ok: true as const, existing: true, job: existing.data as Row };

  const asset = await db.from("media_assets").insert({
    user_id: input.userId,
    kind: "video",
    title: caption.slice(0, 80),
    body: caption,
    storage_bucket: input.storageBucket,
    storage_path: input.storagePath,
    mime_type: "video/mp4",
    byte_size: input.byteSize ?? null,
    duration_seconds: input.durationSeconds ?? null,
    ai_generated: true,
    upload_status: "ready",
  }).select("id").single();
  if (asset.error || !asset.data) throw asset.error || new Error("素材の登録に失敗しました。");

  const job = await db.from("post_jobs").insert({
    user_id: input.userId,
    asset_id: asset.data.id,
    network: "tiktok",
    caption,
    hashtags: [],
    privacy_level: "SELF_ONLY",
    purpose: "product",
    mode: "immediate",
    status: "queued",
    scheduled_at: new Date().toISOString(),
    timezone: "Asia/Tokyo",
    priority: 0,
    idempotency_key: idempotencyKey,
    metadata: { origin: "completed_video", production_job_id: input.productionJobId },
  }).select("id,status,external_post_id,post_url,last_error").single();
  if (job.error?.code === "23505") {
    const raced = await db.from("post_jobs").select("id,status,external_post_id,post_url,last_error").eq("user_id", input.userId).eq("idempotency_key", idempotencyKey).maybeSingle();
    return { ok: true as const, existing: true, job: raced.data as Row };
  }
  if (job.error || !job.data) throw job.error || new Error("投稿キューへの登録に失敗しました。");
  await db.from("post_job_events").insert({
    job_id: job.data.id,
    user_id: input.userId,
    event: "queued_from_video",
    detail: { productionJobId: input.productionJobId },
  });
  return { ok: true as const, existing: false, job: job.data as Row };
}
