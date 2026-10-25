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
  title: "AI Acquisition Search | AI動画制作・SNS自動投稿",
  description: "商品画像とプロンプトからAI動画を制作。ナレーション・BGMを整え、確認後にTikTokなどのSNSへ予約・自動投稿できる動画制作プラットフォーム。",
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
    title: "AI Acquisition Search | AI動画制作からSNS投稿まで",
    description: "商品画像とプロンプトから動画を制作し、確認後に接続済みSNSへ投稿。生成・公開・実績を一元管理。",
    siteName: "AI Acquisition Search",
  },
  twitter: {
    card: "summary",
    title: "AI Acquisition Search | AI動画制作・SNS自動投稿",
    description: "AI動画制作からSNS予約投稿、公開状況と実績管理までをひとつに。",
  },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="ja"><body><a className="skip-link" href="#main-content">メインコンテンツへスキップ</a>{children}<footer className="site-footer"><a href="/terms">利用規約</a><a href="/privacy">プライバシーポリシー</a><a href="/legal">特商法表記</a><a href="/refund">返金・キャンセル</a><a href="/billing">契約・解約</a></footer></body></html>;
}
