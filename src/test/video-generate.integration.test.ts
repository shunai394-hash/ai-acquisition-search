// Direct video generation route: quota charge/refund and job state when the
// provider or narration step fails. Supabase, billing, TTS and Higgsfield are stubbed.
import { beforeEach, mock, test } from "node:test";
import assert from "node:assert/strict";
import { FakeSupabase } from "./fake-supabase";

let db = new FakeSupabase();
const consumed: string[] = [];
const refunds: Array<{ eventType: string; usageEventId: string }> = [];
let higgsfield: "ok" | "error" = "ok";
let tts: "ok" | "error" = "ok";

const withStorage = () => Object.assign(db, {
  storage: {
    from: () => ({
      createSignedUrl: async (path: string) => ({ data: { signedUrl: `https://8.8.8.8/sign/${path}?token=t` }, error: null }),
    }),
  },
});

mock.module("@supabase/supabase-js", { namedExports: { createClient: () => withStorage() } });
mock.module("../lib/billing.ts", {
  namedExports: {
    getAdminSupabase: () => withStorage(),
    getUserFromBearer: async () => ({ id: "u1" }),
    consumeMonthlyUsage: async (_userId: string, eventType: string) => {
      consumed.push(eventType);
      return { allowed: true, usage_event_id: `ue-${eventType}` };
    },
    refundMonthlyUsage: async (_userId: string, eventType: string, usageEventId: string) => {
      refunds.push({ eventType, usageEventId });
      return { refunded: true };
    },
  },
});
mock.module("../lib/video/gemini-tts.ts", {
  namedExports: {
    generateNarration: async () => {
      if (tts === "error") throw new Error("TTS unavailable");
      // 1 second of 24kHz mono 16-bit silence as a WAV file.
      const pcm = new Int16Array(24_000);
      const { pcmToWav } = await import("../lib/video/audio.ts");
      return { model: "tts", voice: "Kore", mimeType: "audio/wav", audioBase64: Buffer.from(pcmToWav(pcm)).toString("base64") };
    },
  },
});
mock.module("../lib/video/storage.ts", {
  namedExports: {
    saveAudioToStorage: async ({ userId, jobId }: { userId: string; jobId: string }) => ({
      bucket: "video-audio", path: `${userId}/${jobId}.wav`, url: `https://8.8.8.8/sign/${userId}/${jobId}.wav?token=t`, bytes: 1, contentType: "audio/wav",
    }),
  },
});

process.env.NEXT_PUBLIC_SUPABASE_URL = "https://supabase.test";
process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role";
process.env.HF_API_KEY = "hf-key";

const higgsfieldBodies: Array<Record<string, unknown>> = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  if (url.host === "api.higgsfield.ai") {
    higgsfieldBodies.push(JSON.parse(String(init?.body || "{}")));
    if (higgsfield === "error") return new Response(JSON.stringify({ detail: "model overloaded" }), { status: 503 });
    return new Response(JSON.stringify({ request_id: "hf-1", status: "queued" }), { status: 200 });
  }
  return realFetch(input, init);
}) as typeof fetch;

const { POST: generate } = await import("../app/api/video/generate/route");

const request = (body: Record<string, unknown>) => new Request("https://app.test/api/video/generate", {
  method: "POST",
  headers: { "content-type": "application/json", authorization: "Bearer t" },
  body: JSON.stringify(body),
});

beforeEach(() => {
  db = new FakeSupabase();
  consumed.length = 0;
  refunds.length = 0;
  higgsfieldBodies.length = 0;
  higgsfield = "ok";
  tts = "ok";
});

test("image + narration + BGM: one job, audio and image references sent to a reference-to-video model", async () => {
  const res = await generate(request({
    prompt: "商品を手に取るUGC広告",
    imagePath: "u1/product.png",
    imageBucket: "video-inputs",
    narrationText: "朝の氷が夕方まで残ります。",
    includeBgm: true,
    duration: 5,
  }));
  const body = await res.json();
  assert.equal(res.status, 202, JSON.stringify(body));
  assert.deepEqual(consumed, ["video_generation", "narration_generation"]);
  assert.equal(refunds.length, 0);
  assert.equal(higgsfieldBodies.length, 1);
  assert.deepEqual(higgsfieldBodies[0].image_urls, ["https://8.8.8.8/sign/u1/product.png?token=t"]);
  assert.equal((higgsfieldBodies[0].audio_urls as string[]).length, 1);
  const job = db.table("production_jobs")[0] as { status: string; model: string; request_id: string; provider_response: Record<string, unknown> };
  assert.equal(job.status, "running");
  assert.equal(job.request_id, "hf-1");
  assert.match(job.model, /reference-to-video/);
  assert.equal(job.provider_response.provider_start_attempted, true);
  assert.equal(job.provider_response.input_audio_bucket, "video-audio");
});

test("provider start failure refunds both video and narration units and marks the job terminal", async () => {
  higgsfield = "error";
  const res = await generate(request({ prompt: "商品CM", narrationText: "ナレーション", includeBgm: false }));
  assert.equal(res.status, 500);
  assert.deepEqual(refunds.map((r) => r.eventType).sort(), ["narration_generation", "video_generation"]);
  const job = db.table("production_jobs")[0] as { status: string; provider_response: Record<string, unknown> };
  assert.equal(job.status, "failed");
  assert.equal(job.provider_response.terminal, true);
});

test("narration failure never calls the provider and refunds everything", async () => {
  tts = "error";
  const res = await generate(request({ prompt: "商品CM", narrationText: "ナレーション" }));
  assert.equal(res.status, 500);
  assert.equal(higgsfieldBodies.length, 0);
  assert.equal(refunds.length, 2);
});

test("another user's storage path is rejected before any quota is consumed", async () => {
  const res = await generate(request({ prompt: "商品CM", imagePath: "u2/product.png", imageBucket: "video-inputs" }));
  assert.equal(res.status, 400);
  assert.equal(consumed.length, 0);
});
