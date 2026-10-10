import Constants from "expo-constants";

const defaultWebAppUrl = "https://ai-acquisition-search.vercel.app";

export type ResearchBundle = {
  connected: boolean;
  research: {
    analysis?: {
      comments_analyzed: number;
      pain_points: Array<{ pain: string; count: number; share_percent: number; examples?: string[] }>;
      recommended_angle?: string | null;
      ad_copy_candidates?: string[];
      next_action?: string;
    };
  } | null;
  products: Array<{ title: string; url: string; price: number | null; currency: string; marketplace?: string | null }>;
  opportunity?: {
    top_pain?: { pain: string; count: number; share_percent: number } | null;
    product_directions?: Array<{ pain: string; product_direction: string; validation: string[] }>;
    ad_test_angles?: Array<{ pain: string; hook: string; proof: string }>;
    next_actions?: string[];
  } | null;
  error?: string;
};

export function getWebAppUrl() {
  return (process.env.EXPO_PUBLIC_WEB_APP_URL || (Constants.expoConfig?.extra?.webAppUrl as string | undefined) || defaultWebAppUrl).replace(/\/$/, "");
}

export async function analyzeProduct(url: string) {
  const response = await fetch(getWebAppUrl() + "/api/analyze", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url })
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || "分析に失敗しました。");
  return body.data;
}

export async function researchProduct(url: string): Promise<ResearchBundle> {
  const response = await fetch(getWebAppUrl() + "/api/ec-pulse-research", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url })
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || "市場リサーチに失敗しました。");
  return body;
}
