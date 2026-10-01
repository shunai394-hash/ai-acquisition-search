import { createClient } from "@supabase/supabase-js";
import { secretMatches } from "@/lib/security/cron-auth";

function requireEnv(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not configured`);
  return value;
}

function requireSupabasePublicKey() {
  return process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
    ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
    ?? (() => { throw new Error("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY is not configured"); })();
}

export function getAdminSupabase() {
  return createClient(
    requireEnv("NEXT_PUBLIC_SUPABASE_URL"),
    requireEnv("SUPABASE_SERVICE_ROLE_KEY"),
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
}

export async function getUserFromBearer(request: Request) {
  const internalSecret = request.headers.get("x-internal-secret");
  const internalUserId = request.headers.get("x-internal-user-id");

  if (internalSecret && internalUserId && secretMatches(internalSecret)) {
    const admin = getAdminSupabase();
    const { data, error } = await admin.auth.admin.getUserById(internalUserId);
    if (!error && data.user) return data.user;
    return null;
  }

  const token = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!token) return null;

  const supabase = createClient(
    requireEnv("NEXT_PUBLIC_SUPABASE_URL"),
    requireSupabasePublicKey(),
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data.user) return null;
  return data.user;
}
export async function consumeMonthlyUsage(userId: string, eventType: string, freeLimit: number) {
  const db = getAdminSupabase();
  const { data, error } = await db.rpc("consume_monthly_usage", {
    p_user_id: userId,
    p_event_type: eventType,
    p_free_limit: freeLimit,
  });
  if (error) throw error;
  return data as {
    allowed: boolean;
    plan: string;
    used: number | null;
    limit: number | null;
    usage_event_id?: string;
  };
}

export async function refundMonthlyUsage(userId: string, eventType: string, usageEventId: string) {
  const db = getAdminSupabase();
  const { data, error } = await db.rpc("refund_monthly_usage", {
    p_user_id: userId,
    p_event_type: eventType,
    p_usage_event_id: usageEventId,
  });
  if (error) throw error;
  return data as { refunded: boolean; usage_event_id?: string; reason?: string };
}
