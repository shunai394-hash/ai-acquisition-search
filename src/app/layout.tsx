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
  title: "AI Acquisition Search | AI動画制作スタジオ",
  description: "文章や画像から、広告・SNSショート・MV・ブランド映像・商品動画などを制作。AIディレクターが企画と演出を整理し、接続済みの生成エンジンで映像制作を支援します。",
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
    title: "AI Acquisition Search | 写真とプロンプトから動画をつくる",
    description: "文章や画像から、広告・SNSショート・MV・ブランド映像・商品動画などを制作。作りたい映像を自分の言葉で指示できます。",
    siteName: "AI Acquisition Search",
  },
  twitter: {
    card: "summary",
    title: "AI Acquisition Search | 写真とプロンプトから動画をつくる",
    description: "画像と自由なプロンプトから動画を生成。作りたい映像を自分の言葉で指示できます。",
  },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="ja"><body><a className="skip-link" href="#main-content">メインコンテンツへスキップ</a>{children}<footer className="site-footer"><a href="/terms">利用規約</a><a href="/privacy">プライバシーポリシー</a><a href="/legal">特商法表記</a><a href="/refund">返金・キャンセル</a><a href="/billing">契約・解約</a></footer></body></html>;
}
