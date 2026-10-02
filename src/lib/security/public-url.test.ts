import assert from "node:assert/strict";
import test from "node:test";
import { assertPublicUrl } from "./public-url";

test("blocks localhost and private IPv4 ranges", async () => {
  await assert.rejects(() => assertPublicUrl("http://127.0.0.1/"));
  await assert.rejects(() => assertPublicUrl("http://10.0.0.1/"));
  await assert.rejects(() => assertPublicUrl("http://192.168.1.1/"));
  await assert.rejects(() => assertPublicUrl("http://169.254.169.254/"));
});

test("blocks IPv4-mapped IPv6 private addresses", async () => {
  await assert.rejects(() => assertPublicUrl("http://[::ffff:127.0.0.1]/"));
  await assert.rejects(() => assertPublicUrl("http://[::ffff:169.254.169.254]/"));
  await assert.rejects(() => assertPublicUrl("http://[::ffff:7f00:1]/"));
});

test("allows ordinary public URL syntax", async () => {
  await assert.doesNotReject(() => assertPublicUrl("https://example.com/"));
});
