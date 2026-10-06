"use client";

import { useCallback, useEffect, useState } from "react";
import type { ActivityView, Tone } from "@/lib/operator/activity";

/** vercel.json runs the loop at 03:00 UTC (12:00 JST) and the patrol right after. */
export const LOOP_SCHEDULE_LABEL = "毎日 12:00 JST";

const LOOP_STEPS = [
  ["01", "POST", "動画をSNSへ投稿"],
  ["02", "MEASURE", "実績を自動取得"],
  ["03", "DECIDE", "継続・切替・停止を判定"],
  ["04", "CREATE", "次の動画を生成"],
] as const;

const GUARANTEES = [
  ["二重投稿しない", "投稿前に予約を取り、結果が不明なときは再投稿せず確認を求めます。"],
  ["AIが落ちても止まらない", "判定はルールで決まり、AIは文言を整えるだけ。AI障害時もルールの判定で続行します。"],
  ["予算を守って止まる", "反応が繰り返し弱い仮説はSTOP。新しい動画は作りません。"],
] as const;

type State =
  | { kind: "signed-out" }
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; view: ActivityView; refreshedAt: string };

const TONE_LABEL: Record<Tone, string> = { ok: "完了", busy: "進行中", warn: "再試行予定", error: "要確認" };

function formatTime(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleString("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function LoopRail() {
  return (
    <ol className="autopilot-rail" aria-label="自動運用ループ">
      {LOOP_STEPS.map(([index, label, ja]) => (
        <li key={label}><b>{index}</b><strong>{label}</strong><span>{ja}</span></li>
      ))}
    </ol>
  );
}

function Guarantees() {
  return (
    <ul className="autopilot-guarantees" aria-label="自動運用の安全設計">
      {GUARANTEES.map(([title, body]) => (
        <li key={title}><strong>{title}</strong><span>{body}</span></li>
      ))}
    </ul>
  );
}

/** Presentational view; exported for tests. */
export function AutopilotView({ state, onRetry }: { state: State; onRetry?: () => void }) {
  if (state.kind === "signed-out") {
    return (
      <>
        <p className="autopilot-lead">ログインして商品URLを分析し「保存して自動運用を起動」すると、AIが{LOOP_SCHEDULE_LABEL}に巡回して、投稿 → 計測 → 判定 → 次の動画までを回し続けます。</p>
        <LoopRail />
        <Guarantees />
      </>
    );
  }
  if (state.kind === "loading") {
    return <div className="autopilot-skeleton" aria-hidden="true"><i /><i /><i /></div>;
  }
  if (state.kind === "error") {
    return (
      <div className="autopilot-error" role="alert">
        <strong>{state.message}</strong>
        {onRetry && <button type="button" onClick={onRetry}>再読み込み</button>}
      </div>
    );
  }

  const { view } = state;
  const { totals, latestDecision: decision } = view;
  const empty = totals.published === 0 && view.pipeline.length === 0 && !decision;
  if (empty) {
    return (
      <>
        <p className="autopilot-lead">まだ稼働中のテストはありません。下で商品URLを分析し「保存して自動運用を起動」すると、ここに判断と進行状況が表示されます。</p>
        <LoopRail />
        <Guarantees />
      </>
    );
  }

  return (
    <>
      <dl className="autopilot-totals">
        <div><dt>検証中</dt><dd>{totals.testing}</dd></div>
        <div><dt>次の動画へ</dt><dd>{totals.superseded}</dd></div>
        <div><dt>停止</dt><dd>{totals.stopped}</dd></div>
        <div><dt>制作中</dt><dd>{totals.videosInFlight}</dd></div>
        <div className={totals.attention ? "attention" : ""}><dt>要確認</dt><dd>{totals.attention}</dd></div>
      </dl>

      {decision && (
        <article className={`autopilot-decision verdict-${decision.verdict}`} aria-labelledby="autopilot-decision-title">
          <header>
            <span className="eyebrow">最新のAI判断 · {formatTime(decision.decidedAt)}</span>
            <h3 id="autopilot-decision-title"><b>{decision.label}</b> {decision.meaning}</h3>
          </header>
          <p className="autopilot-reason"><span>なぜ</span>{decision.reason}</p>
          <p className="autopilot-next"><span>次に</span>{decision.next}{decision.nextAction ? ` ${decision.nextAction}` : ""}</p>
          <ul className="autopilot-meta" aria-label="判断の根拠">
            <li><b>{decision.signals}</b> 件のシグナル{decision.signalSources.length ? `（${decision.signalSources.join("・")}）` : ""}</li>
            <li>確信度 <b>{decision.confidence}%</b></li>
            <li>{decision.source === "ai" ? "判定はルール · 文言はAIで調整" : "ルールによる判定（AI文言なし）"}</li>
            {decision.llmFallback && <li className="warn">AI文言生成に失敗したためルールの文言を使用。次回再試行します</li>}
          </ul>
        </article>
      )}

      {view.attention.length > 0 && (
        <section className="autopilot-attention" aria-labelledby="autopilot-attention-title">
          <h3 id="autopilot-attention-title">確認が必要なこと</h3>
          <ul>
            {view.attention.map((item) => (
              <li key={item.id + item.title}><strong>{item.title}</strong><span>{item.detail}</span><em>{item.action}</em></li>
            ))}
          </ul>
        </section>
      )}

      {view.pipeline.length > 0 && (
        <section className="autopilot-pipeline" aria-labelledby="autopilot-pipeline-title">
          <h3 id="autopilot-pipeline-title">動画と投稿</h3>
          <ul>
            {view.pipeline.map((item) => (
              <li key={item.id} className={`tone-${item.tone}`}>
                <span className="autopilot-dot" aria-hidden="true" />
                <div><strong>{item.status}<span className="sr-only">（{TONE_LABEL[item.tone]}）</span></strong><span>{item.title}{item.imageReference ? " · 商品画像を使用" : ""}</span>{item.detail && <small>{item.detail}</small>}</div>
                <time dateTime={item.at}>{formatTime(item.at)}</time>
              </li>
            ))}
          </ul>
        </section>
      )}

      <p className="autopilot-footer">
        次回の巡回: {LOOP_SCHEDULE_LABEL}
        {view.patrol ? ` · 前回の巡回 ${formatTime(view.patrol.checkedAt)}: ${view.patrol.summary}` : ""}
        {` · 表示更新 ${formatTime(state.refreshedAt)}`}
      </p>
    </>
  );
}

export default function OperatorAutopilot() {
  const [state, setState] = useState<State>({ kind: "loading" });

  const load = useCallback(async (quiet = false) => {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    if (!url || !key) { setState({ kind: "signed-out" }); return; }
    try {
      const { createClient } = await import("@supabase/supabase-js");
      const { data } = await createClient(url, key).auth.getSession();
      if (!data.session) { setState({ kind: "signed-out" }); return; }
      if (!quiet) setState({ kind: "loading" });
      const response = await fetch("/api/operator/activity", { headers: { Authorization: "Bearer " + data.session.access_token }, cache: "no-store" });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || "自動運用の状況を取得できませんでした。");
      setState({ kind: "ready", view: body as ActivityView, refreshedAt: new Date().toISOString() });
    } catch (error) {
      // A failed background refresh keeps the last good view instead of blanking it.
      setState((current) => (quiet && current.kind === "ready" ? current : { kind: "error", message: error instanceof Error ? error.message : "自動運用の状況を取得できませんでした。" }));
    }
  }, []);

  useEffect(() => {
    void load();
    const refresh = () => { if (document.visibilityState === "visible") void load(true); };
    const timer = window.setInterval(refresh, 60_000);
    document.addEventListener("visibilitychange", refresh);
    return () => { window.clearInterval(timer); document.removeEventListener("visibilitychange", refresh); };
  }, [load]);

  return (
    <section className="autopilot" aria-labelledby="autopilot-title" aria-busy={state.kind === "loading"}>
      <div className="autopilot-head">
        <div>
          <p className="eyebrow"><span className="studio-live-dot" aria-hidden="true" /> AUTOPILOT · OPERATOR LOOP</p>
          <h2 id="autopilot-title">AIが集客を回し続ける。あなたは結果と判断だけを見る。</h2>
        </div>
        {state.kind === "ready" && <button type="button" className="autopilot-refresh" onClick={() => void load()}>更新</button>}
      </div>
      <div aria-live="polite">
        <AutopilotView state={state} onRetry={() => void load()} />
      </div>
    </section>
  );
}
