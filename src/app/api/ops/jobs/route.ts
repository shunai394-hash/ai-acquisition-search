import { NextResponse } from "next/server";
import { getAdminSupabase } from "@/lib/billing";
import { pollQueuedTikTok, publishQueuedTikTok } from "@/lib/social/dispatch";
import { isMissingRelation, requireUser } from "@/lib/social/http";
import {
  captionLimit,
  composeCaption,
  findDuplicate,
  initialStatus,
  isValidTimeZone,
  networkCapability,
  normalizeHashtag,
  redactError,
  zonedLocalToUtc,
  type AssetKind,
  type JobMode,
} from "@/lib/social/queue";
import { processDueJobs } from "@/lib/social/worker";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const MODES = new Set<JobMode>(["immediate", "scheduled", "approval", "autopilot"]);
const PRIVACY = new Set(["PUBLIC_TO_EVERYONE", "MUTUAL_FOLLOW_FRIENDS", "FOLLOWER_OF_CREATOR", "SELF_ONLY"]);

export async function GET(request: Request) {
  const { user, error } = await requireUser(request);
  if (!user) return error;
  const db = getAdminSupabase();
  const jobs = await db.from("post_jobs")
    .select("id,asset_id,network,caption,hashtags,privacy_level,purpose,mode,status,scheduled_at,timezone,priority,attempt_count,next_attempt_at,last_error,external_post_id,post_url,publish_accepted_at,created_at,updated_at,metadata")
    .eq("user_id", user.id)
    .order("scheduled_at", { ascending: true })
    .limit(200);
  if (isMissingRelation(jobs.error)) return NextResponse.json({ migrationRequired: true, jobs: [], events: [] });
  if (jobs.error) return NextResponse.json({ error: "投稿キューの取得に失敗しました。" }, { status: 500 });
  const ids = (jobs.data || []).map((job) => job.id);
  const events = ids.length
    ? await db.from("post_job_events").select("id,job_id,event,detail,created_at").eq("user_id", user.id).in("job_id", ids).order("created_at", { ascending: false }).limit(200)
    : { data: [], error: null };
  return NextResponse.json({
    jobs: (jobs.data || []).map((job) => ({
      ...job,
      metadata: {
        retry_safety: job.metadata && typeof job.metadata === "object" ? (job.metadata as { retry_safety?: string }).retry_safety ?? null : null,
      },
    })),
    events: events.data || [],
  });
}

export async function POST(request: Request) {
  const { user, error } = await requireUser(request);
  if (!user) return error;
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  const assetId = typeof body?.assetId === "string" ? body.assetId : "";
  const network = typeof body?.network === "string" ? body.network : "";
  const caption = typeof body?.caption === "string" ? body.caption.trim() : "";
  const hashtags = Array.isArray(body?.hashtags) ? body.hashtags.filter((tag): tag is string => typeof tag === "string").map(normalizeHashtag).filter(Boolean).slice(0, 8) : [];
  const mode = typeof body?.mode === "string" && MODES.has(body.mode as JobMode) ? body.mode as JobMode : null;
  const timezone = typeof body?.timezone === "string" && isValidTimeZone(body.timezone) ? body.timezone : "Asia/Tokyo";
  const idempotencyKey = typeof body?.idempotencyKey === "string" ? body.idempotencyKey : "";
  const privacyLevel = typeof body?.privacyLevel === "string" && PRIVACY.has(body.privacyLevel) ? body.privacyLevel : "SELF_ONLY";
  const purpose = body?.purpose === "product" || body?.purpose === "awareness" || body?.purpose === "traffic" ? body.purpose : null;
  const priority = typeof body?.priority === "number" && body.priority >= 0 && body.priority <= 100 ? Math.round(body.priority) : 0;
  if (!/^[A-Za-z0-9_-]{8,80}$/.test(idempotencyKey)) {
    return NextResponse.json({ error: "idempotencyKey は8〜80文字の英数字で指定してください。" }, { status: 400 });
  }
  if (!assetId || !mode) return NextResponse.json({ error: "素材と投稿方法を指定してください。" }, { status: 400 });
  const capability = networkCapability(network);
  if (!capability) return NextResponse.json({ error: "未対応の投稿先です。" }, { status: 400 });
  if (!capability.executable) {
    return NextResponse.json({ error: capability.reason, code: "NETWORK_NOT_READY" }, { status: 400 });
  }
  if (!caption) return NextResponse.json({ error: "投稿文が必要です。" }, { status: 400 });

  const db = getAdminSupabase();
  const asset = await db.from("media_assets").select("id,kind,upload_status").eq("id", assetId).eq("user_id", user.id).maybeSingle();
  if (asset.error) return NextResponse.json({ error: "素材の確認に失敗しました。" }, { status: 500 });
  if (!asset.data) return NextResponse.json({ error: "素材が見つかりません。" }, { status: 404 });
  if (asset.data.upload_status !== "ready") return NextResponse.json({ error: "素材のアップロードが完了していません。" }, { status: 400 });
  const kind = asset.data.kind as AssetKind;
  if (!capability.formats.includes(kind)) {
    return NextResponse.json({ error: kind === "text" ? "TikTokの公式APIは本文のみの投稿に対応していません。" : "この素材形式は選択したSNSへ投稿できません。" }, { status: 400 });
  }
  const fullCaption = composeCaption(caption, hashtags);
  if (fullCaption.length > captionLimit(network, kind)) {
    return NextResponse.json({ error: `投稿文が${captionLimit(network, kind)}文字を超えています。` }, { status: 400 });
  }

  const now = new Date();
  let scheduledAt = now;
  if (mode === "scheduled" || typeof body?.scheduledLocal === "string") {
    if (typeof body?.scheduledLocal !== "string") return NextResponse.json({ error: "予約日時を指定してください。" }, { status: 400 });
    const parsed = zonedLocalToUtc(body.scheduledLocal, timezone);
    if (!parsed) return NextResponse.json({ error: "予約日時を解釈できませんでした。" }, { status: 400 });
    if (mode === "scheduled" && parsed.getTime() < now.getTime() - 60_000) {
      return NextResponse.json({ error: "予約日時が過去です。" }, { status: 400 });
    }
    scheduledAt = parsed;
  }

  const recent = await db.from("post_jobs")
    .select("id,asset_id,network,caption,status,scheduled_at")
    .eq("user_id", user.id).eq("network", network)
    .gte("scheduled_at", new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString())
    .limit(100);
  if (recent.error && !isMissingRelation(recent.error)) return NextResponse.json({ error: "重複確認に失敗しました。" }, { status: 500 });
  const duplicate = findDuplicate({
    assetId,
    network,
    caption: fullCaption,
    now,
    recent: (recent.data || []).map((job) => ({
      id: job.id,
      assetId: job.asset_id,
      network: job.network,
      caption: job.caption,
      status: job.status,
      scheduledAt: job.scheduled_at,
    })),
  });
  if (duplicate && body?.allowDuplicate !== true) {
    return NextResponse.json({
      error: "同じ素材または同じ投稿文が24時間以内にあります。重複を許可する場合だけ再送信してください。",
      code: "DUPLICATE",
      existingJobId: duplicate.id ?? null,
    }, { status: 409 });
  }

  const status = initialStatus(mode);
  const inserted = await db.from("post_jobs").insert({
    user_id: user.id,
    asset_id: assetId,
    network,
    caption: fullCaption,
    hashtags,
    privacy_level: privacyLevel,
    purpose,
    mode,
    status,
    scheduled_at: scheduledAt.toISOString(),
    timezone,
    priority,
    idempotency_key: idempotencyKey,
    metadata: { allow_duplicate: body?.allowDuplicate === true },
  }).select("id,status,scheduled_at,network,mode").single();

  if (inserted.error?.code === "23505") {
    const existing = await db.from("post_jobs").select("id,status,scheduled_at,network,mode,external_post_id,post_url,last_error").eq("user_id", user.id).eq("idempotency_key", idempotencyKey).maybeSingle();
    return NextResponse.json({ ok: true, existing: true, job: existing.data });
  }
  if (isMissingRelation(inserted.error)) return NextResponse.json({ error: "投稿キューのマイグレーションが未適用です。" }, { status: 503 });
  if (inserted.error || !inserted.data) return NextResponse.json({ error: "投稿キューへの登録に失敗しました。" }, { status: 500 });

  await db.from("post_job_events").insert({
    job_id: inserted.data.id,
    user_id: user.id,
    event: "queued",
    detail: { mode, status },
  });

  let dispatch: { status?: string; error?: string } | null = null;
  if (status === "queued" && scheduledAt.getTime() <= now.getTime() + 5_000) {
    try {
      const summary = await processDueJobs(db, {
        now,
        onlyJobId: inserted.data.id,
        limit: 1,
        publish: publishQueuedTikTok,
        poll: async (job) => pollQueuedTikTok(job.user_id, String(job.external_post_id || "")),
      });
      dispatch = summary.results[0] ?? null;
    } catch (dispatchError) {
      dispatch = { status: "failed", error: redactError(dispatchError instanceof Error ? dispatchError.message : "投稿処理に失敗しました。") };
    }
  }

  const fresh = await db.from("post_jobs").select("id,status,scheduled_at,network,mode,external_post_id,post_url,last_error,publish_accepted_at").eq("id", inserted.data.id).eq("user_id", user.id).maybeSingle();
  return NextResponse.json({ ok: true, existing: false, job: fresh.data, dispatch });
}
