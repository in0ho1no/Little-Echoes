# Phase 6 外部ゲート実施手順（ユーザー承認後に1項目ずつ実施）

ローカルゲートは全て通過済み（tasks.md参照）。本書は実Cloudflare/実OpenAIに対する残作業の手順と検証クエリをまとめる。各節はユーザー承認を得てから実行する。

## 0. 前提確認（読み取りのみ・コスト無し）

```powershell
.\scripts\mise-local.ps1 pnpm exec wrangler whoami
.\scripts\mise-local.ps1 pnpm exec wrangler secret list        # DEVICE_TOKEN_HMAC_SECRET / OPENAI_API_KEY の2件
.\scripts\mise-local.ps1 pnpm exec wrangler deploy --dry-run   # 5 Workflow binding・2 crons・DEMO_WRITE_ENABLED=false を目視
```

- APIトークン失効日: 2026-08-31（README「最小権限」表参照）。
- ブランチ: Phase6の最新コミットで実施する。

## 1. D1マイグレーション 0003〜0007 のremote適用

既知の癖（Phase 2/5実証）: `wrangler d1 migrations apply --remote` はトリガーを含むファイルで
`incomplete input` になる。確立済み手順どおり `d1 execute --file` で1ファイルずつ適用し、
`d1_migrations` へ手動記録する。全ファイル追加のみで破壊的変更はない。

```powershell
# 0003 → 0007 の順に1つずつ
.\scripts\mise-local.ps1 pnpm exec wrangler d1 execute little-echoes-demo --remote --file .\migrations\0003_phase6_diary_image.sql
# ...0004, 0005, 0006, 0007 も同様...
# 各適用後に d1_migrations へ記録（idは連番、nameはファイル名）
.\scripts\mise-local.ps1 pnpm exec wrangler d1 execute little-echoes-demo --remote --command "INSERT INTO d1_migrations (name, applied_at) VALUES ('0003_phase6_diary_image.sql', datetime('now'));"
```

適用後の検証クエリ（全オブジェクトの実在確認）:

```sql
SELECT name, type FROM sqlite_master WHERE name IN (
  'reserve_diary_openai_daily_limit','reserve_image_generation_limits',   -- 0003 trigger×2
  'image_cleanup_jobs','image_cleanup_pending','one_manual_diary_retry',  -- 0004 table+index×2
  'diary_image_dispatch_reconcile',                                        -- 0005 index
  'image_orphan_cleanup_pending','image_cleanup_dispatch_reconcile',       -- 0006 index×2
  'r2_sweep_cursors'                                                       -- 0007 table
) ORDER BY name;
-- 新列の確認
PRAGMA table_info(diary_entries);      -- last_generation_error
PRAGMA table_info(async_jobs);         -- expected_recording_version / expected_diary_version / orphan_cleanup_*
PRAGMA table_info(image_cleanup_jobs); -- dispatch_reconcile_count / dispatch_lease_until
```

## 2. デプロイ（書き込み封止のまま）

`wrangler deploy` で新規Workflow 3件（`little-echoes-diary` / `little-echoes-image` /
`little-echoes-image-cleanup`）と毎時cron `47 * * * *` が登録される。疎通確認:

- `app.in0ho1no.com` → Accessログインへ302（保護維持）
- `ingest.in0ho1no.com` 未定義GET → 404
- 管理画面トップに「絵日記」リンク、`/diary` が空一覧を表示
- PCクライアントの固定サンプル送信 → 403 `DEMO_WRITE_DISABLED`（封止維持の実測）

## 3. 書き込み一時解放と実OpenAI最小確認

解放前に必ず確認（自動バックフィルのコスト見積り）:

```sql
-- 解放直後、承認経路/毎時cronが diary_status='not_started' の承認済み録音へ
-- 初回日記を自動生成する（設計どおり・録音ごと1回・gpt-5.6-luna呼び出し1回）
SELECT COUNT(*) AS backfill FROM recordings WHERE review_status='approved' AND diary_status='not_started';
```

`DEMO_WRITE_ENABLED=true` で再デプロイ後、最小確認セット（各上限: 非画像日次100・画像日次20・録音別画像5）:

1. 日記自動生成の完走（`/diary` で `generating` → 日記文表示、インジケーター段階変化の目視）
2. 手動再生成1回（`manual_retry`消費と2回目の409を確認）
3. 画像生成1回（初回確認ダイアログ → 1024x1024 low、120秒タイムアウト内の完走）
4. 画像置換1回（サムネイル付きダイアログ → 新画像保存成功後の切替 → 旧画像cleanup完走を `image_cleanup_jobs.status='succeeded'` で確認）
5. 画像削除1回（`image_status='not_requested'` へ戻る）
6. 障害注入（最小）:
   - 画像生成中に録音削除 → `DELETE_REQUESTED` 終端とquiesce後のR2 purgeを確認
   - ダッシュボードで生成Workflowを手動terminate → 毎時cron/画面GETの再調停で `WORKFLOW_DISPATCH_UNKNOWN` 収束を確認
7. 使用量照合: `usage_counters` / `openai_call_reservations` が呼び出し実績と一致すること

画像1枚あたりの課金はgpt-image系low/1024x1024で数セント程度、日記文はgpt-5.6-luna数百トークン。
全セットで画像2〜3枚・テキスト数回に収まる想定。

## 4. 再封止

`DEMO_WRITE_ENABLED=false` で再デプロイし、PCクライアント固定サンプル送信の403
`DEMO_WRITE_DISABLED` 定義文表示を実測する。実施結果（Version ID・確認項目・使用量）を
tasks.mdへ記録する。

## 復旧メモ

- マイグレーションは追加のみ。適用途中で失敗した場合は `sqlite_master` で作成済みオブジェクトを
  確認し、未作成分だけを個別 `--command` で適用する（0001/0002と同じ運用）。
- 新Workflowはジョブ未投入なら無害。cron追加分は再調停のみで書き込み封止に影響しない。
- `DELETE_WORKFLOW_DISPATCH_QUARANTINED` の検知・復旧はREADME既存手順に従う。
