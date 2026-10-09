# video-assets バケットの非公開化手順

生成動画（Supabase Storage `video-assets`）は現在、公開バケットの公開URLで保存されている。
公開バケットでは **URLを知っている人なら誰でも、認証なし・期限なしで動画を取得できる**。

## リスク評価

| 項目 | 状態 |
| --- | --- |
| パスの推測 | `{userId}/{jobId}.mp4`（どちらもUUID）。総当たりでの推測は現実的ではない |
| 一覧取得 | 公開フラグはパス指定のGETのみを許可する。`storage.objects` に select ポリシーがなければ一覧は取れない（ポリシーはリポジトリ管理外のため未確認） |
| URLの流出経路 | `video_assets.video_url` / `creatives.video_url` への保存、ブラウザ履歴、共有・コピーされたリンク、SNSへ渡したURL、ログ |
| 失効 | なし。一度流出したURLは、ファイルを削除するまで有効 |
| 影響 | 未公開の広告クリエイティブや商品画像が第三者に見られる。ユーザー間の分離が「URLを知られないこと」だけに依存している |

## このリポジトリでの対応（コード側・実施済み）

- `/api/video/jobs/[id]`：所有者確認のうえ、`storage_path` から **1時間有効の署名付きURL**（再生用・保存用）を毎回発行する。保存済みの公開URLは返さない。
- `/api/social/publish`：`video-assets` のURLを受け取った場合、パスが本人のものか確認し、**6時間有効の署名付きURLを新たに発行**して TikTok / Instagram / Facebook に渡す。他人のパスは 403。
  - TikTok `PULL_FROM_URL` と Meta の動画取り込みは、投稿API呼び出し後に非同期でダウンロードするため、余裕を持って6時間にしている。
- 動画プレビューは、署名付きURLが失効すると自動で再取得する（最大2回）。
- 署名付きURLは公開バケットでもそのまま使える。そのため **コードを先にデプロイし、その後にバケットを非公開化** すれば、再生・保存・SNS投稿は中断しない。

## 非公開化の手順（本番の変更・要承認）

1. このコードを本番にデプロイし、`/api/health`（`Authorization: Bearer $CRON_SECRET`）が成功することを確認する。
2. 本番で動画の生成 → 再生 → 保存 → SNS投稿（テスト用アカウント・`SELF_ONLY`）を一度確認する。
3. Supabase Dashboard → Storage → `video-assets` → Edit bucket → **Public bucket をオフ** にする。
   SQLで行う場合：`update storage.buckets set public = false where id = 'video-assets';`
4. `/api/health` の `checks.videoAssetsBucket.public` が `false` になったことを確認する。
5. 手順2をもう一度実行し、動画が署名付きURLで再生・投稿できることを確認する。

**影響：** 非公開化の前に共有・保存された公開URL（`/object/public/video-assets/...`）は、非公開化した時点ですべて開けなくなる。これは意図した動作。
アプリ内の表示と投稿は、上記のとおり `storage_path` から署名付きURLを再発行するため影響を受けない。

**ロールバック：** 手順3を元に戻す（Public bucket をオン）。コード側は公開・非公開どちらのバケットでも動作する。

## 未解決

- TikTok `PULL_FROM_URL` では、URLプレフィックスの所有確認が必要。`*.supabase.co` は所有確認できない可能性が高いため、独自ドメイン経由の配信か、`FILE_UPLOAD` 方式への変更が必要（未検証）。
