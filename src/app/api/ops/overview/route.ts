import { NextResponse } from "next/server";
import { getAdminSupabase } from "@/lib/billing";
import { isMissingRelation, publicAccount, requireUser } from "@/lib/social/http";
import { DEFAULT_RULE, NETWORK_CAPABILITIES, parseRule } from "@/lib/social/queue";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const LIMITATIONS = [
  "TikTokの未審査アプリは、公式仕様により自分のみ公開（SELF_ONLY）しか選べないことがあります。全員公開にはTikTokのアプリ審査が必要です。",
  "動画は公式の FILE_UPLOAD で投稿します。画像投稿は PULL_FROM_URL だけで、TikTok側のドメイン所有確認が無いと失敗します。",
  "本文のみのTikTok投稿は公式APIの対象外です。",
  "再生数などの取得には video.list 権限が必要です。現在の接続にその権限が無い場合は、数値を推測しません。",
  "Instagram / Facebook / YouTube / X / LinkedIn は、ユーザーごとの公式OAuthをこのキューへ接続するまで投稿しません。",
  "予約と失敗の再試行は /api/cron/publish-queue を5分ごとに起動します。即時投稿は登録したリクエスト内でも処理します。Vercel Hobby はCronを1日1回に制限するため、そのプランでは外部スケジューラが必要です。",
];

export async function GET(request: Request) {
  const { user, error } = await requireUser(request);
  if (!user) return error;
  const db = getAdminSupabase();

  const [jobs, account, consent, rule, run] = await Promise.all([
    db.from("post_jobs").select("status").eq("user_id", user.id).limit(500),
    db.from("tiktok_accounts").select("open_id,display_name,avatar_url,scope,access_token_expires_at,refresh_token_expires_at,updated_at").eq("user_id", user.id).maybeSingle(),
    db.from("tiktok_publish_consents").select("consented_at").eq("user_id", user.id).maybeSingle(),
    db.from("posting_rules").select("timezone,max_per_day,weekdays,window_start,window_end,paused").eq("user_id", user.id).eq("network", "tiktok").maybeSingle(),
    db.from("scheduler_runs").select("started_at,finished_at,claimed,published,failed,deferred,pending,error").eq("job_name", "publish-queue").order("started_at", { ascending: false }).limit(1).maybeSingle(),
  ]);

  const missing = [jobs.error, account.error, rule.error, run.error].filter((item) => isMissingRelation(item));
  const realErrors = [jobs.error, account.error, consent.error, rule.error].filter((item) => item && !isMissingRelation(item));
  if (realErrors.length) {
    return NextResponse.json({ error: "運用状況の取得に失敗しました。" }, { status: 500 });
  }

  const counts: Record<string, number> = {};
  for (const row of jobs.data || []) counts[row.status] = (counts[row.status] || 0) + 1;
  const total = (jobs.data || []).length;
  const published = counts.published || 0;
  const failed = (counts.failed || 0) + (counts.needs_reauth || 0);
  const scheduled = (counts.queued || 0) + (counts.paused || 0) + (counts.awaiting_approval || 0) + (counts.pending || 0);
  const decided = published + (counts.failed || 0);
  const last = run.error || !run.data ? null : run.data;

  return NextResponse.json({
    migrationRequired: missing.length > 0,
    counts,
    dashboard: {
      total,
      published,
      failed,
      scheduled,
      successRate: decided ? Math.round((published / decided) * 1000) / 10 : null,
    },
    tiktok: publicAccount(account.data),
    consent: { consented: Boolean(consent.data), consentedAt: consent.data?.consented_at ?? null },
    rule: rule.data ? parseRule(rule.data) : { ...DEFAULT_RULE, weekdays: [...DEFAULT_RULE.weekdays] },
    ruleSaved: Boolean(rule.data),
    scheduler: last ? {
      running: false,
      lastStartedAt: last.started_at,
      lastFinishedAt: last.finished_at,
      claimed: last.claimed,
      published: last.published,
      failed: last.failed,
      deferred: last.deferred,
      pending: last.pending,
      error: last.error,
      schedule: "*/5 * * * *",
      nextEstimate: last.finished_at ? new Date(Date.parse(last.finished_at) + 300_000).toISOString() : null,
      note: "次回時刻は5分間隔のCronが入っている場合の目安です。最終実行が無いときは未稼働です。",
    } : {
      running: false,
      lastStartedAt: null,
      lastFinishedAt: null,
      schedule: "*/5 * * * *",
      nextEstimate: null,
      note: missing.length ? "投稿キューのテーブルが未適用です。マイグレーション後にCronが記録を残します。" : "スケジューラの実行記録がまだありません。",
    },
    networks: NETWORK_CAPABILITIES,
    limitations: LIMITATIONS,
  });
}
