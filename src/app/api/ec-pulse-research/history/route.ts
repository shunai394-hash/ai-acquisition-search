import { NextRequest, NextResponse } from "next/server";
import { getUserFromBearer } from "@/lib/billing";
import { ecPulseBaseUrl } from "@/lib/ec-pulse/client";

export const runtime = "nodejs";

const EC_PULSE_API_URL = ecPulseBaseUrl();

export async function GET(request: NextRequest) {
  const user = await getUserFromBearer(request);
  if (!user) return NextResponse.json({ error: "ログインが必要です。" }, { status: 401 });

  const apiKey = process.env.EC_PULSE_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ connected: false, runs: [], error: "EC_PULSE_API_KEY が未設定です。" });
  }

  const url = request.nextUrl.searchParams.get("url");
  const limit = Math.min(Math.max(Number(request.nextUrl.searchParams.get("limit") || 12), 1), 100);
  const params = new URLSearchParams({ limit: String(limit) });
  if (url) params.set("url", url);

  try {
    const response = await fetch(
      EC_PULSE_API_URL + "/v1/research/runs?" + params.toString(),
      { headers: { "X-API-Key": apiKey }, cache: "no-store" }
    );
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      return NextResponse.json(
        { connected: true, runs: [], error: data?.detail || "研究履歴を取得できませんでした。" },
        { status: response.status }
      );
    }
    return NextResponse.json({ connected: true, runs: data.runs || [] });
  } catch (error) {
    return NextResponse.json({
      connected: false,
      runs: [],
      error: error instanceof Error ? error.message : "研究履歴の取得に失敗しました。"
    }, { status: 502 });
  }
}
