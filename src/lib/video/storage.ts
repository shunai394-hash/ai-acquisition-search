import { createClient } from "@supabase/supabase-js";
import { fetchPublicUrl } from "@/lib/security/public-url";

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
  // The URL comes from the provider's response; never let it reach internal hosts.
  const response = await fetchPublicUrl(input.sourceUrl);
  if (!response.ok) {
    throw new Error(`動画取得に失敗しました: HTTP ${response.status}`);
  }

  const contentType = response.headers.get("content-type") || "video/mp4";
  const arrayBuffer = await response.arrayBuffer();
  if (!arrayBuffer.byteLength) throw new Error("取得した動画ファイルが空です。");

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
