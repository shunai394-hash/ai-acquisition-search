import type { PageSnapshot } from "./types";
import { fetchPublicUrl } from "@/lib/security/public-url";

const TIMEOUT_MS = 12_000;
const MAX_BYTES = 1_500_000;

function decodeHtml(value: string) {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) =>
      String.fromCodePoint(parseInt(h, 16))
    )
    .replace(/&#([0-9]+);/g, (_, n) =>
      String.fromCodePoint(Number(n))
    );
}

function matches(html: string, pattern: RegExp) {
  const flags = pattern.flags.includes("g") ? pattern.flags : pattern.flags + "g";
  return Array.from(html.matchAll(new RegExp(pattern.source, flags)))
    .map((m) =>
      decodeHtml(m[1] ?? m[2] ?? "")
        .replace(/\s+/g, " ")
        .trim()
    )
    .filter(Boolean);
}

function extractJsonLdProduct(html: string): {
  signals: string[];
  productName?: string;
  brand?: string;
  category?: string;
} {
  const signals: string[] = [];
  let productName: string | undefined;
  let brand: string | undefined;
  let category: string | undefined;

  for (const match of html.matchAll(
    /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi
  )) {
    try {
      const raw = decodeHtml(match[1] ?? "").trim();
      const parsed = JSON.parse(raw);
      const roots = Array.isArray(parsed) ? parsed : [parsed];

      const items = roots.flatMap((root) => [
        root,
        ...(Array.isArray(root?.["@graph"]) ? root["@graph"] : []),
      ]);

      for (const item of items) {
        if (!item || typeof item !== "object") continue;

        const type = Array.isArray(item["@type"])
          ? item["@type"]
          : [item["@type"]];

        if (
          !type.some(
            (x: unknown) =>
              String(x).toLowerCase() === "product"
          )
        ) {
          continue;
        }

        const name =
          typeof item.name === "string"
            ? item.name.trim()
            : "";

        const itemBrand =
          typeof item.brand?.name === "string"
            ? item.brand.name.trim()
            : "";

        const itemCategory =
          typeof item.category === "string"
            ? item.category.trim()
            : "";

        const description =
          typeof item.description === "string"
            ? item.description.trim()
            : "";

        if (!productName && name) productName = name;
        if (!brand && itemBrand) brand = itemBrand;
        if (!category && itemCategory) category = itemCategory;

        for (const value of [
          name,
          itemBrand,
          itemCategory,
          description,
        ]) {
          if (value && value.length <= 500) {
            signals.push(value);
          }
        }
      }
    } catch {
      // Ignore malformed JSON-LD.
    }
  }

  return {
    signals: [...new Set(signals)],
    productName,
    brand,
    category,
  };
}

function cleanText(html: string) {
  return decodeHtml(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
      .replace(/<svg[\s\S]*?<\/svg>/gi, " ")
      .replace(/<[^>]+>/g, " ")
  )
    .replace(/\s+/g, " ")
    .trim();
}

export async function fetchPageSnapshot(
  inputUrl: string
): Promise<PageSnapshot> {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    TIMEOUT_MS
  );

  let response: Response;

  try {
    response = await fetchPublicUrl(inputUrl, {
      signal: controller.signal,
      cache: "no-store",
      headers: {
        "User-Agent": "AI-Acquisition-Search/1.0",
      },
    });
  } catch {
    throw new Error(
      "ページを取得できませんでした。URLと公開状態を確認してください。"
    );
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    throw new Error(
      `ページ取得に失敗しました（HTTP ${response.status}）。`
    );
  }

  const type =
    response.headers.get("content-type") ?? "";

  if (
    !type.includes("text/html") &&
    !type.includes("application/xhtml+xml")
  ) {
    throw new Error(
      "現在はHTMLページのURLに対応しています。"
    );
  }

  const length = Number(
    response.headers.get("content-length") ?? "0"
  );

  if (length > MAX_BYTES) {
    throw new Error(
      "ページサイズが大きすぎます。"
    );
  }

  const html = await response.text();

  if (
    new TextEncoder().encode(html).byteLength >
    MAX_BYTES
  ) {
    throw new Error(
      "ページサイズが大きすぎます。"
    );
  }

  const title =
    matches(
      html,
      /<title[^>]*>([\s\S]*?)<\/title>/i
    )[0] ?? "";

  const description =
    matches(
      html,
      /<meta[^>]+name=["']description["'][^>]+content=["']([\s\S]*?)["'][^>]*>/i
    )[0] ??
    matches(
      html,
      /<meta[^>]+content=["']([\s\S]*?)["'][^>]+name=["']description["'][^>]*>/i
    )[0] ??
    "";

  const headings = [
    ...matches(
      html,
      /<h1[^>]*>([\s\S]*?)<\/h1>/gi
    ),
    ...matches(
      html,
      /<h2[^>]*>([\s\S]*?)<\/h2>/gi
    ),
  ].slice(0, 30);

  const links = Array.from(
    html.matchAll(
      /<a[^>]+href=["']([^"']+)["'][^>]*>/gi
    )
  )
    .map((m) => {
      try {
        return new URL(
          m[1],
          response.url
        ).toString();
      } catch {
        return "";
      }
    })
    .filter((x) => /^https?:/i.test(x))
    .slice(0, 50);

  const text = cleanText(html).slice(0, 20_000);

  const jsonLd = extractJsonLdProduct(html);

  const ogTitle =
    matches(
      html,
      /<meta[^>]+property=["']og:title["'][^>]+content=["']([\s\S]*?)["'][^>]*>/i
    )[0];

  const ogDescription =
    matches(
      html,
      /<meta[^>]+property=["']og:description["'][^>]+content=["']([\s\S]*?)["'][^>]*>/i
    )[0];

  const productSignals = [
    jsonLd.productName,
    jsonLd.brand,
    jsonLd.category,
    ...jsonLd.signals,
    ogTitle,
    ogDescription,
    ...headings.slice(0, 10),
  ]
    .filter(
      (value): value is string =>
        Boolean(value)
    )
    .filter(
      (value, index, all) =>
        all.indexOf(value) === index
    )
    .slice(0, 20);

  return {
    url: response.url,
    title,
    description,
    headings,
    text,
    links,
    productSignals,
    productName:
      jsonLd.productName ||
      ogTitle ||
      headings[0] ||
      title ||
      undefined,
    productBrand: jsonLd.brand,
    productCategory: jsonLd.category,
  };
}

