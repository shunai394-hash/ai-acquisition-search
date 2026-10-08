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
  const options = Array.isArray(creator.privacy_level_options) ? creator.privacy_level_options : [];
  const privacy = input.privacyLevel || (options.includes("PUBLIC_TO_EVERYONE") ? "PUBLIC_TO_EVERYONE" : options[0] || "SELF_ONLY");
  if (!options.includes(privacy)) throw new Error(`指定されたprivacyLevelはこのTikTokアカウントでは使用できません: ${privacy}`);

  const response = await fetch(`${TIKTOK_API_BASE}/post/publish/video/init/`, {
    method: "POST",
    headers: { Authorization: `Bearer ${getAccessToken()}`, "Content-Type": "application/json; charset=UTF-8" },
    body: JSON.stringify({
      post_info: {
        title: input.title.slice(0, 2200),
        privacy_level: privacy,
        disable_comment: input.disableComment ?? false,
        disable_duet: input.disableDuet ?? false,
        disable_stitch: input.disableStitch ?? false,
        is_aigc: input.isAigc ?? true,
        brand_organic_toggle: input.brandOrganicToggle ?? false,
        ...(input.videoCoverTimestampMs == null ? {} : { video_cover_timestamp_ms: input.videoCoverTimestampMs }),
      },
      source_info: { source: "PULL_FROM_URL", video_url: input.videoUrl },
    }),
  });
  const payload = await response.json();
  if (!response.ok || payload?.error?.code !== "ok") throw new Error(payload?.error?.message || `TikTok publish failed: ${response.status}`);

  const publishId = payload?.data?.publish_id;
  if (typeof publishId !== "string" || !publishId) {
    throw new Error("TikTokからpublish_idが返りませんでした。");
  }

  return {
    publishId,
    privacyLevel: privacy,
    creatorUsername: creator.creator_username,
  };
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
    const availableIds = Array.isArray(status?.publicaly_available_post_id)
      ? status.publicaly_available_post_id
      : Array.isArray(status?.publicly_available_post_id)
        ? status.publicly_available_post_id
        : [];
    const videoId = availableIds.length > 0 ? String(availableIds[0]) : (typeof status?.video_id === "string" ? status.video_id : undefined);

    if (videoId) return { ...status, videoId };

    const publishStatus = String(status?.status ?? "");
    if (publishStatus === "PUBLISH_COMPLETE") {
      // Direct Post can be complete before moderation exposes a public post_id.
      // The publish_id is still the authoritative external reference.
      return { ...status, videoId: undefined, publishId };
    }
    if (publishStatus === "FAILED" || publishStatus === "PUBLISH_CANCELLED") {
      throw new Error(`TikTok publish failed: ${publishStatus}: ${JSON.stringify(status)}`);
    }
    if (attempt < attempts - 1) await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  throw new Error(`TikTok publish status did not reach a terminal state: publish_id=${publishId}`);
}
