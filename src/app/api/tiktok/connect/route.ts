import { NextResponse } from "next/server";
import { getAdminSupabase, getUserFromBearer } from "@/lib/billing";
import { createTikTokState, decryptTikTokToken, tiktokAuthUrl } from "@/lib/social/tiktok";

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
  const next = new URL(request.url).searchParams.get("next");
  response.cookies.set("tiktok_oauth_next", next === "/ops" ? "/ops" : "/", {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    maxAge: 600,
  });
  response.cookies.set("tiktok_oauth_state", state, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    maxAge: 600,
  });
  return response;
}

export async function DELETE(request: Request) {
  const user = await getUserFromBearer(request);
  if (!user) return NextResponse.json({ error: "ログインが必要です。" }, { status: 401 });
  const db = getAdminSupabase();
  const account = await db.from("tiktok_accounts").select("access_token_encrypted").eq("user_id", user.id).maybeSingle();
  if (account.error) return NextResponse.json({ error: "TikTok接続の確認に失敗しました。" }, { status: 500 });
  if (account.data?.access_token_encrypted) {
    try {
      const token = decryptTikTokToken(account.data.access_token_encrypted);
      await fetch("https://open.tiktokapis.com/v2/oauth/revoke/", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", "Cache-Control": "no-cache" },
        body: new URLSearchParams({
          client_key: process.env.TIKTOK_CLIENT_KEY || "",
          client_secret: process.env.TIKTOK_CLIENT_SECRET || "",
          token,
        }),
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      console.error("tiktok revoke failed");
    }
  }
  const deleted = await db.from("tiktok_accounts").delete().eq("user_id", user.id);
  if (deleted.error) return NextResponse.json({ error: "TikTok接続の解除に失敗しました。" }, { status: 500 });
  return NextResponse.json({ ok: true });
}
