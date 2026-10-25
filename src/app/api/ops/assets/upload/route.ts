import { NextResponse } from "next/server";
import { getAdminSupabase } from "@/lib/billing";
import { isMissingRelation, requireUser } from "@/lib/social/http";
import { ensureLibraryBucket, LIBRARY_BUCKET, libraryConstraints, libraryExtension } from "@/lib/social/library";
import { isOwnedVideoPath } from "@/lib/video/asset-access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const { user, error } = await requireUser(request);
  if (!user) return error;
  const body = await request.json().catch(() => null) as {
    action?: unknown;
    kind?: unknown;
    mimeType?: unknown;
    byteSize?: unknown;
    title?: unknown;
    aiGenerated?: unknown;
    assetId?: unknown;
    durationSeconds?: unknown;
  } | null;
  const db = getAdminSupabase();

  if (body?.action === "sign") {
    const kind = body.kind === "image" ? "image" : body.kind === "video" ? "video" : null;
    const mimeType = typeof body.mimeType === "string" ? body.mimeType : "";
    const byteSize = typeof body.byteSize === "number" ? body.byteSize : 0;
    if (!kind) return NextResponse.json({ error: "動画または画像を指定してください。" }, { status: 400 });
    const invalid = libraryConstraints(kind, mimeType, byteSize);
    if (invalid) return NextResponse.json({ error: invalid }, { status: 400 });
    const extension = libraryExtension(mimeType);
    if (!extension) return NextResponse.json({ error: "対応していないファイル形式です。" }, { status: 400 });
    const assetId = crypto.randomUUID();
    const path = `${user.id}/${assetId}.${extension}`;
    const inserted = await db.from("media_assets").insert({
      id: assetId,
      user_id: user.id,
      kind,
      title: typeof body.title === "string" && body.title.trim() ? body.title.trim().slice(0, 120) : "無題の素材",
      mime_type: mimeType,
      byte_size: byteSize,
      duration_seconds: typeof body.durationSeconds === "number" ? body.durationSeconds : null,
      ai_generated: body.aiGenerated === true,
      storage_bucket: LIBRARY_BUCKET,
      storage_path: path,
      upload_status: "pending",
    }).select("id").single();
    if (isMissingRelation(inserted.error)) return NextResponse.json({ error: "投稿キューのマイグレーションが未適用です。" }, { status: 503 });
    if (inserted.error) return NextResponse.json({ error: "素材レコードを作成できませんでした。" }, { status: 500 });
    try {
      await ensureLibraryBucket(db);
      const signed = await db.storage.from(LIBRARY_BUCKET).createSignedUploadUrl(path);
      if (signed.error || !signed.data) throw new Error(signed.error?.message || "署名付きアップロードURLを発行できませんでした。");
      return NextResponse.json({
        assetId,
        bucket: LIBRARY_BUCKET,
        path,
        token: signed.data.token,
        signedUrl: signed.data.signedUrl,
      });
    } catch (uploadError) {
      await db.from("media_assets").delete().eq("id", assetId).eq("user_id", user.id);
      const message = uploadError instanceof Error ? uploadError.message : "アップロードの準備に失敗しました。";
      return NextResponse.json({ error: message }, { status: 500 });
    }
  }

  if (body?.action === "complete") {
    const assetId = typeof body.assetId === "string" ? body.assetId : "";
    const asset = await db.from("media_assets")
      .select("id,storage_path,kind,byte_size,upload_status")
      .eq("id", assetId).eq("user_id", user.id).maybeSingle();
    if (asset.error) return NextResponse.json({ error: "素材の確認に失敗しました。" }, { status: 500 });
    if (!asset.data || !isOwnedVideoPath(user.id, asset.data.storage_path)) {
      return NextResponse.json({ error: "素材が見つかりません。" }, { status: 404 });
    }
    const folder = user.id;
    const name = asset.data.storage_path.slice(folder.length + 1);
    const listed = await db.storage.from(LIBRARY_BUCKET).list(folder, { search: name });
    const found = listed.data?.find((item) => item.name === name);
    if (listed.error || !found) {
      await db.from("media_assets").update({ upload_status: "failed", updated_at: new Date().toISOString() }).eq("id", assetId).eq("user_id", user.id);
      return NextResponse.json({ error: "アップロードされたファイルが見つかりません。" }, { status: 400 });
    }
    const size = typeof found.metadata?.size === "number" ? found.metadata.size : null;
    const limit = asset.data.kind === "image" ? 8 * 1024 * 1024 : 100 * 1024 * 1024;
    if (size != null && (size <= 0 || size > limit)) {
      await db.storage.from(LIBRARY_BUCKET).remove([asset.data.storage_path]);
      await db.from("media_assets").update({ upload_status: "failed", updated_at: new Date().toISOString() }).eq("id", assetId).eq("user_id", user.id);
      return NextResponse.json({ error: "ファイルサイズが制限を超えています。" }, { status: 400 });
    }
    const { data, error: updateError } = await db.from("media_assets").update({
      upload_status: "ready",
      byte_size: size ?? asset.data.byte_size,
      updated_at: new Date().toISOString(),
    }).eq("id", assetId).eq("user_id", user.id).select("id,kind,title,upload_status").single();
    if (updateError) return NextResponse.json({ error: "素材の確定に失敗しました。" }, { status: 500 });
    return NextResponse.json({ asset: data });
  }

  return NextResponse.json({ error: "action は sign または complete を指定してください。" }, { status: 400 });
}
