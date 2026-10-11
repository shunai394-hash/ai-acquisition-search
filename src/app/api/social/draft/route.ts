import { NextResponse } from "next/server";
import { getAdminSupabase, getUserFromBearer } from "@/lib/billing";

export const runtime = "nodejs";

const SUPPORTED_PLATFORMS = ["tiktok", "instagram", "facebook", "youtube", "x", "linkedin"] as const;
type Platform = (typeof SUPPORTED_PLATFORMS)[number];

export async function POST(request: Request) {
  try {
    const user = await getUserFromBearer(request);
    if (!user) return NextResponse.json({ error: "ログインが必要です。" }, { status: 401 });

    const body = await request.json().catch(() => null);
    if (!body || typeof body !== "object") {
      return NextResponse.json({ error: "動画プロジェクトの情報が必要です。" }, { status: 400 });
    }

    const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
    const caption = typeof body.caption === "string" ? body.caption.trim() : "";
    const network = typeof body.network === "string" ? body.network.trim() : "";
    const draftKey = typeof body.draftKey === "string" ? body.draftKey.trim() : "";

    if (prompt.length < 8 || prompt.length > 10000) {
      return NextResponse.json({ error: "プロンプトは8〜10,000文字で入力してください。" }, { status: 400 });
    }
    if (caption.length > 2200) {
      return NextResponse.json({ error: "投稿本文は2,200文字以内で入力してください。" }, { status: 400 });
    }
    if (!SUPPORTED_PLATFORMS.includes(network as Platform)) {
      return NextResponse.json({ error: "対応しているSNSを選択してください。" }, { status: 400 });
    }
    if (!draftKey || draftKey.length > 100) {
      return NextResponse.json({ error: "下書きIDが不正です。" }, { status: 400 });
    }

    const db = getAdminSupabase();
    const { data: existing, error: existingError } = await db
      .from("social_posts")
      .select("id")
      .eq("user_id", user.id)
      .filter("metadata->>draft_key", "eq", draftKey)
      .maybeSingle();
    if (existingError) throw existingError;
    if (existing) return NextResponse.json({ ok: true, socialPostId: existing.id, reused: true });

    const { data, error } = await db.from("social_posts").insert({
      creative_id: null,
      user_id: user.id,
      network,
      status: "planned",
      caption: caption || prompt.slice(0, 2200),
      metadata: {
        source_type: "prompt_video",
        draft_key: draftKey,
        production_prompt: prompt,
      },
    }).select("id").single();

    if (error) {
      // If simultaneous retries raced, return the row already written by the other request.
      if (error.code === "23505") {
        const { data: raced, error: racedError } = await db
          .from("social_posts")
          .select("id")
          .eq("user_id", user.id)
          .filter("metadata->>draft_key", "eq", draftKey)
          .maybeSingle();
        if (!racedError && raced) return NextResponse.json({ ok: true, socialPostId: raced.id, reused: true });
      }
      throw error;
    }

    return NextResponse.json({ ok: true, socialPostId: data.id, reused: false });
  } catch (error) {
    console.error("prompt-first social draft creation failed", error);
    return NextResponse.json({ error: "SNS投稿用の動画プロジェクトを保存できませんでした。" }, { status: 500 });
  }
}
