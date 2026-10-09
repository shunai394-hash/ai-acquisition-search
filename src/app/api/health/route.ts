import { NextResponse } from "next/server";
import { getAdminSupabase } from "@/lib/billing";
import { ecPulseConfig, ecPulseFetch } from "@/lib/ec-pulse/client";
import { DECISION_LOGIC_VERSION } from "@/lib/decision/engine";
import { cronSecret, verifyCronRequest } from "@/lib/security/cron-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function check<T>(fn: () => Promise<T>) {
  const started = Date.now();
  try {
    const result = await fn();
    return { ...result, ok: true, ms: Date.now() - started };
  } catch (error) {
    return { ok: false, ms: Date.now() - started, error: error instanceof Error ? `${error.name}: ${error.message}`.slice(0, 200) : "unknown" };
  }
}

// Public: status + deployed commit (no secrets). With `Authorization: Bearer
// CRON_SECRET`: configuration and dependency details for production smoke tests.
export async function GET(request: Request) {
  const commit = process.env.VERCEL_GIT_COMMIT_SHA || null;
  const authorized = verifyCronRequest(request).ok;

  // Keep the public probe cheap: dependency checks are intentionally reserved
  // for authenticated smoke tests so arbitrary traffic cannot fan out to DB/API calls.
  if (!authorized) {
    return NextResponse.json({ ok: true, status: "alive", commit, logicVersion: DECISION_LOGIC_VERSION, checkedAt: new Date().toISOString() });
  }

  const database = await check(async () => {
    const { error } = await getAdminSupabase().from("operator_runs").select("id", { head: true, count: "exact" }).limit(1);
    if (error) throw new Error(`${error.code}: ${error.message}`);
    return {};
  });
  const leaseTable = await check(async () => {
    const { error } = await getAdminSupabase().from("operator_leases").select("name", { head: true, count: "exact" }).limit(1);
    if (error) throw new Error(`${error.code}: ${error.message}`);
    return {};
  });
  // Generated videos must not be readable by anyone holding a URL; the app
  // only hands out signed links, so this bucket should report public=false.
  const videoAssetsBucket = await check(async () => {
    const { data, error } = await getAdminSupabase().storage.getBucket("video-assets");
    if (error) throw new Error(error.message);
    return { public: Boolean(data?.public) };
  });
  const ecPulse = await check(async () => {
    const response = await ecPulseFetch("/health", { method: "GET", timeoutMs: 6000 });
    const body = await response.json().catch(() => null) as Record<string, unknown> | null;
    if (!response.ok) throw new Error(`HTTP ${response.status} ${JSON.stringify(body?.detail ?? body ?? {}).slice(0, 120)}`);
    return { database: body?.database ?? null };
  });

  // The lease table is required for safe cron/operator execution, so its
  // availability is part of overall health rather than a diagnostic-only check.
  const ok = database.ok && leaseTable.ok && ecPulse.ok;
  const summary = { ok, commit, logicVersion: DECISION_LOGIC_VERSION, database: database.ok, operatorLeases: leaseTable.ok, ecPulse: ecPulse.ok, checkedAt: new Date().toISOString() };
  const ec = ecPulseConfig();
  return NextResponse.json({
    ...summary,
    environment: process.env.VERCEL_ENV || process.env.NODE_ENV,
    branch: process.env.VERCEL_GIT_COMMIT_REF || null,
    checks: { database, operatorLeases: leaseTable, ecPulse, videoAssetsBucket },
    config: {
      cronSecret: Boolean(cronSecret()),
      cronSecretHasWhitespace: Boolean(process.env.CRON_SECRET) && process.env.CRON_SECRET !== process.env.CRON_SECRET?.trim(),
      productionUrl: process.env.VERCEL_PROJECT_PRODUCTION_URL || null,
      automationBypass: Boolean(process.env.VERCEL_AUTOMATION_BYPASS_SECRET),
      openai: Boolean(process.env.OPENAI_API_KEY),
      ecPulseUrl: ec.url,
      ecPulseUrlExplicit: ec.explicitUrl,
      ecPulseUrlPinnedDeployment: ec.pinnedDeployment,
      ecPulseKey: ec.configured,
      // Presence only (never values) so a deploy can be checked against the
      // variable names the video/audio/billing/SNS code actually reads.
      supabaseServiceRole: Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY),
      supabasePublicKey: Boolean(process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY),
      higgsfield: Boolean(process.env.HIGGSFIELD_API_KEY || process.env.HF_API_KEY || (process.env.HF_API_KEY_ID && process.env.HF_API_KEY_SECRET)),
      videoEngine: process.env.VIDEO_ENGINE || "higgsfield",
      geminiTts: Boolean(process.env.GEMINI_API_KEY),
      stripe: Boolean(process.env.STRIPE_SECRET_KEY),
      stripeWebhook: Boolean(process.env.STRIPE_WEBHOOK_SECRET),
      stripeProPrice: Boolean(process.env.STRIPE_PRO_PRICE_ID),
      tiktokOAuth: Boolean(process.env.TIKTOK_CLIENT_KEY && process.env.TIKTOK_CLIENT_SECRET && process.env.TIKTOK_REDIRECT_URI && process.env.TIKTOK_TOKEN_ENCRYPTION_KEY),
      tiktokPrivacyLevel: process.env.TIKTOK_PRIVACY_LEVEL || "SELF_ONLY",
    },
  }, { status: ok ? 200 : 503 });
}
