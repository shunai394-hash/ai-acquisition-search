// View model of the autonomous loop for the signed-in user: what the operator
// decided, why, on how many signals, what it does next, and what needs a human.
// Pure: the API route feeds it rows, the UI renders it, tests pin its meaning.

type Row = Record<string, unknown>;
const record = (value: unknown): Row => (value && typeof value === "object" && !Array.isArray(value) ? value as Row : {});
const text = (value: unknown) => (typeof value === "string" ? value : "");

export type Tone = "ok" | "busy" | "warn" | "error";
export type Verdict = "continue" | "pivot" | "stop" | "wait";

export const VERDICT_COPY: Record<Verdict, { label: string; meaning: string; next: string }> = {
  continue: { label: "CONTINUE", meaning: "勝ち筋を維持", next: "訴求はそのまま、Hookだけを変えた次の動画を作って投稿します。" },
  pivot: { label: "PIVOT", meaning: "仮説を切り替え", next: "1つの変数だけを変えた次の動画を作って投稿します。" },
  stop: { label: "STOP", meaning: "この仮説を終了", next: "この系統では新しい動画を作りません。予算を守るための停止です。" },
  wait: { label: "WAIT", meaning: "データ不足", next: "判断できる量の実績が集まるまで、次回の巡回で再判定します。" },
};

const SOURCE_LABEL: Record<string, string> = {
  post_metrics: "SNS実績",
  history: "過去テスト",
  ec_pulse: "市場の声",
  product: "商品データ",
  customer: "顧客像",
  hypothesis: "仮説",
};

export type ActivityDecision = {
  runId: string;
  verdict: Verdict;
  label: string;
  meaning: string;
  reason: string;
  nextAction: string;
  next: string;
  signals: number;
  signalSources: string[];
  confidence: number;
  source: "ai" | "deterministic";
  llmFallback: boolean;
  decidedAt: string;
};

export type PipelineItem = { id: string; title: string; status: string; tone: Tone; detail: string; imageReference: boolean; at: string };
export type AttentionItem = { id: string; title: string; detail: string; action: string };

export type ActivityView = {
  totals: { testing: number; superseded: number; stopped: number; stalled: number; videosInFlight: number; published: number; attention: number };
  latestDecision: ActivityDecision | null;
  pipeline: PipelineItem[];
  attention: AttentionItem[];
  patrol: { severity: string; summary: string; checkedAt: string } | null;
};

export function describeDecision(run: Row | null | undefined): ActivityDecision | null {
  const output = record(run?.output);
  const decision = record(output.decision);
  const verdict = text(decision.verdict || output.verdict) as Verdict;
  if (!VERDICT_COPY[verdict]) return null;
  const evidence = Array.isArray(decision.evidence) ? decision.evidence.map(record) : [];
  // Signals actually observed (a value present), not every slot the engine considered.
  const observed = evidence.filter((item) => item.value !== null && item.value !== undefined && item.value !== "unavailable");
  const sources = [...new Set(observed.map((item) => SOURCE_LABEL[text(item.source)] ?? text(item.source)).filter(Boolean))];
  const confidence = Number(decision.confidence);
  const copy = VERDICT_COPY[verdict];
  return {
    runId: text(run?.id),
    verdict,
    label: copy.label,
    meaning: copy.meaning,
    reason: text(decision.reason || output.reason),
    nextAction: text(record(decision.next_action).description || output.nextAction),
    next: copy.next,
    signals: observed.length,
    signalSources: sources,
    confidence: Number.isFinite(confidence) ? Math.round(Math.min(1, Math.max(0, confidence)) * 100) : 0,
    source: text(decision.model_version) && text(decision.model_version) !== "deterministic" ? "ai" : "deterministic",
    llmFallback: text(record(output.llm).status) === "failed",
    decidedAt: text(run?.completed_at),
  };
}

const ATTENTION_COPY: Record<string, { title: string; detail: string; action: string }> = {
  manual_recovery_required: {
    title: "結果が未確定のため自動実行を停止",
    detail: "外部サービス側では処理が完了している可能性があります。二重投稿・二重生成を避けるため、AIは自動で再実行しません。",
    action: "SNS / Higgsfield 側の状態を確認してください。",
  },
  retries_exhausted: {
    title: "動画生成が再試行上限に到達",
    detail: "生成に繰り返し失敗したため、このジョブの自動再試行を止めました。",
    action: "プロンプトや参照画像を見直して再生成してください。",
  },
  non_retryable: {
    title: "動画がモデレーションで拒否",
    detail: "同じ内容では再度拒否されるため、自動再試行していません。",
    action: "表現や画像を変更して再生成してください。",
  },
  publish_exhausted: {
    title: "SNS投稿に繰り返し失敗",
    detail: "投稿前の段階で失敗が続いたため、自動投稿を止めました（投稿はされていません）。",
    action: "SNS連携・アクセストークン・投稿同意を確認してください。",
  },
};

export function describeJob(job: Row): { item: PipelineItem; attention: AttentionItem | null } {
  const pr = record(job.provider_response);
  const id = text(job.id);
  const at = text(job.updated_at || job.created_at);
  const imageReference = Boolean(text(pr.input_image_url));
  const settled = text(pr.loop_settled_reason);
  const retries = Number(pr.retry_count || 0);
  const base = { id, title: imageReference ? "商品画像から動画生成" : "テキストから動画生成", imageReference, at };
  const attentionFor = (reason: string) => (ATTENTION_COPY[reason] ? { id, ...ATTENTION_COPY[reason] } : null);

  if (settled === "published") return { item: { ...base, status: "投稿済み", tone: "ok", detail: "SNSへ公開しました。次回の巡回で実績を取得します。" }, attention: null };
  if (settled === "no_social_post") return { item: { ...base, status: "完成", tone: "ok", detail: "スタジオで生成した動画です。" }, attention: null };
  if (settled && ATTENTION_COPY[settled]) {
    return { item: { ...base, status: "要確認", tone: "error", detail: ATTENTION_COPY[settled].title }, attention: attentionFor(settled) };
  }
  if (pr.manual_recovery_required === true) {
    return { item: { ...base, status: "要確認", tone: "error", detail: ATTENTION_COPY.manual_recovery_required.title }, attention: attentionFor("manual_recovery_required") };
  }
  switch (text(job.status)) {
    case "queued":
      return { item: { ...base, status: "待機中", tone: "busy", detail: "次回の巡回で生成を開始します。" }, attention: null };
    case "running":
      return { item: { ...base, status: "生成中", tone: "busy", detail: retries > 1 ? `再試行 ${retries - 1} 回目を生成しています。` : "動画を生成しています。完成後に自動で投稿します。" }, attention: null };
    case "completed":
      return Number(pr.publish_attempts || 0) > 0
        ? { item: { ...base, status: "投稿を再試行予定", tone: "warn", detail: text(pr.publish_last_error) || "前回の投稿に失敗しました。次回の巡回で再試行します。" }, attention: null }
        : { item: { ...base, status: "投稿待ち", tone: "busy", detail: "完成。次回の巡回でSNSへ投稿します。" }, attention: null };
    case "failed":
      return { item: { ...base, status: "再試行予定", tone: "warn", detail: pr.timed_out_request_id ? "生成が時間内に終わらなかったため、次回の巡回で作り直します。" : "生成に失敗しました。次回の巡回で同じ素材から再試行します。" }, attention: null };
    default:
      return { item: { ...base, status: text(job.status) || "不明", tone: "warn", detail: "" }, attention: null };
  }
}

const STUCK_PUBLISH_MS = 30 * 60_000;

export function buildActivity(input: { posts: Row[]; decision: Row | null; jobs: Row[]; patrol: Row | null; now?: number }): ActivityView {
  const now = input.now ?? Date.now();
  const totals = { testing: 0, superseded: 0, stopped: 0, stalled: 0, videosInFlight: 0, published: 0, attention: 0 };
  const attention: AttentionItem[] = [];

  for (const post of input.posts) {
    const meta = record(post.metadata);
    const status = text(post.status);
    if (status === "published" && post.external_post_id) {
      totals.published++;
      const patrol = text(meta.operator_patrol_status);
      if (patrol === "superseded") totals.superseded++;
      else if (patrol === "stopped") totals.stopped++;
      else if (patrol === "stalled") {
        totals.stalled++;
        attention.push({ id: text(post.id), title: `${text(post.network).toUpperCase()}の実績を取得できません`, detail: "実績の取得に繰り返し失敗したため、この投稿の巡回を止めました（投稿が削除された可能性があります）。", action: "SNS上で投稿が残っているか確認してください。" });
      } else totals.testing++;
    }
    const updated = Date.parse(text(post.updated_at || post.created_at));
    if (status === "publishing" && Number.isFinite(updated) && now - updated > STUCK_PUBLISH_MS) {
      attention.push({ id: text(post.id), title: `${text(post.network).toUpperCase()}への投稿結果が未確定`, detail: "投稿処理が途中で止まりました。二重投稿を避けるため、AIは自動で再投稿しません。", action: "SNS上に投稿があるか確認し、あれば投稿IDで復旧してください。" });
    }
  }

  const pipeline: PipelineItem[] = [];
  for (const job of input.jobs) {
    const { item, attention: jobAttention } = describeJob(job);
    pipeline.push(item);
    if (item.tone === "busy") totals.videosInFlight++;
    if (jobAttention) attention.push(jobAttention);
  }
  totals.attention = attention.length;

  const patrolOutput = record(input.patrol?.output);
  return {
    totals,
    latestDecision: describeDecision(input.decision),
    pipeline,
    attention,
    patrol: input.patrol ? { severity: text(patrolOutput.severity) || "healthy", summary: text(patrolOutput.summary), checkedAt: text(patrolOutput.checkedAt || input.patrol.completed_at) } : null,
  };
}
