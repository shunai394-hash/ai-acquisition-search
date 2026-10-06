import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { fetchPageSnapshot } from "./fetch-url";

// Public IP literal: the SSRF guard accepts it without DNS, the stub answers it.
const PAGE = "https://93.184.216.34/product";
const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

function serve(body: BodyInit | null, headers: Record<string, string> = { "content-type": "text/html" }, status = 200) {
  globalThis.fetch = (async () => new Response(body, { status, headers })) as typeof fetch;
}

test("a chunked body without Content-Length is cut off at the size cap", async () => {
  let pulled = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulled++;
      if (pulled > 400) return controller.close(); // 400 * 64KiB = 25MiB if read to the end
      controller.enqueue(new Uint8Array(64 * 1024).fill(97));
    },
  });
  serve(stream);
  await assert.rejects(() => fetchPageSnapshot(PAGE), /ページサイズが大きすぎます/);
  assert.ok(pulled < 40, `stopped reading early (pulled ${pulled} chunks)`);
});

test("declared oversized pages are rejected before reading", async () => {
  serve("<html></html>", { "content-type": "text/html", "content-length": "99999999" });
  await assert.rejects(() => fetchPageSnapshot(PAGE), /ページサイズが大きすぎます/);
});

test("out-of-range character references do not crash the analysis", async () => {
  serve("<html><head><title>Bottle &#x110000; &#55296; &#0; &#x1F600;</title></head><body><h1>保冷&amp;ボトル</h1></body></html>");
  const snapshot = await fetchPageSnapshot(PAGE);
  assert.match(snapshot.title, /Bottle/);
  assert.ok(snapshot.title.includes("😀"));
});

test("non-HTML and error responses are rejected with a user-facing message", async () => {
  serve("{}", { "content-type": "application/json" });
  await assert.rejects(() => fetchPageSnapshot(PAGE), /HTMLページ/);
  serve("nope", { "content-type": "text/html" }, 503);
  await assert.rejects(() => fetchPageSnapshot(PAGE), /HTTP 503/);
});

test("internal addresses are refused before any request is made", async () => {
  let called = false;
  globalThis.fetch = (async () => { called = true; return new Response("x"); }) as typeof fetch;
  await assert.rejects(() => fetchPageSnapshot("http://169.254.169.254/latest/meta-data/"));
  await assert.rejects(() => fetchPageSnapshot("http://[::127.0.0.1]/"));
  assert.equal(called, false);
});

test("a redirect to an internal address is refused", async () => {
  globalThis.fetch = (async () => new Response(null, { status: 302, headers: { location: "http://127.0.0.1:8080/admin" } })) as typeof fetch;
  await assert.rejects(() => fetchPageSnapshot(PAGE));
});
