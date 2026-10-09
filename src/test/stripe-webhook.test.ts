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
        if (table === "stripe_webhook_events" && rows.some((row) => row.event_id === payload.event_id)) return Promise.resolve({ data: null, error: { code: "23505", message: "duplicate key" } }).then(resolve);
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
let stripeFetches = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  if (url.host === "api.stripe.com") {
    stripeFetches++;
    if (stripeDown) return new Response(JSON.stringify({ error: { message: "unavailable" } }), { status: 503 });
    return new Response(JSON.stringify(stripeSubscription), { status: 200 });
  }
  return realFetch(input, init);
}) as typeof fetch;

const { POST: webhook } = await import("../app/api/stripe/webhook/route");

function signed(event: Row, options: { ageSeconds?: number; tamper?: boolean } = {}) {
  const payload = JSON.stringify(event);
  const t = Math.floor(Date.now() / 1000) - (options.ageSeconds ?? 0);
  const v1 = createHmac("sha256", "whsec_test").update(`${t}.${payload}`).digest("hex");
  const body = options.tamper ? payload.replace("sub_1", "sub_X") : payload;
  return new Request("https://app.test/api/stripe/webhook", { method: "POST", headers: { "stripe-signature": `t=${t},v1=${v1}` }, body });
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
  stripeFetches = 0;
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

const subscriptionEvent = (id: string, type: string, status = "active") => ({
  id,
  type,
  data: { object: { id: "sub_1", customer: "cus_1", status, metadata: { user_id: "u1" } } },
});

test("an already processed event is acknowledged without touching Stripe or the database", async () => {
  stripeSubscription = { ...stripeSubscription, status: "active" };
  assert.equal((await webhook(signed(subscriptionEvent("evt_dup", "customer.subscription.updated")))).status, 200);
  const fetchesAfterFirst = stripeFetches;
  const upsertsAfterFirst = upserts.length;
  const again = await webhook(signed(subscriptionEvent("evt_dup", "customer.subscription.updated")));
  assert.deepEqual(await again.json(), { received: true, reused: true });
  assert.equal(stripeFetches, fetchesAfterFirst);
  assert.equal(upserts.length, upsertsAfterFirst);
});

test("concurrent duplicate deliveries both succeed and converge on the same state", async () => {
  stripeSubscription = { ...stripeSubscription, status: "active" };
  const [a, b] = await Promise.all([
    webhook(signed(subscriptionEvent("evt_conc", "customer.subscription.updated"))),
    webhook(signed(subscriptionEvent("evt_conc", "customer.subscription.updated"))),
  ]);
  assert.deepEqual([a.status, b.status], [200, 200]);
  const states = upserts.filter((u) => u.table === "subscriptions").map((u) => `${u.row.status}/${u.row.plan}`);
  assert.ok(states.length >= 1 && states.every((s) => s === "active/pro"), states.join(","));
  assert.equal(tables.stripe_webhook_events.length, 1);
  assert.equal(tables.stripe_webhook_events[0].status, "processed");
});

test("subscription.deleted and past_due both drop the user to the free plan", async () => {
  stripeSubscription = { ...stripeSubscription, status: "canceled" };
  await webhook(signed(subscriptionEvent("evt_del", "customer.subscription.deleted", "canceled")));
  stripeSubscription = { ...stripeSubscription, status: "past_due" };
  await webhook(signed(subscriptionEvent("evt_pd", "customer.subscription.updated", "past_due")));
  const subs = upserts.filter((u) => u.table === "subscriptions").map((u) => [u.row.status, u.row.plan]);
  assert.deepEqual(subs, [["canceled", "free"], ["past_due", "free"]]);
});

test("invoice.payment_failed records an event but does not change the plan", async () => {
  tables.billing_customers = [{ stripe_customer_id: "cus_1", user_id: "u1" }];
  const res = await webhook(signed({ id: "evt_inv", type: "invoice.payment_failed", data: { object: { id: "in_1", customer: "cus_1" } } }));
  assert.equal(res.status, 200);
  assert.equal(upserts.filter((u) => u.table === "subscriptions").length, 0);
  assert.equal(tables.usage_events?.[0]?.event_type, "billing_payment_failed");
});

test("a subscription with no matching user is processed without writing a plan", async () => {
  stripeSubscription = { id: "sub_9", customer: "cus_unknown", status: "active" };
  const res = await webhook(signed({ id: "evt_orphan", type: "customer.subscription.updated", data: { object: { id: "sub_9", customer: "cus_unknown", status: "active" } } }));
  assert.equal(res.status, 200);
  assert.equal(upserts.filter((u) => u.table === "subscriptions").length, 0);
});

test("stale (>5 min) or tampered signatures are rejected before any processing", async () => {
  assert.equal((await webhook(signed(staleActiveEvent, { ageSeconds: 600 }))).status, 400);
  assert.equal((await webhook(signed(staleActiveEvent, { tamper: true }))).status, 400);
  assert.equal(tables.stripe_webhook_events?.length ?? 0, 0);
  assert.equal(stripeFetches, 0);
});
