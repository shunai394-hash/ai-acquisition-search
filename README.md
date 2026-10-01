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

### AI Decision / Teacher

`/api/operator/ai-decision`（`src/lib/operator/`）は次の順で「次に何をするか」を決めます。

1. Evidence 収集: 商品（products）、顧客仮説（acquisition_plans）、EC-Pulse の Research / 痛点トレンド / 価格監視、
   投稿実績（post_metrics を指標ごとに統合）、同じ媒体の過去投稿の中央値、仮説系列の PIVOT 履歴。
   判定時点より後に観測されたデータは使いません。
2. Teacher（決定論的ルール `teacher-v2`）: `continue` / `pivot` / `stop` / `wait`。
   - データ不足（公開24時間未満・露出不足・差が出ていない）は `wait`（insufficient_data）。
   - 単発の負けは `pivot`。`stop` は売上・CTR が基準を大きく下回り、かつ同じ系列で2回以上 PIVOT 済みの時だけ。
   - エンゲージメントだけの指標では `stop` しません。
3. 構造化 Decision（action_type, target_customer, hypothesis, reason, expected_outcome, primary_metric,
   learning_objective, priority, evidence, confidence, logic_version, prompt_version, model_version, generated_at）を
   `operator_runs` に保存。同じ入力は `input_hash` で同じ Decision を再利用します。LLM は文章の具体化だけを行い、判定は変えません。
4. `stop` / `wait` では次クリエイティブ・動画を生成しません（`next-creative` も最新 Decision を確認して拒否します）。

精度評価: `npm run backtest`（読み取り専用。Supabase の service role が必要）。

## ローカル開発

```powershell
npm install
npm run build
npm run dev
```

テスト・型検査:

```powershell
npm test
npm run typecheck
npm run lint
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

### Cron / EC-Pulse

```text
CRON_SECRET=...              # Vercel Cron が Authorization: Bearer で送る値
EC_PULSE_API_URL=...         # shunai394-hash/ec-pulse の Production ドメイン
EC_PULSE_API_KEY=...
OPERATOR_EVALUATION_DELAY_HOURS=12
OPERATOR_MAX_EVALUATION_DAYS=30
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
HF_API_KEY_ID=...
HF_API_KEY_SECRET=...
```

APIキーはサーバー側だけで管理し、Gitにコミットしません。

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
