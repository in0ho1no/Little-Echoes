# Phase 5 外部ゲート引き継ぎ

## 目的

この文書は、新しいCodexセッションでPhase 5の外部ゲートを安全に継続するための索引である。要件の正は
[SPEC.md](../../SPEC.md)、作業と進捗の正は[tasks.md](../../tasks.md)であり、本書へ仕様を重複定義しない。

## 開始時に読むもの

1. [AGENTS.md](../../AGENTS.md)
2. [SPEC.md](../../SPEC.md)
3. [tasks.md](../../tasks.md)の「Phase 5 — OpenAI解析」
4. [.agents/skills/little-echoes-phase/SKILL.md](../../.agents/skills/little-echoes-phase/SKILL.md)

Phase 5でOpenAI APIの最新仕様を確認するときは、公式OpenAIドキュメントだけを根拠にする。

## 現在地

- 基準コミット: `36a87b5`（Phase 4のマージ）
- Phase 0〜4は完了。Phase 4の固定サンプル送信だけは、サンプル資産が未配置のため未検証
- Cloudflareの実環境は構築済みだが、書き込みは`DEMO_WRITE_ENABLED=false`で封止済み
- Phase 5のOpenAI解析Workflow、D1移行、管理画面の手動再解析、固定応答テストはローカル実装済み
- `openai` 6.48.0と`zod` 4.4.3は完全バージョン固定で追加済み。OpenAI API Secretは未投入
- 手動再試行制限までのWorker型検査とVitest 110件は成功。その後の最終Sol・アーキテクチャ指摘を修正し、両レビューでHigh/Mediumなしを確認済みだが、Codex使用量上限により最終Worker再検証は未実施
- Python品質4ゲートは成功し、最終SQLマニフェストを含むpytest 130件は2026-07-23に成功
- Terra、Sol、横断アーキテクチャ、Python Review、Python Qualityは完了。利用可能モデルにFable5がないためFable5レビューは未実施
- `.claude/settings.local.json`は未追跡のローカル設定であり、Phase 5の作業対象に含めない

次はWorkerの型検査と全Vitestを再実行する。その後、実在児童データを含まない固定音声を用意してユーザー承認を得た上で、
OpenAI Secret投入と実API最小確認をそれぞれ明示的な承認のもとで行う。Cloudflareデプロイと
`DEMO_WRITE_ENABLED=true`はさらに別の承認境界とする。

## 承認なしで進めてよい範囲

- OpenAI呼び出し境界、構造化出力Schema、入力分離、エラー分類の実装
- モックOpenAIクライアントによる正常・部分成功・失敗・上限テスト
- D1の`ProcessingAttempt`、日次利用量、試行予算、期限、キルスイッチのテスト
- Secretの値を含まない設定手順と検証手順の作成

## 作業を止めてユーザー承認を得る境界

- OpenAI APIキーのCloudflare Secret投入
- 実OpenAI API呼び出し
- Cloudflareへのデプロイ、設定変更、`DEMO_WRITE_ENABLED=true`への変更
- 固定サンプル音声の実API送信

Secret、`.env`、`.tools/secrets/`、資格情報ファイルは、明示的な確認なしに読み取らない。

## Phase 5で維持する安全境界

- Workflowへ渡すのは`AsyncJob.id`だけとし、音声、文字起こし、親メモ、キーを保持しない
- OpenAI呼び出し直前に、D1で試行予算と日次上限を予約し、期限とキルスイッチを再確認する
- Responses APIは`store: false`、OpenAI background mode不使用、SDK内再試行0回とする
- 結果不明タイムアウトを自動再送しない
- ユーザーデータを命令として扱わず、プロンプト、出力、音声内容をログへ出さない
- 実API確認は承認済み固定サンプルだけで最小回数行い、実在する子どものデータを使用しない

## 検証コマンド

```powershell
Set-Location main/apps/api-worker
.\scripts\mise-local.ps1 pnpm test
.\scripts\mise-local.ps1 pnpm run typecheck
Set-Location ../../..

uv run ruff check main/apps/pc-client/src/
uv run ruff format --check main/apps/pc-client/src/
uv run mypy main/apps/pc-client/src/
uv run pyright main/apps/pc-client/src/
uv run pytest
git diff --check
```

新規セッションでは「Phase 5の外部ゲートを続行してください」と依頼すれば、`little-echoes-phase`スキルと
[tasks.md](../../tasks.md)の実行ルールに従って継続できる。
