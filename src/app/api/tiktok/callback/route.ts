import { NextResponse } from "next/server";
import { exchangeTikTokCode, getTikTokStateUserId, saveTikTokAccount, verifyTikTokState } from "@/lib/social/tiktok";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const state = url.searchParams.get("state") || "";
  const code = url.searchParams.get("code") || "";
  const error = url.searchParams.get("error_description") || url.searchParams.get("error") || "";
  const storedState = request.headers.get("cookie")?.match(/(?:^|;\s*)tiktok_oauth_state=([^;]+)/)?.[1] || "";

  if (!state || !storedState || state !== decodeURIComponent(storedState) || !verifyTikTokState(state)) {
    return NextResponse.json({ error: "TikTok OAuth stateが無効です。" }, { status: 400 });
  }
  if (error) return NextResponse.redirect(new URL("/?tiktok=error", request.url));
  if (!code) return NextResponse.json({ error: "TikTok authorization codeがありません。" }, { status: 400 });

  const clearCookie = (response: NextResponse) => {
    response.cookies.set("tiktok_oauth_state", "", {
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      path: "/",
      maxAge: 0,
    });
    return response;
  };

  try {
    const userId = getTikTokStateUserId(state);
    if (!userId) throw new Error("TikTok OAuth stateからユーザーを特定できません。");
    const token = await exchangeTikTokCode(code);
    await saveTikTokAccount(userId, token);
    return clearCookie(NextResponse.redirect(new URL("/?tiktok=connected", request.url)));
  } catch (e) {
    console.error("TikTok OAuth callback failed", e);
    return clearCookie(NextResponse.redirect(new URL("/?tiktok=error", request.url)));
  }
}
