import { createClient } from "@supabase/supabase-js";
import { fetchPublicUrl } from "@/lib/security/public-url";

const bucket = "video-assets";
const MAX_VIDEO_BYTES = 200 * 1024 * 1024;

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
  // The URL comes from the provider's response; never let it reach internal hosts.
  const response = await fetchPublicUrl(input.sourceUrl);
  if (!response.ok) {
    throw new Error(`動画取得に失敗しました: HTTP ${response.status}`);
  }

  const contentType = (response.headers.get("content-type") || "video/mp4").split(";", 1)[0].trim().toLowerCase();
  if (!contentType.startsWith("video/") && contentType !== "application/octet-stream") {
    await response.body?.cancel().catch(() => {});
    throw new Error("動画ではないレスポンスは保存できません。");
  }
  const declaredLength = Number(response.headers.get("content-length") || "0");
  if (declaredLength > MAX_VIDEO_BYTES) {
    await response.body?.cancel().catch(() => {});
    throw new Error("動画ファイルが大きすぎます。");
  }
  if (!response.body) throw new Error("動画レスポンスの本文を読み取れません。");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_VIDEO_BYTES) {
        await reader.cancel().catch(() => {});
        throw new Error("動画ファイルが大きすぎます。");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  if (!total) throw new Error("取得した動画ファイルが空です。");
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const arrayBuffer = bytes.buffer;

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
    contentType
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
  assetId: string;
  bytes: Uint8Array;
  contentType?: "audio/wav" | "audio/mpeg";
}) {
  if (!input.bytes.byteLength) throw new Error("音声ファイルが空です。");
  const supabase = adminClient();
  const contentType = input.contentType ?? "audio/wav";
  const path = `${input.userId}/${input.assetId}.wav`;
  const { error } = await supabase.storage.from(bucket).upload(path, input.bytes, {
    contentType,
    upsert: true,
    cacheControl: "3600",
  });
  if (error) throw new Error(`Supabase Storage audio upload failed: ${error.message}`);
  const { data } = supabase.storage.from(bucket).getPublicUrl(path);
  return { bucket, path, url: data.publicUrl, bytes: input.bytes.byteLength, contentType };
}
