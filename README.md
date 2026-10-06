# AI Acquisition Search / AI Brand Operator

**Claude Code拡張機能として動くAI集客・広告運用エージェント**

商品・サービスを理解し、市場・顧客・競合・SNSシグナルから「次に何を出すか」を判断し、専門のクリエイティブ生成サービスとSNS連携につなげるためのAI集客システムです。

## 最終ゴール

このプロジェクトの目的は動画生成ツールを自作することではありません。

**AIが広告運用そのものを担当すること**を目指します。

```
商品・サービス
    ↓
商品理解 / 市場分析 / 顧客分析 / 競合分析
    ↓
広告仮説
    ↓
「誰に・何を・どこで・どう出すか」
    ↓
クリエイティブ制作指示
    ↓
Higgsfield等の専門生成サービス
    ↓
Gemini TTS等でナレーション
    ↓
完成広告
    ↓
各SNSへ投稿・配信
    ↓
CTR / CVR / CPA / ROAS等を取得
    ↓
AIが結果を分析
    ↓
次の広告を決定
    ↓
再制作 → 再投稿
```

## Claude Code拡張機能

現在のPlugin構成:

- `.claude-plugin/plugin.json`
- `.mcp.json`
- `src/mcp/server.ts`
- `skills/ai-brand-operator/SKILL.md`
- `commands/ai-acquire.md`

主な機能:

- `analyze-acquisition` — 商品・市場・顧客・競合・実績を分析
- `generate-narration` — Gemini TTSによるナレーション生成
- `/ai-acquire` — 分析 → 広告仮説 → 制作指示 → 投稿準備までのオーケストレーション

## 動画生成の考え方

動画生成エンジンは自作しません。

HiggsfieldはClaude CodeなどのAIエージェント向けにCLI/Skillsを提供しており、公式MCPも提供しています。したがって、このPluginは集客判断・制作指示を担当し、動画生成は接続されたHiggsfield側へ委譲します。

将来的な接続:

```
AI Brand Operator
       ↓
production brief
       ↓
Higgsfield
       ↓
video asset
       +
Gemini TTS
       ↓
narration
       ↓
final creative
```

## 自動SNS運用

次の段階では、各SNSの**公式APIまたは認可済み連携**を使って、

1. 投稿素材を準備
2. 投稿
3. 投稿ID / URLを保存
4. パフォーマンスを取得
5. AIが評価
6. 次のテストを決定

まで自動化します。

接続されていないSNSについては、投稿済みと偽らず、投稿用ペイロードを生成して「公開待ち」として扱います。

## AI自律運用

最終的には:

```
企画
 ↓
制作
 ↓
投稿
 ↓
計測
 ↓
分析
 ↓
改善
 ↓
次の企画
 ↺
```

を継続的に回します。

人間が設定するのは、商品、予算、ブランドルール、運用範囲などです。

判定ロジック（Evidence → Teacher → CONTINUE / PIVOT / STOP / WAIT → 次アクション）、二重実行防止、本番設定と検証方法は [docs/decision-loop.md](docs/decision-loop.md) を参照してください。

## ローカル開発

```powershell
npm install
npm run build
npm run dev
```

MCPサーバー:

```powershell
npm run mcp
```

## 環境変数

### 集客分析

```text
OPENAI_API_KEY=...
```

### TikTok / TikTok Shopシグナル（任意）

```text
SCRAPE_CREATORS_API_KEY=...
SCRAPE_CREATORS_REGION=JP
SCRAPE_CREATORS_DATE_POSTED=this-month
```

### Gemini TTS（任意）

```text
GEMINI_API_KEY=...
GEMINI_TTS_MODEL=...
GEMINI_TTS_VOICE=Kore
```

モデル名は利用中のGoogle Gemini APIで有効なTTSモデルに合わせて設定してください。

### Higgsfield API（API方式を使う場合）

```text
HIGGSFIELD_API_KEY=...          # 単一キー。旧形式の HF_API_KEY_ID / HF_API_KEY_SECRET も可
# HIGGSFIELD_API_BASE_URL=https://platform.higgsfield.ai   # 既定値（公式ドキュメントのホスト）
# VIDEO_JOB_TIMEOUT_MINUTES=60  # この時間内に完了しない生成は失敗扱いにし、次回巡回で再生成（最小10）
```

APIキーはサーバー側だけで管理し、Gitにコミットしません。キーが未設定の間、自動運用は動画ジョブを「待機」のまま保持し、再試行回数を消費しません。

### 自動運用ループの安全設計

- 動画ジョブは最大2回まで自動生成を試行します。モデレーション拒否（nsfw）は再試行しません。
- 外部サービスで処理済みか不明な状態（生成開始後のDB保存失敗、SNS投稿後のDB保存失敗）は二重生成・二重投稿を避けるため自動再実行せず、画面の「確認が必要なこと」に表示します。
- SNS投稿の前段で失敗した場合は最大3回まで再試行します。
- 投稿は STOP / 次のクリエイティブ作成 / 実績取得の3回連続失敗で巡回対象から外れ、新しい投稿が古い投稿に押し出されません。

## 重要

「Acquisition」は企業買収ではなく、**Customer Acquisition（顧客獲得・集客）**を意味します。

## TikTok自動投稿

TikTokは公式Content Posting APIのDirect Postを使います。投稿にはTikTok側のアプリ登録、Content Posting API、認可済みユーザーの `video.publish` 権限が必要です。未監査クライアントの投稿はTikTokの仕様上、テスト中は非公開に制限される場合があります。

環境変数:

```text
TIKTOK_ACCESS_TOKEN=...
```

MCPツール:

- `tiktok-creator-info` — 投稿可能な公開範囲などを確認
- `tiktok-publish` — HTTPS動画URLをDirect Post
- `tiktok-publish-status` — publish_idの処理状態を確認

動画URL方式を使う場合、TikTokから取得可能なHTTPS公開URLが必要です。AI生成動画は `is_aigc=true` を既定値として送信します。

次のSNSも同じ構造で公式APIを接続します。YouTubeは `videos.insert` によるアップロードが公式に提供されています。

## Deployment

Production deployment is driven from the `main` branch through the connected Vercel project.
