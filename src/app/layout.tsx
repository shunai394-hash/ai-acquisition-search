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
  title: "AI Acquisition Search | AI集客検索エンジン",
  description: "商品・市場・顧客・競合・実績を分析し、次に取るべき集客アクションを判断するAIシステム。",
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
    title: "AI Acquisition Search | AI集客検索エンジン",
    description: "市場の声から、次の商品と広告を決める。分析・動画・SNS運用をひとつの意思決定ループにつなぐAI集客OS。",
    siteName: "AI Acquisition Search",
  },
  twitter: {
    card: "summary",
    title: "AI Acquisition Search | AI集客検索エンジン",
    description: "市場の声から、次の商品と広告を決めるAI集客OS。",
  },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="ja"><body>{children}<footer className="site-footer"><a href="/terms">利用規約</a><a href="/privacy">プライバシーポリシー</a><a href="/legal">特商法表記</a><a href="/refund">返金・キャンセル</a><a href="/billing">契約・解約</a></footer></body></html>;
}
