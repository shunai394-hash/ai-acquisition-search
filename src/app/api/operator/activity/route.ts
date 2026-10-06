import { NextResponse } from "next/server";
import { getAdminSupabase, getUserFromBearer } from "@/lib/billing";
import { buildActivity } from "@/lib/operator/activity";

export const runtime = "nodejs";
export const maxDuration = 15;

/**
 * Read-only view of the user's autonomous loop. Four parallel queries, every
 * one scoped to the signed-in user; no per-row lookups.
 */
export async function GET(request: Request) {
  try {
    const user = await getUserFromBearer(request);
    if (!user) return NextResponse.json({ error: "ログインが必要です。" }, { status: 401 });
    const db = getAdminSupabase();

    const [posts, decision, jobs, patrol] = await Promise.all([
      db.from("social_posts")
        .select("id,network,status,external_post_id,published_at,created_at,updated_at,metadata")
        .eq("user_id", user.id)
        .order("created_at", { ascending: false })
        .limit(30),
      db.from("operator_runs")
        .select("id,output,completed_at")
        .eq("user_id", user.id)
        .eq("run_type", "ai_performance_verdict")
        .not("completed_at", "is", null)
        .order("completed_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
      db.from("production_jobs")
        .select("id,status,provider_response,created_at,updated_at")
        .eq("user_id", user.id)
        .order("created_at", { ascending: false })
        .limit(8),
      db.from("operator_runs")
        .select("output,completed_at")
        .eq("user_id", user.id)
        .eq("run_type", "ai_patrol")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
    ]);
    const failed = [posts, decision, jobs, patrol].find((result) => result.error);
    if (failed?.error) {
      console.error("operator activity query failed", failed.error);
      return NextResponse.json({ error: "自動運用の状況を取得できませんでした。時間を置いて再読み込みしてください。" }, { status: 503 });
    }

    const view = buildActivity({
      posts: (posts.data ?? []) as Array<Record<string, unknown>>,
      decision: (decision.data ?? null) as Record<string, unknown> | null,
      jobs: (jobs.data ?? []) as Array<Record<string, unknown>>,
      patrol: (patrol.data ?? null) as Record<string, unknown> | null,
    });
    return NextResponse.json({ ok: true, ...view }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("operator activity error", error);
    return NextResponse.json({ error: "自動運用の状況を取得できませんでした。" }, { status: 500 });
  }
}
