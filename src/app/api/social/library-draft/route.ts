import { NextResponse } from "next/server";
import { getAdminSupabase, getUserFromBearer } from "@/lib/billing";
import { isOwnedVideoPath, signVideoAsset } from "@/lib/video/asset-access";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const user = await getUserFromBearer(request);
    if (!user) return NextResponse.json({ error: "ログインが必要です。" }, { status: 401 });
    const body = await request.json().catch(() => null);
    const storagePath = typeof body?.storagePath === "string" ? body.storagePath.trim() : "";
    const caption = typeof body?.caption === "string" ? body.caption.trim().slice(0, 2200) : "";
    if (!isOwnedVideoPath(user.id, storagePath) || !storagePath.startsWith(user.id + "/library/") || !storagePath.toLowerCase().endsWith(".mp4")) {
      return NextResponse.json({ error: "自分の完成動画フォルダーにあるMP4を指定してください。" }, { status: 403 });
    }

    const db = getAdminSupabase();
    // Verify the object exists and belongs to the authenticated user's library before creating a post draft.
    await signVideoAsset(db, storagePath);

    const draftKey = "completed_video:" + storagePath;
    const { data: existing, error: lookupError } = await db.from("social_posts")
      .select("id")
      .eq("user_id", user.id)
      .filter("metadata->>draft_key", "eq", draftKey)
      .maybeSingle();
    if (lookupError) throw lookupError;
    if (existing) return NextResponse.json({ ok: true, socialPostId: existing.id, reused: true });

    const { data, error } = await db.from("social_posts").insert({
      creative_id: null,
      user_id: user.id,
      network: "tiktok",
      status: "planned",
      caption: caption || "完成動画のSNS投稿",
      metadata: {
        source_type: "completed_video",
        draft_key: draftKey,
        video_storage_path: storagePath,
      },
    }).select("id").single();

    if (error) {
      if (error.code === "23505") {
        const { data: raced, error: racedError } = await db.from("social_posts")
          .select("id").eq("user_id", user.id).filter("metadata->>draft_key", "eq", draftKey).maybeSingle();
        if (!racedError && raced) return NextResponse.json({ ok: true, socialPostId: raced.id, reused: true });
      }
      throw error;
    }
    return NextResponse.json({ ok: true, socialPostId: data.id, reused: false }, { status: 201 });
  } catch (error) {
    console.error("completed video SNS draft creation failed", error);
    return NextResponse.json({ error: error instanceof Error ? error.message : "SNS投稿の準備に失敗しました。" }, { status: 500 });
  }
}
