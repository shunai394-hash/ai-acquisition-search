import { mock, test } from "node:test";
import assert from "node:assert/strict";

const uploads: Array<{ path: string; bytes: number; contentType: string }> = [];

mock.module("@/lib/security/public-url", {
  namedExports: {
    fetchPublicUrl: async () => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([0, 0, 0, 1]));
          controller.close();
        },
      });
      return new Response(body, {
        status: 200,
        headers: { "content-type": "video/mp4" },
      });
    },
  },
});

mock.module("@supabase/supabase-js", {
  namedExports: {
    createClient: () => ({
      storage: {
        from: () => ({
          upload: async (path: string, data: ArrayBuffer, options: { contentType: string }) => {
            uploads.push({ path, bytes: data.byteLength, contentType: options.contentType });
            return { data: { path }, error: null };
          },
          getPublicUrl: (path: string) => ({ data: { publicUrl: `https://cdn.test/${path}` } }),
          remove: async () => ({ error: null }),
        }),
      },
    }),
  },
});

process.env.NEXT_PUBLIC_SUPABASE_URL = "https://db.test";
process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role";

const { saveVideoToStorage } = await import("./storage");

test("stores bounded video responses as video assets", async () => {
  uploads.length = 0;
  const result = await saveVideoToStorage({ userId: "u1", jobId: "j1", sourceUrl: "https://cdn.test/video.mp4" });
  assert.equal(result.contentType, "video/mp4");
  assert.equal(result.bytes, 4);
  assert.deepEqual(uploads, [{ path: "u1/j1.mp4", bytes: 4, contentType: "video/mp4" }]);
});
