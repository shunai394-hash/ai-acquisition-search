import assert from "node:assert/strict";
import test from "node:test";
import { assertPublicUrl } from "./public-url";

test("blocks localhost and private IPv4 ranges", async () => {
  for (const host of [
    "127.0.0.1",
    "10.0.0.1",
    "100.64.0.1",
    "169.254.169.254",
    "172.16.0.1",
    "192.0.0.1",
    "192.168.1.1",
    "198.18.0.1",
    "224.0.0.1",
  ]) {
    await assert.rejects(() => assertPublicUrl(`http://${host}/`));
  }
});

test("blocks localhost aliases, IPv4-mapped IPv6, and private IPv6", async () => {
  for (const url of [
    "http://localhost/",
    "http://foo.localhost/",
    "http://service.local/",
    "http://[::1]/",
    "http://[::ffff:127.0.0.1]/",
    "http://[::ffff:169.254.169.254]/",
    "http://[::ffff:7f00:1]/",
    "http://[fd00::1]/",
    "http://[fe80::1]/",
    "http://[ff02::1]/",
  ]) {
    await assert.rejects(() => assertPublicUrl(url));
  }
});

test("rejects unsafe schemes and embedded credentials", async () => {
  await assert.rejects(() => assertPublicUrl("file:///etc/passwd"));
  await assert.rejects(() => assertPublicUrl("ftp://example.com/"));
  await assert.rejects(() => assertPublicUrl("https://user:pass@example.com/"));
  await assert.rejects(() => assertPublicUrl("not-a-url"));
});

test("allows ordinary public URL syntax", async () => {
  await assert.doesNotReject(() => assertPublicUrl("https://example.com/"));
});

test("blocks IPv6 forms that reach IPv4 or local hosts without the ::ffff: prefix", async () => {
  for (const url of [
    "http://[::]/",
    "http://[::127.0.0.1]/",
    "http://[::7f00:1]/",
    "http://[64:ff9b::a9fe:a9fe]/",
    "http://[64:ff9b::169.254.169.254]/",
    "http://[2002:c0a8:101::1]/",
    "http://[2001:0:4136:e378:8000:63bf:3fff:fdd2]/",
  ]) {
    await assert.rejects(() => assertPublicUrl(url), url);
  }
});

test("allows public IP literals (no DNS involved)", async () => {
  await assert.doesNotReject(() => assertPublicUrl("https://93.184.216.34/video.mp4"));
  await assert.doesNotReject(() => assertPublicUrl("https://[2606:4700:4700::1111]/"));
  await assert.doesNotReject(() => assertPublicUrl("https://[2001:4860:4860::8888]/"));
});
