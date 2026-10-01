export function openAiModel() {
  return process.env.OPENAI_MODEL || "gpt-5-mini";
}

/**
 * JSON-mode chat completion. Returns null on any failure (callers keep their
 * deterministic result). Some models reject a non-default temperature with
 * HTTP 400; in that case the request is retried once without it.
 */
export async function openAiJson(input: { system: string; user: string; timeoutMs?: number }): Promise<string | null> {
  const key = process.env.OPENAI_API_KEY?.trim();
  if (!key) return null;
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
    signal: AbortSignal.timeout(input.timeoutMs ?? 25000),
  });
  try {
    let response = await call({ ...base, temperature: 0, seed: 7 });
    if (response.status === 400) {
      const text = await response.text().catch(() => "");
      if (/temperature|seed/i.test(text)) response = await call(base);
      else return null;
    }
    if (!response.ok) return null;
    const payload = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
    return payload.choices?.[0]?.message?.content ?? null;
  } catch {
    return null;
  }
}
