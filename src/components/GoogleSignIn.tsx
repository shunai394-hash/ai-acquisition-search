"use client";

import { useEffect, useState } from "react";
import { createClient, type SupabaseClient, type User } from "@supabase/supabase-js";

let browserClient: SupabaseClient | null = null;

function getSupabaseBrowserClient(): SupabaseClient | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const publishableKey =
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ??
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!url || !publishableKey) return null;

  if (!browserClient) {
    browserClient = createClient(url, publishableKey, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
      },
    });
  }

  return browserClient;
}

export default function GoogleSignIn() {
  const [user, setUser] = useState<User | null>(null);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    const supabase = getSupabaseBrowserClient();

    if (!supabase) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setError("ログイン設定が未完了です。管理者にお問い合わせください。");
      setReady(true);
      return;
    }

    void supabase.auth
      .getUser()
      .then(({ data, error: authError }) => {
        if (!active) return;
        if (authError) {
          setError("ログイン状態を確認できませんでした。再読み込みしてください。");
          return;
        }
        setUser(data.user ?? null);
      })
      .catch(() => {
        if (active) setError("ログイン状態を確認できませんでした。通信環境を確認してください。");
      })
      .finally(() => {
        if (active) setReady(true);
      });

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      if (active) {
        setUser(session?.user ?? null);
        setError("");
      }
    });

    return () => {
      active = false;
      subscription.unsubscribe();
    };
  }, []);

  async function signIn() {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) {
      setError("ログイン設定が未完了です。管理者にお問い合わせください。");
      return;
    }

    setBusy(true);
    setError("");

    try {
      const { error: authError } = await supabase.auth.signInWithOAuth({
        provider: "google",
        options: {
          // Supabase redirects back to this origin; the browser client then
          // exchanges the OAuth code and persists the session.
          redirectTo: window.location.origin,
        },
      });

      if (authError) setError("Googleログインを開始できませんでした。設定を確認して再試行してください。");
    } catch {
      setError("Googleログインを開始できませんでした。通信環境を確認してください。");
    } finally {
      setBusy(false);
    }
  }

  async function signOut() {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;

    setBusy(true);
    setError("");

    try {
      const { error: authError } = await supabase.auth.signOut();
      if (authError) {
        setError("ログアウトできませんでした。もう一度お試しください。");
        return;
      }
      setUser(null);
    } catch {
      setError("ログアウトできませんでした。通信環境を確認してください。");
    } finally {
      setBusy(false);
    }
  }

  if (!ready) {
    return <p role="status" aria-live="polite">ログイン状態を確認しています…</p>;
  }

  return (
    <div className="google-sign-in" aria-busy={busy}>
      {user ? (
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <span aria-label="ログイン中のアカウント">{user.email ?? "ログイン中"}</span>
          <button type="button" onClick={signOut} disabled={busy}>
            {busy ? "処理中…" : "ログアウト"}
          </button>
        </div>
      ) : (
        <button type="button" onClick={signIn} disabled={busy}>
          {busy ? "Googleに接続中…" : "Googleでログイン"}
        </button>
      )}
      {error ? <p role="alert" aria-live="polite">{error}</p> : null}
    </div>
  );
}
