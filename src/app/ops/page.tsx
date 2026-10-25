"use client";

import { FormEvent, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import GoogleSignIn from "@/components/GoogleSignIn";
import "./ops.css";

type Tab = "dashboard" | "assets" | "compose" | "calendar" | "queue" | "accounts" | "analytics" | "system";

type Overview = {
  migrationRequired?: boolean;
  dashboard?: { total: number; published: number; failed: number; scheduled: number; successRate: number | null };
  tiktok?: { connected: boolean; needsReauth: boolean; reason: string | null; displayName: string | null; scopes?: string[]; hasVideoList?: boolean; accessTokenExpiresAt: string | null; refreshTokenExpiresAt: string | null };
  consent?: { consented: boolean; consentedAt: string | null };
  rule?: { timezone: string; maxPerDay: number; weekdays: number[]; windowStart: string; windowEnd: string; paused: boolean };
  scheduler?: { lastStartedAt: string | null; lastFinishedAt: string | null; nextEstimate: string | null; note?: string; error?: string | null; claimed?: number; published?: number; failed?: number; schedule?: string };
  networks?: Array<{ network: string; label: string; executable: boolean; reason: string | null }>;
  limitations?: string[];
};

type Asset = { id: string; kind: string; title: string; body?: string; upload_status: string; previewUrl?: string | null; mime_type?: string | null };
type Job = {
  id: string;
  asset_id: string;
  network: string;
  caption: string;
  status: string;
  mode: string;
  scheduled_at: string;
  timezone: string;
  last_error?: string | null;
  post_url?: string | null;
  external_post_id?: string | null;
  publish_accepted_at?: string | null;
  metadata?: { retry_safety?: string | null };
};
type AnalyticsPost = {
  id: string;
  caption: string;
  status: string;
  postUrl?: string | null;
  externalPostId?: string | null;
  views: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  metricsStatus: string;
  metricsError?: string | null;
  lastError?: string | null;
};

const TABS: Array<{ id: Tab; label: string }> = [
  { id: "dashboard", label: "ダッシュボード" },
  { id: "assets", label: "素材" },
  { id: "compose", label: "投稿作成" },
  { id: "calendar", label: "予約" },
  { id: "queue", label: "キュー" },
  { id: "accounts", label: "アカウント" },
  { id: "analytics", label: "分析" },
  { id: "system", label: "システム" },
];

const WEEK = ["日", "月", "火", "水", "木", "金", "土"];

function subscribeToSearch(callback: () => void) {
  window.addEventListener("popstate", callback);
  return () => window.removeEventListener("popstate", callback);
}

function tiktokQuery() {
  return new URLSearchParams(window.location.search).get("tiktok") || "";
}

async function accessToken() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!supabaseUrl || !anonKey) throw new Error("Supabase設定がありません。");
  const { createClient } = await import("@supabase/supabase-js");
  const supabase = createClient(supabaseUrl, anonKey);
  const { data } = await supabase.auth.getSession();
  if (!data.session) throw new Error("先にGoogleでログインしてください。");
  return { token: data.session.access_token, supabase };
}

export default function OpsPage() {
  const [tab, setTab] = useState<Tab>("dashboard");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [overview, setOverview] = useState<Overview | null>(null);
  const [assets, setAssets] = useState<Asset[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [analytics, setAnalytics] = useState<{ posts: AnalyticsPost[]; suggestions: string[]; metricsScope?: string } | null>(null);
  const [textTitle, setTextTitle] = useState("");
  const [textBody, setTextBody] = useState("");
  const [assetId, setAssetId] = useState("");
  const [caption, setCaption] = useState("");
  const [hashtags, setHashtags] = useState("");
  const [mode, setMode] = useState("immediate");
  const [when, setWhen] = useState("");
  const [purpose, setPurpose] = useState("product");
  const [privacy, setPrivacy] = useState("SELF_ONLY");
  const [allowDuplicate, setAllowDuplicate] = useState(false);
  const [busy, setBusy] = useState(false);
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID());
  const [selectedDay, setSelectedDay] = useState("");
  const tiktok = useSyncExternalStore(subscribeToSearch, tiktokQuery, () => "");

  async function load() {
    const { token } = await accessToken();
    const headers = { Authorization: "Bearer " + token };
    const [overviewRes, assetRes, jobRes, analyticsRes] = await Promise.all([
      fetch("/api/ops/overview", { headers, cache: "no-store" }),
      fetch("/api/ops/assets", { headers, cache: "no-store" }),
      fetch("/api/ops/jobs", { headers, cache: "no-store" }),
      fetch("/api/ops/analytics", { headers, cache: "no-store" }),
    ]);
    const overviewBody = await overviewRes.json();
    const assetBody = await assetRes.json();
    const jobBody = await jobRes.json();
    const analyticsBody = await analyticsRes.json();
    if (!overviewRes.ok) throw new Error(overviewBody.error || "運用状況を取得できませんでした。");
    setOverview(overviewBody);
    setAssets(assetBody.assets || []);
    setJobs(jobBody.jobs || []);
    setAnalytics(analyticsBody.posts ? analyticsBody : { posts: [], suggestions: [] });
  }

  useEffect(() => {
    // Session-backed queue data is read after mount.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load().catch((err) => setError(err instanceof Error ? err.message : "読み込みに失敗しました。"));
  }, []);

  async function saveText(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const { token } = await accessToken();
      const response = await fetch("/api/ops/assets", {
        method: "POST",
        headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
        body: JSON.stringify({ title: textTitle, body: textBody }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "保存に失敗しました。");
      setTextTitle("");
      setTextBody("");
      setNotice("投稿文を保存しました。TikTokへ本文だけでは投稿できません。");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "保存に失敗しました。");
    } finally {
      setBusy(false);
    }
  }

  async function uploadFile(file: File) {
    setBusy(true);
    setError("");
    try {
      const kind = file.type.startsWith("image/") ? "image" : "video";
      const { token, supabase } = await accessToken();
      const signed = await fetch("/api/ops/assets/upload", {
        method: "POST",
        headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
        body: JSON.stringify({ action: "sign", kind, mimeType: file.type, byteSize: file.size, title: file.name, aiGenerated: false }),
      });
      const signedBody = await signed.json();
      if (!signed.ok) throw new Error(signedBody.error || "アップロード準備に失敗しました。");
      const uploaded = await supabase.storage.from(signedBody.bucket).uploadToSignedUrl(signedBody.path, signedBody.token, file);
      if (uploaded.error) throw new Error(uploaded.error.message);
      const completed = await fetch("/api/ops/assets/upload", {
        method: "POST",
        headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
        body: JSON.stringify({ action: "complete", assetId: signedBody.assetId }),
      });
      const completedBody = await completed.json();
      if (!completed.ok) throw new Error(completedBody.error || "アップロードの確定に失敗しました。");
      setNotice("素材を登録しました。");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "アップロードに失敗しました。");
    } finally {
      setBusy(false);
    }
  }

  async function suggest() {
    const asset = assets.find((item) => item.id === assetId);
    setBusy(true);
    setError("");
    try {
      const { token } = await accessToken();
      const response = await fetch("/api/ops/captions", {
        method: "POST",
        headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
        body: JSON.stringify({ body: asset?.body || asset?.title || caption, purpose, network: "tiktok", kind: asset?.kind || "video" }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "文案を作成できませんでした。");
      const first = body.suggestions?.[0];
      if (first) {
        setCaption(first.caption || "");
        setHashtags((first.hashtags || []).join(" "));
      }
      setNotice(body.reason || (body.source === "openai" ? "AI案を反映しました。まだ投稿は実行していません。" : "定型案を反映しました。まだ投稿は実行していません。"));
    } catch (err) {
      setError(err instanceof Error ? err.message : "文案作成に失敗しました。");
    } finally {
      setBusy(false);
    }
  }

  async function createJob(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const { token } = await accessToken();
      const response = await fetch("/api/ops/jobs", {
        method: "POST",
        headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
        body: JSON.stringify({
          assetId,
          network: "tiktok",
          caption,
          hashtags: hashtags.split(/[\s,]+/).filter(Boolean),
          mode,
          scheduledLocal: when || undefined,
          timezone: overview?.rule?.timezone || "Asia/Tokyo",
          purpose,
          privacyLevel: privacy,
          idempotencyKey,
          allowDuplicate,
        }),
      });
      const body = await response.json();
      if (response.status === 409 && body.code === "DUPLICATE") {
        setAllowDuplicate(true);
        throw new Error(body.error);
      }
      if (!response.ok) throw new Error(body.error || "投稿を登録できませんでした。");
      setIdempotencyKey(crypto.randomUUID());
      setAllowDuplicate(false);
      setNotice(body.job?.post_url ? "投稿しました。" : `キューに登録しました。状態: ${body.job?.status || "queued"}`);
      await load();
      setTab("queue");
    } catch (err) {
      setError(err instanceof Error ? err.message : "投稿登録に失敗しました。");
    } finally {
      setBusy(false);
    }
  }

  async function act(id: string, action: string, confirmDuplicateRisk = false) {
    setBusy(true);
    setError("");
    try {
      const { token } = await accessToken();
      const response = await fetch("/api/ops/jobs/" + id, {
        method: "POST",
        headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
        body: JSON.stringify({ action, confirmDuplicateRisk }),
      });
      const body = await response.json();
      if (response.status === 409 && body.code === "CONFIRM_DUPLICATE_RISK") {
        if (!window.confirm(body.error)) return;
        const retry = await fetch("/api/ops/jobs/" + id, {
          method: "POST",
          headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
          body: JSON.stringify({ action, confirmDuplicateRisk: true }),
        });
        const retryBody = await retry.json();
        if (!retry.ok) throw new Error(retryBody.error || "操作に失敗しました。");
        setNotice("投稿状態を更新しました。");
        await load();
        return;
      }
      if (!response.ok) throw new Error(body.error || "操作に失敗しました。");
      setNotice("投稿状態を更新しました。");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "操作に失敗しました。");
    } finally {
      setBusy(false);
    }
  }

  async function connectTikTok() {
    setBusy(true);
    setError("");
    try {
      const { token } = await accessToken();
      const response = await fetch("/api/tiktok/connect?format=json&next=/ops", { headers: { Authorization: "Bearer " + token } });
      const body = await response.json();
      if (!response.ok || !body.url) throw new Error(body.error || "接続を開始できませんでした。");
      window.location.href = body.url;
    } catch (err) {
      setError(err instanceof Error ? err.message : "接続に失敗しました。");
      setBusy(false);
    }
  }

  async function disconnectTikTok() {
    if (!window.confirm("TikTok接続を解除します。")) return;
    setBusy(true);
    try {
      const { token } = await accessToken();
      const response = await fetch("/api/tiktok/connect", { method: "DELETE", headers: { Authorization: "Bearer " + token } });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "解除に失敗しました。");
      setNotice("TikTok接続を解除しました。");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "解除に失敗しました。");
    } finally {
      setBusy(false);
    }
  }

  async function saveRule(event: FormEvent) {
    event.preventDefault();
    if (!overview?.rule) return;
    setBusy(true);
    setError("");
    try {
      const { token } = await accessToken();
      const response = await fetch("/api/ops/rules", {
        method: "PUT",
        headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
        body: JSON.stringify(overview.rule),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "ルールを保存できませんでした。");
      setNotice("投稿ルールを保存しました。既存の予約時刻は自動では変更しません。");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "ルール保存に失敗しました。");
    } finally {
      setBusy(false);
    }
  }

  async function refreshMetrics() {
    setBusy(true);
    setError("");
    try {
      const { token } = await accessToken();
      const response = await fetch("/api/ops/analytics?refresh=1", { headers: { Authorization: "Bearer " + token }, cache: "no-store" });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "実績を取得できませんでした。");
      setAnalytics(body);
      setNotice("取得できた実績だけを更新しました。");
    } catch (err) {
      setError(err instanceof Error ? err.message : "実績取得に失敗しました。");
    } finally {
      setBusy(false);
    }
  }

  const dashboard = overview?.dashboard;
  const days = useMemo(() => {
    const cursor = new Date();
    const start = new Date(cursor.getFullYear(), cursor.getMonth(), 1);
    const cells: Array<{ key: string; label: string; count: number }> = [];
    for (let i = 0; i < start.getDay(); i++) cells.push({ key: "pad-" + i, label: "", count: 0 });
    const last = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0).getDate();
    for (let day = 1; day <= last; day++) {
      const key = `${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
      const count = jobs.filter((job) => new Date(job.scheduled_at).toLocaleDateString("sv-SE", { timeZone: overview?.rule?.timezone || "Asia/Tokyo" }) === key).length;
      cells.push({ key, label: String(day), count });
    }
    return cells;
  }, [jobs, overview?.rule?.timezone]);

  return (
    <main id="main-content" className="shell">
      <header className="topbar">
        <div>
          <strong>SNS自動投稿</strong>
          <span>登録済み素材を、接続したアカウントへ送る</span>
        </div>
        <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
          <Link href="/" className="billing-link">ホーム</Link>
          <GoogleSignIn />
        </div>
      </header>
      {overview?.migrationRequired && <p className="ops-warning">投稿キューのマイグレーションが未適用です。supabase/migrations/20261024120000_sns_post_queue.sql を適用するまで予約は保存できません。</p>}
      {notice && <p className="success" role="status">{notice}</p>}
      {tiktok === "connected" && <p className="success" role="status">TikTokアカウントを接続しました。</p>}
      {(error || tiktok === "error") && <p className="error" role="alert">{error || "TikTok接続に失敗しました。"}</p>}
      <div className="ops-tabs" role="tablist">
        {TABS.map((item) => (
          <button key={item.id} type="button" role="tab" aria-selected={tab === item.id} onClick={() => setTab(item.id)}>{item.label}</button>
        ))}
      </div>

      {tab === "dashboard" && (
        <section className="panel">
          <p className="eyebrow">ダッシュボード</p>
          <div className="ops-grid">
            <div className="ops-stat"><b>投稿数</b><strong>{dashboard?.total ?? "—"}</strong></div>
            <div className="ops-stat"><b>成功率</b><strong>{dashboard?.successRate == null ? "—" : dashboard.successRate + "%"}</strong></div>
            <div className="ops-stat"><b>予約・待機</b><strong>{dashboard?.scheduled ?? "—"}</strong></div>
            <div className="ops-stat"><b>失敗・再認証</b><strong>{dashboard?.failed ?? "—"}</strong></div>
          </div>
          <p className="muted">成功率は公開完了と失敗だけを母数にします。待機中は含めません。TikTok: {overview?.tiktok?.connected ? (overview.tiktok.displayName || "接続済み") : "未接続"}{overview?.tiktok?.needsReauth ? " / 要再認証" : ""}</p>
        </section>
      )}

      {tab === "assets" && (
        <section className="panel">
          <p className="eyebrow">素材管理</p>
          <form className="ops-form" onSubmit={saveText}>
            <label>タイトル<input value={textTitle} onChange={(event) => setTextTitle(event.target.value)} /></label>
            <label>投稿文<textarea value={textBody} onChange={(event) => setTextBody(event.target.value)} required /></label>
            <button type="submit" disabled={busy}>投稿文を保存</button>
          </form>
          <label className="ops-form">動画・画像（MP4 / MOV / WebM は100MBまで、画像は8MBまで）
            <input type="file" accept="video/mp4,video/quicktime,video/webm,image/jpeg,image/png,image/webp" onChange={(event) => { const file = event.target.files?.[0]; if (file) void uploadFile(file); }} />
          </label>
          <div className="ops-list">
            {assets.length === 0 && <p className="muted">登録された素材はありません。</p>}
            {assets.map((asset) => (
              <article key={asset.id} className="ops-row">
                <strong>{asset.title}</strong>
                <small>{asset.kind} / {asset.upload_status}</small>
                {asset.body && <p>{asset.body}</p>}
                {asset.previewUrl && asset.kind === "video" && <video src={asset.previewUrl} controls />}
                {asset.previewUrl && asset.kind === "image" && <a href={asset.previewUrl}>画像を開く</a>}
              </article>
            ))}
          </div>
        </section>
      )}

      {tab === "compose" && (
        <section className="panel">
          <p className="eyebrow">投稿作成</p>
          <form className="ops-form" onSubmit={createJob}>
            <label>素材（動画・画像。本文だけの素材はTikTok公式APIでは投稿できません）
              <select value={assetId} onChange={(event) => setAssetId(event.target.value)} required>
                <option value="">選択</option>
                {assets.filter((asset) => asset.upload_status === "ready" && asset.kind !== "text").map((asset) => (
                  <option key={asset.id} value={asset.id}>{asset.kind}: {asset.title}</option>
                ))}
              </select>
            </label>
            <label>目的
              <select value={purpose} onChange={(event) => setPurpose(event.target.value)}>
                <option value="product">商品紹介</option>
                <option value="awareness">ブランド認知</option>
                <option value="traffic">集客</option>
              </select>
            </label>
            <label>投稿文<textarea value={caption} onChange={(event) => setCaption(event.target.value)} required /></label>
            <label>ハッシュタグ（空白区切り）<input value={hashtags} onChange={(event) => setHashtags(event.target.value)} /></label>
            <button type="button" onClick={() => void suggest()} disabled={busy}>文案を提案（投稿はしない）</button>
            <label>公開範囲
              <select value={privacy} onChange={(event) => setPrivacy(event.target.value)}>
                <option value="SELF_ONLY">自分のみ（未審査アプリで使える範囲）</option>
                <option value="MUTUAL_FOLLOW_FRIENDS">相互フォロー</option>
                <option value="FOLLOWER_OF_CREATOR">フォロワー</option>
                <option value="PUBLIC_TO_EVERYONE">全員（審査済みアプリのみ）</option>
              </select>
            </label>
            <label>実行
              <select value={mode} onChange={(event) => setMode(event.target.value)}>
                <option value="immediate">即時投稿</option>
                <option value="scheduled">予約投稿</option>
                <option value="approval">承認後に投稿</option>
                <option value="autopilot">ルール内で自動投稿</option>
              </select>
            </label>
            <label>日時（予約・承認で使用。タイムゾーンは投稿ルールに従う）
              <input type="datetime-local" value={when} onChange={(event) => setWhen(event.target.value)} />
            </label>
            <button type="submit" disabled={busy}>キューに登録</button>
          </form>
        </section>
      )}

      {tab === "calendar" && (
        <section className="panel">
          <p className="eyebrow">予約カレンダー</p>
          <div className="ops-calendar">
            {WEEK.map((label) => <strong key={label}>{label}</strong>)}
            {days.map((day) => (
              <button key={day.key} type="button" className={day.label ? "" : "muted"} onClick={() => day.label && setSelectedDay(day.key)}>
                {day.label}{day.count ? ` / ${day.count}` : ""}
              </button>
            ))}
          </div>
          <div className="ops-list">
            {jobs.filter((job) => !selectedDay || new Date(job.scheduled_at).toLocaleDateString("sv-SE", { timeZone: overview?.rule?.timezone || "Asia/Tokyo" }) === selectedDay).map((job) => (
              <article key={job.id} className="ops-row">
                <strong>{new Date(job.scheduled_at).toLocaleString("ja-JP", { timeZone: job.timezone || "Asia/Tokyo" })}</strong>
                <small>{job.status} / {job.mode}</small>
                <p>{job.caption}</p>
              </article>
            ))}
          </div>
        </section>
      )}

      {tab === "queue" && (
        <section className="panel">
          <p className="eyebrow">投稿キュー</p>
          <div className="ops-list">
            {jobs.length === 0 && <p className="muted">キューは空です。</p>}
            {jobs.map((job) => (
              <article key={job.id} className="ops-row">
                <strong>{job.status}</strong>
                <small>{job.network} / {job.mode} / {new Date(job.scheduled_at).toLocaleString("ja-JP", { timeZone: job.timezone || "Asia/Tokyo" })}</small>
                <p>{job.caption}</p>
                {job.last_error && <p className="error">{job.last_error}</p>}
                {job.external_post_id && <small>投稿ID: {job.external_post_id}</small>}
                {job.post_url && <a href={job.post_url}>投稿を開く</a>}
                <div>
                  {["queued", "awaiting_approval"].includes(job.status) && <button type="button" onClick={() => void act(job.id, "pause")}>一時停止</button>}
                  {job.status === "paused" && <button type="button" onClick={() => void act(job.id, "resume")}>再開</button>}
                  {job.status === "awaiting_approval" && <button type="button" onClick={() => void act(job.id, "approve")}>承認して投稿待ちにする</button>}
                  {!["processing", "pending", "published", "cancelled"].includes(job.status) && <button type="button" onClick={() => void act(job.id, "cancel")}>キャンセル</button>}
                  {["failed", "needs_reauth"].includes(job.status) && !job.publish_accepted_at && <button type="button" onClick={() => void act(job.id, "retry")}>再試行</button>}
                </div>
              </article>
            ))}
          </div>
        </section>
      )}

      {tab === "accounts" && (
        <section className="panel">
          <p className="eyebrow">SNSアカウント</p>
          <div className="ops-row">
            <strong>TikTok {overview?.tiktok?.connected ? "接続済み" : "未接続"}</strong>
            <small>{overview?.tiktok?.displayName || "表示名なし"}</small>
            <small>権限: {(overview?.tiktok?.scopes || []).join(", ") || "なし"}</small>
            <small>アクセストークン期限: {overview?.tiktok?.accessTokenExpiresAt || "不明"}</small>
            <small>リフレッシュ期限: {overview?.tiktok?.refreshTokenExpiresAt || "不明"}</small>
            <small>公開同意: {overview?.consent?.consented ? overview.consent.consentedAt : "未同意"}</small>
            {overview?.tiktok?.reason && <p className="error">{overview.tiktok.reason}</p>}
            <div>
              <button type="button" onClick={() => void connectTikTok()} disabled={busy}>TikTokを接続</button>
              <button type="button" onClick={() => void disconnectTikTok()} disabled={busy}>切断</button>
              <button type="button" onClick={async () => {
                const { token } = await accessToken();
                await fetch("/api/social/tiktok-consent", { method: "POST", headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" }, body: JSON.stringify({ consented: true }) });
                setNotice("TikTok自動投稿への同意を記録しました。");
                await load();
              }}>公開に同意する</button>
            </div>
          </div>
          <form className="ops-form" onSubmit={saveRule}>
            <p className="eyebrow">TikTokの配信ルール</p>
            <label>1日の上限<input type="number" min={1} max={50} value={overview?.rule?.maxPerDay ?? 10} onChange={(event) => setOverview((current) => current?.rule ? { ...current, rule: { ...current.rule, maxPerDay: Number(event.target.value) } } : current)} /></label>
            <label>開始<input value={overview?.rule?.windowStart ?? "00:00"} onChange={(event) => setOverview((current) => current?.rule ? { ...current, rule: { ...current.rule, windowStart: event.target.value } } : current)} /></label>
            <label>終了<input value={overview?.rule?.windowEnd ?? "23:59"} onChange={(event) => setOverview((current) => current?.rule ? { ...current, rule: { ...current.rule, windowEnd: event.target.value } } : current)} /></label>
            <label>タイムゾーン<input value={overview?.rule?.timezone ?? "Asia/Tokyo"} onChange={(event) => setOverview((current) => current?.rule ? { ...current, rule: { ...current.rule, timezone: event.target.value } } : current)} /></label>
            <label><input type="checkbox" checked={overview?.rule?.paused === true} onChange={(event) => setOverview((current) => current?.rule ? { ...current, rule: { ...current.rule, paused: event.target.checked } } : current)} /> 自動送信を止める</label>
            <div>
              {WEEK.map((label, index) => (
                <label key={label}><input type="checkbox" checked={overview?.rule?.weekdays.includes(index) === true} onChange={(event) => setOverview((current) => {
                  if (!current?.rule) return current;
                  const weekdays = event.target.checked ? [...current.rule.weekdays, index] : current.rule.weekdays.filter((day) => day !== index);
                  return { ...current, rule: { ...current.rule, weekdays } };
                })} />{label}</label>
              ))}
            </div>
            <button type="submit" disabled={busy}>ルールを保存</button>
          </form>
          <div className="ops-list">
            {(overview?.networks || []).map((network) => (
              <article key={network.network} className="ops-row">
                <strong>{network.label}</strong>
                <small>{network.executable ? "投稿キューで実行できます" : "未接続"}</small>
                {network.reason && <p>{network.reason}</p>}
              </article>
            ))}
          </div>
        </section>
      )}

      {tab === "analytics" && (
        <section className="panel">
          <p className="eyebrow">投稿分析</p>
          <button type="button" onClick={() => void refreshMetrics()} disabled={busy}>取得できる実績を更新</button>
          <p className="muted">指標スコープ: {analytics?.metricsScope === "video.list" ? "video.list あり" : "video.list なし。数値は推測しません。"}</p>
          {(analytics?.suggestions || []).map((item) => <p key={item}>{item}</p>)}
          <div className="ops-list">
            {(analytics?.posts || []).map((post) => (
              <article key={post.id} className="ops-row">
                <strong>{post.status}</strong>
                <p>{post.caption}</p>
                <small>再生 {post.views ?? "未取得"} / いいね {post.likes ?? "未取得"} / コメント {post.comments ?? "未取得"} / シェア {post.shares ?? "未取得"}</small>
                <small>{post.metricsStatus}{post.metricsError ? `: ${post.metricsError}` : ""}</small>
                {post.externalPostId && <small>投稿ID: {post.externalPostId}</small>}
                {post.postUrl && <a href={post.postUrl}>投稿を開く</a>}
                {post.lastError && <p className="error">{post.lastError}</p>}
              </article>
            ))}
          </div>
        </section>
      )}

      {tab === "system" && (
        <section className="panel">
          <p className="eyebrow">システム状態</p>
          <div className="ops-row">
            <strong>投稿ワーカー</strong>
            <small>スケジュール: {overview?.scheduler?.schedule || "*/5 * * * *"}</small>
            <small>最終開始: {overview?.scheduler?.lastStartedAt || "記録なし"}</small>
            <small>最終完了: {overview?.scheduler?.lastFinishedAt || "記録なし"}</small>
            <small>次回の目安: {overview?.scheduler?.nextEstimate || "未稼働"}</small>
            <p>{overview?.scheduler?.note}</p>
            {overview?.scheduler?.error && <p className="error">{overview.scheduler.error}</p>}
          </div>
          <div className="ops-list">
            {(overview?.limitations || []).map((item) => <p key={item} className="ops-row">{item}</p>)}
          </div>
        </section>
      )}
    </main>
  );
}
