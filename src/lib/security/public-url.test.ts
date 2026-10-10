import assert from "node:assert/strict";
import { mock, test } from "node:test";
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

test("public URL fetch supplies a default timeout signal", async () => {
  let receivedSignal: AbortSignal | null | undefined;
  mock.method(globalThis, "fetch", async (_input: string | URL | Request, init?: RequestInit) => {
    receivedSignal = init?.signal;
    return new Response("ok", { status: 200 });
  });
  try {
    const { fetchPublicUrl } = await import("./public-url");
    const response = await fetchPublicUrl("https://8.8.8.8/video.mp4");
    assert.equal(response.status, 200);
    assert.ok(receivedSignal instanceof AbortSignal);
    assert.equal(receivedSignal.aborted, false);
  } finally {
    mock.restoreAll();
  }
});
