import { NextResponse } from "next/server";
import { getAdminSupabase } from "@/lib/billing";
import { generateHiggsfieldVideo, higgsfieldConfigured } from "@/lib/video/higgsfield";
import {
  asRecord,
  MAX_PUBLISH_ATTEMPTS,
  MAX_VIDEO_ATTEMPTS,
  mergeProviderResponse,
  settledPatch,
  type SettleReason,
} from "@/lib/video/job-state";
import { acquireLease, releaseLease } from "@/lib/ops/lease";
import { cronSecret, unauthorizedCron, verifyCronRequest } from "@/lib/security/cron-auth";

export const runtime = "nodejs";
export const maxDuration = 300;
const SOFT_DEADLINE_MS = 270_000;
/** Internal calls are cut off here so the loop can still answer before maxDuration. */
const HARD_DEADLINE_MS = 290_000;

/**
 * metadata.operator_patrol_status of a published post:
 * - null / "active": still being evaluated by the loop
 * - "superseded": the next creative was created; its own post carries the test on
 * - "stopped": the Teacher decided STOP
 * - "stalled": metrics could not be fetched repeatedly (e.g. the post was deleted)
 * Only open posts are swept, so concluded posts cannot crowd out new ones.
 */
const OPEN_POSTS_FILTER = "metadata->>operator_patrol_status.is.null,metadata->>operator_patrol_status.eq.active";
const MAX_METRIC_FAILURES = 3;

type Db = ReturnType<typeof getAdminSupabase>;

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
  timeoutMs = 60_000,
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
    signal: AbortSignal.timeout(Math.max(1_000, timeoutMs)),
  });

  if (response.status >= 300 && response.status < 400) {
    throw new Error(
      `Internal operator request was redirected (HTTP ${response.status}). Check Vercel Deployment Protection and VERCEL_AUTOMATION_BYPASS_SECRET.`,
    );
  }

  const payload = await response.json().catch(() => ({}));
  return { status: response.status, payload };
}

type InternalRequest = (method: "GET" | "POST", path: string, userId: string, body?: Record<string, unknown>) => ReturnType<typeof internalRequest>;

/** Merge into the post's current metadata (the metrics route writes claims into it too). */
async function markPost(db: Db, post: { id: string; user_id: string }, patch: Record<string, unknown>) {
  const { data, error } = await db.from("social_posts").select("metadata").eq("id", post.id).eq("user_id", post.user_id).maybeSingle();
  if (error) throw error;
  const now = new Date().toISOString();
  const { error: updateError } = await db.from("social_posts")
    .update({ metadata: { ...asRecord(data?.metadata), ...patch, operator_patrol_updated_at: now }, updated_at: now })
    .eq("id", post.id).eq("user_id", post.user_id);
  if (updateError) throw updateError;
}

async function publishCompletedVideo(
  db: Db,
  request: InternalRequest,
  userId: string,
  socialPostId: string,
  videoUrl: string,
) {
  const { data: nextPost, error: nextPostError } = await db.from("social_posts")
    .select("id,network,caption,status,external_post_id,metadata")
    .eq("id", socialPostId)
    .eq("user_id", userId)
    .maybeSingle();
  if (nextPostError) throw nextPostError;

  if (!nextPost) return { ok: false, skipped: true, reason: "next social post not found" };
  if (nextPost.status === "published" && nextPost.external_post_id) {
    return { ok: true, skipped: true, reason: "target post is already published", postId: nextPost.id };
  }

  if (!["tiktok","instagram","facebook","youtube","x","linkedin"].includes(nextPost.network)) {
    return { ok: false, skipped: true, reason: `unsupported network: ${nextPost.network}` };
  }

  const { data: existingSnake, error: existingSnakeError } = await db.from("social_posts")
    .select("id,status,external_post_id")
    .eq("user_id", userId)
    .eq("network", nextPost.network)
    .eq("metadata->>source_social_post_id", nextPost.id)
    .limit(1);
  if (existingSnakeError) throw existingSnakeError;

  // Keep compatibility with older rows that used camelCase metadata.
  const existing = existingSnake?.length
    ? existingSnake
    : (await db.from("social_posts")
        .select("id,status,external_post_id")
        .eq("user_id", userId)
        .eq("network", nextPost.network)
        .eq("metadata->>sourceSocialPostId", nextPost.id)
        .limit(1)).data;

  if (existing?.[0]?.external_post_id) {
    return { ok: true, skipped: true, reason: "already published", postId: existing[0].id };
  }

  // /api/social/publish reserves (source post, network) before calling the SNS
  // API, so a repeated call here can never post the same video twice.
  const result = await request("POST", "/api/social/publish", userId, {
    socialPostId: nextPost.id,
    videoUrl,
    caption: nextPost.caption || "AI-generated acquisition creative",
    platforms: [nextPost.network],
  });

  if (result.status < 200 || result.status >= 300) {
    return { ok: false, status: result.status, error: result.payload?.error, manualRecoveryRequired: result.payload?.manualRecoveryRequired === true };
  }

  const manualRecoveryRequired = Array.isArray(result.payload?.results)
    && result.payload.results.some((item: { manualRecoveryRequired?: boolean } | null) => item?.manualRecoveryRequired === true);
  const published = Array.isArray(result.payload?.results)
    ? result.payload.results.filter((item: { ok?: boolean } | null) => item?.ok)
    : [];

  if (published.length > 0) {
    const { error: statusError } = await db.from("social_posts").update({
      status: "published",
      metadata: {
        ...(nextPost.metadata || {}),
        auto_published_at: new Date().toISOString(),
        auto_publish_result: result.payload,
      },
      updated_at: new Date().toISOString(),
    }).eq("id", nextPost.id).eq("user_id", userId);
    // The published row itself was stored by /api/social/publish; this is bookkeeping only.
    if (statusError) console.error("operator-loop: next post status update failed", statusError);
  }

  return {
    ok: published.length > 0,
    status: result.status,
    result: result.payload,
    manualRecoveryRequired,
    error: published.length ? undefined : result.payload?.results?.[0]?.error,
  };
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

async function runOperatorLoop(db: Db, leaseMode: string) {
  const loopStartedAt = Date.now();
  const softDeadline = loopStartedAt + SOFT_DEADLINE_MS;
  const hardDeadline = loopStartedAt + HARD_DEADLINE_MS;
  let timeBudgetExceeded = false;
  const budgetRemaining = () => Date.now() < softDeadline;
  const request: InternalRequest = (method, path, userId, body) =>
    internalRequest(method, path, userId, body, Math.min(120_000, hardDeadline - Date.now()));
  const evaluationDelayHours = Math.max(6, Number(process.env.OPERATOR_EVALUATION_DELAY_HOURS || 12));
  const cutoff = new Date(Date.now() - evaluationDelayHours * 60 * 60 * 1000).toISOString();
  const results: Array<Record<string, unknown>> = [];

  const { data: posts, error } = await db
    .from("social_posts")
    .select("id,user_id,network,published_at,external_post_id,metadata")
    .eq("status", "published")
    .not("external_post_id", "is", null)
    .lt("published_at", cutoff)
    .or(OPEN_POSTS_FILTER)
    .order("published_at", { ascending: true })
    .limit(50);

  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });

  // One query instead of one per post: which posts were measured too recently to re-evaluate.
  const recentCutoff = new Date(Date.now() - Math.max(6, evaluationDelayHours - 1) * 60 * 60 * 1000).toISOString();
  const postIds = (posts || []).map((post) => post.id);
  const recentlyMeasured = new Set<string>();
  if (postIds.length) {
    const { data: recentMetrics, error: recentError } = await db.from("post_metrics")
      .select("social_post_id")
      .in("social_post_id", postIds)
      .gte("measured_at", recentCutoff);
    if (recentError) return NextResponse.json({ ok: false, error: recentError.message }, { status: 500 });
    for (const metric of recentMetrics || []) recentlyMeasured.add(String(metric.social_post_id));
  }

  // 投稿単位で処理する。ユーザー単位で1件に制限しない。
  for (const post of posts || []) {
    if (!budgetRemaining()) { timeBudgetExceeded = true; break; }
    if (!post.user_id) continue;

    try {
      if (recentlyMeasured.has(post.id)) continue;

      const failuresSoFar = Number(asRecord(post.metadata).operator_metrics_failures || 0);
      const metrics = await request("POST", "/api/social/metrics", post.user_id, {
        socialPostId: post.id,
      });
      if (metrics.status < 200 || metrics.status >= 300) {
        // 409 = another worker is fetching right now; that is not a failure of the post.
        const failures = metrics.status === 409 ? failuresSoFar : failuresSoFar + 1;
        const stalled = failures >= MAX_METRIC_FAILURES;
        if (failures !== failuresSoFar) {
          await markPost(db, post, {
            operator_metrics_failures: failures,
            operator_metrics_last_error: String(metrics.payload?.error ?? `HTTP ${metrics.status}`).slice(0, 300),
            ...(stalled ? { operator_patrol_status: "stalled" } : {}),
          });
        }
        results.push({ postId: post.id, network: post.network, step: "metrics", status: metrics.status, error: metrics.payload?.error, ...(stalled ? { patrolStatus: "stalled" } : {}) });
        continue;
      }
      if (failuresSoFar > 0) await markPost(db, post, { operator_metrics_failures: 0, operator_metrics_last_error: null });

      const decision = await request("POST", "/api/operator/ai-decision", post.user_id, {
        socialPostId: post.id,
      });
      if (decision.status < 200 || decision.status >= 300) {
        results.push({ postId: post.id, network: post.network, step: "decision", status: decision.status, error: decision.payload?.error });
        continue;
      }

      // STOP: never generate. WAIT (insufficient data): re-evaluate on a later run.
      const verdict = decision.payload?.verdict;
      if (verdict === "stop" || verdict === "wait" || decision.payload?.generateCreative === false) {
        if (verdict === "stop") {
          await markPost(db, post, { operator_patrol_status: "stopped", operator_decision_run_id: decision.payload?.runId ?? null });
        }
        results.push({
          postId: post.id,
          network: post.network,
          verdict,
          decisionRunId: decision.payload?.runId,
          reusedDecision: decision.payload?.reused === true,
          nextCreative: false,
          ...(verdict === "stop" ? { patrolStatus: "stopped" } : {}),
        });
        continue;
      }

      const next = await request("POST", "/api/operator/next-creative", post.user_id, {
        socialPostId: post.id,
        verdict: decision.payload?.verdict,
        nextAction: decision.payload?.nextAction,
        changedAngle: decision.payload?.changedAngle,
        changedHook: decision.payload?.changedHook,
        testMetric: decision.payload?.testMetric,
        autoGenerate: true,
      });

      // 202 means another worker holds the claim; the post stays open until a creative exists.
      const nextPostId = next.payload?.socialPost?.id;
      const superseded = next.status >= 200 && next.status < 300 && Boolean(nextPostId);
      if (superseded) {
        await markPost(db, post, { operator_patrol_status: "superseded", operator_next_social_post_id: nextPostId, operator_decision_run_id: decision.payload?.runId ?? null });
      } else if (next.status === 409 && next.payload?.verdict === "stop") {
        await markPost(db, post, { operator_patrol_status: "stopped", operator_decision_run_id: next.payload?.decisionRunId ?? null });
      }

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
        ...(superseded ? { patrolStatus: "superseded" } : {}),
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
  // 完了済み (投稿済み・再試行上限・手動復旧) のジョブは loop_settled_at で除外し、
  // 新しいジョブが古いジョブに押し出されないようにする。
  const { data: jobs, error: jobsError } = await db.from("production_jobs")
    .select("id,user_id,social_post_id,status,request_id,prompt,duration,resolution,aspect_ratio,model,generate_audio,provider_response,error,created_at,started_at")
    .in("status", ["queued","running","failed","completed"])
    .is("provider_response->>loop_settled_at", null)
    .order("created_at", { ascending: true })
    .limit(30);
  if (jobsError) results.push({ step: "video-jobs", error: jobsError.message });

  type Job = NonNullable<typeof jobs>[number];

  /**
   * Take a job out of the loop for good. Re-reads provider_response so state
   * written by the status route in between (status_response, …) is kept, and
   * only applies while the job is still in the status this run acted on.
   */
  const settle = async (job: Job, expectedStatus: string, reason: SettleReason, extra: Record<string, unknown> = {}, columns: Record<string, unknown> = {}) => {
    const { data: current, error: readError } = await db.from("production_jobs")
      .select("status,provider_response").eq("id", job.id).eq("user_id", job.user_id).maybeSingle();
    if (readError) throw readError;
    if (!current || current.status !== expectedStatus) return false;
    const { error: settleError } = await db.from("production_jobs").update({
      ...columns,
      provider_response: settledPatch(current.provider_response, reason, extra),
      updated_at: new Date().toISOString(),
    }).eq("id", job.id).eq("user_id", job.user_id).eq("status", expectedStatus);
    if (settleError) throw settleError;
    return true;
  };

  const manualRecoveryNote = "外部SNSへの投稿結果をDBへ保存できませんでした。二重投稿防止のため自動再投稿を停止し、手動復旧が必要です。";

  const publishAndSettle = async (job: Job, socialPostId: string, videoUrl: string, step: string) => {
    const publish = await publishCompletedVideo(db, request, job.user_id, socialPostId, videoUrl);
    let status: string;
    if (publish.manualRecoveryRequired) {
      await settle(job, "completed", "manual_recovery_required", {
        manual_recovery_required: true,
        manual_recovery_marked_at: new Date().toISOString(),
      }, { error: manualRecoveryNote });
      status = "manual-recovery-required";
    } else if (publish.ok) {
      await settle(job, "completed", "published");
      status = "published";
    } else if (publish.skipped) {
      await settle(job, "completed", "social_post_missing", { publish_skipped_reason: publish.reason });
      status = "skipped";
    } else {
      // Failed before reaching the SNS (bad credentials, consent missing, API down):
      // retry on later runs, but not forever.
      const { data: current } = await db.from("production_jobs").select("provider_response").eq("id", job.id).eq("user_id", job.user_id).maybeSingle();
      const attempts = Number(asRecord(current?.provider_response).publish_attempts || 0) + 1;
      const lastError = String(publish.error ?? `HTTP ${publish.status}`).slice(0, 300);
      if (attempts >= MAX_PUBLISH_ATTEMPTS) {
        await settle(job, "completed", "publish_exhausted", { publish_attempts: attempts, publish_last_error: lastError }, { error: `SNS投稿に${attempts}回失敗したため自動投稿を停止しました: ${lastError}` });
        status = "publish-exhausted";
      } else {
        const { error: countError } = await db.from("production_jobs").update({
          provider_response: mergeProviderResponse(current?.provider_response, { publish_attempts: attempts, publish_last_error: lastError }),
          updated_at: new Date().toISOString(),
        }).eq("id", job.id).eq("user_id", job.user_id).eq("status", "completed");
        if (countError) throw countError;
        status = "publish-failed";
      }
    }
    results.push({ jobId: job.id, step, status, published: publish.ok, publishResult: publish });
  };

  const providerReady = higgsfieldConfigured();

  for (const job of jobs || []) {
    if (!budgetRemaining()) { timeBudgetExceeded = true; break; }
    if (!job.user_id) continue;

    let claimed = false;
    try {
      const providerResponse = asRecord(job.provider_response);
      const retryCount = Number(providerResponse.retry_count || 0);

      // 外部API呼び出し後にWorkerがDB更新前で落ちると、Higgsfield側では
      // 生成が進行している可能性がある。Higgsfieldに汎用idempotency keyを
      // 付けられることを確認できないため、自動再送はせず手動復旧対象にする。
      if (job.status === "running" && !job.request_id) {
        const startedAt = job.started_at ? new Date(job.started_at).getTime() : 0;
        if (startedAt && startedAt < Date.now() - 15 * 60 * 1000) {
          const { error: markError } = await db.from("production_jobs")
            .update({
              status: "failed",
              error: "Higgsfield開始後にrequest_id保存前でWorkerが停止した可能性があります。外部生成の有無を確認してから再実行してください。",
              provider_response: settledPatch(providerResponse, "manual_recovery_required", {
                manual_recovery_required: true,
                manual_recovery_marked_at: new Date().toISOString(),
              }),
              updated_at: new Date().toISOString(),
            })
            .eq("id", job.id)
            .eq("user_id", job.user_id)
            .eq("status", "running")
            .is("request_id", null);
          if (markError) throw markError;
          results.push({ jobId: job.id, step: "video-recovery", status: "manual-recovery-required" });
        }
        continue;
      }

      if (job.status === "failed" || job.status === "completed") {
        if (providerResponse.manual_recovery_required === true) {
          await settle(job, job.status, "manual_recovery_required");
          results.push({ jobId: job.id, step: "video-retry", status: "manual-recovery-required" });
          continue;
        }
      }

      if (job.status === "completed") {
        if (!job.social_post_id) {
          // Generated from the studio without a post: nothing for the loop to publish.
          await settle(job, "completed", "no_social_post");
          continue;
        }
        // 生成済み動画のSNS投稿だけが失敗した場合も再巡回する。
        // /api/social/publish 側の予約・一意制約で二重投稿を防ぐ。
        const { data: asset } = await db.from("video_assets")
          .select("video_url")
          .eq("production_job_id", job.id)
          .maybeSingle();
        if (!asset?.video_url) {
          results.push({ jobId: job.id, step: "video-publish", status: "completed-without-asset" });
          continue;
        }
        await publishAndSettle(job, job.social_post_id, asset.video_url, "video-publish-retry");
        continue;
      }

      // failed / queued はDB上でrunningへ原子的にclaimする。
      // claimに勝ったCronだけがHiggsfield APIを呼ぶ。
      if (job.status === "failed" || (job.status === "queued" && !job.request_id)) {
        if (job.status === "failed" && providerResponse.non_retryable === true) {
          await settle(job, "failed", "non_retryable");
          results.push({ jobId: job.id, step: "video-retry", status: "non-retryable", error: job.error });
          continue;
        }
        if (job.status === "failed" && retryCount >= MAX_VIDEO_ATTEMPTS) {
          await settle(job, "failed", "retries_exhausted");
          results.push({ jobId: job.id, step: "video-retry", status: "exhausted", retryCount });
          continue;
        }
        if (!providerReady) {
          // A configuration problem must not consume the job's retry budget.
          results.push({ jobId: job.id, step: job.status === "failed" ? "video-retry" : "video-start", status: "blocked", reason: "video provider credentials are not configured" });
          continue;
        }

        const claimTime = new Date().toISOString();
        // 外部Higgsfield APIへの試行回数をclaim時点で確定する。
        // API開始失敗でも回数を残し、Cronごとの無限再試行を防ぐ。
        const attemptCount = job.status === "failed" ? retryCount + 1 : 1;
        const previousRequestIds = Array.isArray(providerResponse.previous_request_ids) ? providerResponse.previous_request_ids : [];
        const claimResponse = {
          ...providerResponse,
          operator_claimed_at: claimTime,
          retry_count: attemptCount,
          // request_id is cleared on claim: the stale-start detector above then
          // also covers a worker that dies during a retry, and a late status poll
          // of the old request can no longer write into this attempt.
          ...(job.request_id ? { previous_request_ids: [...previousRequestIds, job.request_id] } : {}),
        };
        const { data: claim, error: claimError } = await db.from("production_jobs")
          .update({
            status: "running",
            request_id: null,
            started_at: claimTime,
            completed_at: null,
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

        const inputImageUrl = typeof providerResponse.input_image_url === "string"
          ? providerResponse.input_image_url
          : undefined;
        const started = await generateHiggsfieldVideo({
          prompt: String(job.prompt || ""),
          duration: Number(job.duration || 5),
          resolution: (String(job.resolution || "1080p") as "480p" | "720p" | "1080p"),
          aspectRatio: (String(job.aspect_ratio || "9:16") as "16:9" | "4:3" | "1:1" | "3:4" | "9:16" | "adaptive"),
          model: job.model ? String(job.model) : undefined,
          generateAudio: job.generate_audio === true,
          imageUrl: inputImageUrl,
        });
        const requestId = String(started.request_id ?? started.requestId ?? started.id ?? "");
        if (!requestId) throw new Error("Higgsfield開始からrequest_idを取得できませんでした。");
        // From here on the provider is generating: a DB error must not mark the job
        // failed (that would start a second, duplicate generation on the next run).
        claimed = false;

        const now = new Date().toISOString();
        const { data: saved, error: saveError } = await db.from("production_jobs").update({
          status: "running",
          request_id: requestId,
          provider_response: {
            ...claimResponse,
            input_image_url: inputImageUrl,
            started_response: started,
          },
          error: null,
          started_at: now,
          completed_at: null,
          updated_at: now,
        }).eq("id", job.id).eq("user_id", job.user_id).eq("status", "running").is("request_id", null).select("id").maybeSingle();

        if (saveError || !saved) {
          // Left running without request_id: the stale-start detector turns it into
          // manual recovery instead of generating again.
          console.error("operator-loop: request_id could not be stored", { jobId: job.id, requestId, error: saveError?.message });
          results.push({ jobId: job.id, step: "video-start", status: "request-id-not-saved", requestId, error: saveError?.message ?? "job changed concurrently" });
          continue;
        }

        results.push({
          jobId: job.id,
          step: job.status === "failed" ? "video-retry" : "video-start",
          status: "running",
          retryCount: attemptCount,
          requestId,
        });
        continue;
      }

      const polled = await request("GET", `/api/video/jobs/${job.id}`, job.user_id);
      const asset = polled.payload?.asset;
      const polledStatus = polled.payload?.job?.status;

      if (polled.status >= 200 && polled.status < 300 && polledStatus === "completed" && asset?.video_url) {
        if (job.social_post_id) {
          await publishAndSettle(job, job.social_post_id, asset.video_url, "video-publish");
        } else {
          await settle(job, "completed", "no_social_post");
          results.push({ jobId: job.id, step: "video-poll", status: "completed" });
        }
      } else {
        results.push({
          jobId: job.id,
          step: "video-poll",
          status: polledStatus || polled.status,
          ...(polled.status >= 300 ? { error: polled.payload?.error } : {}),
        });
      }
    } catch (error) {
      if (claimed) {
        // The provider call itself failed: nothing was started, so a later retry is safe.
        await db.from("production_jobs").update({
          status: "failed",
          error: error instanceof Error ? error.message : String(error),
          updated_at: new Date().toISOString(),
        }).eq("id", job.id).eq("user_id", job.user_id).eq("status", "running").is("request_id", null);
      }
      results.push({
        jobId: job.id,
        step: "video-poll",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const attention = results.filter((r) => r.status === "manual-recovery-required" || r.status === "request-id-not-saved" || r.status === "publish-exhausted" || r.status === "blocked").length;

  return NextResponse.json({
    ok: true,
    lease: leaseMode,
    checked: posts?.length || 0,
    processed: results.length,
    attention,
    timeBudgetExceeded,
    results,
    ranAt: new Date().toISOString(),
  });
}
