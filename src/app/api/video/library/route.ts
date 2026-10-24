import { NextResponse } from "next/server";
import { getAdminSupabase, getUserFromBearer } from "@/lib/billing";
import { isOwnedVideoPath, signVideoAsset, VIDEO_BUCKET } from "@/lib/video/asset-access";

export const runtime = "nodejs";
export const maxDuration = 60;

const MAX_VIDEO_BYTES = 250 * 1024 * 1024;
const LIBRARY_FOLDER = "library";

function isMp4(bytes: Uint8Array) {
  return bytes.length >= 12 && new TextDecoder().decode(bytes.slice(4, 8)) === "ftyp";
}

export async function GET(request: Request) {
  try {
    const user = await getUserFromBearer(request);
    if (!user) return NextResponse.json({ error: "ログインが必要です。" }, { status: 401 });
    const supabase = getAdminSupabase();
    const prefix = user.id + "/" + LIBRARY_FOLDER;
    const { data: files, error } = await supabase.storage.from(VIDEO_BUCKET).list(prefix, {
      limit: 100,
      sortBy: { column: "created_at", order: "desc" },
    });
    if (error) throw error;
    const videos = await Promise.all((files ?? [])
      .filter((file) => file.name && file.name.toLowerCase().endsWith(".mp4"))
      .map(async (file) => {
        const storagePath = prefix + "/" + file.name;
        if (!isOwnedVideoPath(user.id, storagePath)) return null;
        return {
          name: file.name.replace(/^[0-9a-f-]+_/, ""),
          storagePath,
          size: file.metadata && typeof file.metadata.size === "number" ? file.metadata.size : null,
          createdAt: file.created_at ?? null,
          url: await signVideoAsset(supabase, storagePath),
          downloadUrl: await signVideoAsset(supabase, storagePath, { download: file.name }),
        };
      }));
    return NextResponse.json({ videos: videos.filter(Boolean) });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "完成動画を読み込めませんでした。" }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const declaredLength = Number(request.headers.get("content-length") || 0);
    if (Number.isFinite(declaredLength) && declaredLength > MAX_VIDEO_BYTES + 256 * 1024) {
      return NextResponse.json({ error: "動画は250MB以下にしてください。" }, { status: 413 });
    }
    const user = await getUserFromBearer(request);
    if (!user) return NextResponse.json({ error: "ログインが必要です。" }, { status: 401 });
    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof File)) return NextResponse.json({ error: "保存するMP4動画を選択してください。" }, { status: 400 });
    if (file.type !== "video/mp4" || !file.name.toLowerCase().endsWith(".mp4")) {
      return NextResponse.json({ error: "現在はMP4動画のみ保存できます。" }, { status: 415 });
    }
    if (!file.size || file.size > MAX_VIDEO_BYTES) {
      return NextResponse.json({ error: "動画は1バイト以上、250MB以下にしてください。" }, { status: 413 });
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (!isMp4(bytes)) return NextResponse.json({ error: "ファイルの内容がMP4動画ではありません。" }, { status: 415 });

    const supabase = getAdminSupabase();
    const safeBaseName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_").replace(/\.mp4$/i, "").slice(0, 70) || "completed-video";
    const storagePath = user.id + "/" + LIBRARY_FOLDER + "/" + crypto.randomUUID() + "_" + safeBaseName + ".mp4";
    const { error: uploadError } = await supabase.storage.from(VIDEO_BUCKET).upload(storagePath, Buffer.from(bytes), {
      contentType: "video/mp4",
      upsert: false,
      cacheControl: "3600",
    });
    if (uploadError) throw uploadError;
    const url = await signVideoAsset(supabase, storagePath);
    const downloadUrl = await signVideoAsset(supabase, storagePath, { download: file.name });
    return NextResponse.json({
      ok: true,
      video: { name: file.name, storagePath, size: file.size, createdAt: new Date().toISOString(), url, downloadUrl },
    }, { status: 201 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "動画の保存に失敗しました。" }, { status: 500 });
  }
}
