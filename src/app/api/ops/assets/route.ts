import { NextResponse } from "next/server";
import { getAdminSupabase } from "@/lib/billing";
import { isMissingRelation, requireUser } from "@/lib/social/http";
import { isOwnedVideoPath } from "@/lib/video/asset-access";
import { LIBRARY_BUCKET, signLibraryAsset } from "@/lib/social/library";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function withPreview(db: ReturnType<typeof getAdminSupabase>, userId: string, row: {
  id: string;
  storage_bucket?: string | null;
  storage_path?: string | null;
  upload_status?: string | null;
}) {
  if (row.upload_status !== "ready" || row.storage_bucket !== LIBRARY_BUCKET || !isOwnedVideoPath(userId, row.storage_path)) {
    return { ...row, previewUrl: null };
  }
  try {
    return { ...row, previewUrl: await signLibraryAsset(db, row.storage_path, 60 * 30) };
  } catch {
    return { ...row, previewUrl: null };
  }
}

export async function GET(request: Request) {
  const { user, error } = await requireUser(request);
  if (!user) return error;
  const db = getAdminSupabase();
  const { data, error: readError } = await db.from("media_assets")
    .select("id,kind,title,body,mime_type,byte_size,duration_seconds,ai_generated,upload_status,storage_bucket,storage_path,created_at,updated_at")
    .eq("user_id", user.id)
    .order("created_at", { ascending: false })
    .limit(100);
  if (isMissingRelation(readError)) return NextResponse.json({ migrationRequired: true, assets: [] });
  if (readError) return NextResponse.json({ error: "素材の取得に失敗しました。" }, { status: 500 });
  const assets = await Promise.all((data || []).map((row) => withPreview(db, user.id, row)));
  return NextResponse.json({ assets });
}

export async function POST(request: Request) {
  const { user, error } = await requireUser(request);
  if (!user) return error;
  const body = await request.json().catch(() => null) as { title?: unknown; body?: unknown; aiGenerated?: unknown } | null;
  const title = typeof body?.title === "string" ? body.title.trim().slice(0, 120) : "";
  const text = typeof body?.body === "string" ? body.body.trim().slice(0, 4000) : "";
  if (!text) return NextResponse.json({ error: "投稿文を入力してください。" }, { status: 400 });
  const db = getAdminSupabase();
  const { data, error: insertError } = await db.from("media_assets").insert({
    user_id: user.id,
    kind: "text",
    title: title || text.slice(0, 40),
    body: text,
    ai_generated: body?.aiGenerated === true,
    upload_status: "ready",
  }).select("id,kind,title,body,upload_status,created_at").single();
  if (isMissingRelation(insertError)) return NextResponse.json({ error: "投稿キューのマイグレーションが未適用です。" }, { status: 503 });
  if (insertError) return NextResponse.json({ error: "素材の保存に失敗しました。" }, { status: 500 });
  return NextResponse.json({ asset: data });
}

export async function PATCH(request: Request) {
  const { user, error } = await requireUser(request);
  if (!user) return error;
  const body = await request.json().catch(() => null) as { id?: unknown; title?: unknown; body?: unknown } | null;
  if (typeof body?.id !== "string") return NextResponse.json({ error: "素材IDが必要です。" }, { status: 400 });
  const patch: Record<string, string> = { updated_at: new Date().toISOString() };
  if (typeof body.title === "string") patch.title = body.title.trim().slice(0, 120);
  if (typeof body.body === "string") patch.body = body.body.trim().slice(0, 4000);
  const db = getAdminSupabase();
  const { data, error: updateError } = await db.from("media_assets").update(patch).eq("id", body.id).eq("user_id", user.id).select("id,title,body").maybeSingle();
  if (updateError) return NextResponse.json({ error: "素材の更新に失敗しました。" }, { status: 500 });
  if (!data) return NextResponse.json({ error: "素材が見つかりません。" }, { status: 404 });
  return NextResponse.json({ asset: data });
}

export async function DELETE(request: Request) {
  const { user, error } = await requireUser(request);
  if (!user) return error;
  const id = new URL(request.url).searchParams.get("id") || "";
  if (!id) return NextResponse.json({ error: "素材IDが必要です。" }, { status: 400 });
  const db = getAdminSupabase();
  const used = await db.from("post_jobs").select("id").eq("asset_id", id).eq("user_id", user.id).in("status", ["queued", "paused", "processing", "pending", "awaiting_approval", "published"]).limit(1);
  if (used.error && !isMissingRelation(used.error)) return NextResponse.json({ error: "素材の使用状況を確認できませんでした。" }, { status: 500 });
  if (used.data?.length) return NextResponse.json({ error: "投稿キューで使われている素材は削除できません。" }, { status: 409 });
  const asset = await db.from("media_assets").select("storage_bucket,storage_path").eq("id", id).eq("user_id", user.id).maybeSingle();
  if (asset.error) return NextResponse.json({ error: "素材の削除に失敗しました。" }, { status: 500 });
  if (!asset.data) return NextResponse.json({ error: "素材が見つかりません。" }, { status: 404 });
  if (asset.data.storage_bucket === LIBRARY_BUCKET && isOwnedVideoPath(user.id, asset.data.storage_path)) {
    await db.storage.from(LIBRARY_BUCKET).remove([asset.data.storage_path]);
  }
  const deleted = await db.from("media_assets").delete().eq("id", id).eq("user_id", user.id);
  if (deleted.error) return NextResponse.json({ error: "素材の削除に失敗しました。" }, { status: 500 });
  return NextResponse.json({ ok: true });
}
