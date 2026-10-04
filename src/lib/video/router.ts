import { generateHiggsfieldVideo } from "@/lib/video/higgsfield";

export type VideoEngine = "higgsfield" | "muse";

export type VideoGenerationRequest = {
  prompt: string;
  model?: string;
  duration: number;
  resolution: "480p" | "720p" | "1080p";
  aspectRatio: "16:9" | "4:3" | "1:1" | "3:4" | "9:16" | "adaptive";
  generateAudio: boolean;
};

export type VideoEngineResult = {
  engine: VideoEngine;
  requestId: string;
  raw: Record<string, unknown>;
};

function configuredEngine(): VideoEngine {
  return String(process.env.VIDEO_ENGINE ?? "higgsfield").toLowerCase() === "muse" ? "muse" : "higgsfield";
}

export async function generateVideo(input: VideoGenerationRequest): Promise<VideoEngineResult> {
  const engine = configuredEngine();
  if (engine === "muse") {
    throw new Error("Muse Video is selected, but Meta's supported video-generation API is not configured for this application yet.");
  }
  const started = await generateHiggsfieldVideo(input);
  const requestId = String(started.request_id ?? started.requestId ?? started.id ?? "");
  if (!requestId) throw new Error("動画エンジンからrequest_idを取得できませんでした。");
  return { engine, requestId, raw: started };
}
