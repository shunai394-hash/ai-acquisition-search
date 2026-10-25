import { NextResponse } from "next/server";
import { getAdminSupabase } from "@/lib/billing";
import { acquireLease, releaseLease } from "@/lib/ops/lease";
import { unauthorizedCron, verifyCronRequest } from "@/lib/security/cron-auth";
import { pollQueuedTikTok, publishQueuedTikTok } from "@/lib/social/dispatch";
import { redactError } from "@/lib/social/queue";
import { processDueJobs } from "@/lib/social/worker";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(request: Request) {
  const auth = verifyCronRequest(request);
  if (!auth.ok) return unauthorizedCron(auth);
  const db = getAdminSupabase();
  const started = new Date();
  const lease = await acquireLease(db, "publish-queue", 4 * 60 * 1000);
  if (!lease.acquired) {
    return NextResponse.json({ ok: true, skipped: true, reason: "lease_held" });
  }

  const record = async (patch: Record<string, unknown>) => {
    const { error } = await db.from("scheduler_runs").insert({
      job_name: "publish-queue",
      started_at: started.toISOString(),
      finished_at: new Date().toISOString(),
      ...patch,
    });
    if (error) console.error("scheduler_runs insert failed", error.code || "unknown");
  };

  try {
    const summary = await processDueJobs(db, {
      limit: 2,
      publish: publishQueuedTikTok,
      poll: async (job) => pollQueuedTikTok(job.user_id, String(job.external_post_id || "")),
    });
    await record({
      claimed: summary.claimed,
      published: summary.published,
      failed: summary.failed,
      deferred: summary.deferred,
      pending: summary.pending,
    });
    return NextResponse.json({ ok: true, ...summary, results: summary.results.map((item) => ({ id: item.id, status: item.status })) });
  } catch (error) {
    const message = redactError(error instanceof Error ? error.message : "publish queue failed");
    await record({ error: message });
    console.error("publish queue failed", message);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  } finally {
    await releaseLease(db, "publish-queue", lease);
  }
}
