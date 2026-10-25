# SNS自動投稿

`/ops` が投稿運用の画面です。動画の新規生成は使いません。登録済みの動画・画像・投稿文を、接続したTikTokアカウントへ公式APIで送ります。

## マイグレーション

本番データベースに次を適用します。既存テーブルは削除しません。

```text
supabase/migrations/20261024120000_sns_post_queue.sql
```

未適用のときは画面に「マイグレーションが未適用」と出ます。その状態を投稿成功とは扱いません。

## 環境変数

```text
TIKTOK_CLIENT_KEY
TIKTOK_CLIENT_SECRET
TIKTOK_REDIRECT_URI=https://<host>/api/tiktok/callback
TIKTOK_TOKEN_ENCRYPTION_KEY
TIKTOK_PRIVACY_LEVEL=SELF_ONLY
CRON_SECRET
NEXT_PUBLIC_SUPABASE_URL
SUPABASE_SERVICE_ROLE_KEY
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
OPENAI_API_KEY
```

`OPENAI_API_KEY` が無い場合、投稿文は定型案になり、画面にその旨が出ます。投稿自体は実行されません。

`TIKTOK_PRIVACY_LEVEL` の初期値は `SELF_ONLY` です。未審査のTikTokアプリは全員公開を選べないため、ここを `PUBLIC_TO_EVERYONE` にしてもTikTok側が拒否します。

再生数を取るには、TikTokアプリに `video.list` を追加し、`TIKTOK_SCOPES` はまだ使いません。接続時のスコープは `user.info.basic,video.publish` のままです。`video.list` をスコープへ足すと、開発者画面でその権限が有効でない場合に接続そのものが失敗します。権限を有効にしてから接続し直してください。権限が無い間、分析画面は「権限不足」と表示し、数値を0で埋めません。

## スケジューラ

`vercel.json` は `/api/cron/publish-queue` を5分ごとに呼びます。本番の既存Cronと同じ間隔です。即時投稿はジョブ登録時のリクエスト内でも処理します。Vercel Hobby はCronを1日1回までしか許可しないため、そのプランでは `Authorization: Bearer $CRON_SECRET` で同じURLを呼ぶ外部スケジューラが必要です。

即時投稿はキュー登録と同じリクエスト内でも1回処理します。予約投稿はCronが指定時刻以降に処理します。サーバー再起動ではキュー行を消さないため、予約はデータベースに残ります。

最終実行時刻は `/ops` のシステム状態に出ます。記録が無い場合は未稼働です。

## TikTokでできないこと

- 未審査アプリの全員公開
- ドメイン未確認URLへの画像投稿（画像は PULL_FROM_URL のみ。動画は FILE_UPLOAD にフォールバックする）
- 本文だけの投稿
- `video.list` の無いアカウントの再生数取得
- Instagram、Facebook、YouTube、X、LinkedIn へのこのキューからの投稿。ユーザーごとの公式OAuthが未接続のあいだは、アプリ共通トークンで代わりに投稿しません

## 二重投稿

同じidempotency key、処理中ロック、外部APIが受け付けたあとの `publish_accepted_at` で再送を止めます。通信が途中で切れた失敗は、TikTok側に投稿が無いことを確認するまで再試行ボタンを出しません。
