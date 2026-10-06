import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";

const originalFetch = globalThis.fetch;
const originalBaseUrl = process.env.HIGGSFIELD_API_BASE_URL;
const originalKey = process.env.HIGGSFIELD_API_KEY;
const originalId = process.env.HF_API_KEY_ID;
const originalSecret = process.env.HF_API_KEY_SECRET;

process.env.HIGGSFIELD_API_BASE_URL = "https://api.higgsfield.ai";
delete process.env.HIGGSFIELD_API_KEY;
process.env.HF_API_KEY_ID = "test-id";
process.env.HF_API_KEY_SECRET = "test-secret";

const {
  generateHiggsfieldVideo,
  higgsfieldBaseUrl,
  extractHiggsfieldVideoUrl,
  getHiggsfieldStatus,
  cancelHiggsfieldRequest,
} = await import("../lib/video/higgsfield");

beforeEach(() => {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    return new Response(JSON.stringify({ request_id: "req-1", status: "queued", url: url.href, method: init?.method || "GET", authorization: init?.headers && new Headers(init.headers).get("Authorization") }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
});

test("uses the documented Higgsfield REST base URL by default", () => {
  delete process.env.HIGGSFIELD_API_BASE_URL;
  assert.equal(higgsfieldBaseUrl(), "https://api.higgsfield.ai");
  process.env.HIGGSFIELD_API_BASE_URL = "https://api.higgsfield.ai";
});

test("rejects an invalid Higgsfield base URL before making a request", () => {
  process.env.HIGGSFIELD_API_BASE_URL = "not-a-url";
  assert.throws(() => higgsfieldBaseUrl(), /base URL is invalid/);
  process.env.HIGGSFIELD_API_BASE_URL = "https://api.higgsfield.ai";
});

test("submits Wan 3.0 Prime image-to-video with the reference image and auth contract", async () => {
  let captured: { url: string; body: Record<string, unknown>; auth: string | null } | null = null;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    captured = {
      url: url.href,
      body: JSON.parse(String(init?.body)),
      auth: new Headers(init?.headers).get("Authorization"),
    };
    return new Response(JSON.stringify({ request_id: "req-1", status: "queued" }), { status: 200 });
  }) as typeof fetch;

  await generateHiggsfieldVideo({
    model: "alibaba/wan-3.0-prime/image-to-video",
    prompt: "product close-up",
    imageUrl: "https://storage.test/product.webp",
    duration: 5,
    resolution: "1080p",
    aspectRatio: "9:16",
    generateAudio: false,
  });

  assert.equal(captured?.url, "https://api.higgsfield.ai/alibaba/wan-3.0-prime/image-to-video");
  assert.equal(captured?.auth, "Key test-id:test-secret");
  assert.equal(captured?.body.image_url, "https://storage.test/product.webp");
  assert.equal(captured?.body.duration, 5);
  assert.equal(captured?.body.resolution, "1080p");
  assert.equal(captured?.body.aspect_ratio, "9:16");
  assert.equal(captured?.body.generate_audio, false);
});

test("falls back from image-to-video to text-to-video when no image exists", async () => {
  let requestedUrl = "";
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    requestedUrl = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url).href;
    return new Response(JSON.stringify({ request_id: "req-2", status: "queued" }), { status: 200 });
  }) as typeof fetch;

  await generateHiggsfieldVideo({
    model: "alibaba/wan-3.0-prime/image-to-video",
    prompt: "product close-up",
  });

  assert.equal(requestedUrl, "https://api.higgsfield.ai/alibaba/wan-3.0/text-to-video");
});

test("extracts the documented completed video response", () => {
  assert.equal(
    extractHiggsfieldVideoUrl({
      status: "completed",
      request_id: "req-1",
      video: { url: "https://cdn.test/video.mp4" },
    }),
    "https://cdn.test/video.mp4",
  );
  assert.equal(extractHiggsfieldVideoUrl({ status: "completed", video: { url: "not-a-url" } }), undefined);
});

test("status and cancel use the request lifecycle endpoints", async () => {
  const urls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    urls.push(new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url).href);
    return new Response(JSON.stringify({ request_id: "req-3", status: "queued" }), { status: 200 });
  }) as typeof fetch;

  await getHiggsfieldStatus("req-3");
  await cancelHiggsfieldRequest("req-3");

  assert.equal(urls[0], "https://api.higgsfield.ai/requests/req-3/status");
  assert.equal(urls[1], "https://api.higgsfield.ai/requests/req-3/cancel");
});

after(() => {
  globalThis.fetch = originalFetch;
  if (originalBaseUrl === undefined) delete process.env.HIGGSFIELD_API_BASE_URL;
  else process.env.HIGGSFIELD_API_BASE_URL = originalBaseUrl;
  if (originalKey === undefined) delete process.env.HIGGSFIELD_API_KEY;
  else process.env.HIGGSFIELD_API_KEY = originalKey;
  if (originalId === undefined) delete process.env.HF_API_KEY_ID;
  else process.env.HF_API_KEY_ID = originalId;
  if (originalSecret === undefined) delete process.env.HF_API_KEY_SECRET;
  else process.env.HF_API_KEY_SECRET = originalSecret;
});
