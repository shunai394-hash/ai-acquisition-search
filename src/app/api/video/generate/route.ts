import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { consumeMonthlyUsage, getUserFromBearer, refundMonthlyUsage } from "@/lib/billing";
import { generateVideo } from "@/lib/video/router";
import { assertPublicUrl } from "@/lib/security/public-url";

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
  // Kept on the job in every outcome so the operator loop can retry image-to-video.
  let referenceImageUrl: string | undefined;
  try {
    const user = await getUserFromBearer(request);
    if (!user) return NextResponse.json({ error: "ログインが必要です。" }, { status: 401 });
    userId = user.id;
    const body = await request.json();
    const prompt = String(body.prompt || "").trim();
    const imageUrl = body.imageUrl ? String(body.imageUrl) : undefined;
    referenceImageUrl = imageUrl;
    if (imageUrl) {
      try {
        // The provider fetches this URL, and it is reused on every later iteration.
        await assertPublicUrl(imageUrl, ["https:"]);
      } catch {
        return NextResponse.json({ error: "imageUrl must be a public HTTPS URL" }, { status: 400 });
      }
    }
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
      provider_response: imageUrl ? { input_image_url: imageUrl } : null,
    }).select("id").single();

    if (jobError || !job) throw new Error(jobError?.message || "production jobの作成に失敗しました。");
    jobId = job.id;

    // エンジン選択はRouterに集約する。現在の既定値はHiggsfield。
    const started = await generateVideo({
      prompt,
      model: model ?? (imageUrl ? "alibaba/wan-3.0-prime/image-to-video" : process.env.HF_VIDEO_MODEL ?? "alibaba/wan-3.0/text-to-video"),
      duration,
      resolution,
      aspectRatio,
      generateAudio,
      imageUrl,
    });
    const requestId = started.requestId;
    providerRequestId = requestId;

    const { error: runningUpdateError } = await admin.from("production_jobs").update({
      status: "running",
      request_id: requestId,
      // Keep input_image_url: retries and the next iteration read it from here.
      provider_response: { ...(imageUrl ? { input_image_url: imageUrl } : {}), engine: started.engine, started_response: started.raw },
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
    const internalMessage = error instanceof Error ? error.message : String(error);
    console.error("video generation request failed", {
      userId: userId || undefined,
      jobId: jobId || undefined,
      providerRequestId: providerRequestId || undefined,
      error: internalMessage.slice(0, 1_000),
    });

    const userMessage = providerRequestId
      ? "動画生成は開始されましたが、状態の保存に問題がありました。自動復旧を継続します。"
      : "動画生成を開始できませんでした。しばらくしてからもう一度お試しください。";

    if (jobId) {
      try {
        const { admin } = clients();
        if (providerRequestId) {
          await admin.from("production_jobs").update({
            status: "running",
            request_id: providerRequestId,
            provider_response: {
              ...(referenceImageUrl ? { input_image_url: referenceImageUrl } : {}),
              recovery: true,
              error_code: "provider_started_state_persistence_failed",
            },
            updated_at: new Date().toISOString(),
          }).eq("id", jobId).eq("user_id", userId);
        } else {
          await admin.from("production_jobs").update({
            status: "failed",
            provider_response: {
              ...(referenceImageUrl ? { input_image_url: referenceImageUrl } : {}),
              error_code: "video_generation_start_failed",
            },
            completed_at: new Date().toISOString(),
          }).eq("id", jobId).eq("user_id", userId);
        }
      } catch (persistError) {
        console.error("video generation failure state persistence failed", {
          jobId,
          error: persistError instanceof Error ? persistError.message : String(persistError),
        });
      }
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
    return NextResponse.json({ error: userMessage, jobId: jobId || undefined }, { status: 500 });
  }
}

