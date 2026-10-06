"use client";

import { useEffect, useState } from "react";
import { createClient, type User } from "@supabase/supabase-js";

export default function GoogleSignIn() {
  const [user, setUser] = useState<User | null>(null);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const publishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

    if (!url || !publishableKey) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setReady(true);
      return;
    }

    const supabase = createClient(url, publishableKey);

    void supabase.auth.getUser().then(({ data }) => {
      setUser(data.user ?? null);
      setReady(true);
    }).catch(() => {
      setError("ログイン状態を確認できませんでした。もう一度お試しください。");
      setReady(true);
    });

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      setUser(session?.user ?? null);
      setBusy(false);
      if (session) setError("");
    });

    return () => subscription.unsubscribe();
  }, []);

  async function signIn() {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const publishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

    if (!url || !publishableKey || busy) return;

    setBusy(true);
    setError("");
    const supabase = createClient(url, publishableKey);
    const { error: authError } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: {
        redirectTo: window.location.origin,
      },
    });

    if (authError) {
      setBusy(false);
      setError("Googleログインを開始できませんでした。もう一度お試しください。");
    }
  }

  async function signOut() {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const publishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

    if (!url || !publishableKey || busy) return;

    setBusy(true);
    setError("");
    const supabase = createClient(url, publishableKey);
    const { error: authError } = await supabase.auth.signOut();
    if (authError) {
      setBusy(false);
      setError("ログアウトに失敗しました。もう一度お試しください。");
      return;
    }
    setUser(null);
    setBusy(false);
  }

  if (!ready) return null;

  return (
    <div aria-live="polite">
      {user ? (
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span>{user.email}</span>
          <button type="button" onClick={signOut} disabled={busy} aria-busy={busy}>
            {busy ? "ログアウト中…" : "ログアウト"}
          </button>
        </div>
      ) : (
        <button type="button" onClick={signIn} disabled={busy} aria-busy={busy}>
          {busy ? "Googleに接続中…" : "Googleでログイン"}
        </button>
      )}
      {error && <p role="alert" style={{ margin: "8px 0 0", color: "#ff9d9d", fontSize: 12 }}>{error}</p>}
    </div>
  );
}
