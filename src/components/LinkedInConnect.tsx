"use client";

import { useEffect, useState } from "react";

export default function LinkedInConnect({ socialPostId }: { socialPostId?: string }) {
  const [connected, setConnected] = useState(false);
  const [name, setName] = useState("");
  const [loading, setLoading] = useState(true);
  const [posting, setPosting] = useState(false);
  const [message, setMessage] = useState("");
  const [commentary, setCommentary] = useState("");
  const [postUrn, setPostUrn] = useState("");
  const [analyticsLoading, setAnalyticsLoading] = useState(false);

  async function getToken() {
    const { createClient } = await import("@supabase/supabase-js");
    const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);
    const { data } = await supabase.auth.getSession();
    return data.session?.access_token || "";
  }

  async function refresh() {
    const token = await getToken();
    if (!token) { setLoading(false); return; }
    const response = await fetch("/api/linkedin/status", { headers: { Authorization: "Bearer " + token }, cache: "no-store" });
    const data = await response.json();
    setConnected(Boolean(data.connected));
    setName(data.account?.name || "");
    setLoading(false);
  }

  // eslint-disable-next-line react-hooks/set-state-in-effect, react-hooks/exhaustive-deps
  useEffect(() => { void refresh(); }, []);

  async function connect() {
    setMessage("");
    const token = await getToken();
    if (!token) { setMessage("先にGoogleでログインしてください。"); return; }
    const response = await fetch("/api/linkedin/connect", { headers: { Authorization: "Bearer " + token } });
    const data = await response.json();
    if (!response.ok) { setMessage(data.error || "LinkedIn接続を開始できません。"); return; }
    window.location.href = data.url;
  }

  async function post() {
    setPosting(true); setMessage("");
    try {
      const token = await getToken();
      if (!token) throw new Error("先にGoogleでログインしてください。");
      const response = await fetch("/api/linkedin/post", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
        body: JSON.stringify({ commentary, socialPostId }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "LinkedIn投稿に失敗しました。");
      setPostUrn(data.post?.id || "");
      setMessage("LinkedInへ投稿しました。ID: " + (data.post?.id || "取得済み"));
      setCommentary("");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "LinkedIn投稿に失敗しました。");
    } finally { setPosting(false); }
  }

  if (loading) return null;
  return (
    <section className="social-connect panel">
      <div>
        <p className="eyebrow">LINKEDIN</p>
        <h3>{connected ? "LinkedIn接続済み" + (name ? " · " + name : "") : "LinkedInを広告テスト先に追加"}</h3>
        <p className="muted">AIが決めた次の訴求をLinkedInへ投稿し、テスト結果を次の判断へ戻します。</p>
      </div>
      {!connected ? <button onClick={connect}>LinkedInを接続</button> : (
        <div className="social-post-box">
          <textarea value={commentary} onChange={(e) => setCommentary(e.target.value)} placeholder="LinkedIn投稿本文…" rows={4} />
          <button onClick={post} disabled={posting || !commentary.trim() || !socialPostId}>{posting ? "投稿中…" : "LinkedInへ投稿"}</button>
          {postUrn && <button onClick={async () => { setAnalyticsLoading(true); setMessage(""); try { const token = await getToken(); const response = await fetch("/api/linkedin/analytics", { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + token }, body: JSON.stringify({ socialPostId, postUrn }) }); const data = await response.json(); if (!response.ok) throw new Error(data.error || "LinkedIn実績取得に失敗しました。"); const decisionResponse = await fetch("/api/operator/decision", { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + token }, body: JSON.stringify({ socialPostId }) });
            const decisionData = await decisionResponse.json().catch(() => ({}));
            setMessage(decisionResponse.ok && decisionData.verdict ? "LinkedIn実績を保存し、次の判断: " + decisionData.verdict : "LinkedIn実績を取得し、テスト結果へ保存しました。"); } catch (e) { setMessage(e instanceof Error ? e.message : "LinkedIn実績取得に失敗しました。"); } finally { setAnalyticsLoading(false); } }} disabled={analyticsLoading}>{analyticsLoading ? "取得中…" : "LinkedIn実績を取得"}</button>}
          {!socialPostId && <p className="hint">先に「このテスト計画を保存」するとLinkedIn投稿と実績取得を使えます。</p>}
        </div>
      )}
      {message && <p className="muted">{message}</p>}
    </section>
  );
}
