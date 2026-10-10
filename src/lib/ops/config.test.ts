import assert from "node:assert/strict";
import { test } from "node:test";
import { operatorEvaluationDelayHours } from "./config";

test("operator evaluation delay defaults safely for absent or malformed values", () => {
  assert.equal(operatorEvaluationDelayHours(undefined), 12);
  assert.equal(operatorEvaluationDelayHours(""), 12);
  assert.equal(operatorEvaluationDelayHours("invalid"), 12);
  assert.equal(operatorEvaluationDelayHours("NaN"), 12);
});

test("operator evaluation delay stays within supported bounds", () => {
  assert.equal(operatorEvaluationDelayHours("1"), 6);
  assert.equal(operatorEvaluationDelayHours("6"), 6);
  assert.equal(operatorEvaluationDelayHours("24"), 24);
  assert.equal(operatorEvaluationDelayHours("99999"), 24 * 30);
});
