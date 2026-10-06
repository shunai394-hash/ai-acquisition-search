import assert from "node:assert/strict";
import test from "node:test";
import { buildActivity, describeDecision, describeJob } from "./activity";

const decisionRun = (decision: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  id: "run1", completed_at: "2026-10-05T03:00:00.000Z",
  output: { verdict: decision.verdict, decision, ...extra },
});

test("decision shows what was decided, why, on how many observed signals, and what happens next", () => {
  const d = describeDecision(decisionRun({
    verdict: "pivot", reason: "CTRがベンチマークを下回りました", confidence: 0.75, model_version: "deterministic",
    next_action: { description: "結露の悩みで訴求を変える" },
    evidence: [
      { source: "post_metrics", key: "impressions", value: 5000 },
      { source: "post_metrics", key: "clicks", value: null },
      { source: "ec_pulse", key: "status", value: "unavailable" },
      { source: "product", key: "gross_margin_rate", value: 0.6 },
    ],
  }));
  assert.ok(d);
  assert.equal(d.label, "PIVOT");
  assert.equal(d.reason, "CTRがベンチマークを下回りました");
  assert.equal(d.nextAction, "結露の悩みで訴求を変える");
  assert.match(d.next, /次の動画/);
  assert.equal(d.signals, 2, "unknown and unavailable evidence is not counted as a signal");
  assert.deepEqual(d.signalSources, ["SNS実績", "商品データ"]);
  assert.equal(d.confidence, 75);
  assert.equal(d.source, "deterministic");
});

test("AI wording and LLM fallback are reported honestly", () => {
  assert.equal(describeDecision(decisionRun({ verdict: "continue", model_version: "gpt-5-mini", evidence: [] }))?.source, "ai");
  const fallback = describeDecision(decisionRun({ verdict: "continue", model_version: "deterministic", evidence: [] }, { llm: { status: "failed" } }));
  assert.equal(fallback?.source, "deterministic");
  assert.equal(fallback?.llmFallback, true);
});

test("STOP and WAIT explain that no new video is made", () => {
  assert.match(describeDecision(decisionRun({ verdict: "stop", evidence: [] }))!.next, /作りません/);
  assert.match(describeDecision(decisionRun({ verdict: "wait", evidence: [] }))!.next, /再判定/);
  assert.equal(describeDecision(decisionRun({ verdict: "bogus", evidence: [] })), null);
  assert.equal(describeDecision(null), null);
});

test("job states map to plain-language status and only real blockers need a human", () => {
  const cases: Array<[Record<string, unknown>, string, boolean]> = [
    [{ status: "queued", provider_response: null }, "待機中", false],
    [{ status: "running", provider_response: { input_image_url: "https://img" } }, "生成中", false],
    [{ status: "failed", provider_response: { retry_count: 1 } }, "再試行予定", false],
    [{ status: "failed", provider_response: { timed_out_request_id: "r1" } }, "再試行予定", false],
    [{ status: "completed", provider_response: {} }, "投稿待ち", false],
    [{ status: "completed", provider_response: { publish_attempts: 1, publish_last_error: "X down" } }, "投稿を再試行予定", false],
    [{ status: "completed", provider_response: { loop_settled_reason: "published" } }, "投稿済み", false],
    [{ status: "failed", provider_response: { loop_settled_reason: "retries_exhausted" } }, "要確認", true],
    [{ status: "failed", provider_response: { loop_settled_reason: "non_retryable" } }, "要確認", true],
    [{ status: "completed", provider_response: { loop_settled_reason: "publish_exhausted" } }, "要確認", true],
    [{ status: "failed", provider_response: { manual_recovery_required: true } }, "要確認", true],
  ];
  for (const [job, status, needsHuman] of cases) {
    const described = describeJob({ id: "j", ...job });
    assert.equal(described.item.status, status, JSON.stringify(job));
    assert.equal(Boolean(described.attention), needsHuman, JSON.stringify(job));
    if (described.attention) assert.ok(described.attention.action, "every blocker says what to do");
  }
  assert.equal(describeJob({ id: "j", status: "running", provider_response: { input_image_url: "https://img" } }).item.imageReference, true);
});

test("totals and attention cover stalled posts and stuck publishes", () => {
  const now = Date.parse("2026-10-05T12:00:00.000Z");
  const view = buildActivity({
    now,
    posts: [
      { id: "a", status: "published", external_post_id: "1", network: "x", metadata: {} },
      { id: "b", status: "published", external_post_id: "2", network: "x", metadata: { operator_patrol_status: "superseded" } },
      { id: "c", status: "published", external_post_id: "3", network: "x", metadata: { operator_patrol_status: "stopped" } },
      { id: "d", status: "published", external_post_id: "4", network: "tiktok", metadata: { operator_patrol_status: "stalled" } },
      { id: "e", status: "publishing", network: "x", updated_at: "2026-10-05T10:00:00.000Z", metadata: {} },
      { id: "f", status: "publishing", network: "x", updated_at: "2026-10-05T11:55:00.000Z", metadata: {} },
      { id: "g", status: "scheduled", network: "x", metadata: {} },
    ],
    decision: null,
    jobs: [
      { id: "j1", status: "running", provider_response: {} },
      { id: "j2", status: "failed", provider_response: { loop_settled_reason: "retries_exhausted" } },
    ],
    patrol: { output: { severity: "healthy", summary: "自動運用は正常に巡回しました。", checkedAt: "2026-10-05T03:30:00.000Z" } },
  });
  assert.deepEqual(view.totals, { testing: 1, superseded: 1, stopped: 1, stalled: 1, videosInFlight: 1, published: 4, attention: 3 });
  assert.deepEqual(view.attention.map((a) => a.id).sort(), ["d", "e", "j2"], "a publish still inside its window is not flagged");
  assert.equal(view.patrol?.summary, "自動運用は正常に巡回しました。");
});
