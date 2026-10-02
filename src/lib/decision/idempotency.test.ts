import { test } from "node:test";
import assert from "node:assert/strict";
import { runIdempotentDecision } from "./idempotency";

test("concurrent decision execution reserves once and reuses the completed result", async () => {
  let nextId = 0;
  let reservedId: string | null = null;
  let completed: string | null = null;
  let executions = 0;
  let releaseBarrier: (() => void) | null = null;
  const barrier = new Promise<void>((resolve) => {
    releaseBarrier = resolve;
  });

  const store = {
    async reserve() {
      if (!reservedId) {
        reservedId = `run-${++nextId}`;
        await barrier;
        return { status: "acquired" as const, id: reservedId };
      }
      return { status: "existing" as const, id: reservedId };
    },
    async getCompleted() {
      return completed;
    },
    async complete(_id: string, output: string) {
      completed = output;
    },
    async release() {
      reservedId = null;
    },
  };

  const first = runIdempotentDecision(store, "same-key", async () => {
    executions += 1;
    return "decision-1";
  }, 1, 100);

  const second = runIdempotentDecision(store, "same-key", async () => {
    executions += 1;
    return "decision-2";
  }, 1, 100);

  await new Promise((resolve) => setImmediate(resolve));
  releaseBarrier?.();

  const results = await Promise.all([first, second]);

  assert.equal(executions, 1);
  assert.deepEqual(results.map((r) => r.status), ["acquired", "completed"]);
  assert.equal(results[0].id, results[1].id);
  assert.equal(results[1].output, "decision-1");
});

test("failed execution releases the reservation so the next attempt can run", async () => {
  let reserved = false;
  let released = false;
  let attempts = 0;

  const store = {
    async reserve() {
      if (!reserved) {
        reserved = true;
        return { status: "acquired" as const, id: "run-1" };
      }
      return { status: "existing" as const, id: "run-1" };
    },
    async getCompleted() {
      return null;
    },
    async complete() {},
    async release() {
      reserved = false;
      released = true;
    },
  };

  await assert.rejects(
    runIdempotentDecision(store, "retry-key", async () => {
      attempts += 1;
      throw new Error("AI unavailable");
    }),
    /AI unavailable/,
  );

  assert.equal(attempts, 1);
  assert.equal(released, true);

  const retry = await runIdempotentDecision(store, "retry-key", async () => {
    attempts += 1;
    return "retry-success";
  });

  assert.equal(attempts, 2);
  assert.equal(retry.status, "acquired");
});
