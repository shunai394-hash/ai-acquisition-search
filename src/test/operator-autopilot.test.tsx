// Rendered markup of the Autopilot panel: every state is reachable and keeps
// its accessibility contract (headings, live regions, alerts, labels).
import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AutopilotView } from "../components/OperatorAutopilot";
import { buildActivity } from "../lib/operator/activity";

const view = buildActivity({
  posts: [{ id: "a", status: "published", external_post_id: "1", network: "x", metadata: {} }],
  decision: { id: "r", completed_at: "2026-10-05T03:00:00.000Z", output: { decision: { verdict: "pivot", reason: "CTRが基準未満", confidence: 0.7, model_version: "deterministic", next_action: { description: "訴求を変える" }, evidence: [{ source: "post_metrics", key: "impressions", value: 5000 }] } } },
  jobs: [{ id: "j", status: "failed", provider_response: { loop_settled_reason: "non_retryable" } }],
  patrol: null,
});

test("signed-out state explains the loop and its safety guarantees", () => {
  const html = renderToStaticMarkup(<AutopilotView state={{ kind: "signed-out" }} />);
  assert.match(html, /aria-label="自動運用ループ"/);
  assert.match(html, /二重投稿しない/);
  assert.match(html, /AIが落ちても止まらない/);
  assert.match(html, /予算を守って止まる/);
});

test("error state is announced and offers a retry button", () => {
  const html = renderToStaticMarkup(<AutopilotView state={{ kind: "error", message: "取得できませんでした" }} onRetry={() => {}} />);
  assert.match(html, /role="alert"/);
  assert.match(html, /<button type="button">再読み込み<\/button>/);
});

test("ready state shows decision, reasons, signal count, confidence, blockers and the next run", () => {
  const html = renderToStaticMarkup(<AutopilotView state={{ kind: "ready", view, refreshedAt: "2026-10-05T04:00:00.000Z" }} />);
  assert.match(html, /<h3 id="autopilot-decision-title"><b>PIVOT<\/b>/);
  assert.match(html, /CTRが基準未満/);
  assert.match(html, /<b>1<\/b> 件のシグナル/);
  assert.match(html, /確信度 <b>70%<\/b>/);
  assert.match(html, /ルールによる判定/);
  assert.match(html, /確認が必要なこと/);
  assert.match(html, /モデレーション/);
  assert.match(html, /次回の巡回: 毎日 12:00 JST/);
  // Status colour is never the only signal: the tone is spelled out for screen readers.
  assert.match(html, /class="sr-only">（要確認）/);
});

test("empty ready state points to the next step instead of showing zeros", () => {
  const empty = buildActivity({ posts: [], decision: null, jobs: [], patrol: null });
  const html = renderToStaticMarkup(<AutopilotView state={{ kind: "ready", view: empty, refreshedAt: "2026-10-05T04:00:00.000Z" }} />);
  assert.match(html, /まだ稼働中のテストはありません/);
  assert.doesNotMatch(html, /autopilot-totals/);
});
