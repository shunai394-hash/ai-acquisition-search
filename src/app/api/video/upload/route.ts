import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { getUserFromBearer } from "@/lib/billing";

export const runtime = "nodejs";

const BUCKET = "video-inputs";
const MAX_BYTES = 8 * 1024 * 1024;

function matchesImageSignature(bytes: Uint8Array, mime: string) {
  if (mime === "image/jpeg") return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (mime === "image/png") return bytes.length >= 8 && bytes.slice(0, 8).every((value, index) => value === [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a][index]);
  if (mime === "image/webp") return bytes.length >= 12 && new TextDecoder().decode(bytes.slice(0, 4)) === "RIFF" && new TextDecoder().decode(bytes.slice(8, 12)) === "WEBP";
  return false;
}

export async function POST(request: Request) {
  try {
    // Reject oversized multipart bodies before parsing them into memory.
    const declaredLength = Number(request.headers.get("content-length") || 0);
    if (Number.isFinite(declaredLength) && declaredLength > MAX_BYTES + 256 * 1024) {
      return NextResponse.json({ error: "画像アップロードのリクエストが大きすぎます。画像は8MB以下にしてください。" }, { status: 413 });
    }

    const user = await getUserFromBearer(request);
    if (!user) return NextResponse.json({ error: "ログインが必要です。" }, { status: 401 });

    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const serviceRole = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !serviceRole) throw new Error("Supabase configuration is incomplete.");

    const admin = createClient(url, serviceRole, { auth: { autoRefreshToken: false, persistSession: false } });
    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof File)) return NextResponse.json({ error: "画像ファイルが必要です。" }, { status: 400 });
    if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) return NextResponse.json({ error: "JPG / PNG / WebP の画像を指定してください。" }, { status: 400 });
    if (file.size > MAX_BYTES) return NextResponse.json({ error: "画像は8MB以下にしてください。" }, { status: 400 });
    const fileBytes = new Uint8Array(await file.arrayBuffer());
    if (!matchesImageSignature(fileBytes, file.type)) return NextResponse.json({ error: "画像の内容とMIMEタイプが一致しません。" }, { status: 400 });

    const { data: buckets } = await admin.storage.listBuckets();
    if (!buckets?.some((bucket) => bucket.name === BUCKET)) {
      const created = await admin.storage.createBucket(BUCKET, { public: false, fileSizeLimit: MAX_BYTES, allowedMimeTypes: ["image/jpeg", "image/png", "image/webp"] });
      if (created.error && !created.error.message.toLowerCase().includes("already exists")) throw new Error(created.error.message);
    }
    const privacyUpdate = await admin.storage.updateBucket(BUCKET, { public: false, fileSizeLimit: MAX_BYTES, allowedMimeTypes: ["image/jpeg", "image/png", "image/webp"] });
    if (privacyUpdate.error) throw new Error("Image bucket privacy update failed: " + privacyUpdate.error.message);

    const ext = file.type === "image/png" ? "png" : file.type === "image/webp" ? "webp" : "jpg";
    const path = user.id + "/" + crypto.randomUUID() + "." + ext;
    const buffer = Buffer.from(fileBytes);
    const uploaded = await admin.storage.from(BUCKET).upload(path, buffer, { contentType: file.type, upsert: false, cacheControl: "3600" });
    if (uploaded.error) throw new Error(uploaded.error.message);

    const signed = await admin.storage.from(BUCKET).createSignedUrl(path, 60 * 60);
    if (signed.error || !signed.data?.signedUrl) {
      // Avoid orphaned private uploads if the response cannot be used by the client.
      const cleanup = await admin.storage.from(BUCKET).remove([path]);
      if (cleanup.error) console.error("image upload cleanup failed after signed URL error", { userId: user.id, path, error: cleanup.error.message });
      throw new Error(signed.error?.message || "Image signed URL could not be created.");
    }
    return NextResponse.json({ ok: true, url: signed.data.signedUrl, path, bucket: BUCKET });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "画像アップロードに失敗しました。" }, { status: 500 });
  }
}
