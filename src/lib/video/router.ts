import { generateHiggsfieldVideo } from "@/lib/video/higgsfield";

export type VideoEngine = "higgsfield" | "muse";

export type VideoGenerationRequest = {
  prompt: string;
  model?: string;
  duration: number;
  resolution: "480p" | "720p" | "1080p";
  aspectRatio: "16:9" | "4:3" | "1:1" | "3:4" | "9:16" | "adaptive";
  generateAudio: boolean;
  imageUrl?: string;
  audioUrl?: string;
};

export type VideoEngineResult = {
  engine: VideoEngine;
  requestId: string;
  raw: Record<string, unknown>;
};

function configuredEngine(): VideoEngine {
  const value = String(process.env.VIDEO_ENGINE ?? "higgsfield").toLowerCase();
  return value === "muse" ? "muse" : "higgsfield";
}

/**
 * Central routing point for video generation.
 *
 * Muse Video is intentionally represented as a capability, but not called
 * through an undocumented/private API. Once Meta exposes a supported video
 * generation API, only this adapter needs to change.
 */
export async function generateVideo(
  input: VideoGenerationRequest,
): Promise<VideoEngineResult> {
  const engine = configuredEngine();

  if (engine === "muse") {
    throw new Error(
      "Muse Video is selected, but Meta's supported video-generation API is not currently configured for this application. Set VIDEO_ENGINE=higgsfield until a supported Muse Video API is available.",
    );
  }

  const started = await generateHiggsfieldVideo(input);
  const requestId = String(
    started.request_id ?? started.requestId ?? started.id ?? "",
  );

  if (!requestId) {
    throw new Error("動画エンジンからrequest_idを取得できませんでした。");
  }

  return {
    engine,
    requestId,
    raw: started,
  };
}
