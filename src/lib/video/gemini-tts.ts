import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pcmToWav } from "@/lib/video/audio";

const GEMINI_TTS_MODEL =
  process.env.GEMINI_TTS_MODEL || "gemini-3.8-flash-tts";

export type GenerateNarrationInput = {
  text: string;
  voice?: string;
  style?: string;
};

export type GenerateNarrationResult = {
  model: string;
  voice: string;
  mimeType: string;
  audioBase64: string;
};

/**
 * Gemini TTS commonly returns raw 24kHz mono 16-bit PCM (audio/L16) even when
 * WAV is requested. Downstream mixing requires a WAV container, so wrap raw PCM.
 */
export function ensureWavBase64(audioBase64: string) {
  const bytes = Buffer.from(audioBase64, "base64");
  if (bytes.length >= 12 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WAVE") {
    return audioBase64;
  }
  const sampleCount = Math.floor(bytes.length / 2);
  if (!sampleCount) throw new Error("Gemini TTSから空の音声データが返りました。");
  const pcm = new Int16Array(sampleCount);
  for (let i = 0; i < sampleCount; i++) pcm[i] = bytes.readInt16LE(i * 2);
  return Buffer.from(pcmToWav(pcm)).toString("base64");
}

export async function generateNarration(
  input: GenerateNarrationInput,
): Promise<GenerateNarrationResult> {
  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    throw new Error("GEMINI_API_KEY が設定されていません。");
  }

  const text = input.text.trim();
  if (!text) {
    throw new Error("ナレーション本文が空です。");
  }

  if (text.length > 8000) {
    throw new Error("ナレーション本文は8000文字以内にしてください。");
  }

  const voice = input.voice || process.env.GEMINI_TTS_VOICE || "Kore";
  const style =
    input.style ||
    "Japanese commercial narration. Natural, clear, warm, confident, and easy to understand.";

  const response = await fetch(
    "https://generativelanguage.googleapis.com/v1beta/interactions",
    {
      method: "POST",
      signal: AbortSignal.timeout(45_000),
      headers: {
        "x-goog-api-key": apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: GEMINI_TTS_MODEL,
        input: [
          {
            type: "user_input",
            content: [
              {
                type: "text",
                text,
                annotations: [
                  {
                    type: "speech_metadata",
                    style,
                  },
                ],
              },
            ],
          },
        ],
        response_format: {
          type: "audio",
          mime_type: "audio/wav",
          sample_rate: 24000,
        },
        generation_config: {
          speech_config: [{ voice }],
        },
      }),
    },
  );

  const payload = (await response.json().catch(() => ({}))) as {
    error?: { message?: string };
    output_audio?: { data?: string };
    steps?: Array<{
      type?: string;
      content?: Array<{ type?: string; data?: string }>;
    }>;
  };

  if (!response.ok) {
    throw new Error(
      payload.error?.message || `Gemini TTS API error: ${response.status}`,
    );
  }

  const audioBase64 =
    payload.output_audio?.data ||
    payload.steps
      ?.flatMap((step) => step.content || [])
      .find((part) => part.type === "audio")?.data;

  if (!audioBase64) {
    throw new Error("Gemini TTSから音声データが返りませんでした。");
  }

  return {
    model: GEMINI_TTS_MODEL,
    voice,
    mimeType: "audio/wav",
    audioBase64: ensureWavBase64(audioBase64),
  };
}

export async function saveNarrationFile(
  input: GenerateNarrationInput,
  outputPath = path.join(
    process.cwd(),
    "generated",
    "narration.wav",
  ),
): Promise<{ outputPath: string; model: string; voice: string }> {
  const result = await generateNarration(input);
  const buffer = Buffer.from(result.audioBase64, "base64");

  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, buffer);

  return {
    outputPath,
    model: result.model,
    voice: result.voice,
  };
}
