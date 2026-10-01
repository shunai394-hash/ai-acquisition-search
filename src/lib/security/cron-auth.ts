import { timingSafeEqual } from "node:crypto";

// Vercel Cron は `Authorization: Bearer <CRON_SECRET>` を付けて呼び出す。
// 環境変数を貼り付けた際の末尾改行・空白で一致しなくなり 401 になる事故を防ぐため、
// 両側を trim してから定数時間で比較する。認証自体は必ず行う（未設定なら拒否）。
export function cronSecret() {
  const secret = process.env.CRON_SECRET?.trim();
  return secret ? secret : null;
}

export function isAuthorizedCron(request: Request) {
  const secret = cronSecret();
  if (!secret) return false;
  const header = request.headers.get("authorization")?.trim() ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (!match) return false;
  const given = Buffer.from(match[1].trim());
  const expected = Buffer.from(secret);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

// 401 の原因を秘密値を出さずに切り分けるための情報。
export function cronAuthDiagnostics(request: Request) {
  const raw = process.env.CRON_SECRET;
  const header = request.headers.get("authorization");
  return {
    cronSecretConfigured: !!raw?.trim(),
    cronSecretHasSurroundingWhitespace: !!raw && raw !== raw.trim(),
    authorizationHeaderPresent: !!header,
    authorizationScheme: header ? header.trim().split(/\s+/)[0] : null,
    invokedByVercelCron: (request.headers.get("user-agent") || "").includes("vercel-cron"),
  };
}
