import { NextRequest, NextResponse } from "next/server";
import { getUserFromBearer } from "@/lib/billing";
import { ecPulseFetch } from "@/lib/ec-pulse/client";

export const runtime = "nodejs";
export const maxDuration = 120;

type PainPoint = {
  pain: string;
  count: number;
  share_percent: number;
  examples: string[];
};

function cleanQuery(value: string) {
  return value.replace(/[\r\n]/g, " ").trim().slice(0, 180);
}

export async function POST(request: NextRequest) {
  try {
    const user = await getUserFromBearer(request);
    if (!user) return NextResponse.json({ error: "ログインが必要です。" }, { status: 401 });
    const body = await request.json();
    const url = typeof body?.url === "string" ? body.url.trim() : "";
    if (!url) {
      return NextResponse.json({ error: "リサーチ対象URLを入力してください。" }, { status: 400 });
    }

    const apiKey = process.env.EC_PULSE_API_KEY;
    if (!apiKey) {
      return NextResponse.json({
        connected: false,
        research: null,
        products: [],
        error: "EC_PULSE_API_KEY が未設定です。"
      });
    }

    const ingestResponse = await ecPulseFetch("/v1/research/ingest", {
      method: "POST",
      body: JSON.stringify({ urls: [url], max_comments_per_url: 500 }),
      timeoutMs: 60000
    });

    const ingest = await ingestResponse.json().catch(() => ({}));
    if (!ingestResponse.ok) {
      return NextResponse.json({
        connected: true,
        research: null,
        products: [],
        error: ingest?.detail || ingest?.error || "EC Pulseリサーチに失敗しました。"
      }, { status: ingestResponse.status });
    }

    const research = ingest.results?.[0] ?? null;
    const runId = research?.trend?.run_id ?? null;
    const painPoints: PainPoint[] = research?.analysis?.pain_points ?? [];
    const queries = [
      ...painPoints.slice(0, 3).map((item) => item.pain),
      research?.analysis?.recommended_angle,
      research?.analysis?.top_terms?.[0]
    ].filter(Boolean).map((item) => cleanQuery(String(item)));

    const uniqueQueries = [...new Set(queries)].slice(0, 3);
    const products: Array<Record<string, unknown>> = [];

    for (const query of uniqueQueries) {
      const response = await ecPulseFetch("/v1/products/search", {
        method: "POST",
        body: JSON.stringify({
          query,
          marketplaces: ["amazon", "rakuten", "yahoo"],
          limit: 5
        }),
        timeoutMs: 20000
      }).catch(() => null);
      if (!response?.ok) continue;
      const data = await response.json().catch(() => null);
      for (const item of data?.results ?? []) {
        products.push({
          title: item.title ?? item.product?.product?.title ?? item.product?.title ?? "",
          url: item.url ?? item.product?.source?.url ?? item.source?.url ?? "",
          price: item.price ?? item.product?.pricing?.price ?? item.pricing?.price ?? null,
          currency: item.currency ?? item.product?.pricing?.currency ?? item.pricing?.currency ?? "",
          marketplace: item.marketplace ?? item.product?.source?.marketplace ?? item.source?.marketplace ?? null,
          product_id: item.product_id ?? item.product?.source?.product_id ?? item.source?.product_id ?? null,
          query
        });
      }
    }

    const seen = new Set<string>();
    const deduped = products.filter((item) => {
      const key = String(item.url || item.title);
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    }).slice(0, 15);

    let opportunity = null;
    if (runId) {
      const opportunityResponse = await ecPulseFetch(
        "/v1/research/runs/" + encodeURIComponent(runId) + "/opportunity",
        { method: "GET", timeoutMs: 30000 }
      ).catch(() => null);
      if (opportunityResponse?.ok) {
        opportunity = await opportunityResponse.json().catch(() => null);
      }
    }

    return NextResponse.json({
      connected: true,
      research,
      products: deduped,
      opportunity
    });
  } catch (error) {
    return NextResponse.json({
      connected: false,
      research: null,
      products: [],
      error: error instanceof Error ? error.message : "EC Pulseリサーチに失敗しました。"
    }, { status: 502 });
  }
}
