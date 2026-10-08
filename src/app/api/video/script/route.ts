import { NextResponse } from "next/server";
import { getUserFromBearer } from "@/lib/billing";
import { openAiJson } from "@/lib/ai/openai-json";

export const runtime = "nodejs";
export const maxDuration = 30;

function fallbackScript(prompt: string, hook: string, value: string, duration: number) {
  const maxWords = Math.max(24, Math.round(duration * 4.2));
  const parts = [
    hook || "これ、知っておくと便利です。",
    prompt ? prompt.split("\n").map((v) => v.trim()).filter(Boolean)[0] : "",
    value ? "ポイントは " + value + " です。" : "",
    "気になる人は、商品ページで詳しい条件を確認してください。",
  ].filter(Boolean);
  return parts.join(" ").slice(0, Math.max(120, maxWords * 8));
}

export async function POST(request: Request) {
  try {
    const user = await getUserFromBearer(request);
    if (!user) return NextResponse.json({ error: "ログインが必要です。" }, { status: 401 });

    const body = await request.json();
    const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
    const hook = typeof body.hook === "string" ? body.hook.trim() : "";
    const value = typeof body.valueProposition === "string" ? body.valueProposition.trim() : "";
    const duration = Number(body.duration ?? 5);
    const language = typeof body.language === "string" ? body.language : "ja-JP";

    if (!prompt) return NextResponse.json({ error: "動画プロンプトが必要です。" }, { status: 400 });
    if (!Number.isFinite(duration) || duration < 2 || duration > 30) {
      return NextResponse.json({ error: "duration must be between 2 and 30 seconds" }, { status: 400 });
    }

    const maxChars = Math.max(80, Math.round(duration * 10.5));
    const ai = await openAiJson({
      system:
        "あなたは短尺広告のトップコピーライター兼AI Directorです。商品を誇張せず、入力情報から確認できる事実だけを使い、視聴開始直後に価値が伝わる自然な日本語ナレーションを設計してください。字幕用の説明ではなく、実際に声に出して自然な一続きの台本を作ります。JSONのみ返してください。形式は {\"script\":\"...\"}。",
      user: [
        "言語: " + language,
        "動画尺: " + duration + "秒",
        "ユーザープロンプト:",
        prompt,
        hook ? "分析済みフック: " + hook : "",
        value ? "分析済み価値提案: " + value : "",
        "制約:",
        "- 1文を短くし、話し言葉にする",
        "- 冒頭1〜2秒にフック",
        "- 1本につき主張は1つ",
        "- 未確認の効果、価格、ランキング、口コミを創作しない",
        "- 最後は押し付けないCTA",
        "- 目安 " + maxChars + "文字以内",
      ].filter(Boolean).join("\n"),
    });

    let script = "";
    if (ai) {
      try {
        const parsed = JSON.parse(ai) as { script?: unknown };
        if (typeof parsed.script === "string") script = parsed.script.trim();
      } catch {}
    }
    if (!script) script = fallbackScript(prompt, hook, value, duration);

    return NextResponse.json({ ok: true, script: script.slice(0, maxChars + 40), generatedByAi: Boolean(ai) });
  } catch (error) {
    return NextResponse.json({
      error: error instanceof Error ? error.message : "ナレーション台本の生成に失敗しました。",
    }, { status: 500 });
  }
}
