import { readFile } from "node:fs/promises";

const DEFAULT_MODEL = process.env.HF_VIDEO_MODEL ?? "alibaba/wan-3.0/text-to-video";

export type HiggsfieldVideoInput = {
  prompt: string;
  model?: string;
  duration?: number;
  resolution?: "480p" | "720p" | "1080p";
  aspectRatio?: "16:9" | "4:3" | "1:1" | "3:4" | "9:16" | "adaptive";
  generateAudio?: boolean;
  imageUrl?: string;
};

function credentials() {
  const id = process.env.HF_API_KEY_ID;
  const secret = process.env.HF_API_KEY_SECRET;
  if (!id || !secret) {
    throw new Error("Higgsfield API credentials are not configured. Set HF_API_KEY_ID and HF_API_KEY_SECRET.");
  }
  return `Key ${id}:${secret}`;
}

function modelPath(model: string) {
  return model.replace(/^\/+|\/+$/g, "");
}

async function requestHiggsfield(path: string, init: RequestInit) {
  const response = await fetch(`https://api.higgsfield.ai/${modelPath(path)}`, {
    ...init,
    headers: {
      Authorization: credentials(),
      "Content-Type": "application/json",
      ...(init.headers ?? {})
    }
  });
  const text = await response.text();
  let data: unknown;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!response.ok) {
    throw new Error(`Higgsfield API error ${response.status}: ${JSON.stringify(data)}`);
  }
  return data as Record<string, unknown>;
}

export async function generateHiggsfieldVideo(input: HiggsfieldVideoInput) {
  const model = input.model ?? DEFAULT_MODEL;
  const imageModel = model.includes("/image-to-video");
  const requestModel = imageModel && !input.imageUrl ? "alibaba/wan-3.0/text-to-video" : model;
  return requestHiggsfield(requestModel, {
    method: "POST",
    body: JSON.stringify({
      prompt: input.prompt,
      duration: input.duration ?? 5,
      resolution: input.resolution ?? "1080p",
      aspect_ratio: input.aspectRatio ?? "9:16",
      generate_audio: input.generateAudio ?? false,
      enable_thinking: false,
      ...(input.imageUrl ? { image_url: input.imageUrl } : {})
    })
  });
}

export async function uploadHiggsfieldReference(filePath: string) {
  const buffer = await readFile(filePath);
  if (buffer.length === 0) throw new Error("Reference file is empty.");
  throw new Error("Reference upload is not wired yet. Use a public HTTPS media URL with a reference-to-video model.");
}


export async function getHiggsfieldStatus(requestId: string) {
  return requestHiggsfield(`requests/${encodeURIComponent(requestId)}/status`, { method: "GET" });
}

export function extractHiggsfieldVideoUrl(result: Record<string, unknown>) {
  const direct = (result.video as Record<string, unknown> | undefined)?.url;
  if (typeof direct === "string" && /^https?:/i.test(direct)) return direct;
  const jobs = Array.isArray(result.jobs) ? result.jobs : [];
  for (const job of jobs) {
    const raw = (job as Record<string, unknown>).results;
    const url = (raw as Record<string, unknown> | undefined)?.raw;
    if (typeof url === "string" && /^https?:/i.test(url)) return url;
    const nested = (url as Record<string, unknown> | undefined)?.url;
    if (typeof nested === "string" && /^https?:/i.test(nested)) return nested;
  }
  return undefined;
}

export async function waitForHiggsfieldVideo(requestId: string, timeoutMs = 15 * 60_000) {
  const started = Date.now();
  let delay = 2_000;
  while (Date.now() - started < timeoutMs) {
    const result = await getHiggsfieldStatus(requestId);
    const status = String(result.status ?? "");
    if (status === "completed") {
      const videoUrl = extractHiggsfieldVideoUrl(result);
      if (!videoUrl) throw new Error("Higgsfield生成はcompletedですが動画URLを取得できませんでした。");
      return { ...result, videoUrl };
    }
    if (status === "failed" || status === "nsfw") {
      throw new Error(`Higgsfield generation ${status}: ${JSON.stringify(result)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, delay));
    delay = Math.min(Math.round(delay * 1.5), 10_000);
  }
  throw new Error("Higgsfield動画生成がタイムアウトしました。request_idを保存して後からstatus確認してください。");
}
