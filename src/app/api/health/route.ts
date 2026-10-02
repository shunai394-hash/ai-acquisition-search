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
    return { ok: true, ms: Date.now() - started, ...(await fn()) };
  } catch (error) {
    return { ok: false, ms: Date.now() - started, error: error instanceof Error ? `${error.name}: ${error.message}`.slice(0, 200) : "unknown" };
  }
}

// Public: status + deployed commit (no secrets). With `Authorization: Bearer
// CRON_SECRET`: configuration and dependency details for production smoke tests.
export async function GET(request: Request) {
  const commit = process.env.VERCEL_GIT_COMMIT_SHA || null;

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
  if (!verifyCronRequest(request).ok) return NextResponse.json(summary, { status: ok ? 200 : 503 });

  const ec = ecPulseConfig();
  return NextResponse.json({
    ...summary,
    environment: process.env.VERCEL_ENV || process.env.NODE_ENV,
    branch: process.env.VERCEL_GIT_COMMIT_REF || null,
    checks: { database, operatorLeases: leaseTable, ecPulse },
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
    },
  }, { status: ok ? 200 : 503 });
}
