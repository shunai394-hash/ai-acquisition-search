import { NextResponse } from "next/server";
import { getAdminSupabase } from "@/lib/billing";
import { getTikTokAccessToken, getTikTokVideoMetrics } from "@/lib/social/tiktok";
import { isMissingRelation, requireUser } from "@/lib/social/http";
import { performanceSuggestions, redactError, type SuggestionInput } from "@/lib/social/queue";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

function isPublicVideoId(value: string | null) {
  return Boolean(value && /^\d+$/.test(value));
}

export async function GET(request: Request) {
  const { user, error } = await requireUser(request);
  if (!user) return error;
  const refresh = new URL(request.url).searchParams.get("refresh") === "1";
  const db = getAdminSupabase();
  const jobs = await db.from("post_jobs")
    .select("id,network,caption,status,external_post_id,post_url,last_error,publish_accepted_at,metadata,scheduled_at")
    .eq("user_id", user.id)
    .in("status", ["published", "failed", "pending", "needs_reauth"])
    .order("updated_at", { ascending: false })
    .limit(50);
  if (isMissingRelation(jobs.error)) return NextResponse.json({ migrationRequired: true, posts: [], suggestions: [] });
  if (jobs.error) return NextResponse.json({ error: "分析データの取得に失敗しました。" }, { status: 500 });

  const account = await db.from("tiktok_accounts").select("scope").eq("user_id", user.id).maybeSingle();
  const scopes = String(account.data?.scope || "").split(/[,\s]+/).filter(Boolean);
  const canReadMetrics = scopes.includes("video.list");
  let token: string | null = null;
  if (refresh && canReadMetrics) {
    try {
      token = await getTikTokAccessToken(user.id);
    } catch (tokenError) {
      token = null;
      console.error("tiktok metrics token unavailable", redactError(tokenError instanceof Error ? tokenError.message : "token"));
    }
  }

  const posts: SuggestionInput[] = [];
  const rows = [];
  let refreshed = 0;
  for (const job of jobs.data || []) {
    const stored = job.metadata && typeof job.metadata === "object" ? (job.metadata as { metrics?: { views?: number; likes?: number; comments?: number; shares?: number; fetchedAt?: string } }).metrics : undefined;
    let metricsStatus: SuggestionInput["metricsStatus"] = stored ? "available" : "not_fetched";
    let views = typeof stored?.views === "number" ? stored.views : null;
    let likes = typeof stored?.likes === "number" ? stored.likes : null;
    let comments = typeof stored?.comments === "number" ? stored.comments : null;
    let shares = typeof stored?.shares === "number" ? stored.shares : null;
    let metricsError: string | null = null;

    if (job.network !== "tiktok" || job.status !== "published") {
      metricsStatus = "unavailable";
      metricsError = job.status === "published" ? "このSNSの実績取得はキューに未接続です。" : "投稿が公開完了していないため実績はありません。";
      views = null;
      likes = null;
      comments = null;
      shares = null;
    } else if (!canReadMetrics) {
      metricsStatus = "scope_missing";
      metricsError = "video.list 権限がないため再生数を取得できません。TikTokアプリで権限を追加し、アカウントを接続し直してください。";
      views = null;
      likes = null;
    } else if (!isPublicVideoId(job.external_post_id)) {
      metricsStatus = "unavailable";
      metricsError = "公開動画IDが未発行です。非公開投稿や処理中は再生数を取得できません。";
      views = null;
      likes = null;
    } else if (refresh && token && refreshed < 3) {
      refreshed += 1;
      try {
        const video = await getTikTokVideoMetrics(String(job.external_post_id), token);
        views = typeof video.view_count === "number" ? video.view_count : null;
        likes = typeof video.like_count === "number" ? video.like_count : null;
        comments = typeof video.comment_count === "number" ? video.comment_count : null;
        shares = typeof video.share_count === "number" ? video.share_count : null;
        metricsStatus = views == null && likes == null ? "unavailable" : "available";
        if (metricsStatus === "available") {
          const metrics = { views, likes, comments, shares, fetchedAt: new Date().toISOString() };
          await db.from("post_jobs").update({
            metadata: { ...(job.metadata || {}), metrics },
            updated_at: new Date().toISOString(),
          }).eq("id", job.id).eq("user_id", user.id);
        }
      } catch (metricError) {
        metricsStatus = "unavailable";
        metricsError = redactError(metricError instanceof Error ? metricError.message : "実績を取得できませんでした。");
        views = null;
        likes = null;
      }
    }

    const item = {
      caption: job.caption,
      publishedAt: job.scheduled_at,
      views,
      likes,
      metricsStatus,
    };
    posts.push(item);
    rows.push({
      id: job.id,
      network: job.network,
      caption: job.caption,
      status: job.status,
      postUrl: job.post_url,
      externalPostId: job.external_post_id,
      lastError: job.last_error,
      scheduledAt: job.scheduled_at,
      views,
      likes,
      comments,
      shares,
      metricsStatus,
      metricsError,
    });
  }

  return NextResponse.json({
    posts: rows,
    suggestions: performanceSuggestions(posts, "Asia/Tokyo"),
    metricsScope: canReadMetrics ? "video.list" : "missing",
  });
}
