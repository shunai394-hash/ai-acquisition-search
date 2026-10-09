import crypto from "node:crypto";
import { getAdminSupabase } from "@/lib/billing";

const TIKTOK_API_BASE = "https://open.tiktokapis.com/v2";

function encryptionKey() {
  const value = process.env.TIKTOK_TOKEN_ENCRYPTION_KEY;
  if (!value) throw new Error("TIKTOK_TOKEN_ENCRYPTION_KEY が設定されていません。");
  return crypto.createHash("sha256").update(value).digest();
}

export function encryptTikTokToken(token: string) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv, tag, encrypted].map((part) => part.toString("base64url")).join(".");
}

export function decryptTikTokToken(value: string) {
  const [ivRaw, tagRaw, encryptedRaw] = value.split(".");
  if (!ivRaw || !tagRaw || !encryptedRaw) throw new Error("Invalid TikTok token");
  const decipher = crypto.createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(ivRaw, "base64url"));
  decipher.setAuthTag(Buffer.from(tagRaw, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(encryptedRaw, "base64url")), decipher.final()]).toString("utf8");
}

function oauthRequired(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(name + " が設定されていません。");
  return value;
}

export function getTikTokRedirectUri() {
  return oauthRequired("TIKTOK_REDIRECT_URI");
}

export function createTikTokState(userId: string) {
  const payload = Buffer.from(JSON.stringify({ userId, nonce: crypto.randomBytes(24).toString("base64url"), issuedAt: Date.now() })).toString("base64url");
  const signature = crypto.createHmac("sha256", encryptionKey()).update(payload).digest("base64url");
  return payload + "." + signature;
}

export function verifyTikTokState(state: string) {
  const [payload, signature] = state.split(".");
  if (!payload || !signature) return false;
  const expected = crypto.createHmac("sha256", encryptionKey()).update(payload).digest("base64url");
  if (signature.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return false;
  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { issuedAt?: number };
    return typeof parsed.issuedAt === "number" && Date.now() - parsed.issuedAt < 10 * 60_000;
  } catch {
    return false;
  }
}

export function getTikTokStateUserId(state: string) {
  const [payload] = state.split(".");
  if (!payload) return null;
  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { userId?: string };
    return typeof parsed.userId === "string" ? parsed.userId : null;
  } catch {
    return null;
  }
}

export function tiktokAuthUrl(state: string) {
  const query = new URLSearchParams({
    client_key: oauthRequired("TIKTOK_CLIENT_KEY"),
    response_type: "code",
    scope: "user.info.basic,video.publish",
    redirect_uri: getTikTokRedirectUri(),
    state,
  });
  return "https://www.tiktok.com/v2/auth/authorize/?" + query.toString();
}

export async function exchangeTikTokCode(code: string) {
  const body = new URLSearchParams({
    client_key: oauthRequired("TIKTOK_CLIENT_KEY"),
    client_secret: oauthRequired("TIKTOK_CLIENT_SECRET"),
    code,
    grant_type: "authorization_code",
    redirect_uri: getTikTokRedirectUri(),
  });
  const response = await fetch("https://open.tiktokapis.com/v2/oauth/token/", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "Cache-Control": "no-cache" },
    body,
    cache: "no-store",
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.access_token || !data.refresh_token) throw new Error(data.error_description || data.error || "TikTok OAuth token exchange failed");
  return data as { access_token: string; refresh_token: string; expires_in?: number; refresh_expires_in?: number; open_id?: string; scope?: string };
}

export async function saveTikTokAccount(userId: string, token: Awaited<ReturnType<typeof exchangeTikTokCode>>) {
  const response = await fetch(`${TIKTOK_API_BASE}/user/info/?fields=open_id,display_name,avatar_url`, {
    headers: { Authorization: "Bearer " + token.access_token },
    cache: "no-store",
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload?.error?.code !== "ok") throw new Error(payload?.error?.message || "TikTok user info failed");
  const user = payload.data?.user || {};
  const supabase = getAdminSupabase();
  const { error } = await supabase.from("tiktok_accounts").upsert({
    user_id: userId,
    open_id: user.open_id || token.open_id || null,
    display_name: user.display_name || null,
    avatar_url: user.avatar_url || null,
    access_token_encrypted: encryptTikTokToken(token.access_token),
    refresh_token_encrypted: encryptTikTokToken(token.refresh_token),
    access_token_expires_at: token.expires_in ? new Date(Date.now() + Number(token.expires_in) * 1000).toISOString() : null,
    refresh_token_expires_at: token.refresh_expires_in ? new Date(Date.now() + Number(token.refresh_expires_in) * 1000).toISOString() : null,
    scope: token.scope || null,
    updated_at: new Date().toISOString(),
  }, { onConflict: "user_id" });
  if (error) throw new Error(error.message);
  return user;
}

export async function getTikTokAccessToken(userId: string) {
  const supabase = getAdminSupabase();
  const { data: account, error } = await supabase.from("tiktok_accounts")
    .select("access_token_encrypted,refresh_token_encrypted,access_token_expires_at,scope")
    .eq("user_id", userId).maybeSingle();
  if (error) throw new Error(error.message);
  if (!account) throw new Error("TikTokアカウントを先に接続してください。");
  const expiresAt = account.access_token_expires_at ? new Date(account.access_token_expires_at).getTime() : 0;
  if (expiresAt > Date.now() + 10 * 60_000) return decryptTikTokToken(account.access_token_encrypted);

  const body = new URLSearchParams({
    client_key: oauthRequired("TIKTOK_CLIENT_KEY"),
    client_secret: oauthRequired("TIKTOK_CLIENT_SECRET"),
    grant_type: "refresh_token",
    refresh_token: decryptTikTokToken(account.refresh_token_encrypted),
  });
  const response = await fetch("https://open.tiktokapis.com/v2/oauth/token/", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "Cache-Control": "no-cache" },
    body,
    cache: "no-store",
  });
  const refreshed = await response.json().catch(() => ({}));
  if (!response.ok || !refreshed.access_token || !refreshed.refresh_token) throw new Error(refreshed.error_description || refreshed.error || "TikTok token refresh failed");

  const { error: updateError } = await supabase.from("tiktok_accounts").update({
    access_token_encrypted: encryptTikTokToken(refreshed.access_token),
    refresh_token_encrypted: encryptTikTokToken(refreshed.refresh_token),
    access_token_expires_at: refreshed.expires_in ? new Date(Date.now() + Number(refreshed.expires_in) * 1000).toISOString() : null,
    refresh_token_expires_at: refreshed.refresh_expires_in ? new Date(Date.now() + Number(refreshed.refresh_expires_in) * 1000).toISOString() : null,
    scope: refreshed.scope || account.scope,
    updated_at: new Date().toISOString(),
  }).eq("user_id", userId);
  if (updateError) throw new Error(updateError.message);
  return refreshed.access_token as string;
}

function getAccessToken() {
  const token = process.env.TIKTOK_ACCESS_TOKEN;
  if (!token) {
    throw new Error("TIKTOK_ACCESS_TOKEN が設定されていません。TikTok Login Kitで認可済みのユーザーアクセストークンを設定してください。");
  }
  return token;
}

export type TikTokPublishInput = {
  accessToken?: string;
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

const TIKTOK_PRIVACY_LEVELS = ["PUBLIC_TO_EVERYONE", "MUTUAL_FOLLOW_FRIENDS", "FOLLOWER_OF_CREATOR", "SELF_ONLY"] as const;

export function configuredTikTokPrivacyLevel(): NonNullable<TikTokPublishInput["privacyLevel"]> {
  const value = String(process.env.TIKTOK_PRIVACY_LEVEL || "SELF_ONLY").trim().toUpperCase();
  return (TIKTOK_PRIVACY_LEVELS as readonly string[]).includes(value)
    ? value as NonNullable<TikTokPublishInput["privacyLevel"]>
    : "SELF_ONLY";
}

export async function queryTikTokCreator(accessToken = getAccessToken()) {
  const response = await fetch(`${TIKTOK_API_BASE}/post/publish/creator_info/query/`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json; charset=UTF-8" },
    body: "{}",
    signal: AbortSignal.timeout(15_000),
  });
  const payload = await response.json();
  if (!response.ok || payload?.error?.code !== "ok") throw new Error(payload?.error?.message || `TikTok creator query failed: ${response.status}`);
  return payload.data;
}

const MAX_TIKTOK_UPLOAD_BYTES = 100 * 1024 * 1024;
const TIKTOK_CHUNK_BYTES = 10 * 1024 * 1024;

async function readVideoForTikTok(videoUrl: string) {
  const response = await fetch(videoUrl, {
    cache: "no-store",
    redirect: "error",
    signal: AbortSignal.timeout(25_000),
  });
  if (!response.ok) throw new Error(`TikTok fallback could not download the video (HTTP ${response.status}).`);

  const rawType = (response.headers.get("content-type") || "video/mp4").split(";")[0].trim().toLowerCase();
  const contentType = rawType === "application/octet-stream" ? "video/mp4" : rawType;
  if (!["video/mp4", "video/quicktime", "video/webm"].includes(contentType)) {
    throw new Error("TikTok file upload supports MP4, MOV, or WebM video only.");
  }

  const declaredSize = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredSize) && declaredSize > MAX_TIKTOK_UPLOAD_BYTES) {
    throw new Error("The video exceeds the 100 MB TikTok upload safety limit.");
  }

  const reader = response.body?.getReader();
  if (!reader) {
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.byteLength > MAX_TIKTOK_UPLOAD_BYTES) throw new Error("The video exceeds the 100 MB TikTok upload safety limit.");
    if (!bytes.byteLength) throw new Error("The video file is empty.");
    return { bytes, contentType };
  }

  const chunks: Buffer[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_TIKTOK_UPLOAD_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new Error("The video exceeds the 100 MB TikTok upload safety limit.");
    }
    chunks.push(Buffer.from(value));
  }
  if (!total) throw new Error("The video file is empty.");
  return { bytes: Buffer.concat(chunks, total), contentType };
}

async function uploadTikTokVideoFile(
  input: TikTokPublishInput,
  accessToken: string,
  postInfo: Record<string, unknown>,
) {
  const { bytes, contentType } = await readVideoForTikTok(input.videoUrl);
  const chunkSize = Math.min(TIKTOK_CHUNK_BYTES, bytes.byteLength);
  const totalChunkCount = Math.ceil(bytes.byteLength / chunkSize);
  const initResponse = await fetch(`${TIKTOK_API_BASE}/post/publish/video/init/`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json; charset=UTF-8" },
    body: JSON.stringify({
      post_info: postInfo,
      source_info: {
        source: "FILE_UPLOAD",
        video_size: bytes.byteLength,
        chunk_size: chunkSize,
        total_chunk_count: totalChunkCount,
      },
    }),
    signal: AbortSignal.timeout(15_000),
  });
  const initPayload = await initResponse.json().catch(() => ({}));
  if (!initResponse.ok || initPayload?.error?.code !== "ok") {
    throw new Error(initPayload?.error?.message || `TikTok file upload initialization failed: ${initResponse.status}`);
  }

  const publishId = initPayload?.data?.publish_id;
  const uploadUrlValue = initPayload?.data?.upload_url;
  if (typeof publishId !== "string" || !publishId || typeof uploadUrlValue !== "string") {
    throw new Error("TikTok did not return a publish ID and upload URL for FILE_UPLOAD.");
  }
  let uploadUrl: URL;
  try {
    uploadUrl = new URL(uploadUrlValue);
  } catch {
    throw new Error("TikTok returned an invalid file upload URL.");
  }
  if (uploadUrl.protocol !== "https:" || uploadUrl.hostname !== "open-upload.tiktokapis.com") {
    throw new Error("TikTok returned an unexpected file upload host.");
  }

  for (let offset = 0; offset < bytes.byteLength; offset += chunkSize) {
    const chunk = bytes.subarray(offset, Math.min(offset + chunkSize, bytes.byteLength));
    const lastByte = offset + chunk.byteLength - 1;
    const uploadResponse = await fetch(uploadUrl, {
      method: "PUT",
      headers: {
        "Content-Type": contentType,
        "Content-Length": String(chunk.byteLength),
        "Content-Range": `bytes ${offset}-${lastByte}/${bytes.byteLength}`,
      },
      body: chunk,
      redirect: "error",
      signal: AbortSignal.timeout(25_000),
    });
    if (!uploadResponse.ok) {
      throw new Error(`TikTok rejected a video upload chunk (HTTP ${uploadResponse.status}).`);
    }
  }

  return {
    publishId,
    privacyLevel: input.privacyLevel || configuredTikTokPrivacyLevel(),
  };
}

export async function publishTikTokVideo(input: TikTokPublishInput) {
  if (!input.videoUrl.startsWith("https://")) throw new Error("TikTok投稿にはHTTPSの動画URLが必要です。");
  const accessToken = input.accessToken || getAccessToken();
  const creator = await queryTikTokCreator(accessToken);
  const options = Array.isArray(creator.privacy_level_options) ? creator.privacy_level_options : [];
  // Never silently pick PUBLIC: unaudited TikTok apps may only post SELF_ONLY,
  // and TikTok's Direct Post guidelines require the visibility to be chosen
  // explicitly. Public posting needs an audited app and TIKTOK_PRIVACY_LEVEL.
  const privacy = input.privacyLevel || configuredTikTokPrivacyLevel();
  if (!options.includes(privacy)) throw new Error(`指定されたprivacyLevelはこのTikTokアカウントでは使用できません: ${privacy}`);

  const postInfo = {
    title: input.title.slice(0, 2200),
    privacy_level: privacy,
    disable_comment: input.disableComment ?? false,
    disable_duet: input.disableDuet ?? false,
    disable_stitch: input.disableStitch ?? false,
    is_aigc: input.isAigc ?? true,
    brand_organic_toggle: input.brandOrganicToggle ?? false,
    ...(input.videoCoverTimestampMs == null ? {} : { video_cover_timestamp_ms: input.videoCoverTimestampMs }),
  };

  const response = await fetch(`${TIKTOK_API_BASE}/post/publish/video/init/`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json; charset=UTF-8" },
    body: JSON.stringify({
      post_info: postInfo,
      source_info: { source: "PULL_FROM_URL", video_url: input.videoUrl },
    }),
    signal: AbortSignal.timeout(15_000),
  });
  const payload = await response.json().catch(() => ({}));
  if (payload?.error?.code === "url_ownership_unverified") {
    // Supabase signed URLs cannot be used for PULL_FROM_URL unless their URL
    // prefix is verified with TikTok. Fall back to the documented FILE_UPLOAD
    // flow so publishing does not depend on a custom verified media domain.
    const uploaded = await uploadTikTokVideoFile(input, accessToken, postInfo);
    return { ...uploaded, creatorUsername: creator.creator_username };
  }
  if (!response.ok || payload?.error?.code !== "ok") {
    throw new Error(payload?.error?.message || `TikTok publish initialization failed: ${response.status}`);
  }

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

export async function getTikTokPublishStatus(publishId: string, accessToken = getAccessToken()) {
  const response = await fetch(`${TIKTOK_API_BASE}/post/publish/status/fetch/`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json; charset=UTF-8" },
    body: JSON.stringify({ publish_id: publishId }),
    signal: AbortSignal.timeout(15_000),
  });
  const payload = await response.json();
  if (!response.ok || payload?.error?.code !== "ok") throw new Error(payload?.error?.message || `TikTok status failed: ${response.status}`);
  return payload.data;
}

export async function getTikTokVideoMetrics(videoId: string, accessToken = getAccessToken()) {
  const response = await fetch(
    `${TIKTOK_API_BASE}/video/query/?fields=id,share_url,like_count,comment_count,share_count,view_count,is_aigc`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json; charset=UTF-8" },
      body: JSON.stringify({ filters: { video_ids: [videoId] } }),
    },
  );
  const payload = await response.json();
  if (!response.ok || payload?.error?.code !== "ok") throw new Error(payload?.error?.message || `TikTok video query failed: ${response.status}`);
  const video = payload?.data?.videos?.[0];
  if (!video) throw new Error(`TikTok video not found: ${videoId}`);
  return video;
}

export async function resolveTikTokVideoId(publishId: string, accessToken?: string, attempts = 8, delayMs = 2500) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const status = await getTikTokPublishStatus(publishId, accessToken);
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
  return { pending: true, publishId, status: "PROCESSING" };
}
