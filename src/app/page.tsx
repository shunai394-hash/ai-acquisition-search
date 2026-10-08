"use client";

import { FormEvent, useEffect, useState } from "react";
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
  const [loadingPhase, setLoadingPhase] = useState("市場シグナルを準備しています");
  const [error, setError] = useState("");
  const [selectedScenario, setSelectedScenario] = useState(0);
  const [ecPulse, setEcPulse] = useState<EcPulseResearchBundle | null>(null);
  const [ecPulseLoading, setEcPulseLoading] = useState(false);
  const [testSaving, setTestSaving] = useState(false);
  const [testSaved, setTestSaved] = useState("");
  const [metricsOpen, setMetricsOpen] = useState(false);
  const [metrics, setMetrics] = useState({ impressions:"", views:"", clicks:"", conversions:"", revenue:"", grossProfit:"", adSpend:"" });
  const [verdict, setVerdict] = useState<{
    verdict: string;
    reason: string;
    nextAction?: string;
    aiConnected?: boolean;
    evidenceCount?: number;
  } | null>(null);
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
  const [studioAudio, setStudioAudio] = useState<"off" | "auto" | "custom">("off");
  const [studioNarration, setStudioNarration] = useState("");
  const [studioVoice, setStudioVoice] = useState("Kore");
  const [studioMusic, setStudioMusic] = useState(false);
  const [studioMusicPrompt, setStudioMusicPrompt] = useState("");
  const [studioResolution, setStudioResolution] = useState<"720p" | "1080p">("1080p");
  const [studioStage, setStudioStage] = useState<"idle" | "prepare" | "visual" | "motion" | "audio" | "render">("idle");
  const [publishPlatforms, setPublishPlatforms] = useState<string[]>(["tiktok"]);
  const [publishCaption, setPublishCaption] = useState("");
  const [tiktokConsent, setTiktokConsent] = useState(false);
  const [publishGenerating, setPublishGenerating] = useState(false);
  const [publishStatus, setPublishStatus] = useState("");
  const [publishResults, setPublishResults] = useState<Array<{ platform: string; ok: boolean; url?: string; error?: string }>>([]);
  const [tiktokNotice, setTiktokNotice] = useState("");
  useEffect(() => {
    const value = new URLSearchParams(window.location.search).get("tiktok");
    if (value === "connected") setTiktokNotice("TikTokアカウントを接続しました。自動投稿を利用できます。");
    if (value === "error") setTiktokNotice("TikTok接続に失敗しました。もう一度接続してください。");
    getAccessToken().then(async (token) => {
      const response = await fetch("/api/social/tiktok-consent", {
        headers: { Authorization: "Bearer " + token },
        cache: "no-store",
      });
      const body = await response.json().catch(() => ({}));
      if (response.ok) setTiktokConsent(body.consented === true);
    }).catch(() => {});
  }, []);
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
    setLoadingPhase("商品ページを読み取っています");
    setError("");
    setResult(null);
    const phaseTimers = [
      window.setTimeout(() => setLoadingPhase("市場の声と競合シグナルを整理しています"), 900),
      window.setTimeout(() => setLoadingPhase("痛点と機会の因果関係を組み立てています"), 1900),
      window.setTimeout(() => setLoadingPhase("次に試す広告仮説を決めています"), 3000),
    ];

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
      phaseTimers.forEach(window.clearTimeout);
      setLoading(false);
      setLoadingPhase("市場シグナルを準備しています");
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

  async function generateStudioVideo(remixHint = "") {
    setStudioGenerating(true); setStudioError(""); setStudioUrl(""); setStudioStage("prepare"); setStudioStatus("素材を準備中…");
    try {
      const token = await getAccessToken();
      let currentSocialPostId = socialPostId;
      if (!currentSocialPostId && result) {
        const planResponse = await fetch("/api/operator/plan", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
          body: JSON.stringify({ source: result.source, analysis: result.analysis }),
        });
        const planBody = await planResponse.json().catch(() => ({}));
        if (!planResponse.ok) throw new Error(planBody.error || "SNS自動運用計画の作成に失敗しました。");
        currentSocialPostId = String(planBody.socialPostId || "");
        if (currentSocialPostId) setSocialPostId(currentSocialPostId);
      }
      let imageUrl = "";
      let audioUrl = "";
      if (studioImage) {
        const form = new FormData(); form.append("file", studioImage);
        const upload = await fetch("/api/video/upload", { method: "POST", headers: { Authorization: "Bearer " + token }, body: form });
        const body = await upload.json().catch(() => ({}));
        if (!upload.ok) throw new Error(body.error || "画像のアップロードに失敗しました。");
        imageUrl = String(body.url || "");
      }
      if (studioAudio !== "off" || studioMusic) {
        setStudioStage("audio");
        setStudioStatus("ナレーション / BGMを準備中…");
        let narrationText = studioAudio === "custom" ? studioNarration.trim() : "";
        if (studioAudio === "auto") {
          const scriptResponse = await fetch("/api/video/script", {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
            body: JSON.stringify({
              prompt: studioPrompt.trim(),
              hook: result?.analysis?.nextPosts?.[selectedScenario]?.hook || "",
              valueProposition: result?.analysis?.decision?.valueProposition || "",
              duration: studioDuration,
              language: "ja-JP",
            }),
          });
          const scriptBody = await scriptResponse.json().catch(() => ({}));
          if (!scriptResponse.ok) throw new Error(scriptBody.error || "AIナレーション台本の生成に失敗しました。");
          narrationText = String(scriptBody.script || "").trim();
          if (!narrationText) throw new Error("AIナレーション台本が空です。");
        }
        const audioResponse = await fetch("/api/video/audio", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
          body: JSON.stringify({
            text: narrationText,
            bgm: studioMusic,
            bgmPrompt: studioMusicPrompt.trim(),
            duration: studioDuration,
          }),
        });
        const audioBody = await audioResponse.json().catch(() => ({}));
        if (!audioResponse.ok) throw new Error(audioBody.error || "音声の生成に失敗しました。");
        audioUrl = String(audioBody.url || "");
        if (!audioUrl) throw new Error("生成音声URLを取得できませんでした。");
      }

      setStudioStage("visual");
      setStudioStatus("映像設計を組み立て中…");
      const response = await fetch("/api/video/generate", {
        method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
        body: JSON.stringify({
          prompt: [
            [
              studioPrompt.trim(),
              remixHint ? "REMIX DIRECTION: " + remixHint + ". Preserve the product identity and core concept while changing the visual execution." : ""
            ].filter(Boolean).join("\n"),
            studioAudio !== "off"
              ? "AUDIO: Japanese spoken narration is pre-rendered and must be used as the primary voice track. Voice: " + studioVoice + (studioAudio === "custom" ? ". Narration script: " + studioNarration.trim() : ". Auto-generated narration script. Speak naturally, clearly, and synchronize delivery to the visual beats.") + "."
              : "",
            studioMusic
              ? "BGM: generate subtle, tasteful background music that supports the scene; keep it underneath the narration and do not overpower speech." + (studioMusicPrompt.trim() ? " Style: " + studioMusicPrompt.trim() + "." : "")
              : ""
          ].filter(Boolean).join("\n"),
          imageUrl: imageUrl || undefined,
          audioUrl: audioUrl || undefined,
          socialPostId: currentSocialPostId || undefined,
          duration: studioDuration,
          resolution: studioResolution,
          aspectRatio: studioAspect,
          generateAudio: studioAudio !== "off" || studioMusic
        })
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || "動画生成の開始に失敗しました。");
      const jobId = String(body.jobId || ""); if (!jobId) throw new Error("動画ジョブIDを取得できませんでした。");
      const engine = String(body.engine || "Higgsfield"); setStudioStage("motion"); setStudioStatus(engine + "でモーションを生成中…");
      if (studioAudio !== "off" || studioMusic) window.setTimeout(() => setStudioStage("audio"), 700);
      for (let attempt = 0; attempt < 60; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, attempt === 0 ? 2000 : 5000));
        const poll = await fetch("/api/video/jobs/" + encodeURIComponent(jobId), { headers: { Authorization: "Bearer " + (await getAccessToken()) }, cache: "no-store" });
        const data = await poll.json().catch(() => ({}));
        if (!poll.ok) throw new Error(data.error || "動画生成状態の取得に失敗しました。");
        if (data.job?.status === "completed" && data.asset?.video_url) {
          setStudioStage("render");
          setStudioUrl(data.asset.video_url);
          setStudioStatus("完成。");
          if (currentSocialPostId && publishPlatforms.length && (!publishPlatforms.includes("tiktok") || tiktokConsent)) {
            setPublishStatus("完成動画をSNSへ自動投稿中…");
            try {
              const publishToken = await getAccessToken();
              const caption = publishCaption.trim() || result?.analysis?.nextPosts?.[selectedScenario]?.hook || result?.analysis?.decision?.valueProposition || "AI Acquisition Search creative";
              const publishResponse = await fetch("/api/social/publish", {
                method: "POST",
                headers: { "Content-Type": "application/json", Authorization: "Bearer " + publishToken },
                body: JSON.stringify({ socialPostId: currentSocialPostId, videoUrl: data.asset.video_url, caption, platforms: publishPlatforms }),
              });
              const publishBody = await publishResponse.json().catch(() => ({}));
              if (!publishResponse.ok) throw new Error(publishBody.error || "SNS自動投稿に失敗しました。");
              setPublishResults(Array.isArray(publishBody.results) ? publishBody.results : []);
              setPublishStatus(publishBody.failed ? `自動投稿：${publishBody.published || 0}件成功 / ${publishBody.failed}件失敗` : `自動投稿：${publishBody.published || 0}件`);
            } catch (publishError) {
              setPublishStatus("");
              setStudioError(publishError instanceof Error ? publishError.message : "SNS自動投稿に失敗しました。");
            }
          }
          return;
        }
        if (data.job?.status === "failed") throw new Error(data.job?.error || "動画生成に失敗しました。");
        setStudioStatus(engine + "で生成中… " + (attempt + 1) + "/60");
      }
      throw new Error("動画生成がタイムアウトしました。");
    } catch (err) { setStudioStage("idle"); setStudioError(err instanceof Error ? err.message : "動画生成に失敗しました。"); setStudioStatus(""); }
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
        body: JSON.stringify({
          prompt: videoPrompt.trim(),
          duration: 5,
          resolution: "1080p",
          aspectRatio: "9:16",
          generateAudio: false,
          socialPostId: socialPostId || undefined,
        }),
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
          if (socialPostId && publishPlatforms.length && (!publishPlatforms.includes("tiktok") || tiktokConsent)) {
            setPublishStatus("完成動画をSNSへ自動投稿中…");
            try {
              const publishToken = await getAccessToken();
              const caption = publishCaption.trim() || result?.analysis?.nextPosts?.[selectedScenario]?.hook || result?.analysis?.decision?.valueProposition || "AI Acquisition Search creative";
              const publishResponse = await fetch("/api/social/publish", {
                method: "POST",
                headers: { "Content-Type": "application/json", Authorization: "Bearer " + publishToken },
                body: JSON.stringify({ socialPostId, videoUrl: data.asset.video_url, caption, platforms: publishPlatforms }),
              });
              const publishBody = await publishResponse.json().catch(() => ({}));
              if (!publishResponse.ok) throw new Error(publishBody.error || "SNS自動投稿に失敗しました。");
              setPublishResults(Array.isArray(publishBody.results) ? publishBody.results : []);
              setPublishStatus(publishBody.failed ? `自動投稿：${publishBody.published || 0}件成功 / ${publishBody.failed}件失敗` : `自動投稿：${publishBody.published || 0}件`);
            } catch (publishError) {
              setPublishStatus("");
              setVideoError(publishError instanceof Error ? publishError.message : "SNS自動投稿に失敗しました。");
            }
          }
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
  async function publishGeneratedVideo(sourceUrl = videoUrl) {
    if (!sourceUrl) return;
    if (!socialPostId) {
      setVideoError("先に「このテスト計画を保存」して、投稿先を紐づけてください。");
      return;
    }
    if (!publishPlatforms.length) {
      setVideoError("投稿先を1つ以上選択してください。");
      return;
    }
    if (publishPlatforms.includes("tiktok") && !tiktokConsent) {
      setVideoError("TikTokを選択した場合は、公開前に自動投稿への明示的な同意が必要です。");
      return;
    }
    setPublishGenerating(true);
    setVideoError("");
    setPublishStatus("SNSへの投稿を準備中…");
    setPublishResults([]);
    try {
      const token = await getAccessToken();
      const caption = publishCaption.trim() || result?.analysis?.nextPosts?.[selectedScenario]?.hook || result?.analysis?.decision?.valueProposition || "AI Acquisition Search creative";
      const response = await fetch("/api/social/publish", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
        body: JSON.stringify({ socialPostId, videoUrl: sourceUrl, caption, platforms: publishPlatforms }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || "SNS投稿に失敗しました。");
      setPublishResults(Array.isArray(body.results) ? body.results : []);
      setPublishStatus(body.failed ? `投稿完了：${body.published || 0}件成功 / ${body.failed}件失敗` : `投稿完了：${body.published || 0}件`);
    } catch (err) {
      setPublishStatus("");
      setVideoError(err instanceof Error ? err.message : "SNS投稿に失敗しました。");
    } finally {
      setPublishGenerating(false);
    }
  }

  async function saveMetrics() {
    setVerdict(null);
    setError("");
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
      setVerdict({
        verdict: verdictBody.verdict,
        reason: verdictBody.reason,
        nextAction: verdictBody.nextAction,
        aiConnected: verdictBody.aiConnected === true,
        evidenceCount: Array.isArray(verdictBody.decision?.evidence) ? verdictBody.decision.evidence.length : undefined,
      });
    } catch(err) { setError(err instanceof Error ? err.message : "実績保存に失敗しました。"); }
  }

  return (
    <main className="shell">\n      {tiktokNotice && <div className="integration-notice" role="status" aria-live="polite">{tiktokNotice}</div>}
      <header className="topbar">
        <div>
          <strong>AI Acquisition Search</strong>
          <span>DECISION ENGINE FOR CUSTOMER ACQUISITION</span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          {result && (
            <nav className="cockpit-nav" aria-label="分析ナビゲーション">
              <a href="#research">01 <span>Research</span></a>
              <a href="#decision">02 <span>Decision</span></a>
              <a href="#loop">03 <span>Loop</span></a>
            </nav>
          )}
          <span className="status">AI AD OPERATOR · LIVE</span>
          <GoogleSignIn />
          <Link href="/billing" style={{ color: "#ffffff70", fontSize: 11 }}>契約管理</Link>
        </div>
      </header>

      <section className="hero" aria-labelledby="hero-title">
        <div className="hero-grid">
          <div className="hero-copy">
            <p className="eyebrow">AI CUSTOMER ACQUISITION · DECISION ENGINE</p>
            <h1 id="hero-title">市場を読む。<br /><span>次の一手を決める。</span></h1>
            <p className="lead">商品URLをひとつ。市場の声、顧客の痛点、競合シグナルを束ねて、<strong>「何を、誰に、どこで、どう試すか」</strong>まで一気に決めます。</p>
            <form onSubmit={analyze} className="search" aria-label="商品分析">
              <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="商品URLを入力  /  https://example.com/product" type="url" required aria-label="分析する商品URL" />
              <button disabled={loading} aria-busy={loading}>{loading ? "分析中…" : "市場を読む →"}</button>
            </form>
            {error && <div className="hero-error" role="alert"><span>ANALYSIS INTERRUPTED</span><strong>{error}</strong></div>}
            {loading && <div className="analysis-progress" role="status" aria-live="polite"><span className="analysis-spinner" aria-hidden="true" /><div><strong>{loadingPhase}</strong><small>RESEARCH → EVIDENCE → DECISION</small></div><div className="analysis-progress-track"><i /></div></div>}
            <div className="hero-proof">
              <div><b>01</b><strong>市場を読む</strong><span>レビュー・コメントから「繰り返される声」を抽出</span></div>
              <div><b>02</b><strong>矛盾を見つける</strong><span>痛点と競合の隙間から機会を定義</span></div>
              <div><b>03</b><strong>次を試す</strong><span>訴求・動画・テストまで一本の仮説にする</span></div>
            </div>
          </div>
          <div className="hero-instrument" aria-label="AI Acquisition Search decision loop">
            <div className="instrument-grid" aria-hidden="true"></div>
            <div className="signal-orbit orbit-one"></div><div className="signal-orbit orbit-two"></div><div className="signal-orbit orbit-three"></div>
            <div className="signal-core"><span>AI</span><strong>DECIDE</strong><small>FROM SIGNAL → ACTION</small></div>
            <div className="signal-node node-a"><b>01</b><span>RESEARCH</span></div><div className="signal-node node-b"><b>02</b><span>TENSION</span></div>
            <div className="signal-node node-c"><b>03</b><span>DECISION</span></div><div className="signal-node node-d"><b>04</b><span>CREATIVE</span></div>
            <div className="instrument-caption"><span>LIVE SYSTEM</span><strong>ONE INPUT → MANY SIGNALS → ONE NEXT MOVE</strong></div>
          </div>
        </div>
        <div className="hero-loop" aria-label="Acquisition loop"><span>RESEARCH</span><i>→</i><span>PAIN POINT</span><i>→</i><span>PRODUCT</span><i>→</i><span>AD TEST</span><i>→</i><span>LEARN</span></div>
        <p className="hint">分析結果はレポートで終わらない。判断を、次のクリエイティブとテストへ接続します。</p>
      </section>

      {!result && (
      <section className="video-studio" aria-labelledby="video-studio-title">
        <div className="studio-kicker-row"><span className="studio-live-dot" aria-hidden="true"></span><span>CREATIVE LAB</span><span className="studio-divider">/</span><span>TEXT + IMAGE → VIDEO</span></div>
        <div className="studio-copy">
          <p className="eyebrow">VIDEO STUDIO · HIGGSFIELD</p>
          <h2 id="video-studio-title">作りたい映像を、そのまま書く。</h2>
          <p>画像を置いて、あなたのプロンプトを書く。尺・画角・音を決めて生成します。シナリオ作成は不要です。</p>
        </div>
        <div className="studio-grid">
          <label className="studio-upload">
            <span className="eyebrow">01 · REFERENCE <em>OPTIONAL</em></span>
            <input type="file" accept="image/jpeg,image/png,image/webp" onChange={(e) => {
              const file=e.target.files?.[0] || null; setStudioImage(file); setStudioImagePreview(file ? URL.createObjectURL(file) : "");
            }} />
            {studioImagePreview ? <img src={studioImagePreview} alt="動画生成に使う画像のプレビュー" /> : <span className="upload-empty">＋ 画像・商品写真を追加<br /><small>人物 / 商品 / 写真 / イラスト / 参照素材</small></span>}
          </label>
          <div className="studio-prompt">
            <div className="studio-prompt-head"><label className="eyebrow" htmlFor="studio-prompt">02 · PROMPT</label><div className="studio-presets">{["シネマティック","UGC広告","商品CM","自由制作"].map((preset) => <button key={preset} type="button" onClick={() => setStudioPrompt((current) => current || ({ "シネマティック":"映画のワンシーンのような、光とカメラワークにこだわった映像。","UGC広告":"自然なスマホ撮影感のあるUGC動画。冒頭2秒で視線を引き、リアルな人物の動きを重視。","商品CM":"高級ブランドCMのような商品映像。質感、照明、カメラの動きを美しく見せる。","自由制作":"" } as Record<string,string>)[preset] || "")}>{preset}</button>)}</div></div>
            <textarea id="studio-prompt" value={studioPrompt} onChange={(e)=>setStudioPrompt(e.target.value)} rows={8}
              placeholder={"どんな動画を作りたいか自由に書いてください。\n\n例：この商品画像を使って、20代女性が自然に商品を紹介するUGC風広告。最初の2秒で視線を引き、夕方の柔らかな光。縦9:16、リアルなスマホ撮影感。"} />
            <div className="studio-controls"><label>尺<select aria-label="動画の長さ" value={studioDuration} onChange={(e)=>setStudioDuration(Number(e.target.value))}><option value={5}>5s</option><option value={10}>10s</option><option value={15}>15s</option></select></label><label>比率<select aria-label="動画のアスペクト比" value={studioAspect} onChange={(e)=>setStudioAspect(e.target.value as "9:16" | "16:9" | "1:1")}><option value="9:16">9:16</option><option value="16:9">16:9</option><option value="1:1">1:1</option></select></label><label>解像度<select aria-label="動画の解像度" value={studioResolution} onChange={(e)=>setStudioResolution(e.target.value as "720p" | "1080p")}><option value="1080p">1080p</option><option value="720p">720p</option></select></label></div><div className="studio-audio-settings"><span className="eyebrow">04 · AUDIO</span><div className="studio-audio-grid">{([["off","OFF"],["auto","AUTO"],["custom","CUSTOM"]] as const).map(([value,label]) => <button key={value} type="button" className={studioAudio===value ? "selected" : ""} onClick={()=>setStudioAudio(value)}>{label}</button>)}</div>{studioAudio !== "off" && <div className="studio-audio-options"><label>VOICE<select aria-label="ナレーション音声" value={studioVoice} onChange={(e)=>setStudioVoice(e.target.value)}><option value="Kore">日本語 · Firm</option><option value="Leda">日本語 · Youthful</option><option value="Charon">日本語 · Informative</option><option value="Aoede">日本語 · Breezy</option><option value="Puck">English · Upbeat</option><option value="Achird">English · Friendly</option></select></label>{studioAudio === "custom" && <textarea value={studioNarration} onChange={(e)=>setStudioNarration(e.target.value)} rows={3} placeholder="ナレーション原稿（任意）" aria-label="ナレーション原稿" />}</div>}<label className="studio-music-toggle"><input type="checkbox" checked={studioMusic} onChange={(e)=>setStudioMusic(e.target.checked)} /> BGMを自動生成</label>{studioMusic && <input className="studio-music-prompt" value={studioMusicPrompt} onChange={(e)=>setStudioMusicPrompt(e.target.value)} placeholder="BGMの雰囲気（例：minimal electronic / warm acoustic）" aria-label="BGMの雰囲気" />}</div><div className="studio-stage-rail" aria-label="動画生成ステップ">
              {([["prepare","PREPARE","素材"],["visual","VISUAL","映像設計"],["motion","MOTION","モーション"],["audio","AUDIO","音"],["render","RENDER","仕上げ"]] as const).map(([key,label,ja], index) => {
                const order = ["idle","prepare","visual","motion","audio","render"] as const;
                const active = order.indexOf(studioStage) >= order.indexOf(key);
                return <div key={key} className={active ? "studio-stage active" : "studio-stage"}><span>0{index + 1}</span><strong>{label}</strong><small>{ja}</small></div>;
              })}
            </div><div className="studio-actions">
              <button type="button" onClick={() => { void generateStudioVideo(); }} disabled={studioGenerating || studioPrompt.trim().length < 8 || (studioAudio === "custom" && !studioNarration.trim() && !studioMusic)} aria-busy={studioGenerating}>{studioGenerating ? "生成中…" : "動画を生成 →"}</button>
              {studioStatus && <span className="video-status">{studioStatus}</span>}
            </div>
          </div>
        </div>
        {studioError && <p className="error">{studioError}</p>}
        {studioUrl && <div className="studio-result"><div className="studio-result-head"><div><span className="eyebrow">05 · OUTPUT</span><strong>生成結果</strong></div><span className="studio-result-state">READY</span></div><video src={studioUrl} controls playsInline /><div className="studio-result-actions"><button type="button" onClick={() => { void generateStudioVideo(); }} disabled={studioGenerating}>↻ Regenerate</button><button type="button" onClick={() => { void generateStudioVideo("Try a materially different camera movement, pacing, composition, and lighting while keeping the same product and message."); }} disabled={studioGenerating}>✦ Remix</button><a href={studioUrl} target="_blank" rel="noreferrer">完成動画を開く →</a></div></div>}
      </section>
      )}

      {result && (
        <div className="results">
          <nav className="journey-index" aria-label="Decision journey">
            <a className="journey-active" href="#research"><b>01</b> RESEARCH</a><i>→</i><a href="#decision-map-title"><b>02</b> TENSION</a><i>→</i><a href="#decision"><b>03</b> DECISION</a><i>→</i><a href="#creative-bridge-title"><b>04</b> CREATIVE</a><i>→</i><a href="#test-loop"><b>05</b> TEST</a><i>→</i><a href="#loop"><b>06</b> LEARN</a>
          </nav>
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

          <section className="decision-map" aria-labelledby="decision-map-title">
            <div className="decision-map-head">
              <div>
                <p className="eyebrow">EVIDENCE → DECISION</p>
                <h2 id="decision-map-title">AIの判断を、ブラックボックスにしない。</h2>
                <p>市場シグナル、矛盾、顧客像、訴求を一本の因果線で確認できます。数字だけでなく「なぜこの一手なのか」を残します。</p>
              </div>
              <div className="decision-confidence" aria-label="判断の確信度">
                <span>DECISION CONFIDENCE</span>
                <strong>{Math.round(((result.analysis.channelRecommendation?.confidence ?? 0) * 100) || 0)}%</strong>
              </div>
            </div>
            <div className="decision-rail" role="list" aria-label="意思決定の流れ">
              <article role="listitem"><span>01</span><small>SIGNAL</small><strong>{result.analysis.market.summary}</strong></article>
              <i aria-hidden="true">→</i>
              <article role="listitem"><span>02</span><small>TENSION</small><strong>{result.analysis.evidenceTensions?.[0]?.topic || result.analysis.customer.needs?.[0] || "顧客の未解決課題"}</strong></article>
              <i aria-hidden="true">→</i>
              <article role="listitem"><span>03</span><small>OPPORTUNITY</small><strong>{result.analysis.opportunities?.[0] || result.analysis.decision.desire}</strong></article>
              <i aria-hidden="true">→</i>
              <article role="listitem" className="rail-decision"><span>04</span><small>DECISION</small><strong>{result.analysis.decision.valueProposition}</strong></article>
            </div>
            {result.analysis.evidenceTensions?.length > 0 && (
              <div className="tension-grid">
                {result.analysis.evidenceTensions.slice(0, 3).map((tension, index) => (
                  <article key={tension.topic}>
                    <div><span>0{index + 1}</span><strong>{tension.topic}</strong><em>{tension.status === "conflict" ? "CONFLICT" : "SIGNAL"}</em></div>
                    <p><b>+</b> {tension.positiveEvidence?.[0] || "肯定的なシグナルなし"}</p>
                    <p><b>−</b> {tension.negativeEvidence?.[0] || "反証シグナルなし"}</p>
                  </article>
                ))}
              </div>
            )}
            {result.analysis.channelRecommendation?.comparison?.length > 0 && (
              <div className="channel-matrix">
                <div className="channel-matrix-head"><span>CHANNEL FIT</span><small>視覚適性 × 購買意図 × データ適合</small></div>
                {result.analysis.channelRecommendation.comparison.slice(0, 4).map((channel) => {
                  const score = Math.round((channel.visualFit + channel.purchaseIntent + channel.dataFit + channel.continuity) / 4);
                  return <div className="channel-row" key={channel.channel}>
                    <strong>{channel.channel}</strong><div className="channel-bar"><span style={{ width: Math.min(100, Math.max(0, score)) + "%" }} /></div><b>{score}</b><small>{channel.note}</small>
                  </div>;
                })}
              </div>
            )}
          </section>

          <section className="creative-intelligence" aria-labelledby="creative-intelligence-title">
            <div className="creative-intelligence-head">
              <div>
                <p className="eyebrow">CREATIVE INTELLIGENCE</p>
                <h2 id="creative-intelligence-title">「誰に・何を・どう言うか」を、比較できる形に。</h2>
              </div>
              <span>AI RANKING · EVIDENCE WEIGHTED</span>
            </div>
            <div className="appeal-grid">
              {(result.analysis.appealCandidates || []).slice(0, 3).map((appeal, index) => (
                <article key={appeal.name} className={index === 0 ? "appeal-card featured" : "appeal-card"}>
                  <div className="appeal-top"><span>0{index + 1}</span><em>{appeal.funnelStage}</em></div>
                  <h3>{appeal.name}</h3>
                  <p className="appeal-copy">“{appeal.copy}”</p>
                  <div className="appeal-meta"><span>{appeal.customerLabel}</span><span>{appeal.emotion}</span></div>
                  <div className="score-stack">
                    <div><span>STRENGTH</span><div><i style={{width: Math.min(100, Math.max(0, appeal.strengthScore)) + "%"}} /></div><b>{appeal.strengthScore}</b></div>
                    <div><span>RISK</span><div><i style={{width: Math.min(100, Math.max(0, appeal.riskScore)) + "%"}} /></div><b>{appeal.riskScore}</b></div>
                  </div>
                  <small>{appeal.reason}</small>
                </article>
              ))}
              {!result.analysis.appealCandidates?.length && (
                <div className="appeal-empty">訴求候補の比較データがありません。次の分析で蓄積します。</div>
              )}
            </div>
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

          <section className="signal-atlas" aria-labelledby="signal-atlas-title">
            <div className="signal-atlas-head">
              <div>
                <p className="eyebrow">SIGNAL ATLAS</p>
                <h2 id="signal-atlas-title">調査結果を、5つの視点で一枚にする。</h2>
              </div>
              <span>RAW SIGNALS → DECISION INPUTS</span>
            </div>
            <div className="signal-atlas-grid">
              <article><span>01 · PRODUCT</span><h3>{result.analysis.product.summary}</h3><List items={result.analysis.product.valueProposition.slice(0, 3)} /></article>
              <article><span>02 · MARKET</span><h3>{result.analysis.market.summary}</h3><List items={result.analysis.market.signals.slice(0, 3)} /></article>
              <article><span>03 · CUSTOMER</span><h3>{result.analysis.customer.summary}</h3><List items={[...result.analysis.customer.likelySegments, ...result.analysis.customer.needs].slice(0, 4)} /></article>
              <article><span>04 · COMPETITION</span><h3>{result.analysis.competitors.summary}</h3><List items={result.analysis.competitors.signals.slice(0, 3)} /></article>
              <article className="signal-atlas-wide"><span>05 · PERFORMANCE EVIDENCE</span><h3>{result.analysis.performance.summary}</h3><List items={[...result.analysis.performance.availableEvidence.slice(0, 2), ...result.analysis.performance.missingData.slice(0, 2).map((item) => "不足: " + item)]} /></article>
            </div>
          </section>

          <section className="decision-scorecard" aria-labelledby="decision-scorecard-title">
            <div className="scorecard-head">
              <div><p className="eyebrow">DECISION SCORECARD</p><h2 id="decision-scorecard-title">この判断を、実行可能な4つの変数に固定する。</h2></div>
              <span>ONE HYPOTHESIS · ONE TEST</span>
            </div>
            <div className="scorecard-grid">
              <article><span>WHO</span><strong>{result.analysis.decision.target}</strong><small>狙う顧客</small></article>
              <article><span>WHY</span><strong>{result.analysis.decision.problem}</strong><small>解く問題</small></article>
              <article><span>WHAT</span><strong>{result.analysis.decision.valueProposition}</strong><small>約束する価値</small></article>
              <article><span>WHERE</span><strong>{result.analysis.decision.channel}</strong><small>最初に検証する場所</small></article>
            </div>
            <div className="scorecard-footer">
              <div><span>TEST HYPOTHESIS</span><strong>{result.analysis.decision.testPlan}</strong></div>
              <div><span>PRIMARY FORMAT</span><strong>{result.analysis.decision.format}</strong></div>
            </div>
          </section>

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

          <section className="execution-command" aria-labelledby="execution-command-title">
            <div>
              <p className="eyebrow">EXECUTION COMMAND</p>
              <h2 id="execution-command-title">判断で止めない。次のクリエイティブまで一気に落とす。</h2>
              <p>AIが選んだ仮説を、そのまま動画の初稿へ。シナリオを選ぶと生成プロンプトに反映されます。</p>
            </div>
            <div className="scenario-picker">
              {(result.analysis.nextPosts || []).slice(0, 3).map((scenario, index) => (
                <button type="button" key={scenario.rank} className={selectedScenario === index ? "active" : ""} onClick={() => {
                  setSelectedScenario(index);
                  setVideoPrompt([result.source.title || "商品", "Hook: " + scenario.hook, scenario.concept, "Audience: " + (result.analysis.decision.target || ""), "Format: " + scenario.format, "Channel: " + scenario.channel, "Proof: " + result.analysis.decision.valueProposition, "Natural, factual, high-retention short-form creative; no unsupported claims."].join("\n"));
                }}>
                  <span>0{index + 1}</span><strong>{scenario.concept}</strong><small>{scenario.testMetric}</small>
                </button>
              ))}
            </div>
          </section>

          <section className="hypothesis-console" aria-labelledby="hypothesis-console-title">
            <div className="console-head">
              <div><p className="eyebrow">HYPOTHESIS CONSOLE</p><h2 id="hypothesis-console-title">3つの仮説。1つだけ、次に進める。</h2></div>
              <span>AI RANKED · HUMAN CONFIRM</span>
            </div>
            <div className="hypothesis-grid">
              {(result.analysis.nextPosts || []).slice(0,3).map((scenario,index)=>{
                const active=selectedScenario===index;
                return <button type="button" key={scenario.rank} className={active ? "hypothesis-card active" : "hypothesis-card"} onClick={()=>{
                  setSelectedScenario(index);
                  setVideoPrompt([result.source.title || "商品","Hook: "+scenario.hook,scenario.concept,"Audience: "+(result.analysis.decision.target || ""),"Format: "+scenario.format,"Channel: "+scenario.channel,"Proof: "+result.analysis.decision.valueProposition,"Natural, factual, high-retention short-form creative; no unsupported claims."].join("\n"));
                }}>
                  <span className="hypothesis-number">0{index+1}</span><strong>{scenario.concept}</strong>
                  <small>{scenario.channel} · {scenario.format}</small>
                  <em>{scenario.testMetric}</em><i>{active ? "SELECTED" : "SELECT"}</i>
                </button>
              })}
            </div>
          </section>

          <section className="creative-bridge" aria-labelledby="creative-bridge-title">
            <div className="creative-bridge-index"><span>03 → 04</span><b>DECISION</b><i>→</i><b>CREATIVE</b></div>
            <div><p className="eyebrow">DECISION → CREATIVE</p><h2 id="creative-bridge-title">判断が、そのまま映像の設計図になる。</h2><p>選んだ広告仮説は、Hook・Audience・Format・Proofへ分解され、動画生成の初稿に引き継がれます。</p></div>
            <div className="bridge-state"><span>ARMED HYPOTHESIS</span><strong>0{selectedScenario + 1}</strong><small>{result.analysis.nextPosts?.[selectedScenario]?.testMetric || "NEXT TEST"}</small></div>
          </section>

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
          {(videoUrl || studioUrl) && !socialPostId && (
            <aside className="loop-gate" aria-label="SNS自動運用への接続">
              <div>
                <span className="eyebrow">NEXT · AUTOMATION GATE</span>
                <strong>動画は完成。次はテスト計画を保存して運用ループへ。</strong>
                <p>保存すると投稿IDが発行され、SNS投稿 → 実績取得 → AI判定 → 次のクリエイティブまで接続できます。</p>
              </div>
              <button type="button" onClick={() => document.getElementById("test-loop")?.scrollIntoView({ behavior: "smooth", block: "center" })}>
                テスト計画へ →
              </button>
            </aside>
          )}
          {(videoUrl || studioUrl) && socialPostId && (
            <section className="next publisher-loop" aria-labelledby="publisher-title">
              <p className="eyebrow">PUBLISH · AUTOMATION READY</p>
              <h2 id="publisher-title">完成した動画を、そのままSNSへ。</h2>
              <p className="hint">投稿先を選び、本文を確認して公開。現在選択中の完成動画を投稿し、投稿後はOperator Loopが実績取得 → AI判定 → 次クリエイティブまでつなぎます。</p>
              <div className="publisher-platforms" role="group" aria-label="投稿先">
                {["tiktok","instagram","facebook","youtube","x","linkedin"].map((platform) => {
                  const checked = publishPlatforms.includes(platform);
                  return (
                    <label key={platform}>
                      <input type="checkbox" checked={checked} onChange={(e) => setPublishPlatforms((current) => e.target.checked ? [...new Set([...current, platform])] : current.filter((item) => item !== platform))} />
                      {platform}
                    </label>
                  );
                })}
              </div>
              <textarea
                value={publishCaption}
                onChange={(e) => setPublishCaption(e.target.value)}
                placeholder={result?.analysis?.nextPosts?.[selectedScenario]?.hook || "投稿本文を入力"}
                aria-label="SNS投稿本文"
                rows={3}
              />
              {publishPlatforms.includes("tiktok") && (
                <div className="tiktok-connect-box">
                  <a href="/api/tiktok/connect" className="tiktok-connect-link">TikTokアカウントを接続 →</a>
                  <span>ユーザーごとのTikTok OAuthで安全に投稿します。</span>
                </div>
              )}
              {publishPlatforms.includes("tiktok") && (
                <label className="publish-consent">
                  <input
                    type="checkbox"
                    checked={tiktokConsent}
                    onChange={async (e) => {
                      if (!e.target.checked) {
                        setTiktokConsent(false);
                        return;
                      }
                      try {
                        const token = await getAccessToken();
                        const consent = await fetch("/api/social/tiktok-consent", {
                          method: "POST",
                          headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
                          body: JSON.stringify({ consented: true }),
                        });
                        const body = await consent.json().catch(() => ({}));
                        if (!consent.ok) throw new Error(body.error || "TikTok自動投稿への同意を保存できませんでした。");
                        setTiktokConsent(true);
                      } catch (err) {
                        setTiktokConsent(false);
                        setVideoError(err instanceof Error ? err.message : "TikTok自動投稿への同意を保存できませんでした。");
                      }
                    }}
                  />
                  <span>
                    <strong>TikTok自動投稿を許可する</strong>
                    <small>チェックすると、完成動画をTikTokへ自動公開できる状態になります。</small>
                  </span>
                </label>
              )}
              <div className="video-actions">
                <button type="button" onClick={() => publishGeneratedVideo(studioUrl || videoUrl)} disabled={publishGenerating || !publishPlatforms.length || (publishPlatforms.includes("tiktok") && !tiktokConsent)}>
                  {publishGenerating ? "投稿中…" : "選択したSNSへ投稿 →"}
                </button>
                {publishStatus && <span className="video-status" role="status" aria-live="polite">{publishStatus}</span>}
              </div>
              {publishResults.length > 0 && (
                <div className="publish-results">
                  {publishResults.map((item) => (
                    <div key={item.platform} className={"publish-row " + (item.ok ? "done" : "failed")}>
                      <span>{item.platform}</span>
                      <strong>{item.ok ? "PUBLISHED" : item.error || "FAILED"}</strong>
                      {item.url ? <a href={item.url} target="_blank" rel="noreferrer">開く →</a> : <span />}
                    </div>
                  ))}
                </div>
              )}
            </section>
          )}
          <section id="loop" className="next performance-loop">
          <div className="loop-intro">
            <span className="loop-node active">01 <b>TEST</b></span><i>→</i><span className="loop-node">02 <b>MEASURE</b></span><i>→</i><span className="loop-node">03 <b>DECIDE</b></span><i>→</i><span className="loop-node">04 <b>LEARN</b></span>
          </div>
            <p className="eyebrow">PERFORMANCE LOOP</p>
            <h2>投稿結果を入れて、次の判断へ</h2>
            <p className="hint">投稿後の数字を保存すると、AIが継続・ピボット・停止の次アクションを判断します。</p>
            <button type="button" onClick={()=>setMetricsOpen(!metricsOpen)}>{metricsOpen ? "入力を閉じる" : "実績を入力する"}</button>
            {metricsOpen && <div className="metrics-form">
              {([
                ["impressions","表示回数","件"],
                ["views","再生数","件"],
                ["clicks","クリック","件"],
                ["conversions","コンバージョン","件"],
                ["revenue","売上","円"],
                ["grossProfit","粗利益","円"],
                ["adSpend","広告費","円"],
              ] as const).map(([k,label,unit])=>(
                <label key={k}>
                  <span>{label}</span>
                  <small>{unit}</small>
                  <input aria-label={label} inputMode="decimal" min="0" step="1" type="number" value={metrics[k]} onChange={e=>setMetrics({...metrics,[k]:e.target.value})}/>
                </label>
              ))}
              <p className="hint">テスト計画を保存すると投稿IDが自動発行されます。投稿後の実績を入力してください。</p>
              <button type="button" onClick={saveMetrics}>実績を保存してAI判定</button>
            </div>}
            {verdict && (
              <div className="verdict" role="status" aria-live="polite">
                <div className="verdict-head">
                  <div>
                    <span className="eyebrow">TEACHER DECISION</span>
                    <strong>{verdict.verdict}</strong>
                  </div>
                  <span className="verdict-source">{verdict.aiConnected ? "AI REFINED" : "DETERMINISTIC"}{typeof verdict.evidenceCount === "number" ? ` · ${verdict.evidenceCount} SIGNALS` : ""}</span>
                </div>
                <p>{verdict.reason}</p>
                {verdict.nextAction && (
                  <div className="verdict-next">
                    <span>NEXT ACTION</span>
                    <strong>{verdict.nextAction}</strong>
                  </div>
                )}
              </div>
            )}
          </section>

          <section id="test-loop" className="next test-loop">
            <p className="eyebrow">AD TEST LOOP</p>
            <h2>次の広告を「テスト」として残す</h2>
            <p className="hint">今回の判断を仮説として保存し、投稿結果をもとに次のテストへつなげます。</p>
            <div className="test-loop-grid">
              <article><span>仮説</span><strong>{result.analysis.decision.valueProposition}</strong><p>{result.analysis.decision.testPlan}</p></article>
              <article><span>最初に試す</span><strong>{result.analysis.nextPosts[0]?.hook || "次の投稿仮説"}</strong><p>{result.analysis.nextPosts[0]?.channel} · {result.analysis.nextPosts[0]?.format}</p></article>
              <article><span>見る数字</span><strong>{result.analysis.nextPosts[0]?.testMetric || "CTR / CVR / CPA"}</strong><p>結果を取得したら、次の訴求・クリエイティブを変更します。</p></article>
            </div>
            <div className="test-loop-actions">
              <button type="button" onClick={saveTestPlan} disabled={testSaving}>
                {testSaving ? "保存中..." : "保存して自動運用を起動 →"}
              </button>
              {socialPostId && <span className="auto-loop-badge" role="status"><i aria-hidden="true" /> AUTO LOOP ARMED · POST → MEASURE → LEARN</span>}
            </div>
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
