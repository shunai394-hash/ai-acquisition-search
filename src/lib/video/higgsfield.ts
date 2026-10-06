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
  // Higgsfield's current API console provides a single complete API key.
  // Keep the legacy KEY_ID:KEY_SECRET pair as a backwards-compatible fallback.
  const apiKey = process.env.HIGGSFIELD_API_KEY ?? process.env.HF_API_KEY;
  if (apiKey) return `Key ${apiKey}`;

  const id = process.env.HF_API_KEY_ID;
  const secret = process.env.HF_API_KEY_SECRET;
  if (id && secret) return `Key ${id}:${secret}`;

  throw new Error(
    "Higgsfield API credentials are not configured. Set HIGGSFIELD_API_KEY (or HF_API_KEY)."
  );
}

/** True when credentials() would succeed; lets callers skip work instead of failing a job. */
export function higgsfieldConfigured() {
  return Boolean(
    process.env.HIGGSFIELD_API_KEY
    || process.env.HF_API_KEY
    || (process.env.HF_API_KEY_ID && process.env.HF_API_KEY_SECRET),
  );
}

function modelPath(model: string) {
  return model.replace(/^\/+|\/+$/g, "");
}

// Documented REST base URL of the Higgsfield API (docs.higgsfield.ai).
export function higgsfieldBaseUrl() {
  return (process.env.HIGGSFIELD_API_BASE_URL || "https://api.higgsfield.ai").replace(/\/+$/, "");
}

async function requestHiggsfield(path: string, init: RequestInit) {
  const response = await fetch(`${higgsfieldBaseUrl()}/${modelPath(path)}`, {
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
    console.error("Higgsfield API request failed", {
      status: response.status,
      response: typeof data === "object" && data !== null ? data : undefined,
    });
    throw new Error(`Higgsfield API error ${response.status}`);
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

export async function cancelHiggsfieldRequest(requestId: string) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8_000);
  try {
    return await requestHiggsfield(`requests/${encodeURIComponent(requestId)}/cancel`, {
      method: "POST",
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

export function extractHiggsfieldVideoUrl(result: Record<string, unknown>) {
  const direct = (result.video as Record<string, unknown> | undefined)?.url;
  if (typeof direct === "string" && /^https?:/i.test(direct)) return direct;
  // Outputs may also come as an array ("video" / "videos": [{ url }]).
  for (const key of ["video", "videos"]) {
    const list = result[key];
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      const url = (item as Record<string, unknown> | null)?.url;
      if (typeof url === "string" && /^https?:/i.test(url)) return url;
    }
  }
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
    if (status === "failed" || status === "nsfw" || status === "canceled") {
      throw new Error(`Higgsfield generation ${status}: ${JSON.stringify(result)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, delay));
    delay = Math.min(Math.round(delay * 1.5), 10_000);
  }
  throw new Error("Higgsfield動画生成がタイムアウトしました。request_idを保存して後からstatus確認してください。");
}
