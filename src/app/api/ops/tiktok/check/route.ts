import { NextResponse } from "next/server";
import { queryTikTokCreator } from "@/lib/social/tiktok";
import { getTikTokAccessToken } from "@/lib/social/tiktok";
import { redactError } from "@/lib/social/queue";
import { requireUser } from "@/lib/social/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const { user, error } = await requireUser(request);
  if (!user) return error;
  try {
    const token = await getTikTokAccessToken(user.id);
    const creator = await queryTikTokCreator(token);
    return NextResponse.json({
      ok: true,
      username: creator?.creator_username ?? null,
      privacyOptions: Array.isArray(creator?.privacy_level_options) ? creator.privacy_level_options : [],
      maxVideoDurationSec: creator?.max_video_post_duration_sec ?? null,
      commentDisabled: creator?.comment_disabled === true,
      note: "未審査アプリでは privacyOptions に SELF_ONLY しか含まれないことがあります。その場合、全員公開はできません。",
    });
  } catch (checkError) {
    return NextResponse.json({
      ok: false,
      error: redactError(checkError instanceof Error ? checkError.message : "TikTokの接続確認に失敗しました。"),
    }, { status: 502 });
  }
}
