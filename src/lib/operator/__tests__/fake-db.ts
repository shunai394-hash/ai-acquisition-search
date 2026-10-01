// テスト用の最小インメモリ Supabase（PostgREST クエリビルダーの一部だけを再現）。
// 一意制約は unique で指定した列の組み合わせで判定し、違反時は code 23505 を返す。
import type { SupabaseClient } from "@supabase/supabase-js";

type Row = Record<string, unknown>;
type Filter = (row: Row) => boolean;

function read(row: Row, column: string): unknown {
  const m = /^(\w+)->>(\w+)$/.exec(column);
  if (m) {
    const obj = row[m[1]];
    const v = obj && typeof obj === "object" ? (obj as Row)[m[2]] : undefined;
    return v === undefined || v === null ? null : String(v);
  }
  return row[column] ?? null;
}

function cmp(a: unknown, b: unknown) {
  const x = typeof a === "string" && !Number.isNaN(Date.parse(a)) && typeof b === "string" ? Date.parse(a) : a;
  const y = typeof b === "string" && !Number.isNaN(Date.parse(b)) && typeof a === "string" ? Date.parse(b) : b;
  return (x as number) < (y as number) ? -1 : (x as number) > (y as number) ? 1 : 0;
}

export class FakeDb {
  tables: Record<string, Row[]> = {};
  unique: Record<string, string[][]> = {};
  missingTables = new Set<string>();
  calls: string[] = [];
  private seq = 0;

  constructor(seed: Record<string, Row[]> = {}, unique: Record<string, string[][]> = {}) {
    for (const [name, rows] of Object.entries(seed)) this.tables[name] = rows.map((r) => ({ ...r }));
    this.unique = unique;
  }

  nextId(prefix: string) {
    this.seq++;
    return `${prefix}-${this.seq}`;
  }

  from(table: string) {
    this.calls.push(table);
    return new Query(this, table);
  }

  asClient() {
    return this as unknown as SupabaseClient;
  }
}

type Result = { data: unknown; error: { code?: string; message: string } | null };

class Query {
  private filters: Filter[] = [];
  private op: "select" | "insert" | "update" | "delete" = "select";
  private payload: Row | Row[] | null = null;
  private orderBy: { column: string; ascending: boolean } | null = null;
  private max: number | null = null;
  private mode: "many" | "single" | "maybe" = "many";

  constructor(private db: FakeDb, private table: string) {}

  select() { return this; }
  insert(values: Row | Row[]) { this.op = "insert"; this.payload = values; return this; }
  update(values: Row) { this.op = "update"; this.payload = values; return this; }
  delete() { this.op = "delete"; return this; }
  eq(c: string, v: unknown) { this.filters.push((r) => { const x = read(r, c); return x === v || (typeof x === "string" && v !== null && x === String(v)); }); return this; }
  neq(c: string, v: unknown) { this.filters.push((r) => read(r, c) !== v); return this; }
  lt(c: string, v: unknown) { this.filters.push((r) => read(r, c) !== null && cmp(read(r, c), v) < 0); return this; }
  lte(c: string, v: unknown) { this.filters.push((r) => read(r, c) !== null && cmp(read(r, c), v) <= 0); return this; }
  gte(c: string, v: unknown) { this.filters.push((r) => read(r, c) !== null && cmp(read(r, c), v) >= 0); return this; }
  in(c: string, vs: unknown[]) { this.filters.push((r) => vs.includes(read(r, c))); return this; }
  is(c: string, v: unknown) { this.filters.push((r) => read(r, c) === v); return this; }
  not(c: string, _op: string, v: unknown) { this.filters.push((r) => read(r, c) !== v); return this; }
  or(expr: string) {
    const parts = expr.split(",").map((p) => {
      const [col, op, ...rest] = p.split(".");
      const value = rest.join(".");
      return (r: Row) => {
        const x = read(r, col);
        if (op === "is" && value === "null") return x === null;
        if (op === "eq") return x === value;
        if (op === "lt") return x !== null && cmp(x, value) < 0;
        return false;
      };
    });
    this.filters.push((r) => parts.some((f) => f(r)));
    return this;
  }
  order(column: string, opts?: { ascending?: boolean }) { this.orderBy = { column, ascending: opts?.ascending !== false }; return this; }
  limit(n: number) { this.max = n; return this; }
  single() { this.mode = "single"; return this; }
  maybeSingle() { this.mode = "maybe"; return this; }

  then<T1 = Result, T2 = never>(resolve?: ((v: Result) => T1 | PromiseLike<T1>) | null, reject?: ((e: unknown) => T2 | PromiseLike<T2>) | null): Promise<T1 | T2> {
    return Promise.resolve().then(() => this.run() as Result).then(resolve, reject);
  }

  private rows() {
    if (this.db.missingTables.has(this.table)) return null;
    return (this.db.tables[this.table] ??= []);
  }

  private shape(list: Row[]) {
    if (this.mode === "many") return { data: list.map((r) => ({ ...r })), error: null };
    if (list.length === 0) return this.mode === "single" ? { data: null, error: { code: "PGRST116", message: "no rows" } } : { data: null, error: null };
    return { data: { ...list[0] }, error: null };
  }

  private violates(rows: Row[], candidate: Row, self?: Row) {
    for (const cols of this.db.unique[this.table] ?? []) {
      const key = (r: Row) => cols.map((c) => read(r, c));
      const k = key(candidate);
      if (k.some((x) => x === null)) continue;
      if (rows.some((r) => r !== self && JSON.stringify(key(r)) === JSON.stringify(k))) return true;
    }
    return false;
  }

  private run() {
    const rows = this.rows();
    if (!rows) return { data: null, error: { code: "PGRST205", message: `Could not find the table 'public.${this.table}'` } };
    if (this.op === "insert") {
      const list = (Array.isArray(this.payload) ? this.payload : [this.payload]) as Row[];
      const inserted: Row[] = [];
      for (const value of list) {
        const row = { id: this.db.nextId(this.table), created_at: new Date().toISOString(), ...value };
        if (this.violates(rows, row)) return { data: null, error: { code: "23505", message: "duplicate key value violates unique constraint" } };
        rows.push(row);
        inserted.push(row);
      }
      return this.shape(inserted);
    }
    let matched = rows.filter((r) => this.filters.every((f) => f(r)));
    if (this.op === "update") {
      for (const row of matched) {
        const next = { ...row, ...(this.payload as Row) };
        if (this.violates(rows, next, row)) return { data: null, error: { code: "23505", message: "duplicate key" } };
        Object.assign(row, this.payload);
      }
      return this.shape(matched);
    }
    if (this.op === "delete") {
      this.db.tables[this.table] = rows.filter((r) => !matched.includes(r));
      return this.shape(matched);
    }
    if (this.orderBy) {
      const { column, ascending } = this.orderBy;
      matched = [...matched].sort((a, b) => (ascending ? 1 : -1) * cmp(read(a, column), read(b, column)));
    }
    if (this.max !== null) matched = matched.slice(0, this.max);
    return this.shape(matched);
  }
}
