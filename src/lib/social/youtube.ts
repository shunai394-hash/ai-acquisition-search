import { readFile } from "node:fs/promises";

const API = "https://www.googleapis.com/youtube/v3";
const UPLOAD_API = "https://www.googleapis.com/upload/youtube/v3/videos";

function getAccessToken() {
  const token = process.env.YOUTUBE_ACCESS_TOKEN;
  if (!token) {
    throw new Error("YOUTUBE_ACCESS_TOKEN が設定されていません。YouTube OAuth 2.0で認可済みのアクセストークンを設定してください。");
  }
  return token;
}

export type YouTubeUploadInput = {
  filePath: string;
  title: string;
  description?: string;
  tags?: string[];
  categoryId?: string;
  privacyStatus?: "private" | "unlisted" | "public";
  madeForKids?: boolean;
  containsSyntheticMedia?: boolean;
};

export async function uploadYouTubeVideo(input: YouTubeUploadInput) {
  const token = getAccessToken();
  const file = await readFile(input.filePath);

  const metadata = {
    snippet: {
      title: input.title.slice(0, 100),
      description: input.description || "",
      tags: input.tags || [],
      categoryId: input.categoryId || "22",
    },
    status: {
      privacyStatus: input.privacyStatus || "private",
      selfDeclaredMadeForKids: input.madeForKids ?? false,
      containsSyntheticMedia: input.containsSyntheticMedia ?? true,
    },
  };

  const init = await fetch(`${UPLOAD_API}?uploadType=resumable&part=snippet,status`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json; charset=UTF-8",
      "X-Upload-Content-Type": "video/mp4",
      "X-Upload-Content-Length": String(file.byteLength),
    },
    body: JSON.stringify(metadata),
    signal: AbortSignal.timeout(30_000),
  });

  if (!init.ok) {
    throw new Error(`YouTube upload initialization failed: ${init.status} ${await init.text()}`);
  }

  const uploadUrl = init.headers.get("location");
  if (!uploadUrl) {
    throw new Error("YouTubeからresumable upload URLが返りませんでした。");
  }

  const upload = await fetch(uploadUrl, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "video/mp4",
      "Content-Length": String(file.byteLength),
    },
    body: file,
    signal: AbortSignal.timeout(120_000),
  });

  const payload = await upload.json().catch(() => ({}));
  if (!upload.ok) {
    throw new Error(payload?.error?.message || `YouTube upload failed: ${upload.status}`);
  }

  return {
    videoId: payload.id,
    url: payload.id ? `https://www.youtube.com/watch?v=${payload.id}` : null,
    privacyStatus: payload.status?.privacyStatus,
    processingStatus: payload.processingDetails?.processingStatus || "processing",
  };
}

export async function getYouTubeVideoStatus(videoId: string) {
  const token = getAccessToken();
  const response = await fetch(
    `${API}/videos?part=snippet,status,statistics,processingDetails&id=${encodeURIComponent(videoId)}`,
    {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(15_000),
    },
  );

  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload?.error?.message || `YouTube status failed: ${response.status}`);
  }

  const video = payload.items?.[0];
  if (!video) {
    throw new Error("指定されたYouTube動画が見つかりません。");
  }

  return {
    videoId,
    url: `https://www.youtube.com/watch?v=${videoId}`,
    title: video.snippet?.title,
    privacyStatus: video.status?.privacyStatus,
    uploadStatus: video.status?.uploadStatus,
    processingStatus: video.processingDetails?.processingStatus,
    statistics: video.statistics || {},
  };
}
