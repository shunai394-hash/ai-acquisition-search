import { NextResponse } from "next/server";
import { getAdminSupabase } from "@/lib/billing";
import { encryptLinkedInToken, exchangeLinkedInCode, getLinkedInUserInfo } from "@/lib/linkedin";
import { clearNonceCookie, OAUTH_NONCE_COOKIE, readCookie, verifyOAuthState } from "@/lib/security/oauth-state";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  // The nonce is single-use: every outcome clears it.
  const finish = (result: "connected" | "error") => {
    const response = NextResponse.redirect(new URL(`/?linkedin=${result}`, url.origin));
    response.headers.append("Set-Cookie", clearNonceCookie("/api/linkedin"));
    return response;
  };
  if (!code || !state) return finish("error");
  try {
    const userId = verifyOAuthState(state, readCookie(request.headers.get("cookie"), OAUTH_NONCE_COOKIE), process.env.LINKEDIN_STATE_SECRET);
    const redirectUri = url.origin + "/api/linkedin/callback";
    const token = await exchangeLinkedInCode(code, redirectUri);
    const profile = await getLinkedInUserInfo(token.access_token);
    const supabase = getAdminSupabase();
    const expiresAt = token.expires_in ? new Date(Date.now() + token.expires_in * 1000).toISOString() : null;
    const { error } = await supabase.from("linkedin_accounts").upsert({
      user_id: userId,
      linkedin_sub: profile.sub,
      name: profile.name || null,
      email: profile.email || null,
      picture_url: profile.picture || null,
      access_token_encrypted: encryptLinkedInToken(token.access_token),
      expires_at: expiresAt,
      scopes: (token.scope || "openid profile email w_member_social").split(/\s+/).filter(Boolean),
      updated_at: new Date().toISOString(),
    }, { onConflict: "user_id" });
    if (error) throw error;
    return finish("connected");
  } catch (error) {
    console.error("linkedin callback error", error);
    return finish("error");
  }
}
