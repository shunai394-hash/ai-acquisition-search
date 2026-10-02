export type DecisionReservationResult<T> =
  | { status: "acquired"; id: string; output: T }
  | { status: "completed"; id: string; output: T };

export type DecisionReservationStore<T> = {
  reserve: (decisionKey: string) => Promise<{ status: "acquired"; id: string } | { status: "existing"; id: string }>;
  getCompleted: (id: string) => Promise<T | null>;
  complete: (id: string, output: T) => Promise<void>;
  release: (id: string) => Promise<void>;
};

export async function runIdempotentDecision<T>(
  store: DecisionReservationStore<T>,
  decisionKey: string,
  execute: () => Promise<T>,
  waitMs = 50,
  maxWaits = 40,
): Promise<DecisionReservationResult<T>> {
  const reservation = await store.reserve(decisionKey);

  if (reservation.status === "existing") {
    for (let attempt = 0; attempt < maxWaits; attempt += 1) {
      const output = await store.getCompleted(reservation.id);
      if (output) return { status: "completed", id: reservation.id, output };
      if (attempt < maxWaits - 1) await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
    throw new Error("既存のAI判定が完了するまで待機できませんでした。");
  }

  try {
    const output = await execute();
    await store.complete(reservation.id, output);
    return { status: "acquired", id: reservation.id, output };
  } catch (error) {
    await store.release(reservation.id);
    throw error;
  }
}
