import type { Metadata, Viewport } from "next";
import "./globals.css";

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#050609",
  colorScheme: "dark",
};

export const metadata: Metadata = {
  title: "AI Acquisition Search | SNS自動投稿オペレーション",
  description: "既存の動画・画像を、接続済みSNSへ安全に予約投稿。投稿キュー、アカウント連携、公開状態、実績の確認をひとつに。",
  applicationName: "AI Acquisition Search",
  category: "business",
  icons: {
    icon: "/icon.svg",
    apple: "/icon.svg",
  },
  manifest: "/manifest.webmanifest",
  robots: { index: true, follow: true },
  openGraph: {
    type: "website",
    locale: "ja_JP",
    title: "AI Acquisition Search | SNSへの投稿を自動化",
    description: "手元のメディアをSNSへ予約投稿し、投稿状況と実際の成果を一元管理。",
    siteName: "AI Acquisition Search",
  },
  twitter: {
    card: "summary",
    title: "AI Acquisition Search | 写真とプロンプトから動画をつくる",
    description: "既存メディアのSNS予約投稿・投稿状況・実績管理をひとつに。",
  },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="ja"><body><a className="skip-link" href="#main-content">メインコンテンツへスキップ</a>{children}<footer className="site-footer"><a href="/terms">利用規約</a><a href="/privacy">プライバシーポリシー</a><a href="/legal">特商法表記</a><a href="/refund">返金・キャンセル</a><a href="/billing">契約・解約</a></footer></body></html>;
}
