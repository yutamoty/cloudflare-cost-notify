# AGENTS.md (cloudflare-cost-notify)

Cloudflare の日次利用料金および無料枠使用状況を毎日 JST 9:00 に Discord Webhook へ通知する Cloudflare Worker。

## ブランチ・Git ルール

- デフォルトブランチ: `main`
- `.dev.vars` や `.env`、API トークン、Discord Webhook URL は絶対にコミット・出力しない

## ディレクトリ構成

- `src/index.ts`: Cron Trigger (`scheduled`) 本体。Billable Usage API と GraphQL Analytics API を叩き、Discord Embed を送信する
- `wrangler.toml`: Worker 名、Cron スケジュール (`0 0 * * *` UTC = JST 9:00)、`workers_dev = false` の定義
- `.github/workflows/deploy.yml`: `main` push / 手動実行時の型チェックと Cloudflare Workers 自動デプロイ

## よく使うコマンド

```sh
# 型チェック
npm run typecheck

# ローカルで Cron テスト起動
npx wrangler dev --test-scheduled
curl "http://localhost:8787/__scheduled?cron=0+0+*+*+*"

# 手動デプロイ
npm run deploy
```

## 開発ルール

- 毎月 1 日は当月分の集計範囲が成立しないため、前月の累計にフォールバックする（`computeTargetDates` の `isFirstDayOfMonth` 分岐を壊さない）
- GraphQL Analytics API (`fetchFreeTierTelemetry`) が権限不足やデータ欠損で失敗しても、メインの課金通知自体は止めずに `null` としてスキップする
- HTTP エンドポイント（`fetch` ハンドラ）は不要な攻撃面を作らないため実装しない（`workers_dev = false` を維持）
