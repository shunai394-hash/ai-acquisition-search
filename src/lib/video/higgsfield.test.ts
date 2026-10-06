import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { extractHiggsfieldVideoUrl, generateHiggsfieldVideo, getHiggsfieldStatus, higgsfieldBaseUrl } from "./higgsfield";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; delete process.env.HIGGSFIELD_API_BASE_URL; });

test("requests go to the documented API host with the model path and Key auth", async () => {
  process.env.HF_API_KEY = "k:s";
  const calls: Array<{ url: string; auth: string | null }> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), auth: new Headers(init?.headers).get("authorization") });
    return Response.json({ request_id: "r1", status: "queued" });
  }) as typeof fetch;
  await generateHiggsfieldVideo({ prompt: "p", model: "/alibaba/wan-3.0-prime/image-to-video/", imageUrl: "https://img.test/a.webp" });
  await getHiggsfieldStatus("r 1");
  assert.equal(higgsfieldBaseUrl(), "https://api.higgsfield.ai");
  assert.equal(calls[0].url, "https://api.higgsfield.ai/alibaba/wan-3.0-prime/image-to-video");
  assert.equal(calls[1].url, "https://api.higgsfield.ai/requests/r%201/status");
  assert.equal(calls[0].auth, "Key k:s");
  delete process.env.HF_API_KEY;
});

test("an image-to-video model without an image falls back to text-to-video instead of failing", async () => {
  process.env.HF_API_KEY = "k:s";
  let url = "";
  globalThis.fetch = (async (input: RequestInfo | URL) => { url = String(input); return Response.json({ request_id: "r" }); }) as typeof fetch;
  await generateHiggsfieldVideo({ prompt: "p", model: "alibaba/wan-3.0-prime/image-to-video" });
  assert.match(url, /\/alibaba\/wan-3\.0\/text-to-video$/);
  delete process.env.HF_API_KEY;
});

test("base URL can be overridden for a regional or proxy endpoint", () => {
  process.env.HIGGSFIELD_API_BASE_URL = "https://hf.example.test/";
  assert.equal(higgsfieldBaseUrl(), "https://hf.example.test");
});

test("video URL is found in object, array and job-result shapes, and only http(s) is accepted", () => {
  assert.equal(extractHiggsfieldVideoUrl({ video: { url: "https://cdn/a.mp4" } }), "https://cdn/a.mp4");
  assert.equal(extractHiggsfieldVideoUrl({ video: [{ url: "https://cdn/b.mp4" }] }), "https://cdn/b.mp4");
  assert.equal(extractHiggsfieldVideoUrl({ videos: [{ url: "https://cdn/c.mp4" }] }), "https://cdn/c.mp4");
  assert.equal(extractHiggsfieldVideoUrl({ jobs: [{ results: { raw: { url: "https://cdn/d.mp4" } } }] }), "https://cdn/d.mp4");
  assert.equal(extractHiggsfieldVideoUrl({ video: { url: "file:///etc/passwd" } }), undefined);
  assert.equal(extractHiggsfieldVideoUrl({}), undefined);
});

test("provider errors are safe for user-facing storage", async () => {
  process.env.HF_API_KEY = "k:s";
  globalThis.fetch = (async () => Response.json(
    { detail: "internal provider detail", secret: "should-not-leak" },
    { status: 502 },
  )) as typeof fetch;
  await assert.rejects(
    () => generateHiggsfieldVideo({ prompt: "p" }),
    (error: unknown) => {
      assert.equal(error instanceof Error, true);
      assert.equal((error as Error).message, "Higgsfield API error 502");
      assert.equal((error as Error).message.includes("should-not-leak"), false);
      return true;
    },
  );
  delete process.env.HF_API_KEY;
});
