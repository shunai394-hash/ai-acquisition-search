import { NextRequest, NextResponse } from "next/server";
import { generateNarration } from "@/lib/video/gemini-tts";
import {
  consumeMonthlyUsage,
  getUserFromBearer,
  refundMonthlyUsage,
} from "@/lib/billing";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(request: NextRequest) {
  let userId = "";
  let usageEventId = "";

  try {
    const user = await getUserFromBearer(request);
    if (!user) {
      return NextResponse.json({ error: "ログインが必要です。" }, { status: 401 });
    }
    userId = user.id;

    const body = await request.json();
    const text = typeof body?.text === "string" ? body.text.trim() : "";
    if (!text) {
      return NextResponse.json({ error: "ナレーション本文を入力してください。" }, { status: 400 });
    }
    // Keep the API limit aligned with generateNarration() so rejected requests
    // never consume a quota unit.
    if (text.length > 8000) {
      return NextResponse.json({ error: "ナレーション本文は8000文字以内にしてください。" }, { status: 400 });
    }

    const voice = typeof body?.voice === "string" ? body.voice.trim() : undefined;
    const style = typeof body?.style === "string" ? body.style.trim() : undefined;
    if (voice && voice.length > 100) {
      return NextResponse.json({ error: "音声設定が長すぎます。" }, { status: 400 });
    }
    if (style && style.length > 500) {
      return NextResponse.json({ error: "ナレーションのスタイル設定は500文字以内にしてください。" }, { status: 400 });
    }

    const usage = await consumeMonthlyUsage(user.id, "narration_generation", 5);
    if (!usage.allowed) {
      return NextResponse.json({
        error: `今月の無料ナレーション生成回数（${usage.limit}回）を使い切りました。Proへアップグレードしてください。`,
        usage,
      }, { status: 429 });
    }
    usageEventId = usage.usage_event_id || "";

    const result = await generateNarration({ text, voice, style });

    return NextResponse.json({
      data: {
        model: result.model,
        voice: result.voice,
        mimeType: result.mimeType,
        audioBase64: result.audioBase64,
      },
    });
  } catch (error) {
    const message = error instanceof Error
      ? error.message
      : "ナレーション生成に失敗しました。";

    // TTS provider errors should not charge the user. The refund RPC is
    // idempotent; log failures so they can be retried/investigated.
    if (userId && usageEventId) {
      try {
        const refund = await refundMonthlyUsage(userId, "narration_generation", usageEventId);
        if (!refund.refunded && refund.reason) {
          console.warn("narration quota refund was not applied", {
            userId,
            usageEventId,
            reason: refund.reason,
          });
        }
      } catch (refundError) {
        console.error("narration quota refund failed", {
          userId,
          usageEventId,
          error: refundError instanceof Error ? refundError.message : String(refundError),
        });
      }
    }

    return NextResponse.json({ error: message }, { status: 502 });
  }
}
