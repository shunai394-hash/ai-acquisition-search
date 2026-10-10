const DEFAULT_EVALUATION_DELAY_HOURS = 12;
const MIN_EVALUATION_DELAY_HOURS = 6;
const MAX_EVALUATION_DELAY_HOURS = 24 * 30;

/** Prevent malformed environment values from breaking the operator loop cutoff. */
export function operatorEvaluationDelayHours(raw = process.env.OPERATOR_EVALUATION_DELAY_HOURS) {
  const configured = raw == null || raw.trim() === "" ? DEFAULT_EVALUATION_DELAY_HOURS : Number(raw);
  if (!Number.isFinite(configured)) return DEFAULT_EVALUATION_DELAY_HOURS;
  return Math.min(MAX_EVALUATION_DELAY_HOURS, Math.max(MIN_EVALUATION_DELAY_HOURS, configured));
}
