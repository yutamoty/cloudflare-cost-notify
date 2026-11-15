# cloudflare-cost-notify

Cloudflare の日次利用料金と無料枠の使用状況を Discord に通知する仕組み（`aws-cost-nofty` / `gcp-cost-notify` の Cloudflare 版）。

Cloudflare Workers の Cron Triggers で毎日 JST 9:00 (`0 0 * * *` UTC) に起動し、Billable Usage API と GraphQL Analytics API からコスト・使用量を取得して Discord Webhook へ送信します。

## 特徴

- **課金検知**: Billable Usage API で昨日・前日比・今月累計の課金額を取得し、しきい値（デフォルト `$0.00`）を超えると赤色のアラート通知を送信
- **無料枠の見える化**: GraphQL Analytics API から今月の Workers リクエスト数、R2 ストレージ容量、R2 Class A / B 操作回数を併記
- **低コスト**: Cloudflare Workers の無料枠内で完結し、外部公開用の HTTP エンドポイントは持たない（`workers_dev = false`）

## セットアップ

### 1. Cloudflare API トークンの作成

Cloudflare ダッシュボード（My Profile → API Tokens → Create Custom Token）で、以下の権限を持つトークンを作成します。

- Account / **Billing**: `Read`（必須: 課金額の取得）
- Account / **Account Analytics**: `Read`（任意: Workers / R2 の無料枠使用状況を表示する場合）

### 2. シークレットの設定

Worker に以下のシークレットを登録します（GitHub Actions で初回デプロイ後、Cloudflare ダッシュボードの Workers Settings → Variables and Secrets、または `npx wrangler secret put` で設定）。

- `CF_API_TOKEN`: 上記で作成した API トークン
- `CF_ACCOUNT_ID`: Cloudflare の Account ID
- `DISCORD_WEBHOOK_URL`: 通知先の Discord Webhook URL
- `ALERT_THRESHOLD_USD`: 任意（デフォルト `0`。この金額を超えると赤色アラート表示）

### 3. GitHub Actions 自動デプロイ

GitHub リポジトリの Secrets に以下を登録すると、`main` ブランチへの push 時に自動で型チェックとデプロイが実行されます。

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`

## ローカル動作確認

```sh
npm install
cp .dev.vars.example .dev.vars
# .dev.vars に値を設定
npx wrangler dev --test-scheduled
# 別ターミナルから Cron を手動発火
curl "http://localhost:8787/__scheduled?cron=0+0+*+*+*"
```
