# Phase 2 API Worker

このディレクトリには、Cloudflareへ適用する前にレビューできるWorker、D1初期マイグレーション、Wrangler設定テンプレートを置く。

- `migrations/0001_initial.sql` はPhase 1契約の制約をD1へ移す
- `wrangler.template.toml` はBinding名と互換日だけを固定する。実ID、ホスト名、Secretは含めない
- `src/` は管理用・デバイス用ホストをルーター段階で分離し、固定WAV、有限上限、非公開R2、モック解析Workflowを実装する
- Phase 2ではOpenAI APIを呼ばない。解析結果は固定のモックデータだけである

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

30日後の完全削除は、R2、関連する全D1行、辞典再集計、トゥームストーン、最大3回の総削除予算を同じ削除Workflowで収束させる。Workflow起動結果が不明な場合も新しいIDを作らず、同じIDだけを最大3回照合する。3回とも不明なら録音を非表示のまま隔離して自動操作を停止し、`DELETE_WORKFLOW_DISPATCH_QUARANTINED`を運用確認対象として残す。`queued`/`running`などの非終端状態が24時間続いた場合は旧インスタンスの終了を確認してから、有限予算内の次回試行へ進める。終了結果が不明ならleaseを保持して重複終了要求を防ぎ、3回で同様に隔離する。日次最大10件のうち再調停は最大5件とし、再調停した録音を同じ日次処理の期限候補から除外して、新規削除へ毎回5件以上の枠を残す。

自動テストの成功だけでは書き込みを有効にしない。実Cloudflare Bindingで固定WAVの縦断スライスと30日完全削除を確認し、Fable5レビューと修正後の再検証が完了するまで、実環境でも`DEMO_WRITE_ENABLED=false`を維持する。
