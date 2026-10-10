const GRAPH = "https://graph.facebook.com/v23.0";

function getToken() {
  const token = process.env.META_ACCESS_TOKEN;
  if (!token) {
    throw new Error("META_ACCESS_TOKEN が設定されていません。Meta OAuthで認可済みのアクセストークンを設定してください。");
  }
  return token;
}

function getInstagramAccountId() {
  const id = process.env.INSTAGRAM_BUSINESS_ACCOUNT_ID;
  if (!id) {
    throw new Error("INSTAGRAM_BUSINESS_ACCOUNT_ID が設定されていません。");
  }
  return id;
}

function getFacebookPageId() {
  const id = process.env.FACEBOOK_PAGE_ID;
  if (!id) {
    throw new Error("FACEBOOK_PAGE_ID が設定されていません。");
  }
  return id;
}

async function graph(path: string, init?: RequestInit) {
  const response = await fetch(`${GRAPH}${path}`, { ...init, signal: init?.signal ?? AbortSignal.timeout(30_000) });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload?.error) {
    throw new Error(payload?.error?.message || `Meta Graph API error: ${response.status}`);
  }
  return payload;
}

export type InstagramReelInput = {
 videoUrl: string;
  caption?: string;
};

export async function publishInstagramReel(input: InstagramReelInput) {
  if (!input.videoUrl.startsWith("https://")) {
    throw new Error("Instagram Reels投稿にはMetaから取得可能なHTTPS動画URLが必要です。");
  }

  const igUserId = getInstagramAccountId();
  const token = getToken();

  const create = await graph(
    `/${igUserId}/media?media_type=REELS&video_url=${encodeURIComponent(input.videoUrl)}&caption=${encodeURIComponent(input.caption || "")}&access_token=${encodeURIComponent(token)}`,
    { method: "POST" },
  );

  const creationId = create.id;
  if (!creationId) throw new Error("InstagramメディアコンテナIDが返りませんでした。");

  let status = "IN_PROGRESS";
  for (let i = 0; i < 20 && status === "IN_PROGRESS"; i++) {
    await new Promise((resolve) => setTimeout(resolve, 3000));
    const check = await graph(`/${creationId}?fields=status_code&access_token=${encodeURIComponent(token)}`);
    status = check.status_code || "UNKNOWN";
  }

  if (status !== "FINISHED") {
    throw new Error(`Instagram動画処理が完了しませんでした: ${status}`);
  }

  const publish = await graph(
    `/${igUserId}/media_publish?creation_id=${encodeURIComponent(creationId)}&access_token=${encodeURIComponent(token)}`,
    { method: "POST" },
  );

  return {
    platform: "instagram",
    mediaId: publish.id,
    creationId,
    status,
  };
}

export async function publishFacebookReel(input: InstagramReelInput) {
  if (!input.videoUrl.startsWith("https://")) {
    throw new Error("Facebook Reels投稿にはHTTPS動画URLが必要です。");
  }

  const pageId = getFacebookPageId();
  const token = getToken();

  const create = await graph(
    `/${pageId}/video_reels?upload_phase=START&access_token=${encodeURIComponent(token)}`,
    { method: "POST" },
  );

  const videoId = create.video_id;
  if (!videoId) throw new Error("Facebook Reelsのvideo_idが返りませんでした。");

  const uploadUrl = create.upload_url;
  if (!uploadUrl) throw new Error("Facebook Reelsのupload_urlが返りませんでした。");

  const transfer = await fetch(uploadUrl, {
    method: "POST",
    headers: {
      Authorization: `OAuth ${token}`,
      file_url: input.videoUrl,
    },
    signal: AbortSignal.timeout(120_000),
  });

  if (!transfer.ok) {
    throw new Error(`Facebook動画転送に失敗しました: ${transfer.status} ${await transfer.text()}`);
  }

  const finish = await graph(
    `/${pageId}/video_reels?video_id=${encodeURIComponent(videoId)}&upload_phase=FINISH&video_state=PUBLISHED&description=${encodeURIComponent(input.caption || "")}&access_token=${encodeURIComponent(token)}`,
    { method: "POST" },
  );

  return {
    platform: "facebook",
    videoId,
    published: finish.success === true,
  };
}


export async function getInstagramReelMetrics(mediaId: string) {
  const token = getToken();
  return graph(
    `/${encodeURIComponent(mediaId)}?fields=id,permalink,like_count,comments_count,timestamp&access_token=${encodeURIComponent(token)}`,
  );
}

export async function getFacebookReelMetrics(videoId: string) {
  const token = getToken();
  return graph(
    `/${encodeURIComponent(videoId)}?fields=id,permalink_url,views,likes.summary(true),comments.summary(true),shares&access_token=${encodeURIComponent(token)}`,
  );
}
