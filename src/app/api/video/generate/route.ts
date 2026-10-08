import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { consumeMonthlyUsage, getUserFromBearer, refundMonthlyUsage } from "@/lib/billing";
import { generateVideo } from "@/lib/video/router";

export const runtime = "nodejs";
export const maxDuration = 60;

function clients() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRole = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceRole) throw new Error("Supabase configuration is incomplete.");
  return {
    admin: createClient(url, serviceRole, { auth: { autoRefreshToken: false, persistSession: false } })
  };
}

export async function POST(request: Request) {
  let jobId = "";
  let userId = "";
  let usageEventId = "";
  // Preserve the external provider request if the DB state update fails after start.
  let providerRequestId = "";
  let imageUrl: string | undefined;
  let audioUrl: string | undefined;
  try {
    const user = await getUserFromBearer(request);
    if (!user) return NextResponse.json({ error: "ログインが必要です。" }, { status: 401 });
    userId = user.id;
    const body = await request.json();
    const prompt = String(body.prompt || "").trim();
    imageUrl = body.imageUrl ? String(body.imageUrl) : undefined;
    audioUrl = body.audioUrl ? String(body.audioUrl) : undefined;
    if (imageUrl && !/^https:\/\//i.test(imageUrl)) return NextResponse.json({ error: "imageUrl must be an HTTPS URL" }, { status: 400 });
    if (audioUrl && !/^https:\/\//i.test(audioUrl)) return NextResponse.json({ error: "audioUrl must be an HTTPS URL" }, { status: 400 });
    if (!prompt) return NextResponse.json({ error: "prompt is required" }, { status: 400 });
    if (prompt.length > 10000) return NextResponse.json({ error: "prompt is too long" }, { status: 400 });

    const model = body.model ? String(body.model) : undefined;
    const duration = Number(body.duration ?? 5);
    if (!Number.isFinite(duration) || duration < 2 || duration > 30) return NextResponse.json({ error: "duration must be between 2 and 30 seconds" }, { status: 400 });
    const resolution = body.resolution === "480p" || body.resolution === "720p" || body.resolution === "1080p" ? body.resolution : "1080p";
    const aspectRatio = ["16:9","4:3","1:1","3:4","9:16","adaptive"].includes(body.aspectRatio) ? body.aspectRatio : "9:16";
    const generateAudio = Boolean(body.generateAudio ?? false);
    const socialPostId = body.socialPostId ? String(body.socialPostId) : null;
    const { admin } = clients();

    let creativeId: string | null = null;
    if (socialPostId) {
      const { data: post, error } = await admin.from("social_posts").select("id,creative_id").eq("id", socialPostId).eq("user_id", user.id).maybeSingle();
      if (error) throw new Error(error.message);
      if (!post) throw new Error("指定されたsocial postが見つかりません。");
      creativeId = post.creative_id;
    }

    const usage = await consumeMonthlyUsage(user.id, "video_generation", 5);
    if (!usage.allowed) return NextResponse.json({ error: `今月の無料動画生成回数（${usage.limit}回）を使い切りました。Proへアップグレードしてください。`, usage }, { status: 429 });
    usageEventId = usage.usage_event_id || "";


    if (imageUrl && creativeId) {
      const { data: creativeRecord, error: creativeReadError } = await admin.from("creatives")
        .select("scenario")
        .eq("id", creativeId)
        .eq("user_id", user.id)
        .maybeSingle();
      if (creativeReadError) throw new Error(creativeReadError.message);
      const scenario = creativeRecord?.scenario && typeof creativeRecord.scenario === "object"
        ? creativeRecord.scenario as Record<string, unknown>
        : {};
      const { error: creativeImageError } = await admin.from("creatives").update({
        scenario: { ...scenario, input_image_url: imageUrl },
      }).eq("id", creativeId).eq("user_id", user.id);
      if (creativeImageError) throw new Error(creativeImageError.message);
    }

    const { data: job, error: jobError } = await admin.from("production_jobs").insert({
      user_id: user.id,
      social_post_id: socialPostId,
      creative_id: creativeId,
      provider: process.env.VIDEO_ENGINE ?? "higgsfield",
      model: model ?? (imageUrl ? "alibaba/wan-3.0-prime/image-to-video" : process.env.HF_VIDEO_MODEL ?? "alibaba/wan-3.0/text-to-video"),
      status: "queued",
      prompt,
      duration,
      resolution,
      aspect_ratio: aspectRatio,
      generate_audio: generateAudio,
      provider_response: imageUrl || audioUrl ? { ...(imageUrl ? { input_image_url: imageUrl } : {}), ...(audioUrl ? { input_audio_url: audioUrl } : {}) } : null,
    }).select("id").single();

    if (jobError || !job) throw new Error(jobError?.message || "production jobの作成に失敗しました。");
    jobId = job.id;

    // エンジン選択はRouterに集約する。現在の既定値はHiggsfield。
    const started = await generateVideo({
      prompt,
      model: model ?? (audioUrl ? process.env.HF_AUDIO_VIDEO_MODEL ?? "alibaba/wan-3.0/reference-to-video" : imageUrl ? "alibaba/wan-3.0-prime/image-to-video" : process.env.HF_VIDEO_MODEL ?? "alibaba/wan-3.0/text-to-video"),
      duration,
      resolution,
      aspectRatio,
      generateAudio,
      imageUrl,
      audioUrl,
    });
    const requestId = started.requestId;
    providerRequestId = requestId;

    const { error: runningUpdateError } = await admin.from("production_jobs").update({
      status: "running",
      request_id: requestId,
      provider_response: {
        engine: started.engine,
        started_response: started.raw,
        ...(imageUrl ? { input_image_url: imageUrl } : {}),
        ...(audioUrl ? { input_audio_url: audioUrl } : {}),
      },
      started_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }).eq("id", job.id).eq("user_id", user.id);
    if (runningUpdateError) throw new Error(`動画ジョブの状態保存に失敗しました: ${runningUpdateError.message}`);

    return NextResponse.json({
      ok: true,
      jobId,
      requestId,
      status: "running",
      engine: started.engine,
      message: `${started.engine}で動画生成を開始しました。完成まで自動で確認します。`
    }, { status: 202 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "動画生成の開始に失敗しました。";
    if (jobId) {
      try {
        const { admin } = clients();
        if (providerRequestId) {
          await admin.from("production_jobs").update({ status: "running", request_id: providerRequestId, provider_response: { recovery: true, error: message, ...(imageUrl ? { input_image_url: imageUrl } : {}), ...(audioUrl ? { input_audio_url: audioUrl } : {}) }, updated_at: new Date().toISOString() }).eq("id", jobId).eq("user_id", userId);
        } else {
          await admin.from("production_jobs").update({ status: "failed", provider_response: { error: message }, completed_at: new Date().toISOString() }).eq("id", jobId).eq("user_id", userId);
        }
      } catch {}
    }
    if (usageEventId && !providerRequestId) {
      try {
        const refund = await refundMonthlyUsage(userId, "video_generation", usageEventId);
        if (!refund.refunded) {
          console.error("video generation quota refund was not applied", {
            userId,
            usageEventId,
            reason: refund.reason,
          });
        }
      } catch (refundError) {
        console.error("video generation quota refund failed", {
          userId,
          usageEventId,
          error: refundError,
        });
      }
    }
    return NextResponse.json({ error: message, jobId: jobId || undefined }, { status: 500 });
  }
}

