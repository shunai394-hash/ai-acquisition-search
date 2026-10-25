import { NextResponse } from "next/server";
import { getUserFromBearer } from "@/lib/billing";
import { createTikTokState, tiktokAuthUrl } from "@/lib/social/tiktok";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const user = await getUserFromBearer(request);
  if (!user) return NextResponse.json({ error: "ログインが必要です。" }, { status: 401 });
  let state: string;
  let authorizationUrl: string;
  try {
    state = createTikTokState(user.id);
    authorizationUrl = tiktokAuthUrl(state);
  } catch (error) {
    const message = error instanceof Error ? error.message : "TikTok OAuth設定が不完全です。";
    console.error("TikTok connect configuration error", message);
    return NextResponse.json({
      error: "TikTok連携のサーバー設定が不足しています。VercelのProduction環境変数 TIKTOK_CLIENT_KEY、TIKTOK_CLIENT_SECRET、TIKTOK_REDIRECT_URI、TIKTOK_TOKEN_ENCRYPTION_KEY を確認してください。",
      code: "TIKTOK_OAUTH_CONFIG_MISSING",
      detail: message,
    }, { status: 503 });
  }
  const response = new URL(request.url).searchParams.get("format") === "json"
    ? NextResponse.json({ url: authorizationUrl })
    : NextResponse.redirect(authorizationUrl);
  response.cookies.set("tiktok_oauth_state", state, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    maxAge: 600,
  });
  return response;
}
