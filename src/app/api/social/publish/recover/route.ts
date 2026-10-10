import { NextResponse } from "next/server";
import { getAdminSupabase, getUserFromBearer } from "@/lib/billing";

export const runtime = "nodejs";

const PLATFORMS = ["tiktok", "instagram", "facebook", "youtube", "x", "linkedin"] as const;
type Platform = (typeof PLATFORMS)[number];

export async function POST(request: Request) {
  try {
    const user = await getUserFromBearer(request);
    if (!user) return NextResponse.json({ error: "ログインが必要です。" }, { status: 401 });

    const body = await request.json().catch(() => ({}));
    const socialPostId = typeof body.socialPostId === "string" ? body.socialPostId.trim() : "";
    const externalPostId = typeof body.externalPostId === "string" ? body.externalPostId.trim() : "";
    const postUrl = typeof body.postUrl === "string" ? body.postUrl.trim() : "";
    const platform = typeof body.platform === "string" ? body.platform.trim() : "";

    if (!socialPostId || !externalPostId || !platform || !PLATFORMS.includes(platform as Platform)) {
      return NextResponse.json(
        { error: "socialPostId、platform、externalPostId が必要です。" },
        { status: 400 },
      );
    }

    const db = getAdminSupabase();
    const { data: post, error: postError } = await db
      .from("social_posts")
      .select("id,user_id,network,status,metadata")
      .eq("id", socialPostId)
      .eq("user_id", user.id)
      .eq("network", platform)
      .maybeSingle();

    if (postError) throw postError;
    if (!post) return NextResponse.json({ error: "対象投稿が見つかりません。" }, { status: 404 });

    if (post.status === "published") {
      return NextResponse.json({
        ok: true,
        reused: true,
        externalPostId: post.metadata?.recovered_external_post_id ?? externalPostId,
      });
    }

    const metadata = {
      ...(post.metadata || {}),
      source_social_post_id: post.metadata?.source_social_post_id || null,
      manual_recovery_required: false,
      recovered_manually: true,
      recovered_external_post_id: externalPostId,
      recovered_at: new Date().toISOString(),
    };

    const { data: updated, error: updateError } = await db
      .from("social_posts")
      .update({
        external_post_id: externalPostId,
        post_url: postUrl || null,
        published_at: new Date().toISOString(),
        status: "published",
        metadata,
        updated_at: new Date().toISOString(),
      })
      .eq("id", post.id)
      .eq("user_id", user.id)
      .in("status", ["publishing", "pending", "failed"])
      .select("id,status,external_post_id,post_url")
      .single();

    if (updateError) throw updateError;

    return NextResponse.json({ ok: true, recovered: true, post: updated });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "SNS投稿の復旧に失敗しました。" },
      { status: 500 },
    );
  }
}
