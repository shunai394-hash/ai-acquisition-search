import Link from "next/link";
import GoogleSignIn from "@/components/GoogleSignIn";
import styles from "./login.module.css";

export const metadata = {
  title: "ログイン | AI Acquisition Search",
  description: "GoogleアカウントでAI Acquisition Searchにログインします。",
};

export default function LoginPage() {
  return (
    <main className={styles.page}>
      <section className={styles.card} aria-labelledby="login-title">
        <Link href="/" className={styles.brand}>AI Acquisition Search</Link>
        <p className={styles.eyebrow}>YOUR CREATIVE WORKSPACE</p>
        <h1 id="login-title" className={styles.title}>アイデアを、映像に。</h1>
        <p className={styles.description}>ログインして、企画から動画制作までを始めましょう。</p>
        <div className={styles.signIn}><GoogleSignIn /></div>
        <p className={styles.note}>ログインできない場合は、SupabaseのGoogle Providerとリダイレクト許可URLの設定を確認してください。</p>
        <Link href="/" className={styles.back}>トップページに戻る</Link>
      </section>
    </main>
  );
}
