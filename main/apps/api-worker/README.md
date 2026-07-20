# Phase 2 API Worker（準備中）

このディレクトリには、Cloudflareへ適用する前にレビューできるD1初期マイグレーションとWrangler設定テンプレートを置く。

- `migrations/0001_initial.sql` はPhase 1契約の制約をD1へ移す
- `wrangler.toml.example` はBinding名と互換日だけを固定する。実ID、ホスト名、Secretは含めない
- Worker実装には`wrangler`とHTTPフレームワークの依存追加が必要なため、ユーザー承認後に開始する

デプロイ前には、対象ゾーン、デバイス用ホスト名、最小権限APIトークン、D1/R2実ID、Accessポリシー、HMAC Secretを別途確認する。
