import crypto from "node:crypto";

/**
 * Signed OAuth `state` bound to the browser that started the flow.
 *
 * The HMAC alone proves the state was minted by us for a user, but not that
 * the browser finishing the flow is that user's: an attacker could mint a
 * state for their own account and have a victim complete consent, linking the
 * victim's social account to the attacker. The nonce in the state must match
 * an HttpOnly cookie set when the flow started (SameSite=Lax survives the
 * top-level redirect back from the provider).
 */
export const OAUTH_NONCE_COOKIE = "oauth_state_nonce";
export const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

function sign(value: string, secret: string) {
  return crypto.createHmac("sha256", secret).update(value).digest("base64url");
}

function safeEqual(a: string, b: string) {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

export function createOAuthState(userId: string, secret: string, now = Date.now()) {
  const nonce = crypto.randomBytes(18).toString("base64url");
  const payload = `${userId}.${now}.${nonce}`;
  return { state: `${Buffer.from(payload).toString("base64url")}.${sign(payload, secret)}`, nonce };
}

export function nonceCookie(nonce: string, path: string) {
  return `${OAUTH_NONCE_COOKIE}=${nonce}; Path=${path}; Max-Age=${OAUTH_STATE_TTL_MS / 1000}; HttpOnly; Secure; SameSite=Lax`;
}

export function clearNonceCookie(path: string) {
  return `${OAUTH_NONCE_COOKIE}=; Path=${path}; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
}

export function readCookie(header: string | null, name: string) {
  for (const part of (header ?? "").split(";")) {
    const index = part.indexOf("=");
    if (index > 0 && part.slice(0, index).trim() === name) return part.slice(index + 1).trim();
  }
  return null;
}

/** Returns the user id the flow was started for, or throws. */
export function verifyOAuthState(state: string, cookieNonce: string | null, secret: string | undefined, now = Date.now()) {
  const [encoded, signature] = state.split(".");
  if (!secret || !encoded || !signature) throw new Error("Invalid OAuth state");
  const payload = Buffer.from(encoded, "base64url").toString("utf8");
  if (!safeEqual(signature, sign(payload, secret))) throw new Error("Invalid OAuth state signature");
  const [userId, issued, nonce] = payload.split(".");
  const issuedAt = Number(issued);
  if (!userId || !Number.isFinite(issuedAt) || now - issuedAt > OAUTH_STATE_TTL_MS || issuedAt - now > 60_000) {
    throw new Error("OAuth authorization expired");
  }
  if (!nonce || !cookieNonce || !safeEqual(nonce, cookieNonce)) {
    throw new Error("OAuth state was not started in this browser");
  }
  return userId;
}
