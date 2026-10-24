import assert from "node:assert/strict";
import test from "node:test";
import { blockedSharedCredentialPlatforms } from "@/lib/social/publish-policy";

test("blocks server-wide Meta, YouTube and X credentials by default", () => {
  assert.deepEqual(
    blockedSharedCredentialPlatforms(["tiktok", "instagram", "facebook", "youtube", "x", "linkedin"], false),
    ["instagram", "facebook", "youtube", "x"],
  );
});

test("permits per-user TikTok and LinkedIn connections without shared-account mode", () => {
  assert.deepEqual(blockedSharedCredentialPlatforms(["tiktok", "linkedin"], false), []);
});

test("permits shared-credential platforms only with explicit single-tenant opt-in", () => {
  assert.deepEqual(
    blockedSharedCredentialPlatforms(["instagram", "youtube", "x"], true),
    [],
  );
});
