import { NextResponse } from "next/server";
import { getAdminSupabase } from "@/lib/billing";
import { cronAuthDiagnostics, cronSecret, isAuthorizedCron } from "@/lib/security/cron-auth";

export const runtime = "nodejs";
export const maxDuration = 300;

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
  });
  const payload = await response.json().catch(() => ({}));
  return { status: response.status, payload };
}

async function supervisorDecision(input: unknown) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return null;
  try {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: process.env.OPENAI_MODEL || "gpt-5-mini",
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: "あなたはAI集客システムの巡回監督です。観測値だけを使い、異常・修復結果・未解決事項をJSONで要約してください。作業していないことを修復済みと書かないでください。severityはhealthy|attention|critical。" },
          { role: "user", content: JSON.stringify(input) },
        ],
      }),
    });
    if (!response.ok) return null;
    const payload = await response.json();
    const text = payload.choices?.[0]?.message?.content;
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

export async function GET(request: Request) {
  if (!isAuthorizedCron(request)) {
    console.warn("patrol-ai unauthorized", cronAuthDiagnostics(request));
    return new Response("Unauthorized", { status: 401 });
  }

  const db = getAdminSupabase();
  const checkedAt = new Date().toISOString();
  const repairs: Array<Record<string, unknown>> = [];

  let loop = { status: 0, payload: {} as Record<string, unknown> };
  try {
    loop = await callOperatorLoop();
  } catch (error) {
    repairs.push({ target: "operator-loop", action: "巡回実行", status: "failed", error: error instanceof Error ? error.message : String(error) });
  }

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
        repairs.push({ target: "production_job", id: job.id, action: "外部生成中のため変更せず監視", status: "skipped" });
        continue;
      }
      const { error } = await db.from("production_jobs").update({
        status: "failed",
        error: "巡回AI: 30分以上runningのままrequest_idが存在しないため、外部生成の重複実行を避けて手動復旧対象に変更。",
        provider_response: { ...meta, patrol_repair: true, manual_recovery_required: true, patrol_repaired_at: checkedAt },
        updated_at: checkedAt,
      }).eq("id", job.id).eq("status", "running").is("request_id", null);
      repairs.push({ target: "production_job", id: job.id, action: "staleジョブを安全なmanual-recoveryへ変更", status: error ? "failed" : "repaired", error: error?.message });
    }
  }

  const { data: posts, error: postsError } = await db.from("social_posts")
    .select("id,user_id,status,network,metadata,created_at")
    .in("status", ["planned", "scheduled", "published"])
    .order("created_at", { ascending: false }).limit(100);

  if (postsError) repairs.push({ target: "social_posts", action: "patrol-chain監査", status: "failed", error: postsError.message });

  const users = [...new Set((posts || []).map((post) => post.user_id).filter(Boolean))];
  const counts = { active: 0, stopped: 0, superseded: 0, unmanaged: 0 };
  for (const post of posts || []) {
    const metadata = post.metadata && typeof post.metadata === "object" ? post.metadata as Record<string, unknown> : {};
    const status = String(metadata.operator_patrol_status || "");
    if (status === "active") counts.active++;
    else if (status === "stopped") counts.stopped++;
    else if (status === "superseded") counts.superseded++;
    else counts.unmanaged++;
  }

  const reportInput = { checkedAt, operatorLoop: { status: loop.status, payload: loop.payload }, patrolCounts: counts, staleJobs: staleJobs?.length || 0, repairs, usersChecked: users.length };
  const ai = await supervisorDecision(reportInput);
  const failed = repairs.filter((repair) => repair.status === "failed").length;
  const severity = ai?.severity || (failed ? "critical" : repairs.some((x) => x.status === "repaired") ? "attention" : "healthy");
  const report = {
    patrol: "ai-patrol-v1", checkedAt, severity,
    summary: ai?.summary || (failed ? "巡回中に修復できない異常が残っています。" : repairs.some((x) => x.status === "repaired") ? "巡回AIが安全に修復できる異常を修復し、結果を記録しました。" : "巡回・監査・修復対象に重大な異常はありません。"),
    nextCheck: ai?.next_check || "次回定期巡回",
    operatorLoop: loop, patrolCounts: counts, repairs, usersChecked: users.length,
  };

  for (const userId of users) {
    await db.from("operator_runs").insert({
      user_id: userId, run_type: "ai_patrol", status: failed ? "failed" : "completed",
      input: reportInput, output: report, started_at: checkedAt, completed_at: new Date().toISOString(),
    });
  }

  return NextResponse.json({ ok: failed === 0 && loop.status >= 200 && loop.status < 300, ...report });
}
