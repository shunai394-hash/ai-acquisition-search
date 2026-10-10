import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import http from "node:http";
import { Readable } from "node:stream";
import { assertPublicUrl, pinnedDnsLookup, publicFetchTransport } from "./public-url";

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

test("blocks cloud metadata hostnames before DNS resolution", async () => {
  await assert.rejects(() => assertPublicUrl("http://metadata.google.internal/computeMetadata/v1/"));
  await assert.rejects(() => assertPublicUrl("http://service.internal/secret"));
});

test("pinned DNS lookup ignores a rebinding hostname and refuses private addresses", () => {
  const lookup = pinnedDnsLookup(["8.8.8.8"]);
  let seen = "";
  lookup("rebinding.example", {}, (_err, address) => { seen = address; });
  assert.equal(seen, "8.8.8.8");
  assert.throws(() => pinnedDnsLookup(["169.254.169.254"]));
  assert.throws(() => pinnedDnsLookup([]));
});

test("public URL fetch supplies a default timeout signal and pins DNS", async () => {
  const original = publicFetchTransport.request;
  let receivedSignal: AbortSignal | undefined;
  let lookupHost = "";
  publicFetchTransport.request = (_protocol, _url, options, callback) => {
    receivedSignal = options.signal ?? undefined;
    const report = (_err: NodeJS.ErrnoException | null, address: string) => { lookupHost = address; };
    options.lookup?.("rebinding.example", {}, report as never);
    const incoming = Object.assign(Readable.from(["ok"]), { statusCode: 200, headers: { "content-type": "video/mp4" } });
    queueMicrotask(() => callback(incoming as unknown as http.IncomingMessage));
    const req = new EventEmitter();
    const client = req as EventEmitter & { end: () => void };
    client.end = () => {};
    return client as unknown as ReturnType<typeof original>;
  };
  try {
    const { fetchPublicUrl } = await import("./public-url");
    const response = await fetchPublicUrl("https://8.8.8.8/video.mp4");
    assert.equal(response.status, 200);
    assert.ok(receivedSignal instanceof AbortSignal);
    assert.equal(receivedSignal.aborted, false);
    assert.equal(lookupHost, "8.8.8.8");
  } finally {
    publicFetchTransport.request = original;
  }
});
