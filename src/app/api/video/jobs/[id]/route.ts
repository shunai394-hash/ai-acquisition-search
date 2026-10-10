import { NextResponse } from "next/server";
import { getAdminSupabase, getUserFromBearer } from "@/lib/billing";
import { getHiggsfieldStatus, extractHiggsfieldVideoUrl } from "@/lib/video/higgsfield";
import { deleteVideoFromStorage, saveVideoToStorage } from "@/lib/video/storage";
import { withSignedVideoUrls } from "@/lib/video/asset-access";
import { jobMeta, PROVIDER_JOB_TIMEOUT_MS, providerFailureMessage, refundJobUsage, summarizeProviderPayload } from "@/lib/video/job-recovery";

// provider_response holds signed input URLs and quota event ids; keep it server-side.
function publicJob<T extends { provider_response?: unknown }>(job: T, overrides: Record<string, unknown> = {}) {
  const { provider_response: _providerResponse, ...rest } = job;
  void _providerResponse;
  return { ...rest, ...overrides };
}

export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const user = await getUserFromBearer(request);
    if (!user) return NextResponse.json({ error: "ログインが必要です。" }, { status: 401 });
    const { id } = await context.params;
    const admin = getAdminSupabase();

    const { data: job, error } = await admin.from("production_jobs")
      .select("id,user_id,social_post_id,creative_id,provider,model,status,request_id,prompt,duration,resolution,aspect_ratio,provider_response,error,started_at,completed_at,created_at,updated_at")
      .eq("id", id).eq("user_id", user.id).maybeSingle();

    if (error) throw new Error(error.message);
    if (!job) return NextResponse.json({ error: "production jobが見つかりません。" }, { status: 404 });

    if (job.status === "completed" || job.status === "failed") {
      const { data: asset } = await admin.from("video_assets")
        .select("id,video_url,storage_path,provider,model,duration,resolution,aspect_ratio,metadata,created_at")
        .eq("production_job_id", job.id).maybeSingle();
      return NextResponse.json({ ok: true, job: publicJob(job), asset: await withSignedVideoUrls(admin, user.id, asset ?? null) });
    }

    if (!job.request_id) return NextResponse.json({ ok: true, job: publicJob(job), asset: null });

    const result = await getHiggsfieldStatus(job.request_id);
    let status = String(result.status ?? "").toLowerCase();
    const isCompleted = status === "completed" || status === "succeeded";
    const startedAt = job.started_at ? Date.parse(job.started_at) : NaN;
    if (!isCompleted && Number.isFinite(startedAt) && Date.now() - startedAt > PROVIDER_JOB_TIMEOUT_MS) {
      status = "timeout";
    }
    const isFailed = status === "failed" || status === "nsfw" || status === "cancelled" || status === "canceled" || status === "timeout";

    const syncCreative = async (assetUrl: string) => {
      if (!job.creative_id) return;
      const { error: creativeError } = await admin.from("creatives").update({
        video_url: assetUrl,
        generation_provider: "higgsfield",
        generation_model: job.model,
        status: "generated",
        updated_at: new Date().toISOString()
      }).eq("id", job.creative_id).eq("user_id", user.id);
      if (creativeError) throw new Error("生成動画は保存されましたが、Creativeへの反映に失敗しました: " + creativeError.message);
    };

    if (isCompleted) {
      const videoUrl = extractHiggsfieldVideoUrl(result);
      if (!videoUrl) throw new Error("Higgsfield completed but video URL was not returned.");

      const { data: existingAsset } = await admin.from("video_assets")
        .select("id,video_url,storage_path,provider,model,duration,resolution,aspect_ratio,metadata,created_at")
        .eq("production_job_id", job.id).maybeSingle();

      if (existingAsset) {
        const { error: jobUpdateError } = await admin.from("production_jobs").update({
          status: "completed", provider_response: { ...jobMeta(job.provider_response), final_provider_response: result }, completed_at: new Date().toISOString(), error: null
        }).eq("id", job.id).eq("user_id", user.id);
        if (jobUpdateError) throw new Error("動画は保存済みですが、ジョブ状態の更新に失敗しました: " + jobUpdateError.message);
        await syncCreative(existingAsset.video_url);
        return NextResponse.json({ ok: true, job: publicJob(job, { status: "completed" }), asset: await withSignedVideoUrls(admin, user.id, existingAsset) });
      }

      const stored = await saveVideoToStorage({ userId: user.id, jobId: job.id, sourceUrl: videoUrl });
      const { data: asset, error: assetError } = await admin.from("video_assets").insert({
        user_id: user.id, production_job_id: job.id, creative_id: job.creative_id, social_post_id: job.social_post_id,
        provider: "higgsfield", model: job.model, storage_bucket: stored.bucket, storage_path: stored.path, video_url: stored.url,
        prompt: job.prompt, duration: job.duration, resolution: job.resolution, aspect_ratio: job.aspect_ratio,
        metadata: { bytes: stored.bytes, contentType: stored.contentType, requestId: job.request_id, has_audio_track: stored.hasAudioTrack }
      }).select("id,video_url,storage_path,provider,model,duration,resolution,aspect_ratio,metadata,created_at").single();

      if (assetError?.code === "23505") {
        const { data: concurrentAsset, error: concurrentAssetError } = await admin.from("video_assets")
          .select("id,video_url,storage_path,provider,model,duration,resolution,aspect_ratio,metadata,created_at")
          .eq("production_job_id", job.id).maybeSingle();
        if (concurrentAssetError || !concurrentAsset) {
          try { await deleteVideoFromStorage(stored.path); } catch {}
          throw new Error(concurrentAssetError?.message || "競合したvideo assetを再取得できませんでした。");
        }
        try { await deleteVideoFromStorage(stored.path); } catch (cleanupError) {
          console.error("duplicate video storage cleanup failed", { jobId: job.id, path: stored.path, error: cleanupError });
        }
        await admin.from("production_jobs").update({
          status: "completed", provider_response: { ...jobMeta(job.provider_response), final_provider_response: result }, completed_at: new Date().toISOString(), error: null
        }).eq("id", job.id).eq("user_id", user.id);
        await syncCreative(concurrentAsset.video_url);
        return NextResponse.json({ ok: true, job: publicJob(job, { status: "completed" }), asset: await withSignedVideoUrls(admin, user.id, concurrentAsset) });
      }

      if (assetError || !asset) {
        try { await deleteVideoFromStorage(stored.path); } catch (cleanupError) {
          console.error("video storage cleanup failed after asset insert error", { jobId: job.id, path: stored.path, error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError) });
        }
        throw new Error(assetError?.message || "video assetの保存に失敗しました。");
      }

      const { error: jobUpdateError } = await admin.from("production_jobs").update({
        status: "completed", provider_response: { ...jobMeta(job.provider_response), final_provider_response: result }, completed_at: new Date().toISOString(), error: null
      }).eq("id", job.id).eq("user_id", user.id);
      if (jobUpdateError) throw new Error("動画は保存されましたが、ジョブ状態の更新に失敗しました: " + jobUpdateError.message);

      await syncCreative(stored.url);
      return NextResponse.json({ ok: true, job: publicJob(job, { status: "completed" }), asset: await withSignedVideoUrls(admin, user.id, asset) });
    }

    if (isFailed) {
      const message = providerFailureMessage(status);
      const savedProviderResponse = jobMeta(job.provider_response);
      // Do not terminally mark the job failed until the idempotent quota refunds
      // (video + narration charged for this job) have been attempted. If the RPC
      // errors, this request returns 500 and the next poll retries the refund.
      const refund = await refundJobUsage(user.id, savedProviderResponse);
      // Jobs that charged the user are refunded and closed; quota-free operator
      // jobs keep the existing bounded auto-retry unless retrying cannot help.
      const terminal = refund.video !== undefined || refund.narration !== undefined || status === "nsfw" || status === "timeout";
      const { error: failedUpdateError } = await admin.from("production_jobs").update({
        status: "failed",
        provider_response: {
          ...savedProviderResponse,
          final_provider_status: status,
          final_provider_detail: summarizeProviderPayload(result),
          quota_refunded: refund,
          // A refunded job must never be restarted by the operator loop for free.
          ...(terminal ? { terminal: true } : {}),
        },
        error: message,
        completed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }).eq("id", job.id).eq("user_id", user.id);
      if (failedUpdateError) throw new Error("動画生成は失敗しましたが、ジョブ状態の保存に失敗しました: " + failedUpdateError.message);
      return NextResponse.json({ ok: true, job: publicJob(job, { status: "failed", error: message }), asset: null });
    }

    return NextResponse.json({ ok: true, job: publicJob(job, { provider_status: status || null }), asset: null });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "動画ジョブ確認に失敗しました。" }, { status: 500 });
  }
}
