import { NextResponse } from "next/server";
import { getAdminSupabase, getUserFromBearer } from "@/lib/billing";
import { decryptLinkedInToken, getLinkedInMemberPostAnalytics } from "@/lib/linkedin";
import { getTikTokVideoMetrics, resolveTikTokVideoId } from "@/lib/social/tiktok";
import { getInstagramReelMetrics, getFacebookReelMetrics } from "@/lib/social/meta";
import { getYouTubeVideoStatus } from "@/lib/social/youtube";
import { getXPostMetrics } from "@/lib/social/x";

export const runtime = "nodejs";
export const maxDuration = 60;

type JsonRecord = Record<string, unknown>;

const asRecord = (value: unknown): JsonRecord =>
  value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};

type NormalizedMetrics = {
  impressions: number; views: number; likes: number; comments: number; shares: number;
  saves: number; clicks: number; conversions: number; revenue: number; grossProfit: number; adSpend: number;
};

const num = (v: unknown) => typeof v === "number" && Number.isFinite(v) ? v : Number(v || 0);

function linkedinMetric(raw: unknown): NormalizedMetrics {
  const root = asRecord(raw);
  const elements = Array.isArray(root.elements) ? root.elements : [];
  const first = asRecord(elements[0]);
  const total = asRecord(first.total);
  const metric = Object.keys(total).length > 0 ? total : Object.keys(first).length > 0 ? first : asRecord(root.total);
  return {
    impressions: num(metric.IMPRESSION ?? metric.impression),
    views: 0,
    likes: num(metric.REACTION ?? metric.reaction),
    comments: num(metric.COMMENT ?? metric.comment),
    shares: num(metric.RESHARE ?? metric.reshare),
    saves: num(metric.POST_SAVE ?? metric.postSave),
    clicks: num(metric.LINK_CLICKS ?? metric.linkClicks),
    conversions: 0, revenue: 0, grossProfit: 0, adSpend: 0,
  };
}

function tiktokMetric(raw: unknown): NormalizedMetrics {
  const m = asRecord(raw);
  return {
    impressions: 0,
    views: num(m.view_count),
    likes: num(m.like_count),
    comments: num(m.comment_count),
    shares: num(m.share_count),
    saves: 0,
    clicks: 0,
    conversions: 0, revenue: 0, grossProfit: 0, adSpend: 0,
  };
}

function instagramMetric(raw: unknown): NormalizedMetrics {
  const m = asRecord(raw);
  return {
    impressions: num(m.impressions ?? m.reach),
    views: num(m.views ?? m.plays ?? m.video_views),
    likes: num(m.like_count),
    comments: num(m.comments_count),
    shares: num(m.shares),
    saves: num(m.saved ?? m.saves),
    clicks: 0,
    conversions: 0, revenue: 0, grossProfit: 0, adSpend: 0,
  };
}

function facebookMetric(raw: unknown): NormalizedMetrics {
  const m = asRecord(raw);
  const likesObject = asRecord(m.likes);
  const likesSummary = asRecord(likesObject.summary);
  const commentsObject = asRecord(m.comments);
  const commentsSummary = asRecord(commentsObject.summary);
  const sharesObject = asRecord(m.shares);
  const likes = likesSummary.total_count ?? (Array.isArray(likesObject.data) ? likesObject.data.length : m.like_count);
  const comments = commentsSummary.total_count ?? (Array.isArray(commentsObject.data) ? commentsObject.data.length : m.comment_count);
  const shares = sharesObject.count ?? m.share_count;
  return {
    impressions: 0,
    views: num(raw?.views ?? raw?.view_count),
    likes: num(likes),
    comments: num(comments),
    shares: num(shares),
    saves: 0,
    clicks: 0,
    conversions: 0, revenue: 0, grossProfit: 0, adSpend: 0,
  };
}

function youtubeMetric(raw: unknown): NormalizedMetrics {
  const s = asRecord(asRecord(raw).statistics);
  return {
    impressions: 0,
    views: num(s.viewCount),
    likes: num(s.likeCount),
    comments: num(s.commentCount),
    shares: 0,
    saves: 0,
    clicks: 0,
    conversions: 0, revenue: 0, grossProfit: 0, adSpend: 0,
  };
}

function xMetric(raw: unknown): NormalizedMetrics {
  const root = asRecord(raw);
  const m = asRecord(root.organicMetrics || root.publicMetrics);
  return {
    impressions: num(m.impression_count),
    views: 0,
    likes: num(m.like_count),
    comments: num(m.reply_count),
    shares: num(m.retweet_count ?? m.quote_count),
    saves: num(m.bookmark_count),
    clicks: 0,
    conversions: 0, revenue: 0, grossProfit: 0, adSpend: 0,
  };
}

export async function POST(request: Request) {
  try {
    const user = await getUserFromBearer(request);
    if (!user) return NextResponse.json({ error: "ログインが必要です。" }, { status: 401 });
    const body = await request.json() as { socialPostId?: string };
    if (!body.socialPostId) return NextResponse.json({ error: "socialPostIdが必要です。" }, { status: 400 });

    const db = getAdminSupabase();
    const { data: post, error: postError } = await db.from("social_posts")
      .select("id,user_id,network,external_post_id,creative_id,published_at,metadata")
      .eq("id", body.socialPostId).eq("user_id", user.id).maybeSingle();
    if (postError) throw postError;
    if (!post) return NextResponse.json({ error: "対象投稿が見つかりません。" }, { status: 404 });
    if (!post.external_post_id) return NextResponse.json({ error: "外部投稿IDがまだありません。" }, { status: 400 });

    // 同じ投稿への同時metrics取得を防ぐ。取得処理は外部APIを含むため、
    // claimを10分保持し、二重INSERTを起こさない。
    const claimNow = new Date();
    const claimCutoff = new Date(claimNow.getTime() - 10 * 60 * 1000).toISOString();
    const claimMetadata = {
      ...(post.metadata || {}),
      metrics_refresh_claimed_at: claimNow.toISOString(),
    };
    const { data: claimedPost, error: claimError } = await db.from("social_posts")
      .update({ metadata: claimMetadata, updated_at: claimNow.toISOString() })
      .eq("id", post.id)
      .eq("user_id", user.id)
      .or(
        "metadata->>metrics_refresh_claimed_at.is.null,metadata->>metrics_refresh_claimed_at.lt." + claimCutoff,
      )
      .select("id")
      .maybeSingle();
    if (claimError) throw claimError;
    if (!claimedPost) {
      return NextResponse.json(
        { ok: false, retry: true, error: "同じ投稿の実績取得が現在実行中です。" },
        { status: 409 },
      );
    }

    let normalized: NormalizedMetrics;
    let raw: unknown;

    if (post.network === "linkedin") {
      const { data: account, error } = await db.from("linkedin_accounts")
        .select("access_token_encrypted,expires_at").eq("user_id", user.id).maybeSingle();
      if (error) throw error;
      if (!account) return NextResponse.json({ error: "LinkedInを先に接続してください。" }, { status: 400 });
      if (account.expires_at && new Date(account.expires_at).getTime() <= Date.now()) {
        return NextResponse.json({ error: "LinkedInアクセストークンの有効期限が切れています。再接続してください。" }, { status: 401 });
      }
      raw = await getLinkedInMemberPostAnalytics(
        decryptLinkedInToken(account.access_token_encrypted),
        post.external_post_id,
      );
      normalized = linkedinMetric(raw);
    } else if (post.network === "tiktok") {
      const resolved = await resolveTikTokVideoId(post.external_post_id);
      raw = await getTikTokVideoMetrics(resolved.videoId);
      normalized = tiktokMetric(raw);
    } else if (post.network === "instagram") {
      raw = await getInstagramReelMetrics(post.external_post_id);
      normalized = instagramMetric(raw);
    } else if (post.network === "facebook") {
      raw = await getFacebookReelMetrics(post.external_post_id);
      normalized = facebookMetric(raw);
    } else if (post.network === "youtube") {
      raw = await getYouTubeVideoStatus(post.external_post_id);
      normalized = youtubeMetric(raw);
    } else if (post.network === "x") {
      raw = await getXPostMetrics(post.external_post_id);
      normalized = xMetric(raw);
    } else {
      return NextResponse.json({ ok: false, supported: ["linkedin","tiktok","instagram","facebook","youtube","x"], error: `${post.network} の自動実績取得は未対応です。` }, { status: 501 });
    }

    // CTRは「クリック指標を取得できること」が確認できた媒体だけ計算する。
    // TikTok/Instagram/Facebook/YouTube/Xでは現在クリックを取得していないため、
    // clicks=0 を実測CTR 0% と解釈させない。
    const clickMetricAvailable = post.network === "linkedin"
      ? (() => {
          const metric = Array.isArray((raw as any)?.elements)
            ? ((raw as any)?.elements?.[0]?.total || (raw as any)?.elements?.[0] || {})
            : ((raw as any)?.total || (raw as any) || {});
          return Object.prototype.hasOwnProperty.call(metric, "LINK_CLICKS")
            || Object.prototype.hasOwnProperty.call(metric, "linkClicks");
        })()
      : false;
    const ctr = clickMetricAvailable && normalized.impressions > 0
      ? normalized.clicks / normalized.impressions
      : null;
    const cvr = normalized.clicks > 0 ? normalized.conversions / normalized.clicks : null;
    const { data: metric, error: metricError } = await db.from("post_metrics").insert({
      social_post_id: post.id, ...normalized, ctr, cvr, cpa: null, roas: null,
      raw: { source: post.network, fetched_at: new Date().toISOString(), data: raw },
    }).select("id,measured_at,ctr,cvr,roas").single();
    if (metricError?.code === "23505") {
      const { data: existingMetric, error: existingMetricError } = await db.from("post_metrics")
        .select("id,measured_at,ctr,cvr,roas")
        .eq("social_post_id", post.id)
        .order("measured_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (existingMetricError || !existingMetric) throw existingMetricError || new Error("既存の実績レコードを再取得できませんでした。");
      return NextResponse.json({
        ok: true,
        reused: true,
        socialPostId: post.id,
        network: post.network,
        metric: existingMetric,
        normalized,
      });
    }
    if (metricError) throw metricError;

    return NextResponse.json({ ok: true, socialPostId: post.id, network: post.network, metric, normalized });
  } catch (error) {
    console.error("social metrics refresh error", error);
    return NextResponse.json({ error: error instanceof Error ? error.message : "実績取得に失敗しました。" }, { status: 500 });
  }
}
