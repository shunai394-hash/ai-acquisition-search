import { test } from "node:test";
import assert from "node:assert/strict";
import { secretMatches, verifyCronRequest } from "./cron-auth";

const req = (auth?: string) => new Request("https://example.com/api/cron/operator-loop", { headers: auth ? { authorization: auth } : {} });

test("missing CRON_SECRET is rejected, never bypassed", () => {
  delete process.env.CRON_SECRET;
  assert.deepEqual(verifyCronRequest(req("Bearer anything")), { ok: false, reason: "cron_secret_not_configured" });
  assert.equal(secretMatches("anything"), false);
});

test("secret stored with trailing newline still matches Vercel Cron header", () => {
  process.env.CRON_SECRET = "s3cret-value\n";
  assert.deepEqual(verifyCronRequest(req("Bearer s3cret-value")), { ok: true });
  assert.equal(secretMatches("s3cret-value"), true);
});

test("wrong or missing header is rejected with a reason", () => {
  process.env.CRON_SECRET = "s3cret-value";
  assert.deepEqual(verifyCronRequest(req()), { ok: false, reason: "authorization_header_missing" });
  assert.deepEqual(verifyCronRequest(req("Bearer nope")), { ok: false, reason: "authorization_mismatch" });
  assert.deepEqual(verifyCronRequest(req("s3cret-value")), { ok: false, reason: "authorization_mismatch" });
  assert.equal(secretMatches(""), false);
});
