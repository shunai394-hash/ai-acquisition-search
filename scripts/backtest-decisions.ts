// AI Decision のバックテスト（読み取り専用）。
// 使い方: NEXT_PUBLIC_SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... npx tsx scripts/backtest-decisions.ts [件数]
// 各投稿の実績スナップショット時点を asOf とし、その時点までのデータだけで判定し、
// 最終データでの判定と比較する。DB には一切書き込まない。
import { getAdminSupabase } from "../src/lib/billing";
import { loadDecisionContext } from "../src/lib/operator/evidence";
import { runBacktest, type BacktestEpisode } from "../src/lib/operator/backtest";

async function main() {
  const limit = Math.max(1, Number(process.argv[2] || 100));
  const db = getAdminSupabase();
  const { data: posts, error } = await db.from("social_posts")
    .select("id,user_id,metadata,published_at")
    .not("external_post_id", "is", null)
    .not("published_at", "is", null)
    .order("published_at", { ascending: false })
    .limit(limit);
  if (error) throw error;

  const episodes: BacktestEpisode[] = [];
  for (const post of posts ?? []) {
    const { data: snapshots } = await db.from("post_metrics").select("measured_at")
      .eq("social_post_id", post.id).order("measured_at", { ascending: true }).limit(20);
    if (!snapshots?.length) continue;
    const hindsight = await loadDecisionContext(db, { userId: post.user_id, socialPostId: post.id, includeMarket: false });
    if (!hindsight) continue;
    const meta = (post.metadata ?? {}) as Record<string, unknown>;
    const lineageKey = String(meta.source_social_post_id ?? post.id);
    for (const snap of snapshots) {
      const atDecision = await loadDecisionContext(db, { userId: post.user_id, socialPostId: post.id, asOf: snap.measured_at, includeMarket: false });
      if (atDecision) episodes.push({ postId: post.id, lineageKey, atDecision, hindsight });
    }
  }

  const report = runBacktest(episodes);
  console.log(JSON.stringify({ ...report, details: report.details.slice(0, 50) }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
