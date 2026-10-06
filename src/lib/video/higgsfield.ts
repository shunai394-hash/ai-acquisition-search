import { readFile } from "node:fs/promises";

const DEFAULT_MODEL = process.env.HF_VIDEO_MODEL ?? "alibaba/wan-3.0/text-to-video";
const DEFAULT_BASE_URL = "https://api.higgsfield.ai";
const HTTP_TIMEOUT_MS = 30_000;

export type HiggsfieldVideoInput = {
  prompt: string;
  model?: string;
  duration?: number;
  resolution?: "480p" | "720p" | "1080p";
  aspectRatio?: "16:9" | "4:3" | "1:1" | "3:4" | "9:16" | "adaptive";
  generateAudio?: boolean;
  imageUrl?: string;
  audioUrl?: string;
};

function credentials() {
  const direct = process.env.HIGGSFIELD_API_KEY?.trim();
  if (direct) return direct.startsWith("Key ") ? direct : `Key ${direct}`;

  const apiKey = process.env.HF_API_KEY?.trim();
  if (apiKey) return apiKey.startsWith("Key ") ? apiKey : `Key ${apiKey}`;

  const id = process.env.HF_API_KEY_ID?.trim();
  const secret = process.env.HF_API_KEY_SECRET?.trim();
  if (id && secret) return `Key ${id}:${secret}`;

  throw new Error(
    "Higgsfield API credentials are not configured. Set HIGGSFIELD_API_KEY or HF_API_KEY_ID/HF_API_KEY_SECRET.",
  );
}

export function higgsfieldConfigured() {
  return Boolean(
    process.env.HIGGSFIELD_API_KEY?.trim() ||
    process.env.HF_API_KEY?.trim() ||
    (process.env.HF_API_KEY_ID?.trim() && process.env.HF_API_KEY_SECRET?.trim()),
  );
}

function modelPath(model: string) {
  return model.replace(/^\/+|\/+$/g, "");
}

export function higgsfieldBaseUrl() {
  const raw = (process.env.HIGGSFIELD_API_BASE_URL || DEFAULT_BASE_URL).trim();
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("Higgsfield API base URL is invalid.");
  }
  if (!["https:", "http:"].includes(parsed.protocol) || parsed.search || parsed.hash) {
    throw new Error(
      "Higgsfield API base URL must be an absolute HTTP(S) URL without query parameters.",
    );
  }
  return parsed.toString().replace(/\/+$/, "");
}

async function requestHiggsfield(path: string, init: RequestInit) {
  const response = await fetch(`${higgsfieldBaseUrl()}/${modelPath(path)}`, {
    ...init,
    headers: {
      Authorization: credentials(),
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
    signal: init.signal ?? AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });

  const text = await response.text();
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }

  if (!response.ok) {
    console.error("Higgsfield API request failed", {
      status: response.status,
      response: typeof data === "object" && data !== null ? data : undefined,
    });
    throw new Error(`Higgsfield API error ${response.status}`);
  }

  return data as Record<string, unknown>;
}

function firstHttpUrl(value: unknown): string | undefined {
  if (typeof value === "string" && /^https?:/i.test(value)) return value;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = firstHttpUrl(item);
      if (found) return found;
    }
  }
  if (value && typeof value === "object") {
    for (const key of ["url", "video_url", "videoUrl", "download_url", "downloadUrl", "src"]) {
      const found = firstHttpUrl((value as Record<string, unknown>)[key]);
      if (found) return found;
    }
  }
  return undefined;
}

export async function generateHiggsfieldVideo(input: HiggsfieldVideoInput) {
  const requestedModel = input.model ?? DEFAULT_MODEL;
  const requestModel =
    input.imageUrl && input.audioUrl
      ? "wan/v2.7/image-to-video"
      : input.imageUrl
        ? requestedModel.includes("/image-to-video")
          ? requestedModel
          : "alibaba/wan-3.0-prime/image-to-video"
        : requestedModel.includes("/image-to-video")
          ? "alibaba/wan-3.0/text-to-video"
          : requestedModel;

  return requestHiggsfield(requestModel, {
    method: "POST",
    body: JSON.stringify({
      prompt: input.prompt,
      duration: input.duration ?? 5,
      resolution: input.resolution ?? "1080p",
      aspect_ratio: input.aspectRatio ?? "9:16",
      generate_audio: input.generateAudio ?? false,
      enable_thinking: false,
      ...(input.imageUrl ? { image_url: input.imageUrl } : {}),
      ...(input.audioUrl ? { audio_url: input.audioUrl, generate_audio: false } : {}),
    }),
  });
}

export async function uploadHiggsfieldReference(filePath: string) {
  const buffer = await readFile(filePath);
  if (buffer.length === 0) throw new Error("Reference file is empty.");
  throw new Error(
    "Reference upload is not wired yet. Use a public HTTPS media URL with a reference-to-video model.",
  );
}

export async function getHiggsfieldStatus(requestId: string) {
  return requestHiggsfield(
    `requests/${encodeURIComponent(requestId)}/status`,
    { method: "GET" },
  );
}

export async function cancelHiggsfieldRequest(requestId: string) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8_000);
  try {
    return await requestHiggsfield(
      `requests/${encodeURIComponent(requestId)}/cancel`,
      { method: "POST", signal: controller.signal },
    );
  } finally {
    clearTimeout(timer);
  }
}

export function extractHiggsfieldVideoUrl(result: Record<string, unknown>) {
  const direct = firstHttpUrl(result.video);
  if (direct) return direct;

  for (const key of ["videos", "output", "result", "data", "asset", "jobs", "images", "video_url", "videoUrl", "download_url", "downloadUrl"]) {
    const found = firstHttpUrl(result[key]);
    if (found) return found;
  }

  return undefined;
}

function normalizedStatus(result: Record<string, unknown>) {
  return String(
    result.status ?? result.state ?? result.request_status ?? "",
  ).toLowerCase().replace(/[-_\s]/g, "");
}

function providerErrorMessage(result: Record<string, unknown>) {
  const message = result.error ?? result.message ?? result.detail;
  return typeof message === "string" && message.trim()
    ? message.trim()
    : JSON.stringify(result);
}

function nextPollDelay(current: number) {
  const base = Math.min(Math.round(current * 1.45), 10_000);
  return Math.max(2_000, base + Math.floor(Math.random() * 350));
}

async function getStatusWithRetry(requestId: string) {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await getHiggsfieldStatus(requestId);
    } catch (error) {
      lastError = error;
      if (attempt < 2) {
        await new Promise((resolve) => setTimeout(resolve, 1_000 * (attempt + 1)));
      }
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error("Higgsfield status check failed.");
}

export async function waitForHiggsfieldVideo(
  requestId: string,
  timeoutMs = 15 * 60_000,
) {
  const started = Date.now();
  let delay = 2_000;

  while (Date.now() - started < timeoutMs) {
    const result = await getStatusWithRetry(requestId);
    const status = normalizedStatus(result);

    if (["completed", "succeeded", "success", "done"].includes(status)) {
      const videoUrl = extractHiggsfieldVideoUrl(result);
      if (!videoUrl) {
        throw new Error("Higgsfield生成はcompletedですが動画URLを取得できませんでした。");
      }
      return completionResult(result, videoUrl);
    }

    if (["failed", "nsfw", "canceled", "cancelled"].includes(status)) {
      throw new Error(
        `Higgsfield generation ${status}: ${providerErrorMessage(result)}`,
      );
    }

    await new Promise((resolve) => setTimeout(resolve, delay));
    delay = nextPollDelay(delay);
  }

  throw new Error(
    "Higgsfield動画生成がタイムアウトしました。request_idを保存して後からstatus確認してください。",
  );
}

function completionResult(result: Record<string, unknown>, videoUrl: string) {
  if (!/^https?:/i.test(videoUrl)) {
    throw new Error("Higgsfield returned an invalid video URL.");
  }
  return { ...result, videoUrl };
}
