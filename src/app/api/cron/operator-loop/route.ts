import { NextResponse } from "next/server";
import { getAdminSupabase } from "@/lib/billing";
import { generateHiggsfieldVideo } from "@/lib/video/higgsfield";
import { acquireLease, releaseLease } from "@/lib/ops/lease";
import { cronSecret, unauthorizedCron, verifyCronRequest } from "@/lib/security/cron-auth";

export const runtime = "nodejs";
export const maxDuration = 300;

function baseUrl() {
  const productionUrl = process.env.VERCEL_PROJECT_PRODUCTION_URL;
  if (!productionUrl) {
    throw new Error("VERCEL_PROJECT_PRODUCTION_URL is required for operator-loop internal requests.");
  }
  return productionUrl.replace(/^https?:\/\//, "");
}

async function internalRequest(
  method: "GET" | "POST",
  path: string,
  userId: string,
  body?: Record<string, unknown>,
) {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "x-internal-secret": cronSecret(),
    "x-internal-user-id": userId,
  };

  // Production can be protected by Vercel Authentication. In that case,
  // server-to-server calls must use Vercel's automation bypass header when
  // configured; otherwise a 302/HTML response could be mistaken for success.
  if (process.env.VERCEL_AUTOMATION_BYPASS_SECRET) {
    headers["x-vercel-protection-bypass"] = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
  }

  const response = await fetch(`https://${baseUrl()}${path}`, {
    method,
    headers,
    ...(body ? { body: JSON.stringify(body) } : {}),
    cache: "no-store",
    redirect: "manual",
  });

  if (response.status >= 300 && response.status < 400) {
    throw new Error(
      `Internal operator request was redirected (HTTP ${response.status}). Check Vercel Deployment Protection and VERCEL_AUTOMATION_BYPASS_SECRET.`,
    );
  }

  const payload = await response.json().catch(() => ({}));
  return { status: response.status, payload };
}

const LEASE_NAME = "operator-loop";

export async function GET(request: Request) {
  const auth = verifyCronRequest(request);
  if (!auth.ok) return unauthorizedCron(auth);

  const db = getAdminSupabase();
  // Vercel Cron and the AI patrol can both invoke this loop. Only one run may
  // execute at a time; the lease expires with the function's maxDuration.
  const lease = await acquireLease(db, LEASE_NAME, (maxDuration + 10) * 1000);
  if (!lease.acquired) {
    return NextResponse.json({ ok: true, skipped: true, reason: "operator-loop is already running", leaseExpiresAt: lease.expiresAt, ranAt: new Date().toISOString() });
  }
  try {
    return await runOperatorLoop(db, lease.mode);
  } finally {
    await releaseLease(db, LEASE_NAME, lease).catch((error) => console.error("operator-loop lease release failed", error));
  }
}

async function runOperatorLoop(db: ReturnType<typeof getAdminSupabase>, leaseMode: string) {
  const evaluationDelayHours = Math.max(6, Number(process.env.OPERATOR_EVALUATION_DELAY_HOURS || 12));
  const cutoff = new Date(Date.now() - evaluationDelayHours * 60 * 60 * 1000).toISOString();
  const results: unknown[] = [];

  const { data: posts, error } = await db
    .from("social_posts")
    .select("id,user_id,network,published_at,external_post_id")
    .eq("status", "published")
    .not("external_post_id", "is", null)
    .lt("published_at", cutoff)
    .order("published_at", { ascending: true })
    .limit(50);

  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });

  // 投稿単位で処理する。ユーザー単位で1件に制限しない。
  for (const post of posts || []) {
    if (!post.user_id) continue;

    try {
      const { data: latestMetric } = await db
        .from("post_metrics")
        .select("measured_at")
        .eq("social_post_id", post.id)
        .order("measured_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (latestMetric?.measured_at && new Date(latestMetric.measured_at).getTime() > Date.now() - Math.max(6, evaluationDelayHours - 1) * 60 * 60 * 1000) {
        continue;
      }

      const metrics = await internalRequest("POST", "/api/social/metrics", post.user_id, {
        socialPostId: post.id,
      });
      if (metrics.status < 200 || metrics.status >= 300) {
        results.push({ postId: post.id, network: post.network, step: "metrics", status: metrics.status, error: metrics.payload?.error });
        continue;
      }

      const decision = await internalRequest("POST", "/api/operator/ai-decision", post.user_id, {
        socialPostId: post.id,
      });
      if (decision.status < 200 || decision.status >= 300) {
        results.push({ postId: post.id, network: post.network, step: "decision", status: decision.status, error: decision.payload?.error });
        continue;
      }

      // STOP: never generate. WAIT (insufficient data): re-evaluate on a later run.
      const verdict = decision.payload?.verdict ?? (decision.payload?.decision && typeof decision.payload.decision === "object" ? String((decision.payload.decision as Record<string, unknown>).verdict || "") : undefined);
      if (verdict === "stop" || verdict === "wait" || decision.payload?.generateCreative === false) {
        results.push({
          postId: post.id,
          network: post.network,
          verdict,
          decisionRunId: decision.payload?.runId,
          reusedDecision: decision.payload?.reused === true,
          nextCreative: false,
        });
        continue;
      }

      const next = await internalRequest("POST", "/api/operator/next-creative", post.user_id, {
        socialPostId: post.id,
        verdict: decision.payload?.verdict,
        nextAction: decision.payload?.nextAction,
        changedAngle: decision.payload?.changedAngle,
        changedHook: decision.payload?.changedHook,
        testMetric: decision.payload?.testMetric,
        autoGenerate: true,
      });

      results.push({
        postId: post.id,
        network: post.network,
        verdict: decision.payload?.verdict,
        decisionRunId: decision.payload?.runId,
        nextCreative: next.status >= 200 && next.status < 300,
        nextStatus: next.status,
        nextCreativeId: next.payload?.creative?.id,
        videoJobId: next.payload?.video?.jobId,
        reused: next.payload?.reused === true,
        error: next.status >= 300 ? next.payload?.error : undefined,
      });
    } catch (error) {
      results.push({
        postId: post.id,
        network: post.network,
        step: "post-loop",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // Higgsfieldの未完了ジョブを回収し、完成したらそのままSNSへ投稿する。
  const { data: jobs } = await db.from("production_jobs")
    .select("id,user_id,social_post_id,status,request_id,prompt,duration,resolution,aspect_ratio,model,generate_audio,provider_response,error,created_at,started_at")
    .in("status", ["queued","running","failed","completed"])
    .order("created_at", { ascending: true })
    .limit(30);

  for (const job of jobs || []) {
    if (!job.user_id) continue;

    let claimed = false;
    try {
      const providerResponse = (job.provider_response && typeof job.provider_response === "object")
        ? job.provider_response as Record<string, unknown>
        : {};
      const retryCount = Number(providerResponse.retry_count || 0);

      // 外部API呼び出し後にWorkerがDB更新前で落ちると、Higgsfield側では
      // 生成が進行している可能性がある。Higgsfieldに汎用idempotency keyを
      // 付けられることを確認できないため、自動再送はせず手動復旧対象にする。
      if (job.status === "running" && !job.request_id) {
        const startedAt = job.started_at ? new Date(job.started_at).getTime() : 0;
        if (startedAt && startedAt < Date.now() - 15 * 60 * 1000) {
          await db.from("production_jobs")
            .update({
              status: "failed",
              error: "Higgsfield開始後にrequest_id保存前でWorkerが停止した可能性があります。外部生成の有無を確認してから再実行してください。",
              provider_response: {
                ...providerResponse,
                manual_recovery_required: true,
                manual_recovery_marked_at: new Date().toISOString(),
              },
              updated_at: new Date().toISOString(),
            })
            .eq("id", job.id)
            .eq("user_id", job.user_id)
            .eq("status", "running")
            .is("request_id", null);
        }
        continue;
      }

      if (job.status === "failed" && providerResponse.manual_recovery_required === true) {
        results.push({ jobId: job.id, step: "video-retry", status: "manual-recovery-required" });
        continue;
      }

      // 生成済み動画のSNS投稿だけが失敗した場合も再巡回する。
      // /api/social/publish 側の予約・一意制約で二重投稿を防ぐ。
      if (job.status === "completed" && job.social_post_id) {
        const { data: asset } = await db.from("video_assets")
          .select("video_url")
          .eq("production_job_id", job.id)
          .maybeSingle();
        if (!asset?.video_url) {
          results.push({ jobId: job.id, step: "video-publish", status: "completed-without-asset" });
          continue;
        }
        results.push({
          jobId: job.id,
          step: "video-ready-for-review",
          status: "completed",
          published: false,
          reason: "automatic social publishing is disabled; human approval is required",
        });
        continue;
      }

      // failed / queued はDB上でrunningへ原子的にclaimする。
      // claimに勝ったCronだけがHiggsfield APIを呼ぶ。
      if (job.status === "failed" || (job.status === "queued" && !job.request_id)) {
        if (job.status === "failed" && retryCount >= 2) {
          results.push({ jobId: job.id, step: "video-retry", status: "exhausted", retryCount });
          continue;
        }

        const claimTime = new Date().toISOString();
        // 外部Higgsfield APIへの試行回数をclaim時点で確定する。
        // API開始失敗でも回数を残し、Cronごとの無限再試行を防ぐ。
        const attemptCount = job.status === "failed" ? retryCount + 1 : 1;
        const claimResponse = {
          ...providerResponse,
          operator_claimed_at: claimTime,
          retry_count: attemptCount,
        };
        const { data: claim, error: claimError } = await db.from("production_jobs")
          .update({
            status: "running",
            started_at: claimTime,
            error: null,
            provider_response: claimResponse,
            updated_at: claimTime,
          })
          .eq("id", job.id)
          .eq("user_id", job.user_id)
          .eq("status", job.status)
          .select("id")
          .maybeSingle();

        if (claimError) throw claimError;
        if (!claim) {
          results.push({ jobId: job.id, step: "video-claim", status: "skipped", reason: "another worker claimed this job" });
          continue;
        }
        claimed = true;

        const started = await generateHiggsfieldVideo({
          prompt: String(job.prompt || ""),
          duration: Number(job.duration || 5),
          resolution: (String(job.resolution || "1080p") as "480p" | "720p" | "1080p"),
          aspectRatio: (String(job.aspect_ratio || "9:16") as "16:9" | "4:3" | "1:1" | "3:4" | "9:16" | "adaptive"),
          model: job.model ? String(job.model) : undefined,
          generateAudio: job.generate_audio === true,
        });
        const requestId = String(started.request_id ?? started.requestId ?? started.id ?? "");
        if (!requestId) throw new Error("Higgsfield開始からrequest_idを取得できませんでした。");

        const now = new Date().toISOString();
        await db.from("production_jobs").update({
          status: "running",
          request_id: requestId,
          provider_response: {
            ...claimResponse,
            retry_count: attemptCount,
            started_response: started,
          },
          error: null,
          started_at: now,
          completed_at: null,
          updated_at: now,
        }).eq("id", job.id).eq("user_id", job.user_id).eq("status", "running");

        results.push({
          jobId: job.id,
          step: job.status === "failed" ? "video-retry" : "video-start",
          status: "running",
          retryCount: job.status === "failed" ? retryCount + 1 : retryCount,
          requestId,
        });
        continue;
      }

      const polled = await internalRequest("GET", `/api/video/jobs/${job.id}`, job.user_id);
      const asset = polled.payload?.asset;

      if (polled.status >= 200 && polled.status < 300 && asset?.video_url && polled.payload?.job?.status === "completed" && job.social_post_id) {
        results.push({
          jobId: job.id,
          step: "video-ready-for-review",
          status: polled.payload?.job?.status,
          published: false,
          reason: "automatic social publishing is disabled; human approval is required",
        });
      } else {
        results.push({
          jobId: job.id,
          step: "video-poll",
          status: polled.payload?.job?.status || polled.status,
        });
      }
    } catch (error) {
      if (claimed) {
        await db.from("production_jobs").update({
          status: "failed",
          error: error instanceof Error ? error.message : String(error),
          updated_at: new Date().toISOString(),
        }).eq("id", job.id).eq("user_id", job.user_id).eq("status", "running");
      }
      results.push({
        jobId: job.id,
        step: "video-poll",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return NextResponse.json({
    ok: true,
    lease: leaseMode,
    checked: posts?.length || 0,
    processed: results.length,
    results,
    ranAt: new Date().toISOString(),
  });
}
