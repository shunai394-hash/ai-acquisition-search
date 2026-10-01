import { test } from "node:test";
import assert from "node:assert/strict";
import { acquireLease, releaseLease } from "./lease";

type LeaseRow = { name: string; holder: string; acquired_at: string; expires_at: string };

// Minimal in-memory stand-in for the subset of the Supabase query builder used by lease.ts.
function fakeDb(opts: { missingTable?: boolean } = {}) {
  const rows = new Map<string, LeaseRow>();
  const missing = { code: "42P01", message: "relation does not exist" };
  const db = {
    rows,
    from() {
      return {
        delete() {
          const filters: Array<(r: LeaseRow) => boolean> = [];
          const q = {
            eq(col: keyof LeaseRow, v: string) { filters.push((r) => r[col] === v); return q; },
            lt(col: keyof LeaseRow, v: string) { filters.push((r) => r[col] < v); return q; },
            then(resolve: (x: unknown) => void) {
              if (opts.missingTable) return resolve({ error: missing });
              for (const [k, r] of rows) if (filters.every((f) => f(r))) rows.delete(k);
              resolve({ error: null });
            },
          };
          return q;
        },
        async insert(row: LeaseRow) {
          if (opts.missingTable) return { error: missing };
          if (rows.has(row.name)) return { error: { code: "23505", message: "duplicate" } };
          rows.set(row.name, row);
          return { error: null };
        },
        select() {
          let name = "";
          const q = {
            eq(_c: string, v: string) { name = v; return q; },
            async maybeSingle() { return { data: rows.get(name) ?? null, error: null }; },
          };
          return q;
        },
      };
    },
  };
  return db;
}

test("second concurrent run cannot acquire the lease", async () => {
  const db = fakeDb();
  const [a, b] = await Promise.all([acquireLease(db as never, "operator-loop", 60000), acquireLease(db as never, "operator-loop", 60000)]);
  assert.equal([a, b].filter((l) => l.acquired).length, 1);
  const loser = a.acquired ? b : a;
  assert.ok(loser.heldBy);
});

test("released lease can be acquired again", async () => {
  const db = fakeDb();
  const a = await acquireLease(db as never, "operator-loop", 60000);
  await releaseLease(db as never, "operator-loop", a);
  assert.equal((await acquireLease(db as never, "operator-loop", 60000)).acquired, true);
});

test("expired lease from a crashed run is reclaimed", async () => {
  const db = fakeDb();
  db.rows.set("operator-loop", { name: "operator-loop", holder: "dead", acquired_at: "2020-01-01T00:00:00Z", expires_at: "2020-01-01T00:05:00Z" });
  assert.equal((await acquireLease(db as never, "operator-loop", 60000)).acquired, true);
});

test("release by a non-holder does not drop someone else's lease", async () => {
  const db = fakeDb();
  const a = await acquireLease(db as never, "operator-loop", 60000);
  await releaseLease(db as never, "operator-loop", { ...a, holder: "other" });
  assert.equal((await acquireLease(db as never, "operator-loop", 60000)).acquired, false);
});

test("missing lease table degrades to per-item claims instead of failing the cron", async () => {
  const lease = await acquireLease(fakeDb({ missingTable: true }) as never, "operator-loop", 60000);
  assert.equal(lease.acquired, true);
  assert.equal(lease.mode, "unavailable");
});
