export const SUPPORTED_SOCIAL_PLATFORMS = ["tiktok", "instagram", "facebook", "youtube", "x", "linkedin"] as const;
export type SocialPlatform = (typeof SUPPORTED_SOCIAL_PLATFORMS)[number];

export type PromptVideoDraftInput = {
  prompt: string;
  caption: string;
  network: SocialPlatform;
  draftKey: string;
};

export type PromptVideoDraftValidation =
  | { ok: true; value: PromptVideoDraftInput }
  | { ok: false; error: string };

export function validatePromptVideoDraft(input: unknown): PromptVideoDraftValidation {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, error: "動画プロジェクトの情報が必要です。" };
  }

  const body = input as Record<string, unknown>;
  const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
  const caption = typeof body.caption === "string" ? body.caption.trim() : "";
  const network = typeof body.network === "string" ? body.network.trim() : "";
  const draftKey = typeof body.draftKey === "string" ? body.draftKey.trim() : "";

  if (prompt.length < 8 || prompt.length > 10000) {
    return { ok: false, error: "プロンプトは8〜10,000文字で入力してください。" };
  }
  if (caption.length > 2200) {
    return { ok: false, error: "投稿本文は2,200文字以内で入力してください。" };
  }
  if (!SUPPORTED_SOCIAL_PLATFORMS.includes(network as SocialPlatform)) {
    return { ok: false, error: "対応しているSNSを選択してください。" };
  }
  if (!draftKey || draftKey.length > 100) {
    return { ok: false, error: "下書きIDが不正です。" };
  }

  return {
    ok: true,
    value: { prompt, caption, network: network as SocialPlatform, draftKey },
  };
}
