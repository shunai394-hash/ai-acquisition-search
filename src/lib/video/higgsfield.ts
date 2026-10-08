import { readFile } from "node:fs/promises";

const DEFAULT_T2V_MODEL =
  process.env.HF_VIDEO_MODEL ?? "alibaba/wan-3.0-prime/text-to-video";

const DEFAULT_I2V_MODEL =
  process.env.HF_I2V_MODEL ?? "alibaba/wan-3.0-prime/image-to-video";
const DEFAULT_AUDIO_MODEL =
  process.env.HF_AUDIO_VIDEO_MODEL ?? "alibaba/wan-3.0/reference-to-video";

export type HiggsfieldVideoInput = {
  prompt: string;
  imageUrl?: string;
  endImageUrl?: string;
  audioUrl?: string;
  model?: string;
  duration?: number;
  resolution?: "480p" | "720p" | "1080p";
  aspectRatio?: "16:9" | "4:3" | "1:1" | "3:4" | "9:16" | "adaptive";
  generateAudio?: boolean;
};

function credentials() {
  const apiKey = process.env.HIGGSFIELD_API_KEY ?? process.env.HF_API_KEY;

  if (apiKey) {
    return `Key ${apiKey}`;
  }

  const id = process.env.HF_API_KEY_ID;
  const secret = process.env.HF_API_KEY_SECRET;

  if (id && secret) {
    return `Key ${id}:${secret}`;
  }

  throw new Error(
    "Higgsfield API credentials are not configured. Set HIGGSFIELD_API_KEY (or HF_API_KEY)."
  );
}

function modelPath(model: string) {
  return model.replace(/^\/+|\/+$/g, "");
}

function isHttpUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

async function requestHiggsfield(path: string, init: RequestInit) {
  const response = await fetch(
    `https://api.higgsfield.ai/${modelPath(path)}`,
    {
      ...init,
      headers: {
        Authorization: credentials(),
        "Content-Type": "application/json",
        ...(init.headers ?? {}),
      },
    }
  );

  const text = await response.text();

  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }

  if (!response.ok) {
    throw new Error(
      `Higgsfield API error ${response.status}: ${JSON.stringify(data)}`
    );
  }

  return data as Record<string, unknown>;
}

export async function generateHiggsfieldVideo(
  input: HiggsfieldVideoInput
) {
  const hasImage = Boolean(input.imageUrl?.trim());

  const model =
    input.model ??
    (hasImage ? DEFAULT_I2V_MODEL : DEFAULT_T2V_MODEL);

  const imageUrl = input.imageUrl?.trim();
  const audioUrl = input.audioUrl?.trim();

  if (hasImage && imageUrl && !isHttpUrl(imageUrl)) {
    throw new Error("imageUrl must be a public HTTP(S) URL.");
  }
  if (audioUrl && !isHttpUrl(audioUrl)) {
    throw new Error("audioUrl must be a public HTTP(S) URL.");
  }

  const isReferenceToVideo = model.includes("/reference-to-video");
  const isImageToVideo =
    hasImage &&
    (model.includes("/image-to-video") || model === DEFAULT_I2V_MODEL);

  if (audioUrl && !isReferenceToVideo) {
    throw new Error(
      `The selected Higgsfield model does not support audio reference input: ${model}. Use HF_AUDIO_VIDEO_MODEL with a reference-to-video model.`
    );
  }

  if (hasImage && !isImageToVideo) {
    throw new Error(
      `The selected Higgsfield model does not support image-to-video: ${model}`
    );
  }

  const effectiveModel = audioUrl ? DEFAULT_AUDIO_MODEL : model;
  const body: Record<string, unknown> = {
    prompt: input.prompt,
    duration: input.duration ?? 5,
    resolution: input.resolution ?? "1080p",
    aspect_ratio: input.aspectRatio ?? "9:16",
    generate_audio: input.generateAudio ?? false,
    enable_thinking: false,
  };

  if (isReferenceToVideo && imageUrl) {
    body.image_urls = [imageUrl];
  } else if (isImageToVideo && imageUrl) {
    body.image_url = imageUrl;

    if (input.endImageUrl) {
      if (!isHttpUrl(input.endImageUrl)) {
        throw new Error("endImageUrl must be a public HTTP(S) URL.");
      }

      body.end_image_url = input.endImageUrl;
    }
  }

  if (audioUrl) {
    body.audio_urls = [audioUrl];
    body.generate_audio = false;
  }

  return requestHiggsfield(effectiveModel, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export async function uploadHiggsfieldReference(filePath: string) {
  const buffer = await readFile(filePath);

  if (buffer.length === 0) {
    throw new Error("Reference file is empty.");
  }

  throw new Error(
    "Reference upload is not wired yet. Use a public HTTPS media URL with a reference-to-video model."
  );
}

export async function getHiggsfieldStatus(requestId: string) {
  return requestHiggsfield(
    `requests/${encodeURIComponent(requestId)}/status`,
    { method: "GET" }
  );
}

export function extractHiggsfieldVideoUrl(
  result: Record<string, unknown>
) {
  const directVideo = result.video;

  if (
    directVideo &&
    typeof directVideo === "object" &&
    typeof (directVideo as Record<string, unknown>).url === "string"
  ) {
    const url = (directVideo as Record<string, unknown>).url;

    if (typeof url === "string" && /^https?:/i.test(url)) {
      return url;
    }
  }

  const directUrl = result.url;

  if (
    typeof directUrl === "string" &&
    /^https?:/i.test(directUrl)
  ) {
    return directUrl;
  }

  const jobs = Array.isArray(result.jobs) ? result.jobs : [];

  for (const job of jobs) {
    if (!job || typeof job !== "object") continue;

    const jobRecord = job as Record<string, unknown>;
    const results = jobRecord.results;

    if (!results || typeof results !== "object") continue;

    const resultsRecord = results as Record<string, unknown>;
    const raw = resultsRecord.raw;

    if (
      typeof raw === "string" &&
      /^https?:/i.test(raw)
    ) {
      return raw;
    }

    if (raw && typeof raw === "object") {
      const nestedUrl = (raw as Record<string, unknown>).url;

      if (
        typeof nestedUrl === "string" &&
        /^https?:/i.test(nestedUrl)
      ) {
        return nestedUrl;
      }
    }

    const url = resultsRecord.url;

    if (
      typeof url === "string" &&
      /^https?:/i.test(url)
    ) {
      return url;
    }
  }

  return undefined;
}

export async function waitForHiggsfieldVideo(
  requestId: string,
  timeoutMs = 15 * 60_000
) {
  const started = Date.now();
  let delay = 2_000;

  while (Date.now() - started < timeoutMs) {
    const result = await getHiggsfieldStatus(requestId);
    const status = String(result.status ?? "").toLowerCase();

    if (status === "completed" || status === "succeeded") {
      const videoUrl = extractHiggsfieldVideoUrl(result);

      if (!videoUrl) {
        throw new Error(
          "Higgsfield generation completed but no video URL was returned."
        );
      }

      return {
        ...result,
        videoUrl,
      };
    }

    if (
      status === "failed" ||
      status === "nsfw" ||
      status === "cancelled" ||
      status === "canceled"
    ) {
      throw new Error(
        `Higgsfield generation ${status}: ${JSON.stringify(result)}`
      );
    }

    await new Promise((resolve) => setTimeout(resolve, delay));

    delay = Math.min(
      Math.round(delay * 1.5),
      10_000
    );
  }

  throw new Error(
    "Higgsfield video generation timed out. Keep the request_id and check its status later."
  );
}
