import type { MarketEvidence } from "@/lib/decision/types";

// Kept for backward compatibility with existing deployments. This is a
// deployment-specific (pinned) URL; production should set EC_PULSE_API_URL to
// the EC-Pulse production domain so the latest EC-Pulse main is used.
const LEGACY_DEFAULT_URL = "https://ec-pulse-rk8mola3m-naitoshyuichirou-6935.vercel.app";

export function ecPulseBaseUrl() {
  return (process.env.EC_PULSE_API_URL || LEGACY_DEFAULT_URL).trim().replace(/\/$/, "");
}

export function ecPulseConfig() {
  const url = ecPulseBaseUrl();
  return {
    url,
    configured: Boolean(process.env.EC_PULSE_API_KEY?.trim()),
    explicitUrl: Boolean(process.env.EC_PULSE_API_URL?.trim()),
    // <project>-<hash>-<scope>.vercel.app is a single immutable deployment, not production.
    pinnedDeployment: /^https:\/\/[a-z0-9-]+-[a-z0-9]{9}-[a-z0-9-]+\.vercel\.app$/i.test(url),
  };
}

export async function ecPulseFetch(path: string, init: RequestInit & { timeoutMs?: number } = {}) {
  const apiKey = process.env.EC_PULSE_API_KEY?.trim();
  if (!apiKey) throw new EcPulseNotConfigured();
  const { timeoutMs = 8000, headers, ...rest } = init;
  const response = await fetch(ecPulseBaseUrl() + path, {
    ...rest,
    headers: { "Content-Type": "application/json", "X-API-Key": apiKey, ...(headers || {}) },
    cache: "no-store",
    redirect: "manual",
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (response.status >= 300 && response.status < 400) {
    throw new Error(`EC-Pulse redirected (HTTP ${response.status}); check EC_PULSE_API_URL / deployment protection.`);
  }
  return response;
}

export class EcPulseNotConfigured extends Error {
  constructor() {
    super("EC_PULSE_API_KEY が未設定です。");
  }
}

type ResearchRun = {
  run_id?: string;
  captured_at?: string;
  comments_count?: number;
  top_pain?: { pain?: string; count?: number; share_percent?: number } | null;
  trend?: {
    signal?: string;
    emerging_pains?: Array<{ pain?: string; status?: string; share_delta_percent?: number; current_count?: number; current_share_percent?: number }>;
  };
};

/**
 * Market evidence for a product URL from EC-Pulse research history.
 * Only runs captured at or before asOf are used (no future data leakage).
 * Never throws: EC-Pulse outages degrade to status "unavailable".
 */
export async function loadMarketEvidence(productUrl: string | null, asOf: string): Promise<MarketEvidence> {
  const empty = { topPains: [], emergingPains: [] };
  if (!productUrl) return { status: "no_data", ...empty };
  try {
    const params = new URLSearchParams({ url: productUrl, limit: "20" });
    const response = await ecPulseFetch(`/v1/research/runs?${params}`, { method: "GET" });
    if (!response.ok) {
      return { status: "unavailable", error: `HTTP ${response.status}`, ...empty };
    }
    const payload = await response.json().catch(() => ({})) as { runs?: ResearchRun[] };
    const cutoff = Date.parse(asOf);
    const run = (payload.runs || [])
      .filter((r) => r.captured_at && Date.parse(r.captured_at) <= cutoff)
      .sort((a, b) => Date.parse(b.captured_at as string) - Date.parse(a.captured_at as string))[0];
    if (!run) return { status: "no_data", ...empty };

    const emerging = (run.trend?.emerging_pains || [])
      .filter((p) => p.pain)
      .map((p) => ({ pain: String(p.pain), status: String(p.status || "new"), shareDeltaPercent: Number(p.share_delta_percent || 0) }));
    const topPains = [
      ...(run.top_pain?.pain ? [{ pain: String(run.top_pain.pain), count: Number(run.top_pain.count || 0), sharePercent: Number(run.top_pain.share_percent || 0) }] : []),
      ...(run.trend?.emerging_pains || [])
        .filter((p) => p.pain && p.pain !== run.top_pain?.pain)
        .map((p) => ({ pain: String(p.pain), count: Number(p.current_count || 0), sharePercent: Number(p.current_share_percent || 0) })),
    ];
    return {
      status: "ok",
      runId: run.run_id ?? null,
      capturedAt: run.captured_at ?? null,
      commentsCount: run.comments_count ?? null,
      topPains,
      emergingPains: emerging,
      trendSignal: run.trend?.signal ?? null,
    };
  } catch (error) {
    if (error instanceof EcPulseNotConfigured) return { status: "not_configured", ...empty };
    return { status: "unavailable", error: error instanceof Error ? error.name : "unknown", ...empty };
  }
}
