import { NextResponse } from "next/server";
import { getAdminSupabase, getUserFromBearer } from "@/lib/billing";
import { assertPublicUrl } from "@/lib/security/public-url";
import { isOwnedVideoPath, videoAssetPathFromUrl } from "@/lib/video/asset-access";

export const runtime = "nodejs";

const PLATFORMS = ["tiktok", "instagram", "facebook", "youtube", "x", "linkedin"] as const;

export async function POST(request: Request) {
  try {
    const user = await getUserFromBearer(request);
    if (!user) return NextResponse.json({ error: "ログインが必要です。" }, { status: 401 });

    const body = await request.json();
    const videoUrl = typeof body.videoUrl === "string" ? body.videoUrl.trim() : "";
    const caption = typeof body.caption === "string" ? body.caption.trim().slice(0, 2200) : "";
    const platforms = Array.isArray(body.platforms)
      ? Array.from(new Set(body.platforms.filter((value: unknown): value is typeof PLATFORMS[number] =>
          typeof value === "string" && (PLATFORMS as readonly string[]).includes(value))))
      : [];

    if (!videoUrl.startsWith("https://")) {
      return NextResponse.json({ error: "完成動画を選択してください。" }, { status: 400 });
    }
    const ownedPath = videoAssetPathFromUrl(videoUrl);
    if (ownedPath !== null) {
      if (!isOwnedVideoPath(user.id, ownedPath)) {
        return NextResponse.json({ error: "この動画を投稿する権限がありません。" }, { status: 403 });
      }
    } else {
      try {
        await assertPublicUrl(videoUrl, ["https:"]);
      } catch (error) {
        return NextResponse.json({ error: error instanceof Error ? error.message : "動画URLを検証できませんでした。" }, { status: 400 });
      }
    }
    if (!caption) return NextResponse.json({ error: "投稿本文を入力してください。" }, { status: 400 });
    if (!platforms.length) return NextResponse.json({ error: "投稿先を1つ以上選択してください。" }, { status: 400 });

    const db = getAdminSupabase();
    const { data, error } = await db.from("social_posts").insert({
      creative_id: null,
      user_id: user.id,
      network: platforms[0],
      status: "planned",
      caption,
      metadata: {
        source_type: "standalone_video",
        source_video_path: ownedPath,
        selected_platforms: platforms,
      },
    }).select("id").single();
    if (error) throw error;
    return NextResponse.json({ ok: true, socialPostId: data.id }, { status: 201 });
  } catch (error) {
    console.error("standalone social draft creation failed", error);
    return NextResponse.json({ error: error instanceof Error ? error.message : "SNS投稿の準備に失敗しました。" }, { status: 500 });
  }
}
