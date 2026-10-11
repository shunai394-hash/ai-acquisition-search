import Link from "next/link";
import GoogleSignIn from "@/components/GoogleSignIn";

export const metadata = {
  title: "ログイン | AI Acquisition Search",
  description: "GoogleアカウントでAI Acquisition Searchにログインします。",
};

export default function LoginPage() {
  return (
    <main className="login-page">
      <section className="login-card" aria-labelledby="login-title">
        <Link href="/" className="login-brand">AI Acquisition Search</Link>
        <p className="login-eyebrow">YOUR CREATIVE WORKSPACE</p>
        <h1 id="login-title">アイデアを、映像に。</h1>
        <p className="login-description">ログインして、企画から動画制作までを始めましょう。</p>
        <GoogleSignIn />
        <p className="login-note">ログインできない場合は、SupabaseのGoogle Providerとリダイレクト許可URLの設定を確認してください。</p>
        <Link href="/" className="login-back">トップページに戻る</Link>
      </section>
    </main>
  );
}
