import test from "node:test";
import assert from "node:assert/strict";
import { normalizeAcquisitionScenarios } from "./analyze";

const valid = (archetype: string, overrides: Record<string, unknown> = {}) => ({
  id: archetype,
  archetype,
  hypothesis: "この訴求が反応を生むか検証する",
  targetCustomer: "顧客A",
  painOrDesire: "悩みA",
  hook: "この悩みありませんか？",
  beats: ["悩み提示", "場面提示", "価値提示", "CTA"],
  proof: ["商品ページの記載"],
  cta: "詳細を見る",
  channel: "未確定",
  format: "短尺",
  primaryMetric: "CTR",
  secondaryMetric: "CVR",
  variableToChange: "hook",
  variablesToHold: ["商品", "尺", "CTA"],
  risk: "仮説段階",
  evidence: ["商品ページ"],
  ...overrides,
});

test("scenario normalizer accepts at most one of each archetype", () => {
  const result = normalizeAcquisitionScenarios([
    valid("empathy"),
    valid("empathy", { id: "duplicate" }),
    valid("comparison_discovery"),
    valid("purchase_motivation"),
  ]);
  assert.equal(result.length, 3);
  assert.deepEqual(result.map((x) => x.archetype), [
    "empathy",
    "comparison_discovery",
    "purchase_motivation",
  ]);
});

test("scenario normalizer rejects non-executable scenarios", () => {
  const result = normalizeAcquisitionScenarios([
    valid("empathy", { beats: ["one", "two"] }),
    valid("comparison_discovery", { evidence: [] }),
    valid("purchase_motivation", { variableToChange: "" }),
    valid("empathy", { id: "valid-after-invalid" }),
  ]);
  assert.equal(result.length, 1);
  assert.equal(result[0].archetype, "empathy");
  assert.equal(result[0].id, "valid-after-invalid");
});

test("scenario normalizer caps execution and evidence arrays", () => {
  const result = normalizeAcquisitionScenarios([
    valid("empathy", {
      beats: ["1", "2", "3", "4", "5", "6", "7"],
      evidence: ["1", "2", "3", "4", "5", "6", "7"],
      variablesToHold: ["1", "2", "3", "4", "5", "6", "7", "8", "9"],
    }),
  ]);
  assert.equal(result[0].beats.length, 6);
  assert.equal(result[0].evidence.length, 6);
  assert.equal(result[0].variablesToHold.length, 8);
});

test("scenario normalizer rejects unknown archetypes and preserves explicit unknown channel", () => {
  const result = normalizeAcquisitionScenarios([
    valid("unknown"),
    valid("empathy", { channel: "未確定" }),
  ]);
  assert.equal(result.length, 1);
  assert.equal(result[0].channel, "未確定");
});
