export const SUPPORTED_SOCIAL_DRAFT_PLATFORMS = ["tiktok", "instagram", "facebook", "youtube", "x", "linkedin"] as const;
export type SocialDraftPlatform = (typeof SUPPORTED_SOCIAL_DRAFT_PLATFORMS)[number];

export type SocialDraftInput = {
  prompt: string;
  caption: string;
  network: SocialDraftPlatform;
  draftKey: string;
};

export type SocialDraftValidation =
  | { ok: true; value: SocialDraftInput }
  | { ok: false; error: string };

export function validateSocialDraftInput(body: unknown): SocialDraftValidation {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, error: "動画プロジェクトの情報が必要です。" };
  }

  const record = body as Record<string, unknown>;
  const prompt = typeof record.prompt === "string" ? record.prompt.trim() : "";
  const caption = typeof record.caption === "string" ? record.caption.trim() : "";
  const network = typeof record.network === "string" ? record.network.trim() : "";
  const draftKey = typeof record.draftKey === "string" ? record.draftKey.trim() : "";

  if (prompt.length < 8 || prompt.length > 10000) {
    return { ok: false, error: "プロンプトは8〜10,000文字で入力してください。" };
  }
  if (caption.length > 2200) {
    return { ok: false, error: "投稿本文は2,200文字以内で入力してください。" };
  }
  if (!SUPPORTED_SOCIAL_DRAFT_PLATFORMS.includes(network as SocialDraftPlatform)) {
    return { ok: false, error: "対応しているSNSを選択してください。" };
  }
  if (!draftKey || draftKey.length > 100) {
    return { ok: false, error: "下書きIDが不正です。" };
  }

  return {
    ok: true,
    value: { prompt, caption, network: network as SocialDraftPlatform, draftKey },
  };
}
