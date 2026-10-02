export type NormalizedPerformance = {
  platform: "x" | "youtube" | "tiktok" | "instagram" | "facebook";
  postId: string;
  url?: string;
  collectedAt: string;
  metrics: {
    views?: number | null;
    impressions?: number | null;
    likes?: number | null;
    comments?: number | null;
    shares?: number | null;
    clicks?: number | null;
    watchTimeSeconds?: number | null;
  };
  raw: unknown;
};

type JsonObject = Record<string, unknown>;

function objectOf(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : {};
}

function numberOf(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function stringOf(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export async function normalizeXPerformance(input: JsonObject): Promise<NormalizedPerformance> {
  const m = objectOf(input.publicMetrics);
  const postId = String(input.postId);

  return {
    platform: "x",
    postId,
    url: `https://x.com/i/web/status/${postId}`,
    collectedAt: new Date().toISOString(),
    metrics: {
      impressions: numberOf(m.impression_count),
      likes: numberOf(m.like_count),
      comments: numberOf(m.reply_count),
      shares: numberOf(m.retweet_count),
      clicks: numberOf(m.url_link_clicks),
    },
    raw: input,
  };
}

export async function normalizeYouTubePerformance(input: JsonObject): Promise<NormalizedPerformance> {
  const s = objectOf(input.statistics);
  const videoId = String(input.videoId);

  return {
    platform: "youtube",
    postId: videoId,
    url: `https://www.youtube.com/watch?v=${videoId}`,
    collectedAt: new Date().toISOString(),
    metrics: {
      views: numberOf(s.viewCount),
      likes: numberOf(s.likeCount),
      comments: numberOf(s.commentCount),
    },
    raw: input,
  };
}

export async function normalizeTikTokPerformance(input: JsonObject): Promise<NormalizedPerformance> {
  return {
    platform: "tiktok",
    postId: String(input.id),
    url: stringOf(input.share_url),
    collectedAt: new Date().toISOString(),
    metrics: {
      views: numberOf(input.view_count),
      likes: numberOf(input.like_count),
      comments: numberOf(input.comment_count),
      shares: numberOf(input.share_count),
    },
    raw: input,
  };
}

export async function normalizeInstagramPerformance(input: JsonObject): Promise<NormalizedPerformance> {
  const m = objectOf(input.metrics ?? input);
  const data = Array.isArray(input.data) ? input.data : [];

  const get = (name: string): number | null => {
    const item = data.find((value): value is JsonObject => {
      const record = objectOf(value);
      return record.name === name;
    });

    const values = item ? item.values : undefined;
    if (Array.isArray(values) && values.length > 0) {
      const last = objectOf(values[values.length - 1]);
      const value = numberOf(last.value);
      if (value !== null) return value;
    }

    return numberOf(m[name]);
  };

  return {
    platform: "instagram",
    postId: String(input.id ?? input.mediaId),
    url: stringOf(input.permalink),
    collectedAt: new Date().toISOString(),
    metrics: {
      views: get("views") ?? get("plays"),
      likes: get("likes"),
      comments: get("comments"),
      shares: get("shares"),
    },
    raw: input,
  };
}

export async function normalizeFacebookPerformance(input: JsonObject): Promise<NormalizedPerformance> {
  const s = objectOf(input.statistics ?? input);
  const reactions = objectOf(s.reactions);
  const reactionSummary = objectOf(reactions.summary);

  return {
    platform: "facebook",
    postId: String(input.id ?? input.videoId),
    url: stringOf(input.permalink_url),
    collectedAt: new Date().toISOString(),
    metrics: {
      views: numberOf(s.views ?? s.total_video_views),
      likes: numberOf(s.likes ?? reactionSummary.total_count),
      comments: numberOf(s.comments ?? s.comments_count),
      shares: numberOf(s.shares ?? s.share_count),
    },
    raw: input,
  };
}
