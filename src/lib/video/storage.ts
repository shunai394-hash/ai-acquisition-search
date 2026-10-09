import { createClient } from "@supabase/supabase-js";
import { fetchPublicUrl } from "@/lib/security/public-url";
import { mp4HasAudioTrack } from "@/lib/video/media-probe";

const bucket = "video-assets";

function adminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceRoleKey) {
    throw new Error("Supabase Storage is not configured. Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.");
  }
  return createClient(url, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false }
  });
}

export async function saveVideoToStorage(input: {
  userId: string;
  jobId: string;
  sourceUrl: string;
  extension?: "mp4" | "webm";
}) {
  const response = await fetchPublicUrl(input.sourceUrl, { signal: AbortSignal.timeout(45_000) });
  if (!response.ok) {
    throw new Error(`動画取得に失敗しました: HTTP ${response.status}`);
  }

  const contentType = response.headers.get("content-type") || "video/mp4";
  const maxBytes = 250 * 1024 * 1024;
  const declaredBytes = Number(response.headers.get("content-length") || 0);
  if (declaredBytes > maxBytes) {
    await response.body?.cancel().catch(() => {});
    throw new Error("動画ファイルが大きすぎます（上限250MB）。");
  }
  if (!response.body) throw new Error("動画レスポンスに本文がありません。");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new Error("動画ファイルが大きすぎます（上限250MB）。");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  if (!totalBytes) throw new Error("取得した動画ファイルが空です。");
  const arrayBuffer = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    arrayBuffer.set(chunk, offset);
    offset += chunk.byteLength;
  }

  const ext = input.extension ?? (contentType.includes("webm") ? "webm" : "mp4");
  const path = `${input.userId}/${input.jobId}.${ext}`;
  const supabase = adminClient();

  const { error } = await supabase.storage.from(bucket).upload(path, arrayBuffer, {
    contentType,
    upsert: true,
    cacheControl: "31536000"
  });
  if (error) throw new Error(`Supabase Storage upload failed: ${error.message}`);

  const { data } = supabase.storage.from(bucket).getPublicUrl(path);
  return {
    bucket,
    path,
    url: data.publicUrl,
    bytes: arrayBuffer.byteLength,
    contentType,
    hasAudioTrack: mp4HasAudioTrack(arrayBuffer),
  };
}

export async function deleteVideoFromStorage(path: string) {
  const supabase = adminClient();
  const { error } = await supabase.storage.from(bucket).remove([path]);
  if (error) {
    throw new Error(`Supabase Storage cleanup failed: ${error.message}`);
  }
}

export async function saveAudioToStorage(input: {
  userId: string;
  jobId: string;
  bytes: Uint8Array;
}) {
  const supabase = adminClient();
  const audioBucket = "video-audio";
  const { data: buckets, error: listError } = await supabase.storage.listBuckets();
  if (listError) throw new Error(`Supabase Storage bucket listing failed: ${listError.message}`);

  if (!buckets?.some((item) => item.name === audioBucket)) {
    const created = await supabase.storage.createBucket(audioBucket, {
      public: false,
      fileSizeLimit: 16 * 1024 * 1024,
      allowedMimeTypes: ["audio/wav"],
    });
    if (created.error && !created.error.message.toLowerCase().includes("already exists")) {
      throw new Error(`Supabase audio bucket creation failed: ${created.error.message}`);
    }
  }
  const privacyUpdate = await supabase.storage.updateBucket(audioBucket, {
    public: false,
    fileSizeLimit: 16 * 1024 * 1024,
    allowedMimeTypes: ["audio/wav"],
  });
  if (privacyUpdate.error) throw new Error(`Supabase audio bucket privacy update failed: ${privacyUpdate.error.message}`);

  const path = `${input.userId}/${input.jobId}.wav`;
  const { error: uploadError } = await supabase.storage.from(audioBucket).upload(path, input.bytes, {
    contentType: "audio/wav",
    upsert: true,
    cacheControl: "3600",
  });
  if (uploadError) throw new Error(`Supabase audio upload failed: ${uploadError.message}`);

  const signed = await supabase.storage.from(audioBucket).createSignedUrl(path, 60 * 60);
  if (signed.error || !signed.data?.signedUrl) {
    throw new Error(`Supabase audio signed URL creation failed: ${signed.error?.message || "unknown error"}`);
  }
  return { bucket: audioBucket, path, url: signed.data.signedUrl, bytes: input.bytes.byteLength, contentType: "audio/wav" };
}

