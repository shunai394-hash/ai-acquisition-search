"use client";

import { FormEvent, useState } from "react";
import GoogleSignIn from "@/components/GoogleSignIn";
import BillingButton from "@/components/BillingButton";
import Link from "next/link";
import type { AcquisitionAnalyzeResult, EcPulseResearchBundle, EcPulseResearchRun } from "@/lib/acquisition/types";

function List({ items }: { items: string[] }) {
  return (
    <ul className="list">
      {items.filter(Boolean).map((item, index) => (
        <li key={index}>{item}</li>
      ))}
    </ul>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="panel">
      <p className="eyebrow">{title}</p>
      {children}
    </section>
  );
}

export default function Home() {
  const [url, setUrl] = useState("");
  const [result, setResult] = useState<AcquisitionAnalyzeResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [ecPulse, setEcPulse] = useState<EcPulseResearchBundle | null>(null);
  const [ecPulseLoading, setEcPulseLoading] = useState(false);
  const [testSaving, setTestSaving] = useState(false);
  const [testSaved, setTestSaved] = useState("");
  const [metricsOpen, setMetricsOpen] = useState(false);
  const [metrics, setMetrics] = useState({ impressions:"", views:"", clicks:"", conversions:"", revenue:"", grossProfit:"", adSpend:"" });
  const [verdict, setVerdict] = useState<{verdict:string;reason:string}|null>(null);
  const [socialPostId, setSocialPostId] = useState("");
  const [researchHistory, setResearchHistory] = useState<EcPulseResearchRun[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [videoPrompt, setVideoPrompt] = useState("");
  const [videoGenerating, setVideoGenerating] = useState(false);
  const [videoJobId, setVideoJobId] = useState("");
  const [videoStatus, setVideoStatus] = useState("");
  const [videoUrl, setVideoUrl] = useState("");
  const [videoError, setVideoError] = useState("");
  const [videoEngine, setVideoEngine] = useState("");
  const [studioPrompt, setStudioPrompt] = useState("");
  const [studioImage, setStudioImage] = useState<File | null>(null);
  const [studioImagePreview, setStudioImagePreview] = useState("");
  const [studioGenerating, setStudioGenerating] = useState(false);
  const [studioStatus, setStudioStatus] = useState("");
  const [studioUrl, setStudioUrl] = useState("");
  const [studioError, setStudioError] = useState("");
  const [studioDuration, setStudioDuration] = useState(5);
  const [studioAspect, setStudioAspect] = useState<"9:16" | "16:9" | "1:1">("9:16");
  async function getAccessToken() {
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const anonKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    if (!supabaseUrl || !anonKey) throw new Error("Supabase設定がありません。");
    const { createClient } = await import("@supabase/supabase-js");
    const supabase = createClient(supabaseUrl, anonKey);
    const { data } = await supabase.auth.getSession();
    if (!data.session) throw new Error("先にGoogleでログインしてください。");
    return data.session.access_token;
  }

  async function analyze(e?: FormEvent) {
    e?.preventDefault();
    setLoading(true);
    setError("");
    setResult(null);

    try {
      const token = await getAccessToken();
      const res = await fetch("/api/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ url }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "分析に失敗しました。");

      setResult(data.data);
      const decision = data.data?.analysis?.decision;
      const firstPost = data.data?.analysis?.nextPosts?.[0];
      setVideoPrompt([
        data.data?.source?.title || "商品",
        decision?.valueProposition ? "訴求: " + decision.valueProposition : "",
        firstPost?.hook ? "Hook: " + firstPost.hook : "",
        decision?.format ? "形式: " + decision.format : "9:16 short-form ad",
        "Natural UGC-style product advertising, clear first 3 seconds, factual claims only, no watermark.",
      ].filter(Boolean).join("\n"));
      setEcPulse(null);
      setEcPulseLoading(true);
      try {
        const researchToken = await getAccessToken();
        const researchRes = await fetch("/api/ec-pulse-research", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${researchToken}` },
          body: JSON.stringify({ url }),
        });
        const researchData = await researchRes.json();
        setEcPulse(researchData);
      } catch {
        setEcPulse({ connected: false, research: null, products: [], error: "EC Pulseリサーチに接続できませんでした。" });
      } finally {
        setEcPulseLoading(false);
      }

      setHistoryLoading(true);
      try {
        const historyToken = await getAccessToken();
        const historyResponse = await fetch("/api/ec-pulse-research/history?url=" + encodeURIComponent(url) + "&limit=8", {
          headers: { Authorization: `Bearer ${historyToken}` },
          cache: "no-store"
        });
        const historyData = await historyResponse.json().catch(() => ({}));
        setResearchHistory(historyData.runs || []);
      } catch {
        setResearchHistory([]);
      } finally {
        setHistoryLoading(false);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "分析に失敗しました。");
    } finally {
      setLoading(false);
    }
  }

  async function saveTestPlan() {
    if (!result) return;
    setTestSaving(true);
    setTestSaved("");
    try {
      const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
      const anonKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
      if (!supabaseUrl || !anonKey) throw new Error("Supabase設定がありません。");
      const { createClient } = await import("@supabase/supabase-js");
      const supabase = createClient(supabaseUrl, anonKey);
      const { data } = await supabase.auth.getSession();
      if (!data.session) throw new Error("先にGoogleでログインしてください。");
      const res = await fetch("/api/operator/plan", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${data.session.access_token}` },
        body: JSON.stringify({ source: result.source, analysis: result.analysis }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || "テスト計画の保存に失敗しました。");
      setSocialPostId(body.socialPostId || "");
      setTestSaved(body.message || "テスト計画を保存しました。");
    } catch (err) {
      setError(err instanceof Error ? err.message : "テスト計画の保存に失敗しました。");
    } finally {
      setTestSaving(false);
    }
  }

  async function generateStudioVideo() {
    setStudioGenerating(true); setStudioError(""); setStudioUrl(""); setStudioStatus("素材を準備中…");
    try {
      const token = await getAccessToken();
      let imageUrl = "";
      if (studioImage) {
        const form = new FormData(); form.append("file", studioImage);
        const upload = await fetch("/api/video/upload", { method: "POST", headers: { Authorization: "Bearer " + token }, body: form });
        const body = await upload.json().catch(() => ({}));
        if (!upload.ok) throw new Error(body.error || "画像のアップロードに失敗しました。");
        imageUrl = String(body.url || "");
      }
      const response = await fetch("/api/video/generate", {
        method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
        body: JSON.stringify({ prompt: studioPrompt.trim(), imageUrl: imageUrl || undefined, duration: 5, resolution: "1080p", aspectRatio: "9:16", generateAudio: false })
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || "動画生成の開始に失敗しました。");
      const jobId = String(body.jobId || ""); if (!jobId) throw new Error("動画ジョブIDを取得できませんでした。");
      const engine = String(body.engine || "Higgsfield"); setStudioStatus(engine + "で生成中…");
      for (let attempt = 0; attempt < 60; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, attempt === 0 ? 2000 : 5000));
        const poll = await fetch("/api/video/jobs/" + encodeURIComponent(jobId), { headers: { Authorization: "Bearer " + (await getAccessToken()) }, cache: "no-store" });
        const data = await poll.json().catch(() => ({}));
        if (!poll.ok) throw new Error(data.error || "動画生成状態の取得に失敗しました。");
        if (data.job?.status === "completed" && data.asset?.video_url) { setStudioUrl(data.asset.video_url); setStudioStatus("完成。"); return; }
        if (data.job?.status === "failed") throw new Error(data.job?.error || "動画生成に失敗しました。");
        setStudioStatus(engine + "で生成中… " + (attempt + 1) + "/60");
      }
      throw new Error("動画生成がタイムアウトしました。");
    } catch (err) { setStudioError(err instanceof Error ? err.message : "動画生成に失敗しました。"); setStudioStatus(""); }
    finally { setStudioGenerating(false); }
  }

  async function generateVideo() {
    setVideoGenerating(true);
    setVideoError("");
    setVideoUrl("");
    setVideoStatus("生成ジョブを開始中…");
    try {
      const token = await getAccessToken();
      const response = await fetch("/api/video/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
        body: JSON.stringify({ prompt: videoPrompt.trim(), duration: 5, resolution: "1080p", aspectRatio: "9:16", generateAudio: false }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || "動画生成の開始に失敗しました。");
      const jobId = String(body.jobId || "");
      if (!jobId) throw new Error("動画ジョブIDを取得できませんでした。");
      setVideoJobId(jobId);
      const engine = String(body.engine || "video engine");
      setVideoEngine(engine);
      setVideoStatus(`${engine}で生成中…`);
      for (let attempt = 0; attempt < 60; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, attempt === 0 ? 2000 : 5000));
        const pollToken = await getAccessToken();
        const poll = await fetch("/api/video/jobs/" + encodeURIComponent(jobId), {
          headers: { Authorization: "Bearer " + pollToken },
          cache: "no-store",
        });
        const data = await poll.json().catch(() => ({}));
        if (!poll.ok) throw new Error(data.error || "動画生成状態の取得に失敗しました。");
        if (data.job?.status === "completed" && data.asset?.video_url) {
          setVideoUrl(data.asset.video_url);
          setVideoStatus("動画が完成しました。");
          return;
        }
        if (data.job?.status === "failed") throw new Error(data.job?.error || `${engine}で動画生成に失敗しました。`);
        setVideoStatus(`${engine}で生成中… ${attempt + 1}/60`);
      }
      throw new Error("動画生成がタイムアウトしました。時間を置いてジョブを再確認してください。");
    } catch (err) {
      setVideoError(err instanceof Error ? err.message : "動画生成に失敗しました。");
      setVideoStatus("");
    } finally {
      setVideoGenerating(false);
    }
  }
  async function saveMetrics() {
    try {
      const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
      const anonKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
      if (!supabaseUrl || !anonKey) throw new Error("Supabase設定がありません。");
      const { createClient } = await import("@supabase/supabase-js");
      const supabase = createClient(supabaseUrl, anonKey);
      const { data } = await supabase.auth.getSession();
      if (!data.session) throw new Error("先にGoogleでログインしてください。");
      if (!socialPostId) throw new Error("先に「このテスト計画を保存」してください。");
      const saved = await fetch("/api/operator/metrics", { method:"POST", headers:{"Content-Type":"application/json",Authorization:`Bearer ${data.session.access_token}`}, body:JSON.stringify({...metrics, socialPostId}) });
      const body = await saved.json();
      if (!saved.ok) throw new Error(body.error || "実績保存に失敗しました。");
      const decision = await fetch("/api/operator/decision", { method:"POST", headers:{"Content-Type":"application/json",Authorization:`Bearer ${data.session.access_token}`}, body:JSON.stringify({socialPostId}) });
      const verdictBody = await decision.json();
      if (!decision.ok) throw new Error(verdictBody.error || "判定に失敗しました。");
      setVerdict({verdict:verdictBody.verdict, reason:verdictBody.reason});
    } catch(err) { setError(err instanceof Error ? err.message : "実績保存に失敗しました。"); }
  }

  return (
    <main className="shell">
      <header className="topbar">
        <div>
          <strong>AI Acquisition Search</strong>
          <span>DECISION ENGINE FOR CUSTOMER ACQUISITION</span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          {result && (
            <nav aria-label="主要メニュー" style={{ display: "flex", gap: 18, alignItems: "center" }}>
              <a href="#research" style={{ color: "#ffffff66", fontSize: 11, textDecoration: "none" }}>Research</a>
              <a href="#decision" style={{ color: "#ffffff66", fontSize: 11, textDecoration: "none" }}>Decision</a>
              <a href="#loop" style={{ color: "#ffffff66", fontSize: 11, textDecoration: "none" }}>Loop</a>
            </nav>
          )}
          <span className="status">AI AD OPERATOR · LIVE</span>
          <GoogleSignIn />
          <Link href="/billing" style={{ color: "#ffffff70", fontSize: 11 }}>契約管理</Link>
        </div>
      </header>

      <section className="hero">
        <p className="eyebrow">AI CUSTOMER ACQUISITION · DECISION ENGINE</p>
        <h1>
          市場の声から、
          <br />
          <span>次に売るための一手を決める。</span>
        </h1>
        <p className="lead">
          商品URLから市場・レビュー・顧客の痛点を調査。頻出する不満から商品候補と広告訴求を作り、次のテストまでつなげます。
        </p>

        <form onSubmit={analyze} className="search">
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://example.com/product"
            type="url"
            required
          />
          <button disabled={loading}>
            {loading ? "集客分析中..." : "集客分析を開始"}
          </button>
        </form>

        {error && <p className="error">{error}</p>}
        <div className="hero-proof">
          <div><b>01</b><strong>市場を調査</strong><span>レビュー・コメントから顧客の声を集計</span></div>
          <div><b>02</b><strong>痛点から商品を探す</strong><span>頻出する不満を商品候補と設計方向へ</span></div>
          <div><b>03</b><strong>広告をテストする</strong><span>痛点をHookに変えて次の検証へ</span></div>
        </div>
        <div className="hero-loop">
          <span>RESEARCH</span><i>→</i><span>PAIN POINT</span><i>→</i><span>PRODUCT</span><i>→</i><span>AD TEST</span><i>→</i><span>LEARN</span>
        </div>
        <p className="hint">URLを1つ入力するだけ。市場のシグナルを読み、次に試すべき施策まで一本のループにします。</p>
      </section>

      <section className="video-studio" aria-labelledby="video-studio-title">
        <div className="studio-copy">
          <p className="eyebrow">VIDEO STUDIO · HIGGSFIELD</p>
          <h2 id="video-studio-title">作りたい映像を、言葉から。</h2>
          <p>商品に限りません。画像は任意。作りたい動画を自由に書くだけで生成できます。</p>
        </div>
        <div className="studio-grid">
          <label className="studio-upload">
            <span className="eyebrow">01 · IMAGE <em>OPTIONAL</em></span>
            <input type="file" accept="image/jpeg,image/png,image/webp" onChange={(e) => {
              const file=e.target.files?.[0] || null; setStudioImage(file); setStudioImagePreview(file ? URL.createObjectURL(file) : "");
            }} />
            {studioImagePreview ? <img src={studioImagePreview} alt="動画生成に使う画像のプレビュー" /> : <span className="upload-empty">＋ 画像を追加<br /><small>商品・人物・写真・素材など</small></span>}
          </label>
          <div className="studio-prompt">
            <div className="studio-prompt-head"><label className="eyebrow" htmlFor="studio-prompt">02 · PROMPT</label><div className="studio-presets">{["シネマティック","UGC広告","商品CM","自由制作"].map((preset) => <button key={preset} type="button" onClick={() => setStudioPrompt((current) => current || ({ "シネマティック":"映画のワンシーンのような、光とカメラワークにこだわった映像。","UGC広告":"自然なスマホ撮影感のあるUGC動画。冒頭2秒で視線を引き、リアルな人物の動きを重視。","商品CM":"高級ブランドCMのような商品映像。質感、照明、カメラの動きを美しく見せる。","自由制作":"" } as Record<string,string>)[preset] || "")}>{preset}</button>)}</div></div>
            <textarea id="studio-prompt" value={studioPrompt} onChange={(e)=>setStudioPrompt(e.target.value)} rows={8}
              placeholder={"どんな動画を作りたいか自由に書いてください。\n\n例：この商品画像を使って、20代女性が自然に商品を紹介するUGC風広告。最初の2秒で視線を引き、夕方の柔らかな光。縦9:16、リアルなスマホ撮影感。"} />
            <div className="studio-controls"><label>尺<select value={studioDuration} onChange={(e)=>setStudioDuration(Number(e.target.value))}><option value={5}>5s</option><option value={10}>10s</option><option value={15}>15s</option></select></label><label>比率<select value={studioAspect} onChange={(e)=>setStudioAspect(e.target.value as "9:16" | "16:9" | "1:1")}><option value="9:16">9:16</option><option value="16:9">16:9</option><option value="1:1">1:1</option></select></label></div><div className="studio-actions">
              <button type="button" onClick={generateStudioVideo} disabled={studioGenerating || !studioPrompt.trim()}>{studioGenerating ? "生成中…" : "動画を生成 →"}</button>
              {studioStatus && <span className="video-status">{studioStatus}</span>}
            </div>
          </div>
        </div>
        {studioError && <p className="error">{studioError}</p>}
        {studioUrl && <div className="studio-result"><video src={studioUrl} controls playsInline /><a href={studioUrl} target="_blank" rel="noreferrer">完成動画を開く →</a></div>}
      </section>



      {result && (
        <div className="results">
          <div className="source">
            <span>分析対象</span>
            <a href={result.source.url} target="_blank" rel="noreferrer">
              {result.source.title || result.source.url}
            </a>
            <small>{result.source.url}</small>
          </div>

          <section id="research" className="research-flow">
            <div className="research-head">
              <div>
                <p className="eyebrow">EC PULSE RESEARCH LOOP</p>
                <h2>市場リサーチ → 痛点 → 商品候補 → 広告訴求</h2>
                <p>公開レビューを集計し、頻出する顧客痛点から商品候補と広告テスト案までつなげます。</p>
              </div>
              <span className={ecPulse?.connected ? "pulse-on" : "pulse-off"}>
                {ecPulseLoading ? "RESEARCHING" : ecPulse?.connected ? "EC PULSE CONNECTED" : "NOT CONNECTED"}
              </span>
            </div>
            {ecPulseLoading && <div className="research-loading">公開コメントを収集 → 痛点を集計 → 商品候補を検索中…</div>}
            {!ecPulseLoading && ecPulse?.error && <div className="research-error">{ecPulse.error}</div>}
            {!ecPulseLoading && ecPulse?.research?.analysis && (
              <div className="research-grid">
                <article className="research-card">
                  <p className="eyebrow">01 PAIN POINTS</p>
                  <h3>頻出する顧客の痛み</h3>
                  <div className="pain-list">
                    {ecPulse.research.analysis.pain_points.slice(0, 5).map((pain) => (
                      <div key={pain.pain} className="pain-row">
                        <div><strong>{pain.pain}</strong><small>{pain.count}件 · {pain.share_percent}%</small></div>
                        <span>{pain.examples?.[0] || "レビュー例なし"}</span>
                      </div>
                    ))}
                  </div>
                </article>
                <article className="research-card">
                  <p className="eyebrow">02 AD ANGLES</p>
                  <h3>広告で検証する訴求</h3>
                  <div className="angle">
                    <strong>{ecPulse.research.analysis.recommended_angle || "頻出痛点を訴求軸として検証"}</strong>
                    <ul>
                      {(ecPulse.research.analysis.ad_copy_candidates || []).slice(0, 4).map((copy, index) => <li key={index}>{copy}</li>)}
                    </ul>
                  </div>
                </article>
                <article className="research-card candidates">
                  <p className="eyebrow">03 PRODUCT CANDIDATES</p>
                  <h3>痛点から探した商品候補</h3>
                  {ecPulse.products.length ? ecPulse.products.slice(0, 8).map((product, index) => (
                    <div className="candidate" key={product.url || product.title || String(index)}>
                      <div><strong>{product.title || "商品候補"}</strong><small>{product.marketplace || "market"} · {product.price ?? "-"} {product.currency || ""}</small></div>
                      {product.url && <a href={product.url} target="_blank" rel="noreferrer">見る →</a>}
                    </div>
                  )) : <p className="muted">痛点に紐づく商品候補を取得できませんでした。</p>}
                </article>
                {ecPulse.opportunity && (
                  <article className="research-card opportunity">
                    <p className="eyebrow">04 OPPORTUNITY ENGINE</p>
                    <h3>痛点 → 商品設計 → 広告テスト</h3>
                    {ecPulse.opportunity.top_pain && (
                      <p><strong>最重要痛点：</strong>{ecPulse.opportunity.top_pain.pain}（{ecPulse.opportunity.top_pain.count}件 / {ecPulse.opportunity.top_pain.share_percent}%）</p>
                    )}
                    {(ecPulse.opportunity.ad_test_angles || []).slice(0, 3).map((angle, index) => (
                      <div className="angle" key={index}>
                        <strong>{angle.hook}</strong>
                        <small>{angle.proof}</small>
                      </div>
                    ))}
                    {(ecPulse.opportunity.next_actions || []).slice(0, 3).map((action, index) => (
                      <small key={index}>→ {action}</small>
                    ))}
                  </article>
                )}
                <article className="research-card">
                  <p className="eyebrow">05 NEXT TEST</p>
                  <h3>次の広告テスト</h3>
                  <p className="test-copy">「{ecPulse.research.analysis.recommended_angle || "最頻出の顧客痛点"}」を主訴求にして、短尺動画・静止画の2パターンを作成。クリック率と購入率で比較します。</p>
                  {ecPulse.research.analysis.next_action && <small>{ecPulse.research.analysis.next_action}</small>}
                </article>
              </div>
            )}
          </section>

          <section className="research-history">
            <div className="research-head">
              <div>
                <p className="eyebrow">RESEARCH HISTORY</p>
                <h2>調査を蓄積して、変化を見る</h2>
                <p>同じ商品を再調査するたびに、前回の痛点と比較できるように履歴を残します。</p>
              </div>
              <span className="history-count">{historyLoading ? "LOADING" : `${researchHistory.length} RUNS`}</span>
            </div>
            {researchHistory.length > 0 ? (
              <div className="history-list">
                {researchHistory.map((run, index) => (
                  <article className="history-row" key={run.run_id}>
                    <div className="history-index">{String(researchHistory.length - index).padStart(2, "0")}</div>
                    <div>
                      <strong>{new Date(run.captured_at).toLocaleString("ja-JP")}</strong>
                      <small>{run.comments_count}件のコメント · {run.market || "GLOBAL"} · {run.source_type || "research"}</small>
                    </div>
                    <div className="history-pain">
                      {run.top_pain ? <><span>TOP PAIN</span><strong>{run.top_pain.pain}</strong><small>{run.top_pain.count}件 / {run.top_pain.share_percent}%</small></> : <span>痛点データなし</span>}
                    </div>
                    <div className="history-trend">
                      {run.trend?.emerging_pains?.[0] ? (() => {
                        const pain = run.trend.emerging_pains[0];
                        const delta = pain.share_delta_percent;
                        return (
                          <>
                            <span className={pain.status === "new" ? "trend-new" : "trend-rising"}>{pain.status === "new" ? "NEW" : "RISING"}</span>
                            <strong>{pain.pain}</strong>
                            <small>{delta >= 0 ? "+" : ""}{delta}pt · {pain.current_share_percent}%</small>
                          </>
                        );
                      })() : run.trend?.signal === "no_previous_run" ? (
                        <><span className="trend-neutral">BASELINE</span><small>次回調査から変化を比較</small></>
                      ) : (
                        <><span className="trend-neutral">STABLE</span><small>大きな上昇シグナルなし</small></>
                      )}
                    </div>
                  </article>
                ))}
              </div>
            ) : !historyLoading ? (
              <div className="history-empty">
                <strong>まだ比較できる履歴はありません。</strong>
                <span>この商品をもう一度調査すると、痛点の増減を追えるようになります。</span>
              </div>
            ) : null}
          </section>

          <Section title="01 商品分析">
            <h2>{result.analysis.product.summary}</h2>
            <List items={result.analysis.product.valueProposition} />
          </Section>

          <Section title="02 市場分析">
            <h2>{result.analysis.market.summary}</h2>
            <List items={result.analysis.market.signals} />
          </Section>

          <Section title="03 顧客分析">
            <h2>{result.analysis.customer.summary}</h2>
            <List items={[...result.analysis.customer.likelySegments, ...result.analysis.customer.needs]} />
          </Section>

          <Section title="04 競合分析">
            <h2>{result.analysis.competitors.summary}</h2>
            <List items={result.analysis.competitors.signals} />
          </Section>

          <Section title="05 実績分析">
            <h2>{result.analysis.performance.summary}</h2>
            <List
              items={[
                ...result.analysis.performance.availableEvidence,
                ...result.analysis.performance.missingData.map((item) => "不足: " + item),
              ]}
            />
          </Section>

          <section className="next">
            <p className="eyebrow">DECISION ENGINE</p>
            <h2>次に何をすべきか</h2>
            <article className="decision">
              <strong>狙う顧客</strong>
              <p>{result.analysis.decision.target}</p>
              <strong>顧客の問題</strong>
              <p>{result.analysis.decision.problem}</p>
              <strong>欲求</strong>
              <p>{result.analysis.decision.desire}</p>
              <strong>訴求</strong>
              <p>{result.analysis.decision.valueProposition}</p>
              <strong>媒体</strong>
              <p>{result.analysis.decision.channel}</p>
              <strong>投稿形式</strong>
              <p>{result.analysis.decision.format}</p>
              <strong>検証方法</strong>
              <p>{result.analysis.decision.testPlan}</p>
              {result.analysis.decision.evidence?.length > 0 && (
                <>
                  <strong>根拠</strong>
                  <List items={result.analysis.decision.evidence} />
                </>
              )}
            </article>
          </section>

          <section className="next">
            <p className="eyebrow">NEXT ACTION</p>
            <h2>次にやるべき集客</h2>
            <div className="action-list">
              {result.analysis.priorities.map((item) => (
                <article key={item.priority}>
                  <b>#{item.priority}</b>
                  <div>
                    <strong>{item.action}</strong>
                    <p>{item.reason}</p>
                    <small>{item.channel}</small>
                  </div>
                </article>
              ))}
            </div>
          </section>

          <section className="next">
            <p className="eyebrow">NEXT POSTS</p>
            <h2>次に出す投稿</h2>
            <div className="action-list">
              {result.analysis.nextPosts.map((item) => (
                <article key={item.rank}>
                  <b>#{item.rank}</b>
                  <div>
                    <strong>{item.concept}</strong>
                    <p><b>HOOK</b>　{item.hook}</p>
                    <p>{item.reason}</p>
                    <small>{item.channel} · {item.format} · 検証: {item.testMetric}</small>
                  </div>
                </article>
              ))}
            </div>
          </section>

          <Section title="集客課題"><List items={result.analysis.acquisitionProblems} /></Section>
          <Section title="集客機会"><List items={result.analysis.opportunities} /></Section>
          <Section title="すぐやること"><List items={result.analysis.nextActions} /></Section>

          {result.analysis.socialSignals?.length > 0 && (
            <Section title="SNS実データ">
              <div className="action-list">
                {result.analysis.socialSignals.map((item, index) => (
                  <article key={index}>
                    <b>{index + 1}</b>
                    <div>
                      <a href={item.url} target="_blank" rel="noreferrer">
                        <strong>{item.title}</strong>
                      </a>
                      <p>@{item.author}</p>
                      <small>
                        TikTok · 再生 {item.views ?? "-"} · いいね {item.likes ?? "-"} · コメント {item.comments ?? "-"} · シェア {item.shares ?? "-"}
                      </small>
                    </div>
                  </article>
                ))}
              </div>
            </Section>
          )}

          {result.analysis.shopSignals?.length > 0 && (
            <Section title="TikTok Shop競合">
              <div className="action-list">
                {result.analysis.shopSignals.map((item, index) => (
                  <article key={index}>
                    <b>{index + 1}</b>
                    <div>
                      <a href={item.url || "#"} target="_blank" rel="noreferrer">
                        <strong>{item.title}</strong>
                      </a>
                      <p>{item.seller || "販売者不明"}</p>
                      <small>
                        価格 {item.price ?? "-"} {item.currency} · 販売数 {item.sales ?? "-"} · 評価 {item.rating ?? "-"} · レビュー {item.reviewCount ?? "-"}
                      </small>
                    </div>
                  </article>
                ))}
              </div>
            </Section>
          )}

          {result.analysis.searchEvidence?.length > 0 && (
            <Section title="検索エビデンス">
              <List items={result.analysis.searchEvidence.map((item) => item.title + " — " + item.url + " — " + item.snippet)} />
            </Section>
          )}

          <section id="decision" className="next video-generator">
            <p className="eyebrow">CREATIVE EXECUTION · HIGGSFIELD</p>
            <h2>決めた一手を、そのまま広告にする</h2>
            <p className="hint">分析結果をもとに9:16広告動画をHiggsfield APIで生成します。HiggsfieldやCloud Codeをユーザー側で起動する必要はありません。</p>
            <textarea
              value={videoPrompt}
              readOnly
              aria-label="AIが決定した動画シナリオ"
              placeholder="分析結果からAIが動画シナリオを生成します"
              rows={5}
              style={{ width: "100%", marginTop: 12, padding: 14, borderRadius: 12, background: "#101012", color: "#fff", border: "1px solid #29292e" }}
            />
            <button type="button" onClick={generateVideo} disabled={videoGenerating || !videoPrompt.trim()}>
              {videoGenerating ? "動画生成中..." : "決定したシナリオから動画を生成"}
            </button>
            {videoStatus && <p className="hint">{videoStatus}</p>}
            {videoJobId && <small className="hint">Job: {videoJobId}</small>}
            {videoError && <p className="error">{videoError}</p>}
            {videoUrl && (
              <div style={{ marginTop: 16 }}>
                <video src={videoUrl} controls playsInline style={{ width: "100%", maxWidth: 420, borderRadius: 16, background: "#000" }} />
                <p style={{ marginTop: 10 }}><a href={videoUrl} target="_blank" rel="noreferrer">完成動画を開く →</a></p>
              </div>
            )}
          </section>
          <section id="loop" className="next performance-loop">
            <p className="eyebrow">PERFORMANCE LOOP</p>
            <h2>投稿結果を入れて、次の判断へ</h2>
            <p className="hint">投稿後の数字を保存すると、AIが継続・ピボット・停止の次アクションを判断します。</p>
            <button type="button" onClick={()=>setMetricsOpen(!metricsOpen)}>{metricsOpen ? "入力を閉じる" : "実績を入力する"}</button>
            {metricsOpen && <div className="metrics-form">
              {(["impressions","views","clicks","conversions","revenue","grossProfit","adSpend"] as const).map(k=><label key={k}>{k}<input type="number" value={metrics[k]} onChange={e=>setMetrics({...metrics,[k]:e.target.value})}/></label>)}
              <p className="hint">テスト計画を保存すると投稿IDが自動発行されます。投稿後の実績を入力してください。</p>
              <button type="button" onClick={saveMetrics}>実績を保存してAI判定</button>
            </div>}
            {verdict && <div className="verdict"><strong>{verdict.verdict}</strong><p>{verdict.reason}</p></div>}
          </section>

          <section className="next test-loop">
            <p className="eyebrow">AD TEST LOOP</p>
            <h2>次の広告を「テスト」として残す</h2>
            <p className="hint">今回の判断を仮説として保存し、投稿結果をもとに次のテストへつなげます。</p>
            <div className="test-loop-grid">
              <article><span>仮説</span><strong>{result.analysis.decision.valueProposition}</strong><p>{result.analysis.decision.testPlan}</p></article>
              <article><span>最初に試す</span><strong>{result.analysis.nextPosts[0]?.hook || "次の投稿仮説"}</strong><p>{result.analysis.nextPosts[0]?.channel} · {result.analysis.nextPosts[0]?.format}</p></article>
              <article><span>見る数字</span><strong>{result.analysis.nextPosts[0]?.testMetric || "CTR / CVR / CPA"}</strong><p>結果を取得したら、次の訴求・クリエイティブを変更します。</p></article>
            </div>
            <button type="button" onClick={saveTestPlan} disabled={testSaving}>
              {testSaving ? "保存中..." : "このテスト計画を保存"}
            </button>
            {testSaved && <p className="success">{testSaved}</p>}
          </section>



      <section className="next">
        <p className="eyebrow">MONETIZATION</p>
        <h2>AI集客を継続運用する</h2>
        <p className="hint">無料で入口を試し、Proでは広告テストを継続。投稿結果を蓄積して次の施策につなげます。</p>
        <div className="action-list">
          <article>
            <b>FREE</b>
            <div><strong>まず試す</strong><p>商品分析・顧客分析・次の集客アクションを利用。</p><small>月5回まで</small></div>
          </article>
          <article>
            <b>PRO</b>
            <div><strong>広告運用を回す</strong><p>継続的なテスト、結果の記録、次アクションの学習に対応。</p><small>月額4,980円（税込）</small><div style={{ marginTop: 10 }}><BillingButton /></div></div>
          </article>
          <article>
            <b>AGENCY</b>
            <div><strong>複数商品を運用</strong><p>複数商品の運用・チーム利用向け。</p><small>複数商品・チーム運用向け（順次提供）</small></div>
          </article>
        </div>
      </section>

          <p className="ai-note">
            {result.analysis.aiConnected ? "AI分析: 接続済み" : "AI分析: 未接続（ページ抽出ベース）"}
          </p>
        </div>
      )}
    </main>
  );
}
