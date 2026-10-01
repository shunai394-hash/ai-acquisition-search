import type { SupabaseClient } from "@supabase/supabase-js";

// Cron / 巡回の同時実行を防ぐ DB リース。
// 期限付きなので、実行中に Function が落ちても期限後に次の実行が取得できる。
// operator_leases テーブル未作成（マイグレーション未適用）の環境では
// 投稿単位の claim / 一意制約だけで重複を防ぎ、処理自体は止めない。

export type LeaseResult =
  | { acquired: true; holder: string; enforced: boolean; release: () => Promise<void> }
  | { acquired: false; holder: null; enforced: true; heldBy: string | null; expiresAt: string | null };

function missingTable(error: { code?: string; message?: string } | null) {
  return !!error && (error.code === "42P01" || error.code === "PGRST205" || /operator_leases/.test(error.message || "") && /does not exist|not find/i.test(error.message || ""));
}

export async function acquireLease(db: SupabaseClient, name: string, ttlSeconds: number): Promise<LeaseResult> {
  const holder = crypto.randomUUID();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + ttlSeconds * 1000).toISOString();
  const release = async () => {
    await db.from("operator_leases").delete().eq("name", name).eq("holder", holder);
  };

  const inserted = await db.from("operator_leases")
    .insert({ name, holder, acquired_at: now.toISOString(), expires_at: expiresAt })
    .select("name").maybeSingle();
  if (!inserted.error) return { acquired: true, holder, enforced: true, release };
  if (missingTable(inserted.error)) {
    console.warn("operator_leases table is missing; running without run-level lease");
    return { acquired: true, holder, enforced: false, release: async () => {} };
  }
  if (inserted.error.code !== "23505") throw inserted.error;

  // 期限切れのリースだけを奪取する（条件付き UPDATE なので同時に1つしか成功しない）。
  const taken = await db.from("operator_leases")
    .update({ holder, acquired_at: now.toISOString(), expires_at: expiresAt })
    .eq("name", name).lt("expires_at", now.toISOString())
    .select("name").maybeSingle();
  if (taken.error) throw taken.error;
  if (taken.data) return { acquired: true, holder, enforced: true, release };

  const { data: current } = await db.from("operator_leases").select("holder,expires_at").eq("name", name).maybeSingle();
  return { acquired: false, holder: null, enforced: true, heldBy: current?.holder ?? null, expiresAt: current?.expires_at ?? null };
}
