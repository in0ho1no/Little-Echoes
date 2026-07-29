# Little Echoes API Worker

このディレクトリには、Cloudflareへ適用する前にレビューできるWorker、D1初期マイグレーション、Wrangler設定テンプレートを置く。

- `migrations/0001_initial.sql` はPhase 1契約の制約をD1へ移す
- `wrangler.template.toml` はBinding名と互換日だけを固定する。実ID、ホスト名、Secretは含めない
- `src/` は管理用・デバイス用ホストをルーター段階で分離し、固定WAV、有限上限、非公開R2、OpenAI解析・日記・画像Workflowを実装する
- 自動テストではOpenAI APIを呼ばず、注入した固定応答だけを使用する

## ローカル実行

Node、pnpm、取得キャッシュ、pnpmストアはすべてWorkspaceの`.tools/`に閉じる。グローバルnpm/pnpm、PATH、レジストリは変更しない。

```powershell
.\scripts\mise-local.ps1
.\scripts\mise-local.ps1 pnpm install --frozen-lockfile
.\scripts\mise-local.ps1 pnpm run types
.\scripts\mise-local.ps1 pnpm run typecheck
.\scripts\mise-local.ps1 pnpm test
```

`mise-local.ps1`はwingetで導入済みのmiseを実行するだけで、miseが作成するNode本体とキャッシュの保存先をWorkspace内へ固定する。`worker-configuration.d.ts`は`pnpm run typecheck`ごとにWranglerが再生成するためGitへ追加しない。

デプロイ前には、対象ゾーン、デバイス用ホスト名、最小権限APIトークン、D1/R2実ID、Accessポリシー、HMAC Secretを別途確認する。`wrangler.toml`とSecret値はGitへ追加しない。

## Cloudflare APIトークンの最小権限

Phase 5の外部ゲート（Secret投入、D1マイグレーション適用、デプロイ）に必要な最小権限。
ダッシュボードの「My Profile → API Tokens → Create Token → Custom token」で作成する。

| スコープ | 権限グループ | レベル | 必要とする操作 |
| --- | --- | --- | --- |
| Account（対象アカウントのみ） | Workers Scripts | Edit | `wrangler deploy`、`wrangler secret put/list`（SecretはWorkerスクリプト設定の一部） |
| Account（対象アカウントのみ） | D1 | Edit | `wrangler d1 migrations apply --remote`、`d1 execute --remote` |
| Account（対象アカウントのみ） | Account Settings | Read | `wrangler whoami`とアカウント解決 |
| Zone（`in0ho1no.com`のみ） | Workers Routes | Edit | `custom_domain = true`の2ホスト（`app.`/`ingest.`）の登録 |

含めない権限: Workers R2 Storage（バケット作成済みで、デプロイ時のBinding接続に権限は不要）、
Workers KV Storage（未使用）、Zone DNS（カスタムドメインのDNSレコードはWorkers Routes経由で管理される）。

作成時の設定:

- Account Resources / Zone Resources は対象アカウントと`in0ho1no.com`だけに限定する
- TTL（有効期限）を設定する。デモ失効日の2026-09-01以前を推奨
- トークン値はファイルへ保存せず、使用するPowerShellセッションでだけ環境変数へ設定する

```powershell
# トークン値は貼り付け入力し、履歴・ファイルへ残さない
$env:CLOUDFLARE_API_TOKEN = Read-Host -MaskInput 'Cloudflare API Token'
.\scripts\mise-local.ps1 pnpm exec wrangler whoami
```

`account_id`は`wrangler.toml`に記載済みのため`CLOUDFLARE_ACCOUNT_ID`は不要。
権限グループ名はCloudflareの権限リファレンスに基づくが、Workflowsのデプロイとインスタンス照会が
Workers Scripts Editでカバーされる点は公式に明記されていない。デプロイ時にAuthorizationエラー
（code 10000系）が出た場合は、エラーメッセージが示す権限グループを1つずつ追加する。

## OpenAI API Secret

`OPENAI_API_KEY`はPCクライアント、Wranglerの`vars`、設定ファイル、ログへ保存しない。CloudflareへのデプロイとSecret投入がユーザー承認済みであることを確認した後、対象WorkerへSecretとして設定する。

```powershell
.\scripts\mise-local.ps1 pnpm exec wrangler secret put OPENAI_API_KEY --config wrangler.toml
.\scripts\mise-local.ps1 pnpm exec wrangler secret list --config wrangler.toml
```

Secret値をコマンドライン引数、PowerShell履歴、リダイレクト先ファイルへ含めない。`secret put`の対話入力を使用する。Secret投入後も、固定サンプル、日次・録音別上限、期限、緊急停止、レビュー、デプロイの各ゲートが完了するまで`DEMO_WRITE_ENABLED=false`を維持する。

解析Workflowは次を固定する。

- 文字起こしは`gpt-4o-transcribe`を`/v1/audio/transcriptions`で使用する
- 単語抽出は`gpt-5.6-luna`のResponses APIと構造化出力を使用する
- Responses APIは`store: false`、`background: false`
- OpenAI SDKは`maxRetries: 0`
- Workflowへ渡すペイロードは`AsyncJob.id`だけで、音声、文字起こし、プロンプト、Secretを保持しない

## Phase 6 日記・画像Workflow

- 日記文は承認済みの文字起こし、確定単語、場面、親メモだけから`gpt-5.6-luna`の構造化出力で生成する
- 画像は親の明示操作だけで`gpt-image-2`を呼び、`1024x1024`、`quality=low`、非公開R2へ固定する
- OpenAI SDKの再試行は0回とし、Workflow側も日記初回2試行、手動再生成1試行、画像1試行へ制限する
- 日記・画像の予約時に承認済み録音と日記の版番号を保存し、外部応答後のD1確定でも同じ版番号とジョブ状態を再確認する
- 画像キーは画像ジョブIDから決定的に導出する。D1確定応答が失われた場合は、ジョブ失敗とD1未参照を原子的に確認できたキーだけを削除する
- 参照のない失敗ジョブと非アクティブ画像の削除は、D1へ成功・失敗・試行数を永続化し、先頭詰まりを起こさない有限なcron収束で回収する
- Workflow起動結果が不明なジョブは同一IDだけを最大3回照合し、D1を終端状態へ収束させる
- 画像cleanupの起動照合もlease付きで最大3回に制限する。`failed`隔離後の再開は、D1参照とR2オブジェクトを管理者が確認し、ユーザー承認を得た場合だけ行う
- 認可済み画像削除と期限後の後始末は`DEMO_WRITE_ENABLED`の停止対象に含めない

`migrations/0003_phase6_diary_image.sql`以降、3つのWorkflow Binding、実D1/R2での障害注入、実OpenAI呼び出し、デプロイ、書き込み有効化は外部ゲートである。ローカルテスト完了だけでは実行せず、ユーザー承認後に1項目ずつ確認する。

## Phase 5依存ライセンス

- `openai` 6.48.0: Apache License 2.0
- `zod` 4.4.3: MIT License

どちらもバージョンを`package.json`と`pnpm-lock.yaml`へ固定する。配布時は各パッケージのライセンス・著作権表示を維持し、最終的な公開リポジトリのライセンス判断とは分離して扱う。

30日後の完全削除は、R2、関連する全D1行、辞典再集計、トゥームストーン、最大3回の総削除予算を同じ削除Workflowで収束させる。Workflow起動結果が不明な場合も新しいIDを作らず、同じIDだけを最大3回照合する。3回とも不明なら録音を非表示のまま隔離して自動操作を停止し、`DELETE_WORKFLOW_DISPATCH_QUARANTINED`を運用確認対象として残す。`queued`/`running`などの非終端状態が24時間続いた場合は旧インスタンスの終了を確認してから、有限予算内の次回試行へ進める。終了結果が不明ならleaseを保持して重複終了要求を防ぎ、3回で同様に隔離する。日次最大10件のうち再調停は最大5件とし、再調停した録音を同じ日次処理の期限候補から除外して、新規削除へ毎回5件以上の枠を残す。

自動テストの成功だけでは書き込みを有効にしない。実Cloudflare Bindingで固定WAVの縦断スライスと30日完全削除を確認し、Fable5レビューと修正後の再検証が完了するまで、実環境でも`DEMO_WRITE_ENABLED=false`を維持する。

## 削除Workflowの隔離検知と復旧手順

`DELETE_WORKFLOW_DISPATCH_QUARANTINED`は「同じ削除ジョブIDの起動・終了照合が3回連続で不明」を意味する。隔離された録音は非表示のまま自動操作が止まるが、**トゥームストーンができるまで削除済みとして扱わない**。Phase 2では自動通知を持たないため、次の手動チェックを実データ書き込み有効化の前提条件とし、デモ期間中は週1回実行する（通知の自動化はPhase 7で判断する）。

1. 検知（隔離ジョブの一覧）:

   ```powershell
   ./.tools/wrangler-local.ps1 d1 execute little-echoes-demo --remote --command "SELECT id, recording_id, updated_at FROM async_jobs WHERE last_error_code = 'DELETE_WORKFLOW_DISPATCH_QUARANTINED'"
   ```

2. 旧Workflowの終端確認。`errored`/`terminated`/`complete`のいずれかであることを確認する。`complete`なのに`recording_tombstones`へ行がない場合は削除未完了として扱い、そのまま手順3へ進む:

   ```powershell
   ./.tools/wrangler-local.ps1 workflows instances describe little-echoes-delete <async_job_id>
   ```

3. 終端を確認できた場合にだけ、同一IDの再調停を再開する（新しいジョブIDは作らない）。次回の日次cronが同じIDで最大3回の予算内から再調停する:

   ```powershell
   ./.tools/wrangler-local.ps1 d1 execute little-echoes-demo --remote --command "UPDATE async_jobs SET dispatch_reconcile_count = 0, last_error_code = NULL, dispatch_lease_until = NULL, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = '<async_job_id>' AND last_error_code = 'DELETE_WORKFLOW_DISPATCH_QUARANTINED'"
   ```

4. 終端を確認できない（Workflowsの状態取得自体が失敗し続ける）場合は再開せず、隔離のまま翌日以降に手順2を再実行する。
