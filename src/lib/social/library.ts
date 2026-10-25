import type { SupabaseClient } from "@supabase/supabase-js";

export const LIBRARY_BUCKET = "library-assets";
export const LIBRARY_VIDEO_MAX_BYTES = 100 * 1024 * 1024;
export const LIBRARY_IMAGE_MAX_BYTES = 8 * 1024 * 1024;

const VIDEO_MIME = new Set(["video/mp4", "video/quicktime", "video/webm"]);
const IMAGE_MIME = new Set(["image/jpeg", "image/png", "image/webp"]);

export function libraryExtension(mime: string) {
  if (mime === "video/mp4") return "mp4";
  if (mime === "video/quicktime") return "mov";
  if (mime === "video/webm") return "webm";
  if (mime === "image/jpeg") return "jpg";
  if (mime === "image/png") return "png";
  if (mime === "image/webp") return "webp";
  return null;
}

export function libraryConstraints(kind: "video" | "image", mime: string, byteSize: number) {
  if (kind === "video") {
    if (!VIDEO_MIME.has(mime)) return "動画は MP4 / MOV / WebM のみ登録できます。";
    if (byteSize <= 0 || byteSize > LIBRARY_VIDEO_MAX_BYTES) return "動画は1バイト以上、100MB以下にしてください。";
    return null;
  }
  if (!IMAGE_MIME.has(mime)) return "画像は JPG / PNG / WebP のみ登録できます。";
  if (byteSize <= 0 || byteSize > LIBRARY_IMAGE_MAX_BYTES) return "画像は1バイト以上、8MB以下にしてください。";
  return null;
}

type StorageAdmin = Pick<SupabaseClient, "storage">;

export async function ensureLibraryBucket(db: StorageAdmin) {
  const existing = await db.storage.getBucket(LIBRARY_BUCKET);
  if (!existing.error && existing.data) {
    if (existing.data.public) {
      const updated = await db.storage.updateBucket(LIBRARY_BUCKET, { public: false });
      if (updated.error) throw new Error("素材バケットを非公開にできませんでした。");
    }
    return;
  }
  const created = await db.storage.createBucket(LIBRARY_BUCKET, {
    public: false,
    fileSizeLimit: LIBRARY_VIDEO_MAX_BYTES,
  });
  if (created.error && !created.error.message.toLowerCase().includes("already exists")) {
    throw new Error(created.error.message);
  }
}

export async function signLibraryAsset(db: StorageAdmin, path: string, ttlSeconds = 60 * 60) {
  const signed = await db.storage.from(LIBRARY_BUCKET).createSignedUrl(path, ttlSeconds);
  if (signed.error || !signed.data?.signedUrl) {
    throw new Error("素材の署名付きURLを発行できませんでした。");
  }
  return signed.data.signedUrl;
}
