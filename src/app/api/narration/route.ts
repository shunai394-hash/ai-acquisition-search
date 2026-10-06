import { NextRequest, NextResponse } from "next/server";
import { generateNarration } from "@/lib/video/gemini-tts";
import { consumeMonthlyUsage, getUserFromBearer } from "@/lib/billing";
import { saveAudioToStorage } from "@/lib/video/storage";
import { mixNarrationWithBgm } from "@/lib/video/audio";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  try {
    const user = await getUserFromBearer(request);
    if (!user) return NextResponse.json({ error: "ログインが必要です。" }, { status: 401 });
    const body = await request.json();

    const text = typeof body?.text === "string" ? body.text : "";
    if (!text.trim()) return NextResponse.json({ error: "text is required" }, { status: 400 });
    if (text.length > 10000) return NextResponse.json({ error: "text is too long" }, { status: 400 });
    const usage = await consumeMonthlyUsage(user.id, "narration_generation", 5);
    if (!usage.allowed) return NextResponse.json({ error: `今月の無料ナレーション生成回数（${usage.limit}回）を使い切りました。Proへアップグレードしてください。`, usage }, { status: 429 });
    const voice = typeof body?.voice === "string" ? body.voice : undefined;
    const style = typeof body?.style === "string" ? body.style : undefined;
    const withBgm = body?.withBgm === true;
    const bgmPrompt = typeof body?.bgmPrompt === "string" ? body.bgmPrompt.slice(0, 500) : "";
    const persist = body?.persist !== false;

    const result = await generateNarration({ text, voice, style });
    const rawAudio = Buffer.from(result.audioBase64, "base64");
    const finalAudio = withBgm
      ? mixNarrationWithBgm(new Uint8Array(rawAudio), Number(body?.duration || 15), bgmPrompt)
      : new Uint8Array(rawAudio);
    const finalBase64 = Buffer.from(finalAudio).toString("base64");
    const audio = persist
      ? await saveAudioToStorage({ userId: user.id, assetId: crypto.randomUUID(), bytes: finalAudio, contentType: "audio/wav" })
      : null;

    return NextResponse.json({
      data: {
        model: result.model,
        voice: result.voice,
        mimeType: result.mimeType,
        audioBase64: finalBase64,
        audioUrl: audio?.url ?? null,
        withBgm,
      },
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "ナレーション生成に失敗しました。";

    return NextResponse.json({ error: message }, { status: 502 });
  }
}
