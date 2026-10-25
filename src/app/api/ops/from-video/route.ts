import { NextResponse } from "next/server";
import { getAdminSupabase } from "@/lib/billing";
import { enqueueCompletedVideo } from "@/lib/social/from-video";
import { isMissingRelation, requireUser } from "@/lib/social/http";
import { pollQueuedTikTok, publishQueuedTikTok } from "@/lib/social/dispatch";
import { redactError } from "@/lib/social/queue";
import { processDueJobs } from "@/lib/social/worker";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(request: Request) {
  const { user, error } = await requireUser(request);
  if (!user) return error;
  const body = await request.json().catch(() => null) as { productionJobId?: unknown; caption?: unknown } | null;
  const productionJobId = typeof body?.productionJobId === "string" ? body.productionJobId.trim() : "";
  const caption = typeof body?.caption === "string" ? body.caption.trim() : "";
  if (!productionJobId || !caption) return NextResponse.json({ error: "完成動画と投稿文が必要です。" }, { status: 400 });

  const db = getAdminSupabase();
  const asset = await db.from("video_assets")
    .select("storage_bucket,storage_path,duration,metadata")
    .eq("production_job_id", productionJobId)
    .eq("user_id", user.id)
    .maybeSingle();
  if (asset.error) return NextResponse.json({ error: "完成動画の確認に失敗しました。" }, { status: 500 });
  if (!asset.data?.storage_path || !asset.data.storage_bucket) {
    return NextResponse.json({ error: "完成動画がまだ保存されていません。生成の完了後に投稿できます。" }, { status: 404 });
  }
  const consent = await db.from("tiktok_publish_consents").select("consented_at").eq("user_id", user.id).maybeSingle();
  if (consent.error) return NextResponse.json({ error: "公開同意の確認に失敗しました。" }, { status: 500 });
  const bytes = asset.data.metadata && typeof asset.data.metadata === "object" ? Number((asset.data.metadata as { bytes?: unknown }).bytes) : null;

  let queued;
  try {
    queued = await enqueueCompletedVideo(db, {
      userId: user.id,
      productionJobId,
      storageBucket: asset.data.storage_bucket,
      storagePath: asset.data.storage_path,
      caption,
      durationSeconds: typeof asset.data.duration === "number" ? asset.data.duration : null,
      byteSize: Number.isFinite(bytes) ? bytes : null,
      consented: Boolean(consent.data),
    });
  } catch (enqueueError) {
    if (isMissingRelation(enqueueError as { code?: string })) {
      return NextResponse.json({ error: "投稿キューのマイグレーションが未適用です。", code: "MIGRATION_REQUIRED" }, { status: 503 });
    }
    return NextResponse.json({ error: "投稿キューへの登録に失敗しました。" }, { status: 500 });
  }
  if (!queued.ok) return NextResponse.json({ error: queued.error, code: queued.code }, { status: queued.code === "CONSENT_REQUIRED" ? 403 : 400 });

  if (!queued.existing && queued.job && queued.job.status === "queued") {
    try {
      await processDueJobs(db, {
        onlyJobId: String(queued.job.id),
        limit: 1,
        publish: publishQueuedTikTok,
        poll: async (job) => pollQueuedTikTok(job.user_id, String(job.external_post_id || "")),
      });
    } catch (dispatchError) {
      console.error("from-video dispatch failed", redactError(dispatchError instanceof Error ? dispatchError.message : "dispatch"));
    }
  }
  const fresh = await db.from("post_jobs")
    .select("id,status,external_post_id,post_url,last_error,publish_accepted_at")
    .eq("id", queued.job.id)
    .eq("user_id", user.id)
    .maybeSingle();
  return NextResponse.json({ ok: true, existing: queued.existing, job: fresh.data ?? queued.job });
}
