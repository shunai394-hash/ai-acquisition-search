import { NextResponse } from "next/server";
import { getAdminSupabase, getUserFromBearer } from "@/lib/billing";
import { getHiggsfieldStatus, extractHiggsfieldVideoUrl } from "@/lib/video/higgsfield";
import { deleteVideoFromStorage, saveVideoToStorage } from "@/lib/video/storage";
import { isVideoJobTimedOut, mergeProviderResponse } from "@/lib/video/job-state";

export const runtime = "nodejs";
export const maxDuration = 60;

const ASSET_COLUMNS = "id,video_url,storage_path,provider,model,duration,resolution,aspect_ratio,created_at";

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
        .select(ASSET_COLUMNS)
        .eq("production_job_id", job.id).maybeSingle();
      return NextResponse.json({ ok: true, job, asset: asset ?? null });
    }

    if (!job.request_id) return NextResponse.json({ ok: true, job, asset: null });
    const requestId = String(job.request_id);

    // Every write below is fenced on the request_id this poll observed. When the
    // operator loop re-claims the job for a retry in between, the stale provider
    // status of the previous attempt can no longer overwrite the new attempt.
    const updateJob = (patch: Record<string, unknown>) => admin.from("production_jobs")
      .update({ ...patch, updated_at: new Date().toISOString() })
      .eq("id", job.id).eq("user_id", user.id).eq("request_id", requestId);

    const markTimedOut = async (detail: string) => {
      const minutes = Math.round((Date.now() - Date.parse(String(job.started_at))) / 60_000);
      const message = `動画生成が${minutes}分経っても完了しないため打ち切りました (${detail})。次回の巡回で再生成します。`;
      const { error: timeoutError } = await updateJob({
        status: "failed",
        error: message,
        completed_at: new Date().toISOString(),
        provider_response: mergeProviderResponse(job.provider_response, {
          timed_out_request_id: requestId,
          timed_out_at: new Date().toISOString(),
        }),
      }).eq("status", job.status);
      if (timeoutError) throw new Error("タイムアウトした動画ジョブの状態保存に失敗しました: " + timeoutError.message);
      return NextResponse.json({ ok: true, job: { ...job, status: "failed", error: message }, asset: null });
    };

    let result: Record<string, unknown>;
    try {
      result = await getHiggsfieldStatus(requestId);
    } catch (statusError) {
      // A provider that keeps failing to answer must not pin the job in "running".
      if (isVideoJobTimedOut(job.started_at)) {
        return markTimedOut(statusError instanceof Error ? statusError.message.slice(0, 200) : "status unavailable");
      }
      throw statusError;
    }
    const status = String(result.status ?? "");

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

    // Merge, never replace: input_image_url and retry_count drive the retry path.
    const completedPatch = () => ({
      status: "completed",
      provider_response: mergeProviderResponse(job.provider_response, { status_response: result }),
      completed_at: new Date().toISOString(),
      error: null,
    });

    if (status === "completed") {
      const videoUrl = extractHiggsfieldVideoUrl(result);
      if (!videoUrl) throw new Error("Higgsfield completed but video URL was not returned.");

      const { data: existingAsset } = await admin.from("video_assets")
        .select(ASSET_COLUMNS)
        .eq("production_job_id", job.id).maybeSingle();

      if (existingAsset) {
        const { error: jobUpdateError } = await updateJob(completedPatch());
        if (jobUpdateError) throw new Error("動画は保存済みですが、ジョブ状態の更新に失敗しました: " + jobUpdateError.message);
        await syncCreative(existingAsset.video_url);
        return NextResponse.json({ ok: true, job: { ...job, status: "completed" }, asset: existingAsset });
      }

      const stored = await saveVideoToStorage({ userId: user.id, jobId: job.id, sourceUrl: videoUrl });
      const { data: asset, error: assetError } = await admin.from("video_assets").insert({
        user_id: user.id,
        production_job_id: job.id,
        creative_id: job.creative_id,
        social_post_id: job.social_post_id,
        provider: "higgsfield",
        model: job.model,
        storage_bucket: stored.bucket,
        storage_path: stored.path,
        video_url: stored.url,
        prompt: job.prompt,
        duration: job.duration,
        resolution: job.resolution,
        aspect_ratio: job.aspect_ratio,
        metadata: { bytes: stored.bytes, contentType: stored.contentType, requestId }
      }).select(ASSET_COLUMNS).single();

      if (assetError?.code === "23505") {
        // Another poller already created the DB row. The Storage path is deterministic
        // and shared by the job, so do not delete it here.
        const { data: concurrentAsset, error: concurrentAssetError } = await admin.from("video_assets")
          .select(ASSET_COLUMNS)
          .eq("production_job_id", job.id)
          .maybeSingle();
        if (concurrentAssetError || !concurrentAsset) {
          throw new Error(concurrentAssetError?.message || "競合したvideo assetを再取得できませんでした。");
        }
        const { error: jobUpdateError } = await updateJob(completedPatch());
        if (jobUpdateError) throw new Error("動画は保存済みですが、ジョブ状態の更新に失敗しました: " + jobUpdateError.message);
        return NextResponse.json({ ok: true, job: { ...job, status: "completed" }, asset: concurrentAsset });
      }

      if (assetError || !asset) {
        // No DB row references this upload, so remove the deterministic Storage object.
        // Never perform this cleanup on 23505: the competing transaction may already
        // reference the same object.
        try {
          await deleteVideoFromStorage(stored.path);
        } catch (cleanupError) {
          console.error("video storage cleanup failed after asset insert error", {
            jobId: job.id,
            path: stored.path,
            error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
          });
        }
        throw new Error(assetError?.message || "video assetの保存に失敗しました。");
      }

      const { error: jobUpdateError } = await updateJob(completedPatch());
      if (jobUpdateError) throw new Error("動画は保存されましたが、ジョブ状態の更新に失敗しました: " + jobUpdateError.message);

      await syncCreative(stored.url);

      return NextResponse.json({ ok: true, job: { ...job, status: "completed" }, asset });
    }

    if (status === "failed" || status === "nsfw") {
      const message = `Higgsfield generation ${status}: ${JSON.stringify(result).slice(0, 300)}`;
      const { error: failUpdateError } = await updateJob({
        status: "failed",
        // A moderation rejection fails again with the same prompt and image.
        provider_response: mergeProviderResponse(job.provider_response, {
          status_response: result,
          ...(status === "nsfw" ? { non_retryable: true } : {}),
        }),
        error: message,
        completed_at: new Date().toISOString()
      });
      if (failUpdateError) throw new Error("動画生成の失敗状態を保存できませんでした: " + failUpdateError.message);
      return NextResponse.json({ ok: true, job: { ...job, status: "failed", error: message }, asset: null });
    }

    if (isVideoJobTimedOut(job.started_at)) return markTimedOut(`provider status: ${status || "unknown"}`);

    return NextResponse.json({ ok: true, job: { ...job, provider_status: status }, asset: null });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "動画ジョブ確認に失敗しました。" }, { status: 500 });
  }
}
