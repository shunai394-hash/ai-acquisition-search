"use client";

import GoogleSignIn from "@/components/GoogleSignIn";
import BillingButton from "@/components/BillingButton";
import Link from "next/link";

export default function BillingPage() {
  return <main className="shell legal"><p className="eyebrow">BILLING</p><h1>契約・サブスクリプション管理</h1>
    <GoogleSignIn />
    <h2>契約中のお客様</h2><p>Googleでログインしたうえで、Stripeの請求管理画面を開くと、請求情報の確認・支払方法の変更・サブスクリプション解約ができます。</p>
    <BillingButton mode="portal" />
    <h2>解約について</h2><p>解約すると次回更新が停止され、現在の請求期間終了後に有料機能が終了します。返金条件は申込時の表示および返金・キャンセルポリシーに従います。</p>
    <p className="legal-note">アプリを削除しただけではサブスクリプションは解約されません。必ずStripeの請求管理画面から解約してください。</p>
    <Link href="/">← トップへ</Link></main>;
}