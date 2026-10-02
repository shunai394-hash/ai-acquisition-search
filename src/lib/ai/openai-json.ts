export function openAiModel() {
  return process.env.OPENAI_MODEL || "gpt-5-mini";
}

/** Per-request timeout of openAiJson. */
export const OPENAI_JSON_TIMEOUT_MS = 25_000;
/** openAiJson sends at most this many requests (one retry without temperature). */
export const OPENAI_JSON_MAX_ATTEMPTS = 2;

export type OpenAiJsonResult =
  | { status: "ok"; text: string | null }
  | { status: "not_configured" }
  | { status: "failed"; reason: string };

/**
 * JSON-mode chat completion. Returns null on any failure (callers keep their
 * deterministic result). Some models reject a non-default temperature with
 * HTTP 400; in that case the request is retried once without it.
 */
export async function openAiJson(input: { system: string; user: string; timeoutMs?: number }): Promise<string | null> {
  const result = await openAiJsonResult(input);
  return result.status === "ok" ? result.text : null;
}

/**
 * Same request as openAiJson, but tells "no API key configured" (intentional
 * deterministic mode) apart from "the API call failed" (worth retrying).
 */
export async function openAiJsonResult(input: { system: string; user: string; timeoutMs?: number }): Promise<OpenAiJsonResult> {
  const key = process.env.OPENAI_API_KEY?.trim();
  if (!key) return { status: "not_configured" };
  const base = {
    model: openAiModel(),
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: input.system },
      { role: "user", content: input.user },
    ],
  };
  const call = async (body: Record<string, unknown>) => fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(input.timeoutMs ?? OPENAI_JSON_TIMEOUT_MS),
  });
  try {
    let response = await call({ ...base, temperature: 0, seed: 7 });
    if (response.status === 400) {
      const text = await response.text().catch(() => "");
      if (/temperature|seed/i.test(text)) response = await call(base);
      else return { status: "failed", reason: "HTTP 400" };
    }
    if (!response.ok) return { status: "failed", reason: `HTTP ${response.status}` };
    const payload = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
    return { status: "ok", text: payload.choices?.[0]?.message?.content ?? null };
  } catch (error) {
    return { status: "failed", reason: error instanceof Error ? error.name : "unknown" };
  }
}
