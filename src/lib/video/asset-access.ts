import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Access to generated videos in the `video-assets` bucket.
 *
 * Every reader gets a short-lived signed URL built from `storage_path`, never
 * the stored public URL. Signed URLs also work while the bucket is still
 * public, so this code can ship first and the bucket can then be switched to
 * private without breaking playback or SNS publishing.
 */
export const VIDEO_BUCKET = "video-assets";

/** In-app playback / download links. */
export const PLAYBACK_URL_TTL_SECONDS = 60 * 60;
/**
 * Links handed to TikTok PULL_FROM_URL / Instagram / Facebook, which fetch the
 * file asynchronously after the publish call returns.
 */
export const SNS_INGEST_URL_TTL_SECONDS = 6 * 60 * 60;

/** A bucket lookup must succeed and explicitly report public=false. */
export function isVideoBucketPrivate(check: { ok: boolean; public?: boolean }) {
  return check.ok && check.public === false;
}

// Minimal surface so tests can pass a stub instead of a full client.
type StorageClient = Pick<SupabaseClient, "storage">;

export function isOwnedVideoPath(userId: string, path: unknown): path is string {
  return typeof path === "string"
    && path.startsWith(userId + "/")
    && !path.split("/").some((part) => !part || part === "." || part === "..");
}

export async function signVideoAsset(
  db: StorageClient,
  path: string,
  options: { ttlSeconds?: number; download?: string } = {},
) {
  const { data, error } = await db.storage.from(VIDEO_BUCKET).createSignedUrl(
    path,
    options.ttlSeconds ?? PLAYBACK_URL_TTL_SECONDS,
    options.download ? { download: options.download } : undefined,
  );
  if (error || !data?.signedUrl) {
    throw new Error("動画の署名付きURLを発行できませんでした: " + (error?.message || "unknown error"));
  }
  return data.signedUrl;
}

/**
 * Extract the object path when `url` points at this project's video-assets
 * bucket (public or signed form). Returns null for any other URL.
 */
export function videoAssetPathFromUrl(url: string, supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL) {
  if (!supabaseUrl) return null;
  let parsed: URL;
  let base: URL;
  try {
    parsed = new URL(url);
    base = new URL(supabaseUrl);
  } catch {
    return null;
  }
  if (parsed.host !== base.host) return null;
  const match = /^\/storage\/v1\/object\/(?:public|sign|authenticated)\/video-assets\/(.+)$/.exec(parsed.pathname);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
}

type AssetRow = { video_url?: unknown; storage_path?: unknown; [key: string]: unknown };

// Expose only the audio-track probe from metadata (it also holds the provider request id).
function publicAsset<T extends AssetRow>(asset: T) {
  const { metadata, ...rest } = asset;
  const meta = metadata && typeof metadata === "object" ? metadata as Record<string, unknown> : {};
  return { ...rest, has_audio_track: typeof meta.has_audio_track === "boolean" ? meta.has_audio_track : null };
}

/**
 * Replace the stored URL with fresh signed playback/download URLs. Rows whose
 * path does not belong to the user are not signed (defense in depth on top of
 * the user_id filter that loaded the row).
 */
export async function withSignedVideoUrls<T extends AssetRow>(db: StorageClient, userId: string, asset: T | null) {
  if (!asset) return null;
  if (!isOwnedVideoPath(userId, asset.storage_path)) {
    return { ...publicAsset(asset), video_url: null, download_url: null, url_expires_in: null };
  }
  const [videoUrl, downloadUrl] = await Promise.all([
    signVideoAsset(db, asset.storage_path),
    signVideoAsset(db, asset.storage_path, { download: "ai-acquisition-video.mp4" }),
  ]);
  return { ...publicAsset(asset), video_url: videoUrl, download_url: downloadUrl, url_expires_in: PLAYBACK_URL_TTL_SECONDS };
}
