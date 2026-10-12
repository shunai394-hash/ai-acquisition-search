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
  if (typeof record.prompt !== "string" || typeof record.caption !== "string" || typeof record.network !== "string" || typeof record.draftKey !== "string") {
    return { ok: false, error: "プロンプト、投稿本文、SNS、下書きIDの形式が不正です。" };
  }

  const prompt = record.prompt.trim();
  const caption = record.caption.trim();
  const network = record.network.trim();
  const draftKey = record.draftKey.trim();

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
