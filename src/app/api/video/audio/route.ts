import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { getUserFromBearer, consumeMonthlyUsage } from "@/lib/billing";
import { generateNarration } from "@/lib/video/gemini-tts";
import { generateBgm, mixNarrationWithBgm, pcmToWav, fitWavToDuration } from "@/lib/video/audio";

export const runtime = "nodejs";
export const maxDuration = 60;

const BUCKET = "audio-inputs";
const MAX_BYTES = 15 * 1024 * 1024;

export async function POST(request: Request) {
  try {
    const user = await getUserFromBearer(request);
    if (!user) return NextResponse.json({ error: "ログインが必要です。" }, { status: 401 });

    const body = await request.json();
    const text = typeof body.text === "string" ? body.text.trim() : "";
    const bgm = Boolean(body.bgm);
    const bgmPrompt = typeof body.bgmPrompt === "string" ? body.bgmPrompt.trim() : "";\n    const voice = typeof body.voice === "string" ? body.voice.trim() : "";
    const duration = Math.max(2, Math.min(30, Number(body.duration || 5)));

    if (!text && !bgm) {
      return NextResponse.json({ error: "ナレーション本文またはBGMを指定してください。" }, { status: 400 });
    }

    let audio: Uint8Array;
    let narrationModel = "";

    if (text) {
      const usage = await consumeMonthlyUsage(user.id, "narration_generation", 5);
      if (!usage.allowed) {
        return NextResponse.json({ error: `今月の無料ナレーション生成回数（${usage.limit}回）を使い切りました。Proへアップグレードしてください。`, usage }, { status: 429 });
      }

      const narration = await generateNarration({
        text,
        style: "Japanese commercial narration. Natural, clear, warm, confident, tightly paced for short-form advertising.",
      });
      narrationModel = narration.model;
      const narrationWav = new Uint8Array(Buffer.from(narration.audioBase64, "base64"));
      audio = bgm ? mixNarrationWithBgm(narrationWav, duration, bgmPrompt) : fitWavToDuration(narrationWav, duration);
    } else {
      audio = pcmToWav(generateBgm(duration, bgmPrompt));
    }

    if (audio.byteLength > MAX_BYTES) {
      return NextResponse.json({ error: "生成音声が大きすぎます。" }, { status: 413 });
    }

    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const serviceRole = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !serviceRole) throw new Error("Supabase configuration is incomplete.");

    const admin = createClient(url, serviceRole, { auth: { autoRefreshToken: false, persistSession: false } });
    const { data: buckets } = await admin.storage.listBuckets();
    if (!buckets?.some((bucket) => bucket.name === BUCKET)) {
      const created = await admin.storage.createBucket(BUCKET, {
        public: true,
        fileSizeLimit: MAX_BYTES,
        allowedMimeTypes: ["audio/wav"],
      });
      if (created.error && !created.error.message.toLowerCase().includes("already exists")) {
        throw new Error(created.error.message);
      }
    }

    const path = user.id + "/" + crypto.randomUUID() + ".wav";
    const uploaded = await admin.storage.from(BUCKET).upload(path, Buffer.from(audio), {
      contentType: "audio/wav",
      upsert: false,
      cacheControl: "3600",
    });
    if (uploaded.error) throw new Error(uploaded.error.message);

    const publicUrl = admin.storage.from(BUCKET).getPublicUrl(path).data.publicUrl;
    return NextResponse.json({
      ok: true,
      url: publicUrl,
      mimeType: "audio/wav",
      bytes: audio.byteLength,
      narrationModel: narrationModel || undefined,
      hasNarration: Boolean(text),
      hasBgm: bgm,
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "音声生成に失敗しました。" }, { status: 502 });
  }
}
