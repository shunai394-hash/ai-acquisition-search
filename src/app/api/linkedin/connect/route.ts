import { NextResponse } from "next/server";
import { getUserFromBearer } from "@/lib/billing";
import { linkedInAuthUrl } from "@/lib/linkedin";
import { createOAuthState, nonceCookie } from "@/lib/security/oauth-state";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const user = await getUserFromBearer(request);
  if (!user) return NextResponse.json({ error: "ログインが必要です。" }, { status: 401 });
  const secret = process.env.LINKEDIN_STATE_SECRET;
  if (!secret) return NextResponse.json({ error: "LinkedIn連携は現在設定中です。" }, { status: 503 });
  const origin = new URL(request.url).origin;
  const redirectUri = origin + "/api/linkedin/callback";
  const { state, nonce } = createOAuthState(user.id, secret);
  const response = NextResponse.json({ url: linkedInAuthUrl({ state, redirectUri }) });
  // Binds the state to this browser; checked once by /api/linkedin/callback.
  response.headers.append("Set-Cookie", nonceCookie(nonce, "/api/linkedin"));
  return response;
}
