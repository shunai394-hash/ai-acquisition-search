import { NextResponse } from "next/server";
import { getUserFromBearer } from "@/lib/billing";

export function isMissingRelation(error: { code?: string } | null | undefined) {
  return Boolean(error && ["42P01", "PGRST205", "PGRST202"].includes(String(error.code)));
}

export async function requireUser(request: Request) {
  const user = await getUserFromBearer(request);
  if (!user) {
    return { user: null, error: NextResponse.json({ error: "ログインが必要です。" }, { status: 401 }) };
  }
  return { user, error: null };
}

export function publicAccount(row: {
  open_id?: string | null;
  display_name?: string | null;
  avatar_url?: string | null;
  scope?: string | null;
  access_token_expires_at?: string | null;
  refresh_token_expires_at?: string | null;
  updated_at?: string | null;
} | null) {
  if (!row) return { connected: false, needsReauth: true, reason: "TikTokアカウントが未接続です。" };
  const scopes = String(row.scope || "").split(/[,\s]+/).filter(Boolean);
  const refreshExpired = row.refresh_token_expires_at ? Date.parse(row.refresh_token_expires_at) <= Date.now() : false;
  const needsReauth = refreshExpired || !scopes.includes("video.publish");
  return {
    connected: true,
    needsReauth,
    reason: needsReauth ? "再認証が必要です。video.publish 権限、またはリフレッシュトークンの期限を確認してください。" : null,
    openId: row.open_id ?? null,
    displayName: row.display_name ?? null,
    avatarUrl: row.avatar_url ?? null,
    scopes,
    hasVideoList: scopes.includes("video.list"),
    accessTokenExpiresAt: row.access_token_expires_at ?? null,
    refreshTokenExpiresAt: row.refresh_token_expires_at ?? null,
    updatedAt: row.updated_at ?? null,
  };
}
