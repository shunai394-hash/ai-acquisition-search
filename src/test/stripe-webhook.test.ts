// Stripe webhook: signature, redelivery after failure, and current-state sync.
import { beforeEach, mock, test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";

type Row = Record<string, unknown>;
const tables: Record<string, Row[]> = {};
const upserts: Array<{ table: string; row: Row }> = [];

function builder(table: string) {
  const rows = (tables[table] ||= []);
  let op: "select" | "insert" | "update" = "select";
  let payload: Row = {};
  const filters: Array<[string, unknown]> = [];
  const api = {
    insert(row: Row) { op = "insert"; payload = row; return api; },
    update(row: Row) { op = "update"; payload = row; return api; },
    upsert(row: Row) { upserts.push({ table, row }); return Promise.resolve({ data: null, error: null }); },
    select() { return api; },
    eq(col: string, value: unknown) { filters.push([col, value]); return api; },
    maybeSingle() { return api; },
    then(resolve: (value: unknown) => unknown) {
      const match = rows.filter((row) => filters.every(([col, value]) => row[col] === value));
      if (op === "insert") {
        if (rows.some((row) => row.event_id === payload.event_id)) return Promise.resolve({ data: null, error: { code: "23505", message: "duplicate key" } }).then(resolve);
        rows.push({ ...payload });
        return Promise.resolve({ data: { event_id: payload.event_id }, error: null }).then(resolve);
      }
      if (op === "update") { match.forEach((row) => Object.assign(row, payload)); return Promise.resolve({ data: null, error: null }).then(resolve); }
      return Promise.resolve({ data: match[0] ?? null, error: null }).then(resolve);
    },
  };
  return api;
}

mock.module("../lib/billing.ts", { namedExports: { getAdminSupabase: () => ({ from: builder }) } });

process.env.STRIPE_WEBHOOK_SECRET = "whsec_test";
process.env.STRIPE_SECRET_KEY = "sk_test";

let stripeSubscription: Row = {};
let stripeDown = false;
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  if (url.host === "api.stripe.com") {
    if (stripeDown) return new Response(JSON.stringify({ error: { message: "unavailable" } }), { status: 503 });
    return new Response(JSON.stringify(stripeSubscription), { status: 200 });
  }
  return realFetch(input, init);
}) as typeof fetch;

const { POST: webhook } = await import("../app/api/stripe/webhook/route");

function signed(event: Row) {
  const payload = JSON.stringify(event);
  const t = Math.floor(Date.now() / 1000);
  const v1 = createHmac("sha256", "whsec_test").update(`${t}.${payload}`).digest("hex");
  return new Request("https://app.test/api/stripe/webhook", { method: "POST", headers: { "stripe-signature": `t=${t},v1=${v1}` }, body: payload });
}

const staleActiveEvent = {
  id: "evt_1",
  type: "customer.subscription.updated",
  data: { object: { id: "sub_1", customer: "cus_1", status: "active", metadata: { user_id: "u1" } } },
};

beforeEach(() => {
  for (const key of Object.keys(tables)) delete tables[key];
  upserts.length = 0;
  stripeDown = false;
  stripeSubscription = { id: "sub_1", customer: "cus_1", status: "canceled", items: { data: [{ current_period_end: 1893456000 }] } };
});

test("rejects an invalid signature", async () => {
  const request = new Request("https://app.test/api/stripe/webhook", { method: "POST", headers: { "stripe-signature": "t=1,v1=bad" }, body: "{}" });
  assert.equal((await webhook(request)).status, 400);
});

test("an out-of-order 'active' event syncs Stripe's current canceled state with the item period end", async () => {
  const res = await webhook(signed(staleActiveEvent));
  assert.equal(res.status, 200, await res.clone().text());
  const sub = upserts.find((u) => u.table === "subscriptions")!.row;
  assert.equal(sub.status, "canceled");
  assert.equal(sub.plan, "free");
  assert.equal(sub.user_id, "u1", "metadata from the event is kept when the fetched object lacks it");
  assert.equal(sub.current_period_end, new Date(1893456000 * 1000).toISOString());
});

test("a failed delivery can be retried: the duplicate event id no longer returns 500 forever", async () => {
  stripeDown = true;
  assert.equal((await webhook(signed(staleActiveEvent))).status, 500);
  assert.equal(tables.stripe_webhook_events[0].status, "failed");
  stripeDown = false;
  const retry = await webhook(signed(staleActiveEvent));
  assert.equal(retry.status, 200, await retry.clone().text());
  assert.equal(tables.stripe_webhook_events[0].status, "processed");
  const again = await (await webhook(signed(staleActiveEvent))).json();
  assert.equal(again.reused, true);
});
