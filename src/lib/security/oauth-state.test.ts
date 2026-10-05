import assert from "node:assert/strict";
import test from "node:test";
import { createOAuthState, nonceCookie, OAUTH_NONCE_COOKIE, readCookie, verifyOAuthState } from "./oauth-state";

const SECRET = "state-secret";

test("the browser that started the flow completes it", () => {
  const { state, nonce } = createOAuthState("user-1", SECRET);
  assert.equal(verifyOAuthState(state, nonce, SECRET), "user-1");
});

test("a state finished in another browser (OAuth CSRF) is rejected", () => {
  const attacker = createOAuthState("attacker", SECRET);
  const victimBrowser = createOAuthState("victim", SECRET);
  assert.throws(() => verifyOAuthState(attacker.state, null, SECRET), /not started in this browser/);
  assert.throws(() => verifyOAuthState(attacker.state, victimBrowser.nonce, SECRET), /not started in this browser/);
});

test("tampered, foreign-secret, expired and future states are rejected", () => {
  const { state, nonce } = createOAuthState("user-1", SECRET);
  const [encoded, signature] = state.split(".");
  const forged = Buffer.from(`attacker.${Date.now()}.${nonce}`).toString("base64url");
  assert.throws(() => verifyOAuthState(`${forged}.${signature}`, nonce, SECRET), /signature/);
  assert.throws(() => verifyOAuthState(state, nonce, "other-secret"), /signature/);
  assert.throws(() => verifyOAuthState(state, nonce, undefined), /Invalid/);
  assert.throws(() => verifyOAuthState(`${encoded}`, nonce, SECRET), /Invalid/);
  const old = createOAuthState("user-1", SECRET, Date.now() - 11 * 60_000);
  assert.throws(() => verifyOAuthState(old.state, old.nonce, SECRET), /expired/);
  const future = createOAuthState("user-1", SECRET, Date.now() + 5 * 60_000);
  assert.throws(() => verifyOAuthState(future.state, future.nonce, SECRET), /expired/);
});

test("nonce cookie is HttpOnly, Secure, Lax and parsed back from a Cookie header", () => {
  const cookie = nonceCookie("abc", "/api/linkedin");
  for (const attr of ["HttpOnly", "Secure", "SameSite=Lax", "Path=/api/linkedin", "Max-Age=600"]) assert.ok(cookie.includes(attr), attr);
  assert.equal(readCookie(`a=1; ${OAUTH_NONCE_COOKIE}=abc; b=2`, OAUTH_NONCE_COOKIE), "abc");
  assert.equal(readCookie(null, OAUTH_NONCE_COOKIE), null);
  assert.equal(readCookie(`x${OAUTH_NONCE_COOKIE}=evil`, OAUTH_NONCE_COOKIE), null);
});
