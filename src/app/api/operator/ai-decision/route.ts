import { NextResponse } from "next/server";
import { getAdminSupabase, getUserFromBearer } from "@/lib/billing";
import { decideForPost, legacyFields } from "@/lib/operator/decide";

export const runtime = "nodejs";
export const maxDuration = 60;

// AI Decision:
// 商品・顧客仮説・EC-Pulse の市場シグナル・投稿実績・過去比較を Evidence として集め、
// Teacher の決定論的ルールで CONTINUE / PIVOT / STOP / WAIT を判定し、
// 次に行うことを構造化して operator_runs に保存する。
export async function POST(request: Request) {
  try {
    const user = await getUserFromBearer(request);
    if (!user) return NextResponse.json({ error: "ログインが必要です。" }, { status: 401 });
    const body = await request.json().catch(() => ({})) as { socialPostId?: string; productId?: string };
    if (!body.socialPostId) return NextResponse.json({ error: "socialPostIdが必要です。" }, { status: 400 });

    const db = getAdminSupabase();
    const result = await decideForPost(db, { userId: user.id, socialPostId: body.socialPostId, productId: body.productId });
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });

    return NextResponse.json({
      ok: true,
      runId: result.runId,
      reused: result.reused,
      ...legacyFields(result.decision),
      decision: result.decision,
    });
  } catch (error) {
    console.error("ai decision error", error);
    return NextResponse.json({ error: error instanceof Error ? error.message : "AI判定に失敗しました。" }, { status: 500 });
  }
}
