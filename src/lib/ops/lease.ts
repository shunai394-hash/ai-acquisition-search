import type { getAdminSupabase } from "@/lib/billing";

type Db = ReturnType<typeof getAdminSupabase>;

export type Lease = {
  acquired: boolean;
  holder: string;
  /** "db": enforced by operator_leases. "unavailable": table missing, per-item claims still apply. */
  mode: "db" | "unavailable";
  heldBy?: string | null;
  expiresAt?: string | null;
};

const MISSING_TABLE = new Set(["42P01", "PGRST205", "PGRST202"]);

/**
 * Global lease so two Cron/patrol invocations never run the same loop body
 * concurrently. Expired leases are reclaimed, so a crashed run cannot block
 * the loop for longer than ttlMs.
 */
export async function acquireLease(db: Db, name: string, ttlMs: number): Promise<Lease> {
  const holder = crypto.randomUUID();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + ttlMs).toISOString();

  const { error: reclaimError } = await db.from("operator_leases").delete().eq("name", name).lt("expires_at", now.toISOString());
  if (reclaimError && MISSING_TABLE.has(String(reclaimError.code))) {
    return { acquired: true, holder, mode: "unavailable" };
  }

  const { error } = await db.from("operator_leases").insert({ name, holder, acquired_at: now.toISOString(), expires_at: expiresAt });
  if (!error) return { acquired: true, holder, mode: "db", expiresAt };
  if (MISSING_TABLE.has(String(error.code))) return { acquired: true, holder, mode: "unavailable" };
  if (error.code === "23505") {
    const { data } = await db.from("operator_leases").select("holder,expires_at").eq("name", name).maybeSingle();
    return { acquired: false, holder, mode: "db", heldBy: data?.holder ?? null, expiresAt: data?.expires_at ?? null };
  }
  throw error;
}

export async function releaseLease(db: Db, name: string, lease: Lease) {
  if (lease.mode !== "db" || !lease.acquired) return;
  await db.from("operator_leases").delete().eq("name", name).eq("holder", lease.holder);
}
