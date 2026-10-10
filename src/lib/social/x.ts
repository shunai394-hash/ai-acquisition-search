const API = "https://api.x.com/2";

function getToken() {
  const value = process.env.X_ACCESS_TOKEN;
  if (!value) throw new Error("X_ACCESS_TOKEN が設定されていません。OAuth 2.0 user context token を設定してください。");
  return value;
}

async function request(path: string, init?: RequestInit) {
  const response = await fetch(API + path, {
    ...init,
    headers: { Authorization: `Bearer ${getToken()}`, "Content-Type": "application/json", ...(init?.headers || {}) },
    signal: init?.signal ?? AbortSignal.timeout(30_000),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload?.errors) {
    throw new Error(payload?.detail || payload?.errors?.[0]?.detail || `X API error: ${response.status}`);
  }
  return payload;
}

async function uploadXVideo(video: Uint8Array) {
  const init = await request("/media/upload/initialize", {
    method: "POST",
    body: JSON.stringify({
      media_type: "video/mp4",
      media_category: "tweet_video",
      total_bytes: video.byteLength,
      shared: false,
    }),
  });
  const mediaId = String(init?.data?.id || "");
  if (!mediaId) throw new Error("X media uploadのmedia IDが返りませんでした。");
  const chunkSize = 4 * 1024 * 1024;
  for (let offset = 0, index = 0; offset < video.byteLength; offset += chunkSize, index++) {
    const chunk = video.slice(offset, Math.min(offset + chunkSize, video.byteLength));
    const form = new FormData();
    form.append("media", new Blob([chunk], { type: "video/mp4" }));
    form.append("segment_index", String(index));
    const response = await fetch(`${API}/media/upload/${encodeURIComponent(mediaId)}/append`, {
      method: "POST",
      headers: { Authorization: `Bearer ${getToken()}` },
      body: form,
      signal: AbortSignal.timeout(120_000),
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      throw new Error(payload?.detail || `X media APPEND error: ${response.status}`);
    }
  }

  const finalized = await request(`/media/upload/${encodeURIComponent(mediaId)}/finalize`, { method: "POST" });
  let processing = finalized?.data?.processing_info;
  for (let attempt = 0; processing && processing.state !== "succeeded"; attempt++) {
    if (processing.state === "failed") {
      throw new Error(processing.error?.message || "X video media processing failed");
    }
    if (attempt >= 12) throw new Error("X video media processingがタイムアウトしました。");
    const waitMs = Math.max(1000, Math.min(15000, Number(processing.check_after_secs || 3) * 1000));
    await new Promise(resolve => setTimeout(resolve, waitMs));
    const status = await request(`/media/upload?command=STATUS&media_id=${encodeURIComponent(mediaId)}`);
    processing = status?.data?.processing_info;
    if (!processing || processing.state === "succeeded") break;
  }
  return mediaId;
}

export async function publishXPost(input: { text: string; video?: Uint8Array }) {
  const text = input.text.trim();
  if (!text) throw new Error("X投稿本文が空です。");
  if (text.length > 280) throw new Error("X投稿本文は280文字以内にしてください。");
  const mediaId = input.video ? await uploadXVideo(input.video) : null;
  const result = await request("/tweets", {
    method: "POST",
    body: JSON.stringify({
      text,
      ...(mediaId ? { media: { media_ids: [mediaId] } } : {}),
    }),
  });
  const id = result?.data?.id;
  if (!id) throw new Error("X投稿IDが返りませんでした。");
  return { platform: "x", postId: id, mediaId, url: `https://x.com/i/web/status/${id}`, status: "published" as const };
}

export async function getXPostMetrics(postId: string) {
  const result = await request(`/tweets/${encodeURIComponent(postId)}?tweet.fields=created_at,public_metrics,organic_metrics`);
  const data = result?.data;
  if (!data?.id) throw new Error("X投稿が見つかりませんでした。");
  return { platform: "x", postId: data.id, text: data.text, createdAt: data.created_at ?? null, publicMetrics: data.public_metrics ?? null, organicMetrics: data.organic_metrics ?? null };
}
