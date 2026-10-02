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

test("scenario normalizer is total for malformed top-level input", () => {
  assert.deepEqual(normalizeAcquisitionScenarios(null), []);
  assert.deepEqual(normalizeAcquisitionScenarios(undefined), []);
  assert.deepEqual(normalizeAcquisitionScenarios({}), []);
  assert.deepEqual(normalizeAcquisitionScenarios("not-an-array"), []);
});

test("scenario normalizer strips non-string execution entries and whitespace", () => {
  const result = normalizeAcquisitionScenarios([
    valid("empathy", {
      hypothesis: "  仮説  ",
      hook: "  フック  ",
      beats: ["  one  ", 123, "", null, "two", "three", "four"],
      evidence: ["  source  ", false, "", "second"],
      variablesToHold: ["  商品  ", 99, "", "CTA"],
    }),
  ]);
  assert.equal(result.length, 1);
  assert.equal(result[0].hypothesis, "仮説");
  assert.equal(result[0].hook, "フック");
  assert.deepEqual(result[0].beats, ["  one  ", "two", "three", "four"]);
  assert.deepEqual(result[0].evidence, ["  source  ", "second"]);
  assert.deepEqual(result[0].variablesToHold, ["  商品  ", "CTA"]);
});

test("scenario normalizer applies safe defaults to optional fields", () => {
  const result = normalizeAcquisitionScenarios([
    valid("empathy", {
      targetCustomer: "",
      painOrDesire: " ",
      cta: "",
      channel: "",
      format: "",
      secondaryMetric: "",
      variablesToHold: "not-an-array",
      risk: "",
    }),
  ]);
  assert.equal(result.length, 1);
  assert.equal(result[0].targetCustomer, "未特定");
  assert.equal(result[0].painOrDesire, "未検証");
  assert.equal(result[0].cta, "未検証");
  assert.equal(result[0].channel, "未確定");
  assert.equal(result[0].format, "未確定");
  assert.equal(result[0].secondaryMetric, "未確定");
  assert.deepEqual(result[0].variablesToHold, []);
  assert.equal(result[0].risk, "未評価");
});

test("scenario normalizer keeps at most three executable scenarios", () => {
  const result = normalizeAcquisitionScenarios([
    valid("empathy"),
    valid("comparison_discovery"),
    valid("purchase_motivation"),
    valid("empathy", { id: "extra-1" }),
    valid("comparison_discovery", { id: "extra-2" }),
  ]);
  assert.equal(result.length, 3);
  assert.deepEqual(result.map((x) => x.id), ["empathy", "comparison_discovery", "purchase_motivation"]);
});

test("scenario normalizer requires evidence even when all execution fields exist", () => {
  const result = normalizeAcquisitionScenarios([
    valid("empathy", { evidence: [] }),
    valid("comparison_discovery"),
  ]);
  assert.equal(result.length, 1);
  assert.equal(result[0].archetype, "comparison_discovery");
});
