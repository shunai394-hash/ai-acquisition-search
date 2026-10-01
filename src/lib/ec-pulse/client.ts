// EC-Pulse（中心サブ/API基盤）へのクライアント。
// EC-Pulse が停止していてもメインサイトの判定全体が壊れないよう、
// 失敗は例外ではなく { ok: false } として返す。

// 既存の接続先（特定デプロイのURL）。固定URLのままだと EC-Pulse を再デプロイしても
// 古いビルドを呼び続けるため、Production では EC_PULSE_API_URL に
// shunai394-hash/ec-pulse の Production ドメインを設定すること。
export const EC_PULSE_LEGACY_URL = "https://ec-pulse-rk8mola3m-naitoshyuichirou-6935.vercel.app";

let warnedLegacyUrl = false;

export function ecPulseBaseUrl() {
  const configured = process.env.EC_PULSE_API_URL?.trim();
  if (!configured && !warnedLegacyUrl) {
    warnedLegacyUrl = true;
    console.warn("EC_PULSE_API_URL is not set; falling back to a pinned EC-Pulse deployment URL");
  }
  return (configured || EC_PULSE_LEGACY_URL).replace(/\/$/, "");
}

export type EcPulseResult<T> =
  | { ok: true; status: number; data: T }
  | { ok: false; status: number | null; error: string; configured: boolean };

export type EcPulseResearchRun = {
  run_id: string;
  url: string;
  title?: string | null;
  market?: string | null;
  locale?: string | null;
  comments_count?: number;
  captured_at: string;
  top_pain?: { pain: string; count: number; share_percent: number } | null;
  trend?: {
    previous_run_id?: string | null;
    previous_captured_at?: string | null;
    emerging_pains?: Array<{ pain: string; status: string; count_delta: number; share_delta_percent: number; current_share_percent?: number }>;
    signal?: string;
  };
};

export type EcPulseMonitor = {
  id: string;
  url: string;
  last_price: number | null;
  last_checked_at: string | null;
  created_at: string;
};

export async function ecPulseRequest<T>(
  path: string,
  init: { method?: "GET" | "POST"; body?: unknown; timeoutMs?: number } = {},
  fetchImpl: typeof fetch = fetch,
): Promise<EcPulseResult<T>> {
  const apiKey = process.env.EC_PULSE_API_KEY?.trim();
  if (!apiKey) return { ok: false, status: null, error: "EC_PULSE_API_KEY が未設定です。", configured: false };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), init.timeoutMs ?? 8000);
  try {
    const response = await fetchImpl(ecPulseBaseUrl() + path, {
      method: init.method || "GET",
      headers: { "Content-Type": "application/json", "X-API-Key": apiKey },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
      cache: "no-store",
      signal: controller.signal,
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      const detail = payload && typeof payload === "object" ? (payload as Record<string, unknown>).detail : null;
      return {
        ok: false,
        status: response.status,
        error: typeof detail === "string" ? detail : `EC-Pulse HTTP ${response.status}`,
        configured: true,
      };
    }
    return { ok: true, status: response.status, data: payload as T };
  } catch (error) {
    const aborted = error instanceof Error && error.name === "AbortError";
    return {
      ok: false,
      status: null,
      error: aborted ? "EC-Pulse がタイムアウトしました。" : (error instanceof Error ? error.message : String(error)),
      configured: true,
    };
  } finally {
    clearTimeout(timer);
  }
}

// 課金されない参照系APIだけで、Decision 用の市場シグナルを集める。
export async function fetchMarketSignals(productUrl: string | null, fetchImpl: typeof fetch = fetch) {
  const [runs, monitors] = await Promise.all([
    productUrl
      ? ecPulseRequest<{ runs: EcPulseResearchRun[] }>(`/v1/research/runs?${new URLSearchParams({ url: productUrl, limit: "5" })}`, {}, fetchImpl)
      : Promise.resolve(null),
    ecPulseRequest<{ monitors: EcPulseMonitor[] }>("/v1/monitors", {}, fetchImpl),
  ]);
  return { runs, monitors };
}
