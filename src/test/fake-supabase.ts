// In-memory stand-in for the subset of the Supabase/PostgREST query builder
// used by the operator routes. Each awaited call yields to the event loop so
// concurrent requests interleave like real network I/O, and the unique
// indexes from supabase/migrations are enforced.

type Row = Record<string, unknown>;
type Filter = (row: Row) => boolean;
type Result = { data: unknown; error: { code: string; message: string } | null; count?: number };

function get(row: Row, path: string): unknown {
  const m = /^(\w+)->>(\w+)$/.exec(path);
  if (m) {
    const obj = row[m[1]];
    const v = obj && typeof obj === "object" ? (obj as Row)[m[2]] : undefined;
    return v == null ? null : String(v);
  }
  return row[path] ?? null;
}

const cmp = (a: unknown, b: unknown) => (String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0);

function parseOr(expr: string): Filter {
  const parts = expr.split(",").map((part) => {
    const m = /^(.+?)\.(is|eq|lt)\.(.*)$/.exec(part);
    if (!m) throw new Error(`unsupported or(): ${part}`);
    const [, col, op, value] = m;
    return (row: Row) => {
      const v = get(row, col);
      if (op === "is") return value === "null" ? v == null : v != null;
      if (op === "eq") return v != null && String(v) === value;
      return v != null && cmp(v, value) < 0;
    };
  });
  return (row) => parts.some((p) => p(row));
}

const UNIQUE: Record<string, Array<(row: Row) => string | null>> = {
  // operator_runs_decision_key_uidx: (user_id, input->>'decision_key') for ai_performance_verdict.
  operator_runs: [(r) => (r.run_type === "ai_performance_verdict" && get(r, "input->>decision_key") ? `dk:${r.user_id}:${get(r, "input->>decision_key")}` : null)],
  social_posts: [(r) => (get(r, "metadata->>source_social_post_id") ? `src:${r.user_id}:${get(r, "metadata->>source_social_post_id")}:${r.network}` : null)],
  post_metrics: [(r) => `pm:${r.social_post_id}:${Math.floor(Date.parse(String(r.measured_at)) / 300000)}`],
  operator_leases: [(r) => `lease:${r.name}`],
};

export class FakeSupabase {
  tables: Record<string, Row[]> = {};
  private seq = 0;
  /** Simulated outage: table name -> error code returned for any operation. */
  failures: Record<string, string> = {};
  /**
   * Targeted outage: return an error code to fail one specific operation
   * (e.g. only the update that stores an SNS result), or null to let it run.
   */
  failWhen: ((table: string, op: "select" | "insert" | "update" | "delete", payload: Row | Row[] | null) => string | null) | null = null;

  table(name: string) {
    return (this.tables[name] ||= []);
  }

  seed(name: string, rows: Row[]) {
    for (const row of rows) this.table(name).push({ ...this.defaults(name), ...row });
  }

  defaults(name: string): Row {
    const now = new Date(Date.now() + this.seq++).toISOString();
    const base: Row = { id: `${name}-${this.seq}`, created_at: now, updated_at: now };
    if (name === "post_metrics") base.measured_at = now;
    return base;
  }

  from(name: string) {
    return new Query(this, name);
  }
}

class Query implements PromiseLike<Result> {
  private filters: Filter[] = [];
  private orderBy: Array<{ col: string; asc: boolean }> = [];
  private max: number | null = null;
  private op: "select" | "insert" | "update" | "delete" = "select";
  private payload: Row | Row[] | null = null;
  private mode: "many" | "single" | "maybe" = "many";
  private head = false;

  constructor(private db: FakeSupabase, private name: string) {}

  select(_cols?: string, opts?: { head?: boolean; count?: string }) {
    if (opts?.head) this.head = true;
    return this;
  }
  insert(row: Row | Row[]) { this.op = "insert"; this.payload = row; return this; }
  update(patch: Row) { this.op = "update"; this.payload = patch; return this; }
  delete() { this.op = "delete"; return this; }
  eq(col: string, v: unknown) { this.filters.push((r) => get(r, col) != null && String(get(r, col)) === String(v)); return this; }
  neq(col: string, v: unknown) { this.filters.push((r) => String(get(r, col)) !== String(v)); return this; }
  lt(col: string, v: unknown) { this.filters.push((r) => get(r, col) != null && cmp(get(r, col), v) < 0); return this; }
  lte(col: string, v: unknown) { this.filters.push((r) => get(r, col) != null && cmp(get(r, col), v) <= 0); return this; }
  in(col: string, vs: unknown[]) { const set = new Set(vs.map(String)); this.filters.push((r) => set.has(String(get(r, col)))); return this; }
  is(col: string, v: null) { this.filters.push((r) => get(r, col) === v); return this; }
  not(col: string, op: string, v: unknown) {
    if (op !== "is" || v !== null) throw new Error("unsupported not()");
    this.filters.push((r) => get(r, col) != null);
    return this;
  }
  filter(col: string, op: string, v: unknown) {
    if (op !== "eq") throw new Error(`unsupported filter(): ${op}`);
    return this.eq(col, v);
  }
  or(expr: string) { this.filters.push(parseOr(expr)); return this; }
  order(col: string, opts?: { ascending?: boolean }) { this.orderBy.push({ col, asc: opts?.ascending !== false }); return this; }
  limit(n: number) { this.max = n; return this; }
  single() { this.mode = "single"; return this; }
  maybeSingle() { this.mode = "maybe"; return this; }

  then<A = Result, B = never>(onOk?: ((value: Result) => A | PromiseLike<A>) | null, onErr?: ((reason: unknown) => B | PromiseLike<B>) | null) {
    return new Promise<Result>((resolve) => setImmediate(() => resolve(this.run()))).then(onOk, onErr);
  }

  private matching() {
    let rows = this.db.table(this.name).filter((r) => this.filters.every((f) => f(r)));
    for (const { col, asc } of [...this.orderBy].reverse()) {
      rows = [...rows].sort((a, b) => (asc ? 1 : -1) * cmp(get(a, col), get(b, col)));
    }
    return rows;
  }

  private finish(rows: Row[]): Result {
    if (this.head) return { data: null, error: null, count: rows.length };
    const limited = this.max != null ? rows.slice(0, this.max) : rows;
    const copy = limited.map((r) => structuredClone(r));
    if (this.mode === "many") return { data: copy, error: null };
    if (this.mode === "single" && copy.length !== 1) return { data: null, error: { code: "PGRST116", message: "not single" } };
    return { data: copy[0] ?? null, error: null };
  }

  private run(): Result {
    const failure = this.db.failures[this.name];
    if (failure) return { data: null, error: { code: failure, message: `simulated ${failure} on ${this.name}` } };
    const targeted = this.db.failWhen?.(this.name, this.op, this.payload) ?? null;
    if (targeted) return { data: null, error: { code: targeted, message: `simulated ${targeted} on ${this.op} ${this.name}` } };
    const table = this.db.table(this.name);
    if (this.op === "insert") {
      const rows = (Array.isArray(this.payload) ? this.payload : [this.payload]).map((r) => ({ ...this.db.defaults(this.name), ...(r as Row) }));
      for (const row of rows) {
        for (const key of UNIQUE[this.name] || []) {
          const k = key(row);
          if (k && table.some((existing) => key(existing) === k)) {
            return { data: null, error: { code: "23505", message: `duplicate key ${k}` } };
          }
        }
      }
      table.push(...rows);
      return this.finish(rows);
    }
    const rows = this.matching();
    if (this.op === "update") {
      for (const row of rows) Object.assign(row, structuredClone(this.payload as Row));
      return this.finish(rows);
    }
    if (this.op === "delete") {
      this.db.tables[this.name] = table.filter((r) => !rows.includes(r));
      return this.finish(rows);
    }
    return this.finish(rows);
  }
}
