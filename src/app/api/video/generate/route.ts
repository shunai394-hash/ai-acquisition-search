import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { consumeMonthlyUsage, getUserFromBearer, refundMonthlyUsage } from "@/lib/billing";
import { generateVideo } from "@/lib/video/router";
import { generateNarration } from "@/lib/video/gemini-tts";
import { fitWavToDuration, mixNarrationWithBgm } from "@/lib/video/audio";
import { saveAudioToStorage } from "@/lib/video/storage";

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
  let narrationUsageEventId = "";
  let narrationAudioSaved = false;
  // Preserve the external provider request if the DB state update fails after start.
  let providerRequestId = "";
  let imageUrl: string | undefined;
  let imagePath: string | undefined;
  let imageBucket: string | undefined;
  let audioUrl: string | undefined;
  let audioPath: string | undefined;
  let audioBucket: string | undefined;
  try {
    const user = await getUserFromBearer(request);
    if (!user) return NextResponse.json({ error: "ログインが必要です。" }, { status: 401 });
    userId = user.id;
    const body = await request.json();
    const prompt = String(body.prompt || "").trim();
    imageUrl = body.imageUrl ? String(body.imageUrl) : undefined;
    imagePath = body.imagePath ? String(body.imagePath) : undefined;
    imageBucket = body.imageBucket ? String(body.imageBucket) : undefined;
    audioUrl = body.audioUrl ? String(body.audioUrl) : undefined;
    audioPath = body.audioPath ? String(body.audioPath) : undefined;
    audioBucket = body.audioBucket ? String(body.audioBucket) : undefined;
    const narrationText = typeof body.narrationText === "string" ? body.narrationText.trim() : "";
    const includeBgm = body.includeBgm !== false;
    const narrationVoice = typeof body.narrationVoice === "string" ? body.narrationVoice.trim() : undefined;
    const narrationStyle = typeof body.narrationStyle === "string" ? body.narrationStyle.trim() : undefined;
    const bgmPrompt = typeof body.bgmPrompt === "string" ? body.bgmPrompt.trim() : "";
    if (imageUrl && !/^https:\/\//i.test(imageUrl)) return NextResponse.json({ error: "imageUrl must be an HTTPS URL" }, { status: 400 });
    if (audioUrl && !/^https:\/\//i.test(audioUrl)) return NextResponse.json({ error: "audioUrl must be an HTTPS URL" }, { status: 400 });
    if (audioPath && (!audioPath.startsWith(user.id + "/") || audioPath.split("/").some((part) => !part || part === "." || part === ".."))) {
      return NextResponse.json({ error: "audioPath is invalid for this user" }, { status: 400 });
    }
    if (imagePath && (!imagePath.startsWith(user.id + "/") || imagePath.split("/").some((part) => !part || part === "." || part === ".."))) {
      return NextResponse.json({ error: "imagePath is invalid for this user" }, { status: 400 });
    }
    if (imagePath && imageBucket !== "video-inputs") {
      return NextResponse.json({ error: "imageBucket is invalid" }, { status: 400 });
    }
    if (audioPath && !["audio-inputs", "video-audio"].includes(audioBucket || "")) {
      return NextResponse.json({ error: "audioBucket is invalid" }, { status: 400 });
    }
    if (!prompt) return NextResponse.json({ error: "prompt is required" }, { status: 400 });
    if (prompt.length > 10000) return NextResponse.json({ error: "prompt is too long" }, { status: 400 });
    if (narrationText.length > 8000) return NextResponse.json({ error: "narrationText must be 8,000 characters or fewer" }, { status: 400 });
    if (narrationVoice && narrationVoice.length > 100) return NextResponse.json({ error: "narrationVoice is too long" }, { status: 400 });
    if (narrationStyle && narrationStyle.length > 500) return NextResponse.json({ error: "narrationStyle is too long" }, { status: 400 });
    if (bgmPrompt.length > 500) return NextResponse.json({ error: "bgmPrompt is too long" }, { status: 400 });

    const model = body.model ? String(body.model) : undefined;
    const duration = Number(body.duration ?? 5);
    if (!Number.isFinite(duration) || duration < 2 || duration > 30) return NextResponse.json({ error: "duration must be between 2 and 30 seconds" }, { status: 400 });
    const resolution = body.resolution === "480p" || body.resolution === "720p" || body.resolution === "1080p" ? body.resolution : "1080p";
    const aspectRatio = ["16:9","4:3","1:1","3:4","9:16","adaptive"].includes(body.aspectRatio) ? body.aspectRatio : "9:16";
    const generateAudio = body.generateAudio === true;
    const socialPostId = body.socialPostId ? String(body.socialPostId) : null;
    const { admin } = clients();
    if (imagePath && imageBucket) {
      const signedImage = await admin.storage.from(imageBucket).createSignedUrl(imagePath, 60 * 60);
      if (signedImage.error || !signedImage.data?.signedUrl) {
        throw new Error("商品画像の署名付きURLを再発行できませんでした: " + (signedImage.error?.message || "unknown error"));
      }
      imageUrl = signedImage.data.signedUrl;
    }
    if (audioPath && audioBucket) {
      const signedAudio = await admin.storage.from(audioBucket).createSignedUrl(audioPath, 60 * 60);
      if (signedAudio.error || !signedAudio.data?.signedUrl) {
        throw new Error("音声ファイルの署名付きURLを再発行できませんでした: " + (signedAudio.error?.message || "unknown error"));
      }
      audioUrl = signedAudio.data.signedUrl;
    }

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

    if (narrationText) {
      const narrationUsage = await consumeMonthlyUsage(user.id, "narration_generation", 5);
      if (!narrationUsage.allowed) {
        if (usageEventId) {
          try { await refundMonthlyUsage(user.id, "video_generation", usageEventId); } catch (refundError) {
            console.error("video quota refund failed after narration quota rejection", { userId: user.id, usageEventId, error: refundError });
          }
        }
        return NextResponse.json({ error: `今月の無料ナレーション生成回数（${narrationUsage.limit}回）を使い切りました。Proへアップグレードしてください。`, usage: narrationUsage }, { status: 429 });
      }
      narrationUsageEventId = narrationUsage.usage_event_id || "";
    }

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
      model: model ?? ((audioUrl || narrationText) ? process.env.HF_AUDIO_VIDEO_MODEL ?? "alibaba/wan-3.0/reference-to-video" : imageUrl ? "alibaba/wan-3.0-prime/image-to-video" : process.env.HF_VIDEO_MODEL ?? "alibaba/wan-3.0/text-to-video"),
      status: "queued",
      prompt,
      duration,
      resolution,
      aspect_ratio: aspectRatio,
      generate_audio: generateAudio,
      provider_response: imageUrl || audioUrl ? { ...(imageUrl ? { input_image_url: imageUrl } : {}), ...(imagePath ? { input_image_path: imagePath, input_image_bucket: imageBucket } : {}), ...(audioUrl ? { input_audio_url: audioUrl } : {}), ...(audioPath ? { input_audio_path: audioPath, input_audio_bucket: audioBucket } : {}) } : null,
    }).select("id").single();

    if (jobError || !job) throw new Error(jobError?.message || "production jobの作成に失敗しました。");
    jobId = job.id;

    if (narrationText) {
      const narration = await generateNarration({ text: narrationText, voice: narrationVoice, style: narrationStyle });
      const narrationWav = Buffer.from(narration.audioBase64, "base64");
      const audioWav = includeBgm
        ? mixNarrationWithBgm(narrationWav, duration, bgmPrompt)
        : fitWavToDuration(narrationWav, duration);
      const savedAudio = await saveAudioToStorage({ userId: user.id, jobId: job.id, bytes: audioWav });
      narrationAudioSaved = true;
      audioUrl = savedAudio.url;
      audioPath = savedAudio.path;
      audioBucket = savedAudio.bucket;
    }

    // エンジン選択はRouterに集約する。現在の既定値はHiggsfield。
    const started = await generateVideo({
      prompt,
      model: model ?? ((audioUrl || narrationText) ? process.env.HF_AUDIO_VIDEO_MODEL ?? "alibaba/wan-3.0/reference-to-video" : imageUrl ? "alibaba/wan-3.0-prime/image-to-video" : process.env.HF_VIDEO_MODEL ?? "alibaba/wan-3.0/text-to-video"),
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
        ...(usageEventId ? { usage_event_id: usageEventId } : {}),
        ...(narrationUsageEventId ? { narration_usage_event_id: narrationUsageEventId } : {}),
        ...(imageUrl ? { input_image_url: imageUrl } : {}),
        ...(imagePath ? { input_image_path: imagePath, input_image_bucket: imageBucket } : {}),
        ...(audioUrl ? { input_audio_url: audioUrl } : {}),
        ...(audioPath ? { input_audio_path: audioPath, input_audio_bucket: audioBucket } : {}),
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
          await admin.from("production_jobs").update({ status: "running", request_id: providerRequestId, provider_response: { recovery: true, error: message, ...(usageEventId ? { usage_event_id: usageEventId } : {}), ...(narrationUsageEventId ? { narration_usage_event_id: narrationUsageEventId } : {}), ...(imageUrl ? { input_image_url: imageUrl } : {}), ...(imagePath ? { input_image_path: imagePath, input_image_bucket: imageBucket } : {}), ...(audioUrl ? { input_audio_url: audioUrl } : {}), ...(audioPath ? { input_audio_path: audioPath, input_audio_bucket: audioBucket } : {}) }, updated_at: new Date().toISOString() }).eq("id", jobId).eq("user_id", userId);
        } else {
          await admin.from("production_jobs").update({
            status: "failed",
            provider_response: {
              error: message,
              ...(usageEventId ? { usage_event_id: usageEventId } : {}),
              ...(narrationUsageEventId ? { narration_usage_event_id: narrationUsageEventId } : {}),
              ...(imageUrl ? { input_image_url: imageUrl } : {}),
              ...(imagePath ? { input_image_path: imagePath, input_image_bucket: imageBucket } : {}),
              ...(audioUrl ? { input_audio_url: audioUrl } : {}),
              ...(audioPath ? { input_audio_path: audioPath, input_audio_bucket: audioBucket } : {}),
            },
            completed_at: new Date().toISOString()
          }).eq("id", jobId).eq("user_id", userId);
        }
      } catch {}
    }
    if (narrationUsageEventId && !narrationAudioSaved) {
      try {
        const refund = await refundMonthlyUsage(userId, "narration_generation", narrationUsageEventId);
        if (!refund.refunded) console.error("narration quota refund was not applied", { userId, narrationUsageEventId, reason: refund.reason });
      } catch (refundError) {
        console.error("narration quota refund failed", { userId, narrationUsageEventId, error: refundError });
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
    return NextResponse.json({ error: message, jobId: jobId || undefined }, { status: 500 });
  }
}

