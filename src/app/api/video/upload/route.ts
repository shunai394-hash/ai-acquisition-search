import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { getUserFromBearer } from "@/lib/billing";

export const runtime = "nodejs";

const BUCKET = "video-inputs";
const MAX_BYTES = 8 * 1024 * 1024;

export async function POST(request: Request) {
  try {
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

    const { data: buckets } = await admin.storage.listBuckets();
    if (!buckets?.some((bucket) => bucket.name === BUCKET)) {
      const created = await admin.storage.createBucket(BUCKET, { public: true, fileSizeLimit: MAX_BYTES, allowedMimeTypes: ["image/jpeg", "image/png", "image/webp"] });
      if (created.error && !created.error.message.toLowerCase().includes("already exists")) throw new Error(created.error.message);
    }

    const ext = file.type === "image/png" ? "png" : file.type === "image/webp" ? "webp" : "jpg";
    const path = user.id + "/" + crypto.randomUUID() + "." + ext;
    const buffer = Buffer.from(await file.arrayBuffer());
    const uploaded = await admin.storage.from(BUCKET).upload(path, buffer, { contentType: file.type, upsert: false, cacheControl: "3600" });
    if (uploaded.error) throw new Error(uploaded.error.message);

    const publicUrl = admin.storage.from(BUCKET).getPublicUrl(path).data.publicUrl;
    return NextResponse.json({ ok: true, url: publicUrl });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "画像アップロードに失敗しました。" }, { status: 500 });
  }
}
