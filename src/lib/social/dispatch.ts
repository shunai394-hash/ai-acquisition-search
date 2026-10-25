import { isOwnedVideoPath, SNS_INGEST_URL_TTL_SECONDS } from "@/lib/video/asset-access";
import { getAdminSupabase } from "@/lib/billing";
import {
  getTikTokAccessToken,
  getTikTokPublishStatus,
  publishTikTokPhoto,
  publishTikTokVideo,
  resolveTikTokVideoId,
} from "@/lib/social/tiktok";
import { LIBRARY_BUCKET, signLibraryAsset } from "@/lib/social/library";
import { VIDEO_BUCKET, signVideoAsset } from "@/lib/video/asset-access";
import { classifyPublishError, redactError, type ErrorClass } from "@/lib/social/queue";

type JobRow = {
  id: string;
  user_id: string;
  caption: string;
  privacy_level?: string | null;
};

type AssetRow = {
  kind: string;
  storage_bucket?: string | null;
  storage_path?: string | null;
  mime_type?: string | null;
  byte_size?: number | null;
  duration_seconds?: number | null;
  ai_generated?: boolean | null;
  upload_status?: string | null;
};

export type DispatchHooks = {
  markAccepted: (publishId: string) => Promise<void>;
};

function asError(error: unknown) {
  const message = redactError(error instanceof Error ? error.message : String(error));
  const failure = new Error(message) as Error & { errorClass: ErrorClass };
  failure.errorClass = classifyPublishError(message);
  return failure;
}

async function mediaUrl(userId: string, asset: AssetRow) {
  if (!asset.storage_path || (asset.storage_bucket !== LIBRARY_BUCKET && asset.storage_bucket !== VIDEO_BUCKET)) {
    throw Object.assign(new Error("投稿できる動画または画像ファイルが登録されていません。"), { errorClass: "terminal" as const });
  }
  if (!isOwnedVideoPath(userId, asset.storage_path)) {
    throw Object.assign(new Error("この素材の所有者ではありません。"), { errorClass: "terminal" as const });
  }
  const db = getAdminSupabase();
  if (asset.storage_bucket === VIDEO_BUCKET) return signVideoAsset(db, asset.storage_path, { ttlSeconds: SNS_INGEST_URL_TTL_SECONDS });
  return signLibraryAsset(db, asset.storage_path, SNS_INGEST_URL_TTL_SECONDS);
}

export async function publishQueuedTikTok(job: JobRow, asset: AssetRow, hooks: DispatchHooks) {
  if (asset.upload_status && asset.upload_status !== "ready") {
    throw Object.assign(new Error("素材のアップロードが完了していません。"), { errorClass: "terminal" as const });
  }
  if (asset.kind === "text") {
    throw Object.assign(new Error("TikTokの公式APIは本文のみの投稿に対応していません。動画または画像を登録してください。"), { errorClass: "terminal" as const });
  }
  if (asset.kind === "video" && typeof asset.duration_seconds === "number") {
    if (asset.duration_seconds < 3 || asset.duration_seconds > 600) {
      throw Object.assign(new Error("TikTokへ送る動画は3秒以上10分以下にしてください。"), { errorClass: "terminal" as const });
    }
  }
  if (asset.kind === "video" && typeof asset.byte_size === "number" && asset.byte_size > 100 * 1024 * 1024) {
    throw Object.assign(new Error("動画が100MBを超えています。"), { errorClass: "terminal" as const });
  }

  let accessToken: string;
  try {
    accessToken = await getTikTokAccessToken(job.user_id);
  } catch (error) {
    throw asError(error);
  }
  const videoUrl = await mediaUrl(job.user_id, asset);
  const privacyLevel = (job.privacy_level || undefined) as "PUBLIC_TO_EVERYONE" | "MUTUAL_FOLLOW_FRIENDS" | "FOLLOWER_OF_CREATOR" | "SELF_ONLY" | undefined;

  try {
    if (asset.kind === "image") {
      const started = await publishTikTokPhoto({
        accessToken,
        imageUrl: videoUrl,
        description: job.caption,
        privacyLevel,
      });
      await hooks.markAccepted(started.publishId);
      const resolved = await resolveTikTokVideoId(started.publishId, accessToken, 2, 1000);
      if (resolved.pending || !resolved.videoId) {
        return { outcome: "pending" as const, externalPostId: started.publishId, postUrl: null, metadata: { privacyLevel: started.privacyLevel } };
      }
      return {
        outcome: "published" as const,
        externalPostId: resolved.videoId,
        postUrl: typeof resolved.share_url === "string" ? resolved.share_url : null,
        metadata: { publishId: started.publishId, privacyLevel: started.privacyLevel },
      };
    }

    const started = await publishTikTokVideo({
      accessToken,
      videoUrl,
      title: job.caption,
      privacyLevel,
      isAigc: asset.ai_generated === true,
    });
    await hooks.markAccepted(started.publishId);
    const resolved = await resolveTikTokVideoId(started.publishId, accessToken, 2, 1000);
    if (resolved.pending) {
      return {
        outcome: "pending" as const,
        externalPostId: started.publishId,
        postUrl: null,
        metadata: { privacyLevel: started.privacyLevel, creatorUsername: started.creatorUsername },
      };
    }
    return {
      outcome: "published" as const,
      externalPostId: resolved.videoId ?? started.publishId,
      postUrl: typeof resolved.share_url === "string" ? resolved.share_url : null,
      metadata: {
        publishId: started.publishId,
        privacyLevel: started.privacyLevel,
        creatorUsername: started.creatorUsername,
        publicVideoId: resolved.videoId ?? null,
      },
    };
  } catch (error) {
    throw asError(error);
  }
}

export async function pollQueuedTikTok(userId: string, publishId: string) {
  const accessToken = await getTikTokAccessToken(userId);
  const status = await getTikTokPublishStatus(publishId, accessToken);
  const publishStatus = String(status?.status ?? "");
  const available = Array.isArray(status?.publicaly_available_post_id)
    ? status.publicaly_available_post_id
    : Array.isArray(status?.publicly_available_post_id)
      ? status.publicly_available_post_id
      : [];
  const videoId = available.length ? String(available[0]) : (typeof status?.video_id === "string" ? status.video_id : null);
  if (publishStatus === "FAILED" || publishStatus === "PUBLISH_CANCELLED") {
    return { outcome: "failed" as const, error: `TikTok publish failed: ${publishStatus}` };
  }
  if (videoId || publishStatus === "PUBLISH_COMPLETE") {
    return {
      outcome: "published" as const,
      externalPostId: videoId || publishId,
      postUrl: typeof status?.share_url === "string" ? status.share_url : null,
    };
  }
  return { outcome: "pending" as const };
}
