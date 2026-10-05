import { NextResponse } from "next/server";
import { getAdminSupabase } from "@/lib/billing";
import { openAiJson } from "@/lib/ai/openai-json";
import { acquireLease, releaseLease } from "@/lib/ops/lease";
import { cronSecret, unauthorizedCron, verifyCronRequest } from "@/lib/security/cron-auth";
import { settledPatch } from "@/lib/video/job-state";

export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * Time budget inside maxDuration: the operator loop call is cut off first (the
 * loop keeps running in its own invocation under its own lease), so the
 * stale-job audit, the supervisor summary and the report are always written.
 */
const LOOP_CALL_TIMEOUT_MS = 200_000;
const SUPERVISOR_TIMEOUT_MS = 15_000;

function productionHost() {
  const host = process.env.VERCEL_PROJECT_PRODUCTION_URL;
  if (!host) throw new Error("VERCEL_PROJECT_PRODUCTION_URL is not configured.");
  return host.replace(/^https?:\/\//, "");
}

async function callOperatorLoop() {
  const response = await fetch(`https://${productionHost()}/api/cron/operator-loop`, {
    headers: {
      Authorization: `Bearer ${cronSecret()}`,
      ...(process.env.VERCEL_AUTOMATION_BYPASS_SECRET
        ? { "x-vercel-protection-bypass": process.env.VERCEL_AUTOMATION_BYPASS_SECRET }
        : {}),
    },
    cache: "no-store",
    redirect: "manual",
    signal: AbortSignal.timeout(LOOP_CALL_TIMEOUT_MS),
  });
  if (response.status >= 300 && response.status < 400) {
    throw new Error(`operator-loop was redirected (HTTP ${response.status}). Check Vercel Deployment Protection and VERCEL_AUTOMATION_BYPASS_SECRET.`);
  }
  const payload = await response.json().catch(() => ({}));
  return { status: response.status, payload: payload as Record<string, unknown> };
}

async function supervisorDecision(input: unknown) {
  const text = await openAiJson({
    system: "あなたはAI集客システムの巡回監督です。観測値だけを使い、異常・修復結果・未解決事項をJSONで要約してください。作業していないことを修復済みと書かないでください。severityはhealthy|attention|critical。",
    user: JSON.stringify(input),
    timeoutMs: SUPERVISOR_TIMEOUT_MS,
  });
  if (!text) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const value = parsed as Record<string, unknown>;
    // The model only phrases the summary; severity is never allowed to look healthier than observed.
    return {
      severity: ["healthy", "attention", "critical"].includes(String(value.severity)) ? String(value.severity) as Severity : null,
      summary: typeof value.summary === "string" ? value.summary.slice(0, 500) : null,
      next_check: typeof value.next_check === "string" ? value.next_check.slice(0, 200) : null,
    };
  } catch {
    return null;
  }
}

type Severity = "healthy" | "attention" | "critical";
const SEVERITY_RANK: Record<Severity, number> = { healthy: 0, attention: 1, critical: 2 };
type Repair = { target: string; action: string; status: "failed" | "repaired" | "skipped" | "pending"; id?: string; userId?: string; error?: string };

const LEASE_NAME = "ai-patrol";

export async function GET(request: Request) {
  const auth = verifyCronRequest(request);
  if (!auth.ok) return unauthorizedCron(auth);

  const db = getAdminSupabase();
  const lease = await acquireLease(db, LEASE_NAME, (maxDuration + 10) * 1000);
  if (!lease.acquired) {
    return NextResponse.json({ ok: true, skipped: true, reason: "ai-patrol is already running", leaseExpiresAt: lease.expiresAt });
  }
  try {
    return await runPatrol(db);
  } finally {
    await releaseLease(db, LEASE_NAME, lease).catch((error) => console.error("ai-patrol lease release failed", error));
  }
}

function observedSeverity(repairs: Repair[], loopOk: boolean): Severity {
  if (repairs.some((repair) => repair.status === "failed") || !loopOk) return "critical";
  if (repairs.some((repair) => repair.status === "repaired" || repair.status === "pending")) return "attention";
  return "healthy";
}

async function runPatrol(db: ReturnType<typeof getAdminSupabase>) {
  const checkedAt = new Date().toISOString();
  const repairs: Repair[] = [];

  let loop = { status: 0, payload: {} as Record<string, unknown> };
  try {
    loop = await callOperatorLoop();
  } catch (error) {
    const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
    repairs.push(timedOut
      ? { target: "operator-loop", action: "巡回実行", status: "pending", error: "operator-loopの応答待ちを打ち切りました。ループ自体は独立して実行を続けます。" }
      : { target: "operator-loop", action: "巡回実行", status: "failed", error: error instanceof Error ? error.message : String(error) });
  }
  const loopOk = (loop.status >= 200 && loop.status < 300) || repairs.some((repair) => repair.target === "operator-loop" && repair.status === "pending");

  const staleCutoff = new Date(Date.now() - 30 * 60 * 1000).toISOString();
  const { data: staleJobs, error: staleError } = await db.from("production_jobs")
    .select("id,user_id,status,request_id,started_at,provider_response")
    .eq("status", "running").lt("started_at", staleCutoff).limit(50);

  if (staleError) {
    repairs.push({ target: "production_jobs", action: "stale監査", status: "failed", error: staleError.message });
  } else {
    for (const job of staleJobs || []) {
      const meta = job.provider_response && typeof job.provider_response === "object" ? job.provider_response as Record<string, unknown> : {};
      if (job.request_id) {
        // The status route times these out and the loop retries them.
        repairs.push({ target: "production_job", id: job.id, userId: job.user_id, action: "外部生成中のため変更せず監視", status: "skipped" });
        continue;
      }
      const { error } = await db.from("production_jobs").update({
        status: "failed",
        error: "巡回AI: 30分以上runningのままrequest_idが存在しないため、外部生成の重複実行を避けて手動復旧対象に変更。",
        provider_response: settledPatch(meta, "manual_recovery_required", { patrol_repair: true, manual_recovery_required: true, patrol_repaired_at: checkedAt }),
        updated_at: checkedAt,
      }).eq("id", job.id).eq("status", "running").is("request_id", null);
      repairs.push({ target: "production_job", id: job.id, userId: job.user_id, action: "staleジョブを安全なmanual-recoveryへ変更", status: error ? "failed" : "repaired", error: error?.message });
    }
  }

  const { data: posts, error: postsError } = await db.from("social_posts")
    .select("id,user_id,status,network,metadata,created_at")
    .in("status", ["planned", "scheduled", "published"])
    .order("created_at", { ascending: false }).limit(100);

  if (postsError) repairs.push({ target: "social_posts", action: "patrol-chain監査", status: "failed", error: postsError.message });

  type Counts = { active: number; stopped: number; superseded: number; stalled: number; unmanaged: number };
  const emptyCounts = (): Counts => ({ active: 0, stopped: 0, superseded: 0, stalled: 0, unmanaged: 0 });
  const counts = emptyCounts();
  const countsByUser = new Map<string, Counts>();
  for (const post of posts || []) {
    const metadata = post.metadata && typeof post.metadata === "object" ? post.metadata as Record<string, unknown> : {};
    const status = String(metadata.operator_patrol_status || "");
    const key: keyof Counts = status === "active" || status === "stopped" || status === "superseded" || status === "stalled" ? status : "unmanaged";
    counts[key]++;
    if (post.user_id) {
      const own = countsByUser.get(post.user_id) ?? emptyCounts();
      own[key]++;
      countsByUser.set(post.user_id, own);
    }
  }
  const users = [...countsByUser.keys()];

  const severity = observedSeverity(repairs, loopOk);
  const loopSummary = {
    status: loop.status,
    checked: loop.payload.checked ?? null,
    processed: loop.payload.processed ?? null,
    attention: loop.payload.attention ?? null,
    skipped: loop.payload.skipped === true,
    timeBudgetExceeded: loop.payload.timeBudgetExceeded === true,
  };
  const reportInput = { checkedAt, operatorLoop: loopSummary, patrolCounts: counts, staleJobs: staleJobs?.length || 0, repairs, usersChecked: users.length };
  const ai = await supervisorDecision(reportInput);
  // The supervisor may escalate severity, never downgrade what was observed.
  const finalSeverity: Severity = ai?.severity && SEVERITY_RANK[ai.severity] > SEVERITY_RANK[severity] ? ai.severity : severity;
  const fallbackSummary = severity === "critical"
    ? "巡回中に修復できない異常が残っています。"
    : repairs.some((x) => x.status === "repaired")
      ? "巡回AIが安全に修復できる異常を修復し、結果を記録しました。"
      : "巡回・監査・修復対象に重大な異常はありません。";
  const report = {
    patrol: "ai-patrol-v2", checkedAt, severity: finalSeverity,
    summary: ai?.summary || fallbackSummary,
    summarySource: ai?.summary ? "ai" : "deterministic",
    nextCheck: ai?.next_check || "次回定期巡回",
    operatorLoop: { ...loopSummary, payload: loop.payload }, patrolCounts: counts, repairs, usersChecked: users.length,
  };

  // Each user's stored report holds only that user's own data. The global
  // report (other users' job ids, errors and the AI summary written from them)
  // is returned to the cron caller only.
  for (const userId of users) {
    const ownRepairs = repairs.filter((repair) => repair.userId === userId);
    const globalProblem = repairs.some((repair) => !repair.userId && repair.status === "failed");
    const ownSeverity = observedSeverity([...ownRepairs, ...(globalProblem ? [{ target: "system", action: "巡回", status: "failed" as const }] : [])], loopOk);
    const userReport = {
      patrol: "ai-patrol-v2", checkedAt, severity: ownSeverity,
      summary: ownSeverity === "critical"
        ? "巡回中に修復できない異常が残っています。運営側で確認しています。"
        : ownRepairs.some((x) => x.status === "repaired")
          ? "動画ジョブの停止を検知し、二重生成を避けるため手動復旧対象にしました。"
          : "自動運用は正常に巡回しました。",
      summarySource: "deterministic",
      patrolCounts: countsByUser.get(userId),
      repairs: ownRepairs.map((repair) => ({ target: repair.target, id: repair.id, action: repair.action, status: repair.status })),
      operatorLoop: { ok: loopOk, ranAt: checkedAt },
    };
    const { error } = await db.from("operator_runs").insert({
      user_id: userId, run_type: "ai_patrol", status: ownSeverity === "critical" ? "failed" : "completed",
      input: { checkedAt, patrolCounts: countsByUser.get(userId), repairs: userReport.repairs },
      output: userReport, started_at: checkedAt, completed_at: new Date().toISOString(),
    });
    if (error) console.error("ai-patrol report insert failed", { userId, error: error.message });
  }

  return NextResponse.json({ ok: finalSeverity !== "critical" && loopOk, ...report });
}
