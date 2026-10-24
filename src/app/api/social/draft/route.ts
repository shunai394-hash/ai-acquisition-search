import { NextResponse } from "next/server";
import { getAdminSupabase, getUserFromBearer } from "@/lib/billing";
import { validateSocialDraftInput } from "@/lib/social/draft-validation";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const user = await getUserFromBearer(request);
    if (!user) return NextResponse.json({ error: "ログインが必要です。" }, { status: 401 });

    const body = await request.json().catch(() => null);
    const validation = validateSocialDraftInput(body);
    if (!validation.ok) {
      return NextResponse.json({ error: validation.error }, { status: 400 });
    }
    const { prompt, caption, network, draftKey } = validation.value;

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
