const TIKTOK_API_BASE = "https://open.tiktokapis.com/v2";

function getAccessToken() {
  const token = process.env.TIKTOK_ACCESS_TOKEN;
  if (!token) {
    throw new Error("TIKTOK_ACCESS_TOKEN が設定されていません。TikTok Login Kitで認可済みのユーザーアクセストークンを設定してください。");
  }
  return token;
}

export type TikTokPublishInput = {
  videoUrl: string;
  title: string;
  privacyLevel?: "PUBLIC_TO_EVERYONE" | "MUTUAL_FOLLOW_FRIENDS" | "FOLLOWER_OF_CREATOR" | "SELF_ONLY";
  disableComment?: boolean;
  disableDuet?: boolean;
  disableStitch?: boolean;
  isAigc?: boolean;
  brandOrganicToggle?: boolean;
  videoCoverTimestampMs?: number;
};

export async function queryTikTokCreator() {
  const response = await fetch(`${TIKTOK_API_BASE}/post/publish/creator_info/query/`, {
    method: "POST",
    headers: { Authorization: `Bearer ${getAccessToken()}`, "Content-Type": "application/json; charset=UTF-8" },
    body: "{}",
  });
  const payload = await response.json();
  if (!response.ok || payload?.error?.code !== "ok") throw new Error(payload?.error?.message || `TikTok creator query failed: ${response.status}`);
  return payload.data;
}

export async function publishTikTokVideo(input: TikTokPublishInput) {
  if (!input.videoUrl.startsWith("https://")) throw new Error("TikTokのPULL_FROM_URL投稿にはHTTPSの公開動画URLが必要です。");
  const creator = await queryTikTokCreator();
  const privacy = input.privacyLevel || creator.privacy_level_options?.[0] || "SELF_ONLY";
  if (!creator.privacy_level_options?.includes(privacy)) throw new Error(`指定されたprivacyLevelはこのTikTokアカウントでは使用できません: ${privacy}`);
  const response = await fetch(`${TIKTOK_API_BASE}/post/publish/video/init/`, {
    method: "POST",
    headers: { Authorization: `Bearer ${getAccessToken()}`, "Content-Type": "application/json; charset=UTF-8" },
    body: JSON.stringify({
      post_info: {
        title: input.title.slice(0, 2200), privacy_level: privacy,
        disable_comment: input.disableComment ?? false, disable_duet: input.disableDuet ?? false,
        disable_stitch: input.disableStitch ?? false, is_aigc: input.isAigc ?? true,
        brand_organic_toggle: input.brandOrganicToggle ?? false,
        ...(input.videoCoverTimestampMs == null ? {} : { video_cover_timestamp_ms: input.videoCoverTimestampMs }),
      },
      source_info: { source: "PULL_FROM_URL", video_url: input.videoUrl },
    }),
  });
  const payload = await response.json();
  if (!response.ok || payload?.error?.code !== "ok") throw new Error(payload?.error?.message || `TikTok publish failed: ${response.status}`);
  return { publishId: payload.data.publish_id, privacyLevel: privacy, creatorUsername: creator.creator_username };
}

export async function getTikTokPublishStatus(publishId: string) {
  const response = await fetch(`${TIKTOK_API_BASE}/post/publish/status/fetch/`, {
    method: "POST",
    headers: { Authorization: `Bearer ${getAccessToken()}`, "Content-Type": "application/json; charset=UTF-8" },
    body: JSON.stringify({ publish_id: publishId }),
  });
  const payload = await response.json();
  if (!response.ok || payload?.error?.code !== "ok") throw new Error(payload?.error?.message || `TikTok status failed: ${response.status}`);
  return payload.data;
}

export async function getTikTokVideoMetrics(videoId: string) {
  const response = await fetch(
    `${TIKTOK_API_BASE}/video/query/?fields=id,share_url,like_count,comment_count,share_count,view_count,is_aigc`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${getAccessToken()}`, "Content-Type": "application/json; charset=UTF-8" },
      body: JSON.stringify({ filters: { video_ids: [videoId] } }),
    },
  );
  const payload = await response.json();
  if (!response.ok || payload?.error?.code !== "ok") throw new Error(payload?.error?.message || `TikTok video query failed: ${response.status}`);
  const video = payload?.data?.videos?.[0];
  if (!video) throw new Error(`TikTok video not found: ${videoId}`);
  return video;
}

export async function resolveTikTokVideoId(publishId: string, attempts = 8, delayMs = 2500) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const status = await getTikTokPublishStatus(publishId);
    const rawIds = status?.publicaly_available_post_id ?? status?.publicly_available_post_id ?? status?.video_id;
    const videoId = Array.isArray(rawIds) ? rawIds[0] : rawIds;
    if ((typeof videoId === "string" && videoId) || (typeof videoId === "number" && Number.isFinite(videoId))) {
      return { ...status, videoId: String(videoId) };
    }
    const publishStatus = String(status?.status ?? "");
    if (publishStatus === "FAILED" || publishStatus === "PUBLISH_CANCELLED") {
      const error = new Error(`TikTok publish failed: ${publishStatus}: ${String(status?.fail_reason ?? "")}`);
      Object.assign(error, { code: "TIKTOK_PUBLISH_FAILED", publishId, status });
      throw error;
    }
    if (attempt < attempts - 1) await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  const error = new Error(`TikTok publish is still processing: publish_id=${publishId}`);
  Object.assign(error, { code: "TIKTOK_PUBLISH_PENDING", publishId });
  throw error;
}
