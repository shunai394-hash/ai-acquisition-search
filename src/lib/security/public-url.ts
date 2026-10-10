import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

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

export async function assertPublicUrl(input: string, allowedProtocols: readonly string[] = ["http:", "https:"]) {
  let url: URL;
  try { url = new URL(input); } catch { throw new Error("URLの形式が正しくありません。"); }
  if (!allowedProtocols.includes(url.protocol)) throw new Error("許可されていないURLスキームです。");
  if (url.username || url.password) throw new Error("認証情報を含むURLには対応していません。");
  const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (hostname === "localhost" || hostname.endsWith(".localhost") || hostname === "local" || hostname.endsWith(".local")) {
    throw new Error("ローカルネットワークのURLにはアクセスできません。");
  }
  const addresses = isIP(hostname) ? [hostname] : (await lookup(hostname, { all: true })).map((entry) => entry.address);
  if (!addresses.length || addresses.some(blockedIp)) throw new Error("内部・プライベートネットワークのURLにはアクセスできません。");
  return url;
}

export async function fetchPublicUrl(input: string, init: RequestInit = {}) {
  let url = await assertPublicUrl(input);
  for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect++) {
    // SNS media downloads can otherwise occupy a serverless function indefinitely.
    // Callers may provide a tighter signal for operations with known limits.
    const signal = init.signal ?? AbortSignal.timeout(120_000);
    const response = await fetch(url.toString(), { ...init, signal, redirect: "manual" });
    if (response.status < 300 || response.status >= 400) return response;
    const location = response.headers.get("location");
    if (!location || redirect === MAX_REDIRECTS) throw new Error("動画URLのリダイレクト回数が上限を超えました。");
    url = await assertPublicUrl(new URL(location, url).toString());
  }
  throw new Error("動画URLを取得できませんでした。");
}
