import { test } from "node:test";
import assert from "node:assert/strict";
import { runIdempotentDecision } from "./idempotency";

test("concurrent decision execution reserves once and reuses the completed result", async () => {
  let nextId = 0;
  let reservedId: string | null = null;
  let completed: string | null = null;
  let executions = 0;
  let releaseBarrier = () => {};
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
    return { output: "decision-1" };
  }, 1, 100);

  const second = runIdempotentDecision(store, "same-key", async () => {
    executions += 1;
    return { output: "decision-2" };
  }, 1, 100);

  await new Promise((resolve) => setImmediate(resolve));
  releaseBarrier();

  const results = await Promise.all([first, second]);

  assert.equal(executions, 1);
  assert.deepEqual(results.map((r) => r.status), ["acquired", "completed"]);
  assert.equal(results[0].id, results[1].id);
  assert.equal(results[1].output, "decision-1");
});

test("wait window can exceed the old 2-second polling window", async () => {
  let completed: string | null = null;
  let reads = 0;
  const store = {
    async reserve() {
      return { status: "existing" as const, id: "run-1" };
    },
    async getCompleted() {
      reads += 1;
      if (reads >= 4) completed = "late-decision";
      return completed;
    },
    async complete() {},
    async release() {},
  };

  const result = await runIdempotentDecision(store, "slow-key", async () => ({ output: "unused" }), 800, 4);
  assert.equal(result.status, "completed");
  assert.equal(result.output, "late-decision");
  assert.equal(reads, 4);
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

  const retry = await runIdempotentDecision(store, "retry-key", async () => ({ output: "retry-success" }));
  assert.equal(attempts, 2);
  assert.equal(retry.status, "acquired");
});

test("non-persistable output is released and returned as transient", async () => {
  let released = false;
  let completed = false;
  const store = {
    async reserve() {
      return { status: "acquired" as const, id: "run-1" };
    },
    async getCompleted() {
      return null;
    },
    async complete() {
      completed = true;
    },
    async release() {
      released = true;
    },
  };

  const result = await runIdempotentDecision(store, "transient-key", async () => ({
    output: "deterministic-fallback",
    persist: false,
  }));

  assert.equal(result.status, "transient");
  assert.equal(result.output, "deterministic-fallback");
  assert.equal(released, true);
  assert.equal(completed, false);
});
