import { NextResponse } from "next/server";
import { getUserFromBearer } from "@/lib/billing";
import { createTikTokState, tiktokAuthUrl } from "@/lib/social/tiktok";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const user = await getUserFromBearer(request);
  if (!user) return NextResponse.json({ error: "ログインが必要です。" }, { status: 401 });
  const state = createTikTokState(user.id);
  const authorizationUrl = tiktokAuthUrl(state);
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
