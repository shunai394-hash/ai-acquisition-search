import { createHash, timingSafeEqual } from "node:crypto";

// Secrets pasted into the Vercel dashboard or piped through `vercel env add`
// often carry a trailing newline. Vercel Cron sends `Bearer <secret>` without
// it (header values cannot contain newlines), so an exact comparison returns
// 401 forever. Compare trimmed values instead. Authentication is never skipped.
export function cronSecret() {
  return process.env.CRON_SECRET?.trim() || "";
}

function safeEqual(a: string, b: string) {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

export function secretMatches(candidate: string | null | undefined) {
  const secret = cronSecret();
  if (!secret || !candidate) return false;
  return safeEqual(candidate.trim(), secret);
}

export type CronAuthResult =
  | { ok: true }
  | { ok: false; reason: "cron_secret_not_configured" | "authorization_header_missing" | "authorization_mismatch" };

export function verifyCronRequest(request: Request): CronAuthResult {
  if (!cronSecret()) return { ok: false, reason: "cron_secret_not_configured" };
  const header = request.headers.get("authorization");
  if (!header) return { ok: false, reason: "authorization_header_missing" };
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!match || !secretMatches(match[1])) return { ok: false, reason: "authorization_mismatch" };
  return { ok: true };
}

/** 401 with a non-secret reason code so production logs show why auth failed. */
export function unauthorizedCron(result: Extract<CronAuthResult, { ok: false }>) {
  console.warn("cron unauthorized", result.reason);
  return Response.json({ ok: false, error: "Unauthorized", reason: result.reason }, { status: 401 });
}
