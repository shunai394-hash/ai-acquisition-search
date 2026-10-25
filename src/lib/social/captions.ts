import { openAiJsonResult } from "@/lib/ai/openai-json";
import { captionLimit, composeCaption, type AssetKind, type Network } from "@/lib/social/queue";

export type CaptionPurpose = "product" | "awareness" | "traffic";

export type CaptionSuggestion = {
  caption: string;
  hashtags: string[];
  preview: string;
};

const PURPOSE_LABEL: Record<CaptionPurpose, string> = {
  product: "商品紹介",
  awareness: "ブランド認知",
  traffic: "集客",
};

export function templateCaptions(input: {
  body: string;
  purpose: CaptionPurpose;
  network: Network;
  kind: AssetKind;
}): CaptionSuggestion[] {
  const subject = input.body.trim().slice(0, 80) || "この内容";
  const purpose = PURPOSE_LABEL[input.purpose];
  const drafts = [
    { caption: `${subject}。${purpose}として、要点を短く伝えます。`, hashtags: [purpose, "投稿"] },
    { caption: `いま見ている人へ。${subject}`, hashtags: [purpose] },
    { caption: `${subject}を、${input.network}向けに短くまとめました。`, hashtags: [input.network, purpose] },
  ];
  const limit = captionLimit(input.network, input.kind);
  return drafts.map((draft) => ({
    caption: draft.caption.slice(0, limit),
    hashtags: draft.hashtags,
    preview: composeCaption(draft.caption, draft.hashtags).slice(0, limit),
  }));
}

export async function suggestCaptions(input: {
  body: string;
  purpose: CaptionPurpose;
  network: Network;
  kind: AssetKind;
  historyNote?: string;
}) {
  const limit = captionLimit(input.network, input.kind);
  const templates = templateCaptions(input);
  const ai = await openAiJsonResult({
    system: "あなたはSNS投稿文の編集者です。指定のJSONだけを返します。投稿は実行せず、文案だけを提案します。誇張や未確認の実績は書かないでください。",
    user: JSON.stringify({
      network: input.network,
      purpose: PURPOSE_LABEL[input.purpose],
      material: input.body.slice(0, 2000),
      captionLimit: limit,
      history: input.historyNote?.slice(0, 1000) || null,
      responseShape: { suggestions: [{ caption: "string", hashtags: ["string"] }] },
      count: 3,
    }),
  });
  if (ai.status !== "ok" || !ai.text) {
    return {
      source: "template" as const,
      applied: false,
      reason: ai.status === "not_configured" ? "OPENAI_API_KEY が未設定のため、定型文案を返しました。" : "AI文案の取得に失敗したため、定型文案を返しました。",
      suggestions: templates,
    };
  }
  try {
    const parsed = JSON.parse(ai.text) as { suggestions?: Array<{ caption?: unknown; hashtags?: unknown }> };
    const suggestions = (parsed.suggestions || []).slice(0, 3).map((item) => {
      const caption = typeof item.caption === "string" ? item.caption.trim().slice(0, limit) : "";
      const hashtags = Array.isArray(item.hashtags)
        ? item.hashtags.filter((tag): tag is string => typeof tag === "string").map((tag) => tag.replace(/^#+/, "").trim()).filter(Boolean).slice(0, 8)
        : [];
      return { caption, hashtags, preview: composeCaption(caption, hashtags).slice(0, limit) };
    }).filter((item) => item.caption);
    if (!suggestions.length) throw new Error("empty");
    return { source: "openai" as const, applied: false, reason: null, suggestions };
  } catch {
    return {
      source: "template" as const,
      applied: false,
      reason: "AIの応答を文案として解釈できなかったため、定型文案を返しました。",
      suggestions: templates,
    };
  }
}
