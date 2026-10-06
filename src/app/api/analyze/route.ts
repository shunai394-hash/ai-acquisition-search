import { NextRequest, NextResponse } from "next/server";
import { consumeMonthlyUsage, getUserFromBearer } from "@/lib/billing";
import { analyzePage } from "@/lib/acquisition/analyze";
import { fetchPageSnapshot } from "@/lib/acquisition/fetch-url";
import { discoverAcquisitionSignals, searchWeb } from "@/lib/acquisition/search-web";
import { discoverSocialSignals } from "@/lib/acquisition/social-search";
import { discoverShopSignals } from "@/lib/acquisition/shop-search";
import type { PageSnapshot } from "@/lib/acquisition/types";

export const runtime = "nodejs";

function amazonSnapshot(inputUrl: string): PageSnapshot | null {
  let url: URL;
  try {
    url = new URL(inputUrl);
  } catch {
    return null;
  }

  if (!/(^|\.)amazon\.(co\.jp|com|co\.uk|de|fr|it|es)$/i.test(url.hostname)) {
    return null;
  }

  const asin = url.pathname.match(/\/dp\/([A-Z0-9]{10})/i)?.[1]?.toUpperCase() ?? "";
  if (!asin) return null;

  let decodedPath = url.pathname;
  try { decodedPath = decodeURIComponent(url.pathname); } catch { /* malformed %-escape: keep the raw path */ }
  const dpIndex = decodedPath.toLowerCase().indexOf("/dp/");
  const rawTitle = dpIndex > 0
    ? decodedPath.slice(1, dpIndex).replace(/[-_]+/g, " ").trim()
    : "";

  const title = rawTitle || "Amazon商品 " + asin;
  return {
    url: inputUrl,
    title,
    description: "",
    headings: [title, "ASIN: " + asin],
    text: title + " ASIN: " + asin,
    links: [inputUrl],
    productSignals: [title, asin],
    productName: title,
  };
}

async function buildSource(inputUrl: string): Promise<PageSnapshot> {
  try {
    return await fetchPageSnapshot(inputUrl);
  } catch (error) {
    const fallback = amazonSnapshot(inputUrl);
    if (!fallback) throw error;

    const asin = fallback.productSignals[1];
    const query = asin + " " + fallback.productName + " 商品";
    const evidence = await searchWeb(query, 8, "market");

    if (!evidence.length) {
      return {
        ...fallback,
        description: "Amazonの商品ページを直接取得できなかったため、ASINと公開検索情報を使って分析します。",
      };
    }

    const snippets = evidence.map((item) => item.title + " " + item.snippet).join("\n");
    const first = evidence[0];
    return {
      ...fallback,
      title: first.title || fallback.title,
      description: "Amazonの商品ページを直接取得できなかったため、ASINと公開検索情報を使って分析します。",
      headings: [fallback.productName ?? fallback.title, ...evidence.slice(0, 5).map((item) => item.title)],
      text: [fallback.text, snippets].join("\n"),
      links: [inputUrl, ...evidence.map((item) => item.url)],
      productSignals: [...new Set([...(fallback.productSignals ?? []), ...evidence.flatMap((item) => [item.title, item.snippet])])].slice(0, 20),
    };
  }
}

export async function POST(request: NextRequest) {
  try {
    const user = await getUserFromBearer(request);
    if (!user) return NextResponse.json({ error: "ログインが必要です。" }, { status: 401 });
    const body = await request.json();
    const url = typeof body?.url === "string" ? body.url.trim() : "";
    if (!url) {
      return NextResponse.json({ error: "商品・サービスURLを入力してください。" }, { status: 400 });
    }
    if (url.length > 2048) return NextResponse.json({ error: "URLが長すぎます。" }, { status: 400 });
    const usage = await consumeMonthlyUsage(user.id, "acquisition_analysis", 5);
    if (!usage.allowed) return NextResponse.json({ error: `今月の無料分析回数（${usage.limit}回）を使い切りました。Proへアップグレードしてください。`, usage }, { status: 429 });

    const source = await buildSource(url);
    const search = await discoverAcquisitionSignals({
      productName: source.productName || source.title,
      description: source.description,
      productSignals: source.productSignals,
      productCategory: source.productCategory,
      productBrand: source.productBrand,
      sourceDomain: (() => { try { return new URL(source.url).hostname.replace(/^www\./i, ""); } catch { return ""; } })(),
    });
    const productName = source.productName || source.title;
    const socialSignals = await discoverSocialSignals(productName);
    const shopSignals = await discoverShopSignals(productName);
    const analysis = await analyzePage(
      source,
      { query: search.queries.join(" / "), results: search.results },
      socialSignals,
      shopSignals,
    );

    return NextResponse.json({ data: { source, analysis } });
  } catch (error) {
    // Keep provider/database details out of the browser response; they belong in
    // server logs, not in a public error payload.
    console.error("acquisition analysis error", error);
    return NextResponse.json({ error: "分析中に外部情報の取得または解析に失敗しました。時間を置いてもう一度お試しください。" }, { status: 502 });
  }
}
