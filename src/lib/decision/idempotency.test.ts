import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DECISION_LEASE_TTL_MS,
  DECISION_LLM_MAX_MS,
  DECISION_ROUTE_MAX_DURATION_MS,
  DECISION_WAIT_MAX_MS,
  DecisionInProgressError,
  runIdempotentDecision,
  type DecisionReservationStore,
} from "./idempotency";
import { OPENAI_JSON_MAX_ATTEMPTS, OPENAI_JSON_TIMEOUT_MS } from "../ai/openai-json";

type Row = { id: string; key: string | null; holder: string | null; output: string | null; leaseExpiresAt: number };

/** In-memory store with the same semantics as the operator_runs store. */
function memoryStore(clock: () => number = Date.now) {
  const rows: Row[] = [];
  let seq = 0;
  const calls = { completes: 0, releases: 0 };
  const store: DecisionReservationStore<string> = {
    async reserve(key, holder) {
      await Promise.resolve();
      const existing = rows.find((r) => r.key === key);
      if (existing) return { status: "existing", id: existing.id };
      const row = { id: `run-${++seq}`, key, holder, output: null, leaseExpiresAt: clock() + DECISION_LEASE_TTL_MS };
      rows.push(row);
      return { status: "acquired", id: row.id };
    },
    async inspect(id) {
      await Promise.resolve();
      const row = rows.find((r) => r.id === id);
      if (!row) return { state: "missing" };
      if (row.output != null) return { state: "completed", output: row.output };
      return { state: "processing", leaseExpiresAt: row.leaseExpiresAt };
    },
    async takeover(id, holder, now) {
      await Promise.resolve();
      const row = rows.find((r) => r.id === id && r.output == null && r.leaseExpiresAt < now.getTime());
      if (!row) return false;
      row.holder = holder;
      row.leaseExpiresAt = now.getTime() + DECISION_LEASE_TTL_MS;
      return true;
    },
    async complete(id, holder, output, { retryable }) {
      await Promise.resolve();
      const row = rows.find((r) => r.id === id && r.holder === holder && r.output == null);
      if (!row) return false;
      calls.completes += 1;
      row.output = output;
      if (retryable) row.key = null;
      return true;
    },
    async release(id, holder) {
      await Promise.resolve();
      calls.releases += 1;
      const index = rows.findIndex((r) => r.id === id && r.holder === holder && r.output == null);
      if (index >= 0) rows.splice(index, 1);
    },
  };
  return { store, rows, calls };
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

test("wait budget is derived from the LLM timeout and retry count and fits in the route", () => {
  assert.equal(DECISION_LLM_MAX_MS, OPENAI_JSON_TIMEOUT_MS * OPENAI_JSON_MAX_ATTEMPTS);
  assert.ok(DECISION_WAIT_MAX_MS > DECISION_LLM_MAX_MS, "waiter outlasts the slowest LLM call");
  assert.ok(DECISION_WAIT_MAX_MS < DECISION_ROUTE_MAX_DURATION_MS, "waiter still answers before the platform kills it");
  assert.ok(DECISION_LEASE_TTL_MS > DECISION_ROUTE_MAX_DURATION_MS, "an expired lease can only belong to a dead request");
});

test("concurrent execution reserves once and the second request reuses the stored result", async () => {
  const { store, rows } = memoryStore();
  let executions = 0;
  const execute = async () => {
    executions += 1;
    await sleep(30);
    return { output: `decision-${executions}`, retryable: false };
  };
  const [a, b] = await Promise.all([
    runIdempotentDecision(store, "same-key", execute, { pollMs: 5 }),
    runIdempotentDecision(store, "same-key", execute, { pollMs: 5 }),
  ]);
  assert.equal(executions, 1);
  assert.equal(rows.length, 1);
  assert.deepEqual([a.status, b.status].sort(), ["acquired", "completed"]);
  assert.equal(a.id, b.id);
  assert.deepEqual(a.output, b.output);
});

test("a waiter that runs out of budget gets a retryable in-progress error, not a generic failure", async () => {
  const { store } = memoryStore();
  let finish = () => {};
  const holder = runIdempotentDecision(store, "slow", () => new Promise((resolve) => {
    finish = () => resolve({ output: "done", retryable: false });
  }), { pollMs: 5 });
  await sleep(5);
  await assert.rejects(
    runIdempotentDecision(store, "slow", async () => ({ output: "never", retryable: false }), { pollMs: 5, maxWaitMs: 30 }),
    (error: unknown) => error instanceof DecisionInProgressError && error.retryAfterMs > 0,
  );
  finish();
  assert.equal((await holder).output, "done");
  // Once the holder is done, the same key is answered from the stored result.
  const later = await runIdempotentDecision(store, "slow", async () => ({ output: "never", retryable: false }), { pollMs: 5 });
  assert.equal(later.status, "completed");
  assert.equal(later.output, "done");
});

test("failed execution releases the reservation so the next attempt can run", async () => {
  const { store, rows, calls } = memoryStore();
  let attempts = 0;
  await assert.rejects(
    runIdempotentDecision(store, "retry-key", async () => {
      attempts += 1;
      throw new Error("DB write failed");
    }),
    /DB write failed/,
  );
  assert.equal(calls.releases, 1);
  assert.equal(rows.length, 0);

  const retry = await runIdempotentDecision(store, "retry-key", async () => {
    attempts += 1;
    return { output: "retry-success", retryable: false };
  });
  assert.equal(attempts, 2);
  assert.equal(retry.status, "acquired");
  assert.equal(retry.output, "retry-success");
});

test("a waiter whose holder fails takes over instead of failing with it", async () => {
  const { store } = memoryStore();
  let calls = 0;
  const execute = async () => {
    calls += 1;
    await sleep(20);
    if (calls === 1) throw new Error("first attempt crashed");
    return { output: "second", retryable: false };
  };
  const [a, b] = await Promise.allSettled([
    runIdempotentDecision(store, "k", execute, { pollMs: 2 }),
    runIdempotentDecision(store, "k", execute, { pollMs: 2 }),
  ]);
  assert.equal(calls, 2);
  assert.deepEqual([a.status, b.status].sort(), ["fulfilled", "rejected"]);
});

test("retryable result frees the key: the next request executes again", async () => {
  const { store, rows } = memoryStore();
  const first = await runIdempotentDecision(store, "k", async () => ({ output: "fallback", retryable: true }));
  assert.equal(first.retryable, true);
  const second = await runIdempotentDecision(store, "k", async () => ({ output: "ai", retryable: false }));
  assert.equal(second.status, "acquired");
  assert.notEqual(second.id, first.id);
  assert.equal(second.output, "ai");
  assert.equal(rows.filter((r) => r.key === "k").length, 1);
});

test("expired reservation (holder died) is taken over; concurrent takeovers run the decision once", async () => {
  let now = 1_000_000;
  const clock = () => now;
  const { store, rows } = memoryStore(clock);
  rows.push({ id: "run-dead", key: "k", holder: "dead", output: null, leaseExpiresAt: now + DECISION_LEASE_TTL_MS });
  now += DECISION_LEASE_TTL_MS + 1;

  let executions = 0;
  const execute = async () => {
    executions += 1;
    await sleep(20);
    return { output: "recovered", retryable: false };
  };
  const [a, b] = await Promise.all([
    runIdempotentDecision(store, "k", execute, { pollMs: 2, now: clock, sleep }),
    runIdempotentDecision(store, "k", execute, { pollMs: 2, now: clock, sleep }),
  ]);
  assert.equal(executions, 1);
  assert.equal(rows.length, 1);
  assert.equal(a.id, "run-dead");
  assert.equal(b.id, "run-dead");
  assert.deepEqual([a.tookOver, b.tookOver].sort(), [false, true]);
  assert.equal(a.output, "recovered");
  assert.equal(b.output, "recovered");
});

test("a holder that lost its lease does not overwrite the new holder's result", async () => {
  let now = 0;
  const clock = () => now;
  const { store, rows } = memoryStore(clock);
  let releaseSlow = () => {};
  const slow = runIdempotentDecision(store, "k", () => new Promise((resolve) => {
    releaseSlow = () => resolve({ output: "zombie", retryable: false });
  }), { now: clock });
  await sleep(5);
  now += DECISION_LEASE_TTL_MS + 1;
  const fresh = await runIdempotentDecision(store, "k", async () => ({ output: "fresh", retryable: false }), { now: clock, sleep });
  assert.equal(fresh.tookOver, true);
  releaseSlow();
  const zombie = await slow;
  assert.equal(zombie.status, "completed");
  assert.equal(zombie.output, "fresh");
  assert.equal(rows[0].output, "fresh");
});
