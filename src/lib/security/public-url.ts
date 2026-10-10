import { lookup } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import { isIP } from "node:net";
import { Readable } from "node:stream";

const MAX_REDIRECTS = 4;

function blockedIp(address: string) {
  const normalized = address.toLowerCase().split("%")[0];
  if (normalized === "::1" || normalized === "0:0:0:0:0:0:0:1") return true;
  if (isIP(normalized) === 4) {
    const [a, b, c, d] = normalized.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 0 || b === 168)) ||
      (a === 198 && b >= 18 && b <= 19) ||
      (a >= 224) ||
      [a, b, c, d].some((part) => !Number.isInteger(part) || part < 0 || part > 255);
  }
  if (isIP(normalized) === 6) {
    if (normalized === "::" || normalized.startsWith("::ffff:")) {
      const mapped = normalized.slice("::ffff:".length);
      if (isIP(mapped) === 4) return blockedIp(mapped);
      const parts = mapped.split(":");
      if (parts.length === 2) {
        const hi = Number.parseInt(parts[0], 16);
        const lo = Number.parseInt(parts[1], 16);
        if (Number.isInteger(hi) && Number.isInteger(lo) && hi >= 0 && hi <= 0xffff && lo >= 0 && lo <= 0xffff) {
          return blockedIp([hi >> 8, hi & 0xff, lo >> 8, lo & 0xff].join("."));
        }
      }
    }
    return normalized.startsWith("fc") || normalized.startsWith("fd") ||
      normalized.startsWith("fe8") || normalized.startsWith("fe9") ||
      normalized.startsWith("fea") || normalized.startsWith("feb") ||
      normalized.startsWith("ff");
  }
  return true;
}

async function resolvePublicUrl(input: string, allowedProtocols: readonly string[] = ["http:", "https:"]) {
  let url: URL;
  try { url = new URL(input); } catch { throw new Error("URLの形式が正しくありません。"); }
  if (!allowedProtocols.includes(url.protocol)) throw new Error("許可されていないURLスキームです。");
  if (url.username || url.password) throw new Error("認証情報を含むURLには対応していません。");
  const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (
    hostname === "localhost" || hostname.endsWith(".localhost") || hostname === "local" || hostname.endsWith(".local") ||
    hostname.endsWith(".internal") || hostname === "metadata" || hostname === "metadata.google.internal" || hostname === "metadata.google.com"
  ) {
    throw new Error("ローカルネットワークのURLにはアクセスできません。");
  }
  const addresses = isIP(hostname) ? [hostname] : (await lookup(hostname, { all: true })).map((entry) => entry.address);
  if (!addresses.length || addresses.some(blockedIp)) throw new Error("内部・プライベートネットワークのURLにはアクセスできません。");
  return { url, addresses };
}

export async function assertPublicUrl(input: string, allowedProtocols: readonly string[] = ["http:", "https:"]) {
  return (await resolvePublicUrl(input, allowedProtocols)).url;
}

/**
 * DNS lookup that always returns the addresses already checked by assertPublicUrl.
 * A later resolver change (DNS rebinding) cannot redirect the connection at a private IP.
 */
export function pinnedDnsLookup(addresses: readonly string[]) {
  if (!addresses.length || addresses.some((address) => blockedIp(address))) {
    throw new Error("内部・プライベートネットワークのURLにはアクセスできません。");
  }
  const address = addresses[0];
  const family = address.includes(":") ? 6 : 4;
  return (_hostname: string, options: unknown, callback?: (err: NodeJS.ErrnoException | null, address: string, family: number) => void) => {
    const report = typeof options === "function" ? options as typeof callback : callback;
    report?.(null, address, family);
  };
}

function outgoingHeaders(headers: HeadersInit | undefined): http.OutgoingHttpHeaders {
  if (!headers) return {};
  if (headers instanceof Headers) {
    const record: http.OutgoingHttpHeaders = {};
    headers.forEach((value, key) => { record[key] = value; });
    return record;
  }
  if (Array.isArray(headers)) return Object.fromEntries(headers);
  return { ...headers };
}

export const publicFetchTransport = {
  request(protocol: string, url: URL, options: https.RequestOptions, callback: (incoming: http.IncomingMessage) => void) {
    const transport = protocol === "https:" ? https : http;
    return transport.request(url, options, callback);
  },
};

function requestPinned(url: URL, init: RequestInit, addresses: readonly string[], signal: AbortSignal) {
  return new Promise<Response>((resolve, reject) => {
    const req = publicFetchTransport.request(url.protocol, url, {
      method: init.method || "GET",
      headers: outgoingHeaders(init.headers),
      lookup: pinnedDnsLookup(addresses) as NonNullable<http.RequestOptions["lookup"]>,
      signal,
    }, (incoming) => {
      const headers = new Headers();
      for (const [key, value] of Object.entries(incoming.headers)) {
        if (typeof value === "string") headers.set(key, value);
        else if (Array.isArray(value)) for (const item of value) headers.append(key, item);
      }
      resolve(new Response(Readable.toWeb(incoming) as ReadableStream<Uint8Array>, {
        status: incoming.statusCode ?? 0,
        headers,
      }));
    });
    req.on("error", reject);
    req.end();
  });
}

export async function fetchPublicUrl(input: string, init: RequestInit = {}) {
  let current = input;
  for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect++) {
    const { url, addresses } = await resolvePublicUrl(current);
    // SNS media downloads can otherwise occupy a serverless function indefinitely.
    // Callers may provide a tighter signal for operations with known limits.
    const signal = init.signal ?? AbortSignal.timeout(120_000);
    const response = await requestPinned(url, init, addresses, signal);
    if (response.status < 300 || response.status >= 400) return response;
    const location = response.headers.get("location");
    if (!location || redirect === MAX_REDIRECTS) throw new Error("動画URLのリダイレクト回数が上限を超えました。");
    await response.body?.cancel().catch(() => {});
    current = new URL(location, url).toString();
  }
  throw new Error("動画URLを取得できませんでした。");
}
