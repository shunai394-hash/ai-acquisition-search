import assert from "node:assert/strict";
import { mock, test } from "node:test";

mock.module("../lib/billing.ts", {
  namedExports: {
    getAdminSupabase: () => {
      throw new Error("TikTok file upload should not access Supabase directly");
    },
  },
});

const { publishTikTokVideo } = await import("../lib/social/tiktok.ts");

test("TikTok falls back to bounded FILE_UPLOAD when PULL_FROM_URL ownership is unverified", async () => {
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; method: string; headers: Headers; body?: BodyInit | null }> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method || "GET";
    const headers = new Headers(init?.headers);
    calls.push({ url, method, headers, body: init?.body });

    if (url.includes("/post/publish/creator_info/query/")) {
      return Response.json({ error: { code: "ok" }, data: { privacy_level_options: ["SELF_ONLY"], creator_username: "creator" } });
    }
    if (url.includes("/post/publish/video/init/") && calls.filter((call) => call.url.includes("/post/publish/video/init/")).length === 1) {
      return Response.json({ error: { code: "url_ownership_unverified", message: "Verify the media URL" } }, { status: 403 });
    }
    if (url.startsWith("https://proj.supabase.co/storage/")) {
      return new Response(new Uint8Array([1, 2, 3, 4, 5, 6]), {
        status: 200,
        headers: { "content-type": "video/mp4", "content-length": "6" },
      });
    }
    if (url.includes("/post/publish/video/init/")) {
      return Response.json({
        error: { code: "ok" },
        data: {
          publish_id: "publish-file-1",
          upload_url: "https://open-upload.tiktokapis.com/video/?upload_id=123&upload_token=secret",
        },
      });
    }
    if (url.startsWith("https://open-upload.tiktokapis.com/") && method === "PUT") {
      return new Response(null, { status: 200 });
    }
    throw new Error("Unexpected mocked fetch: " + method + " " + url);
  }) as typeof fetch;

  try {
    const result = await publishTikTokVideo({
      accessToken: "test-access-token",
      videoUrl: "https://proj.supabase.co/storage/v1/object/sign/video-assets/u1/job.mp4?token=signed",
      title: "Test post",
      privacyLevel: "SELF_ONLY",
    });

    assert.equal(result.publishId, "publish-file-1");
    assert.equal(result.privacyLevel, "SELF_ONLY");
    assert.equal(result.creatorUsername, "creator");

    const initCalls = calls.filter((call) => call.url.includes("/post/publish/video/init/"));
    assert.equal(initCalls.length, 2);
    assert.equal(JSON.parse(String(initCalls[0].body)).source_info.source, "PULL_FROM_URL");
    const fileInit = JSON.parse(String(initCalls[1].body));
    assert.equal(fileInit.source_info.source, "FILE_UPLOAD");
    assert.equal(fileInit.source_info.video_size, 6);
    assert.equal(fileInit.source_info.chunk_size, 6);
    assert.equal(fileInit.source_info.total_chunk_count, 1);

    const upload = calls.find((call) => call.method === "PUT");
    assert.ok(upload);
    assert.equal(upload.headers.get("content-range"), "bytes 0-5/6");
    assert.equal(upload.headers.get("content-length"), "6");
    assert.equal(upload.headers.get("content-type"), "video/mp4");
    assert.deepEqual(Buffer.from(upload.body as Uint8Array), Buffer.from([1, 2, 3, 4, 5, 6]));
  } finally {
    globalThis.fetch = originalFetch;
  }
});
