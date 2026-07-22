# Little Echoes — 実行計画

## 文書の役割

本書はPhaseごとの作業、進捗、検証、レビュー、提出準備を定める実行計画である。プロダクト要件、アーキテクチャ、API・データ契約、セキュリティ要件、受入条件は [SPEC.md](SPEC.md) を正とする。仕様・安全性・コスト・プライバシーを変える場合は、実装前に `SPEC.md` を更新する。

## Phase 実行ルール

`Phase Nを実施してください` の指示を受けたら、次の順で進める。

1. `AGENTS.md`、`SPEC.md`、本書、対象Phaseの入口条件を確認する。
2. 未決の製品判断、依存追加、設定変更、外部認証情報だけを確認する。
3. 小さくレビュー可能な単位で実装し、必要最小限の自動検証を行う。
4. Terra実装、Sol独立レビュー、利用可能な場合のFable5レビューを行い、採用した修正後に再検証する。
5. 実施結果と残る入口条件を本書へ記録する。Fable5が使えない場合は未実施として明記し、完了とは扱わない。

Python変更時は既存のPython Quality/Reviewエージェントを、横断的な設計変更時は `ag-little-echoes-architecture-review` を使う。

## Phase の状態

| Phase | 状態 | 根拠・入口条件 |
| --- | --- | --- |
| 0 — ベースライン | 完了（提出用Session IDは未取得） | README、参照境界、基準コミットを整備。`61a122b` |
| 1 — 契約・安全性・データ設計 | 完了 | 管理系GET応答スキーマとOpenAPI入力の契約テストを含む。Phase 1Aは並行して実施可能 |
| 1A — PC音声スパイク | 完了 | 実装・品質確認・Sol/Fable5レビュー・実機確認済み。知見はSPECへ反映済み |
| 2 — 固定データ縦断スライス | 完了 | 実デプロイ・実D1・縦断E2E・スマホ実機再生・キルスイッチ実測・Fable5レビュー2回と修正済み。書き込みは`DEMO_WRITE_ENABLED=false`で封止。実データの書き込み有効化は隔離チェック（README手順）を前提条件とする |
| 3 — 承認・日時・辞典 | ローカル完了（Fable5レビュー・修正済み） | High 2件を含む指摘を修正し再検証済み。実デプロイと実環境での承認E2E（書き込み一時有効化を含む）が未実施 |
| 4 — PC参照クライアント | 未着手 | Phase 1Aの知見を仕様へ反映後 |
| 5 — OpenAI解析 | 未着手 | モック縦断スライスとコスト制御の確認後 |
| 6 — 日記・画像 | 未着手 | 承認フロー確認後 |
| 7 — セキュリティ・提出強化 | 未着手 | 中核フロー完了後 |
| 8 — Atom VoiceS3R | 任意 | PC・バックエンド・Webが安定後 |

## Phase 0 — ベースライン

- [x] 公開リポジトリ方針、参照実装境界、Build Weekの範囲をREADMEへ記録。
- [x] `reference/`を実行時依存にしない方針を記録。
- [ ] 提出に必要な `/feedback` Session IDを保存。

## Phase 1 — 契約・安全性・データ設計

1. 脅威モデルとデータフローを作成する。
2. 状態遷移表・図とAPIスキーマを同期する。
3. Recording、Transcript、WordCandidate、WordOccurrence、DiaryEntry、DiaryImage、DictionaryWord、ProcessingAttempt、AsyncJob、UsageCounterを定義する。
4. OpenAPIまたはJSON Schemaと共通エラー形式を定義する。
5. D1スキーマ、ユニーク制約、外部キー、トランザクション境界を定義する。
6. 非公開R2キー形式、保持・削除を定義する。
7. 管理/デバイス経路、Access JWT検証、デバイストークン認可を定義する。
8. WorkflowのID・状態・有限再試行・D1整合性を定義する。
9. 冪等性、楽観ロック、録音別/日別上限、期限、緊急停止を定義する。
10. `store: false`、OpenAI background mode不使用、開示事項を定義する。
11. サンプルJSONと契約テストを追加する。

### Phase 1 の進捗（2026-07-20）

- [x] 脅威モデル、データフロー、D1/R2、認可、Workflow、冪等性、上限、エラー、テスト観点を [phase1-contracts.md](main/docs/phase1-contracts.md) に記録。
- [x] 13経路の機械可読な共有API契約を [openapi.json](main/packages/shared/api/openapi.json) に追加し、JSON構造を検証。
- [x] Solレビューで見つかった世帯分離、全体/生涯上限、アップロード冪等性、最小トゥームストーン、デバイス応答範囲を修正。High指摘なし。
- [x] Python配置を `main/apps/pc-client/src/` とし、品質設定を同じ配置へ更新。
- [x] Fable5レビューを実施（2026-07-20）。High指摘なし。Medium 3件: (1) D1/OpenAPIの`pre_roll`0–10・`post_roll`0–5上限がSPECの可変範囲（バッファ5〜15秒、操作後変更可）と矛盾、(2) SPEC「記録作成 送信内容」の`source_type`/`source_id`/`captured_at_source`はOpenAPIどおりトークン・サーバー導出へ更新が必要、(3) 管理系GET（確認キュー詳細・日記・辞典）の応答スキーマが未定義で契約テストの前提を満たさない。Minor: 契約書の必須エラー一覧に`IDEMPOTENCY_CONFLICT`欠落、DELETE要求のJSON本文はプロキシで欠落し得るため実装時注意、旧`main/src/`空スキャフォールドの削除推奨。
- [x] Fable5指摘を反映（2026-07-20）。SPECを記録秒数10/5固定へ変更、送信内容をサーバー導出へ更新、契約書エラー一覧へ`IDEMPOTENCY_CONFLICT`追記、旧`main/src/`を削除。DELETE本文のプロキシ互換は実装時に問題が出た場合だけ`If-Match`等へ変更する。
- [x] 管理系GET（確認キュー詳細・日記・辞典）の応答スキーマをopenapi.jsonへ定義。
- [x] OpenAPIを入力にした実行可能な契約テストを追加（5関数）。
- [x] Phase 1品質確認: `ruff`、`mypy`、`pyright`、`pytest`を実行。Fable5レビューとSolレビューの指摘を反映。
- [x] Fable5レビュー第2回を実施（2026-07-20、`ed7334d`対象）。5テスト成功・品質ゲート通過・R2キー露出ゼロ・`allOf`平坦化を確認。High指摘なし。Medium 2件: (1) 下書きの`scene`/`parent_note`がGET応答に存在せず、D1上の保存先も未規定のため下書きの往復が閉じない、(2) `ReviewQueueItem`に失敗理由・再試行可否（error/ジョブ概要）がなくSPEC確認画面要件と不整合。Minor: ハンドロール検証器は未対応キーワードを沈黙passするため、`jsonschema`依存追加かキーワード制限ガードテストのどちらかを選ぶ。
- [x] Fable5第2回指摘を反映（2026-07-20）。`recordings`へ`draft_scene`/`draft_parent_note`列（`draft_`接頭辞で将来拡張）、`ReviewQueueItem`へ`scene`/`parent_note`、`ManagementRecording`へ`error`/`async_job`概要を追加。検証器は依存追加せずキーワード制限ガードテストで保護。6テスト成功、ruff/mypy/pyright通過。

## Phase 1A — PC音声スパイク

クラウド非接続の単体スクリプトとして半日で区切る。`sounddevice` 0.5.5は承認・lock済み。

1. 入力デバイスを列挙する。
2. 24 kHz入力と48 kHzフォールバックを確認する。
3. `RawInputStream` の `bytes` で10秒の上書きリングバッファを実装する。
4. 1.5秒長押し、5秒後録り、24 kHz/16-bit/mono WAV保存を実装する。
5. GUI/コールバック/ワーカー分離、切断検出、1回だけの自動再接続を確認する。

完了条件: コールバックでブロッキングI/Oをしないこと、前の音声を含むWAVを繰り返し作れること、デモPCで24 kHz直接または48 kHzフォールバックが動くこと、知見を製品統合前に `SPEC.md` へ反映すること。

実施記録（2026-07-20）:

- [x] `audio/spike.py`へ、`RawInputStream`の`bytes`入力、10秒リングバッファ、1.5秒長押し、5秒後録り、24 kHz基準WAV、48→24 kHz隣接平均変換を実装。クラウド接続・秘密情報の読み取り・送信は行わない。
- [x] `status`と`finished_callback`で入力異常を検知し、後録り中の切断では取得済み範囲を保存する。記録開始前の切断は既定デバイスで1回だけ再接続を試し、既存の10秒バッファを保持する。
- [x] Terra実装相当の作業、Sol独立レビュー、および指摘修正を実施。Sol指摘のバッファ保持、切断時保存、終了通知、容量境界を反映した。
- [x] `ruff check`、`ruff format --check`、`mypy`、`pyright`、`pytest`を実行し、16テストを通過。
- [x] Fable5レビューを実施（2026-07-20、`6eb4d11`対象）。16テスト成功・ruff/format/mypy/pyright通過を確認。High指摘なし。Medium 1件: statusフラグ付きコールバックが当該音声ブロックごと破棄して欠落を拡大する（status記録+`append`継続へ修正推奨）。Phase 4への引き継ぎ3件: (1) クリップ確定を解放時点でなく長押し成立時点（press+1.5秒タイマー）に変更する、(2) 例外を伴わないストリーム停止（`finished_callback`のみ発火）を再接続トリガーに含める、(3) `status_messages`の有界化。
- [x] Fable5指摘を修正（2026-07-21）。status付きブロックを破棄せず記録+append継続へ変更、クリップ確定を長押し成立時点（押下+1.5秒、解放を待たない）へ変更、`finished_callback`のみのストリーム停止を`InputStreamStoppedError`として再接続経路へ接続、`status_messages`を`deque(maxlen=16)`で有界化。16テスト成功、ruff/format/mypy/pyright通過。
- [x] 実機確認で小さい録音音量を検出したため、クリップ確定後にだけ働く上限付きローカル増幅を追加。最大8倍、目標ピーク27,000、ピーク256未満は非増幅とし、OS入力レベルを優先する。外部送信・依存追加なし。
- [x] 初回のデモPC確認（2026-07-21）で、起動直後とEnter後の音声は保存できた。一方、コンソールの物理的なEnter長押しは`input()`で検出できず、後録り確認には使えないことを確認した。
- [x] 実機確認をFable5が検証（2026-07-21）。`capture.wav`は24 kHz/16-bit/mono・14.99秒で、操作前区間（4〜9秒に発話）と後録り区間（11〜14秒に発話）の両方を保存。クリッピング0、DCオフセットなし、増幅は上限8倍で適用済み（補正前ピーク約3%FS→補正後22%FS。デモ時はOS入力レベルの引き上げを推奨）。デモPC既定入力（AudioBox Go）は24 kHz/48 kHzとも受理を実測し、24 kHz直接入力に確定。キャプチャ形式・レベル補正・CLI長押し模擬の限界を`SPEC.md`へ反映済み。20テスト成功、ruff/format/mypy/pyright通過。確認済みの録音ファイル`capture.wav`は削除してよい。

## Phase 2 — 固定データ縦断スライス

- [x] Cloudflareアカウント、対象ゾーン、管理用・デバイス用ホスト名、デプロイ先環境を確認する。新規アカウント作成、ゾーン変更、DNS変更、Secret投入、課金プラン変更はユーザー承認後にだけ実施する。
- [x] Worker、D1、非公開R2、Workflowsのローカル構成を追加し、Wranglerの`compatibility_date`と全Binding名を固定する。実Workflow作成は安全要件完了後のデプロイ時に行う。
- [x] D1マイグレーションを実装し、Phase 1の制約・外部キー・ユニーク制約・インデックスをローカルで適用する。
- [x] 管理用/デバイス用ホストの許可表をルーターへ実装し、HTTPS以外と想定外のホスト・メソッド・パスをdeny-by-defaultで拒否する。
- [x] Access JWTの署名・`iss`・`aud`・`exp`検証と、デバイストークンのHMAC照合・権限・期限・キルスイッチ検証を実装する。平文トークンは保存・ログ出力しない。
- [x] 録音作成APIを実装し、WAV形式/20秒/1,100,000 bytes、`client_capture_id`、日次上限、R2予約と冪等性を検証する（生涯上限はSPEC上、画像の録音別通算のみでPhase 6対象）。
- [x] 固定WAVだけを非公開R2へ保存し、D1へ`Recording`と`AsyncJob`を作成する。実在の子どもの音声・OpenAI APIは使わない。
- [x] Workflowsでモック解析を非同期実装し、`202 Accepted`、状態ポーリング、有限再試行、`pending`/`succeeded`/`failed`/`partial`をD1へ収束させる。
- [x] 固定のモック文字起こし・単語候補を返す管理API、認可済み音声再生、確認待ち一覧/詳細の最小Web画面、待機・失敗・復旧表示を実装する。
- [x] 同一`client_capture_id`、同一`AsyncJob.id`、世帯・デバイス越境、失効済みトークン、不正WAV、上限超過を自動テストする。
- [x] 固定WAV→`202`→Workflow→確認待ち表示の縦断テストを実行し、Terra実装・Solレビュー・Fable5レビュー・修正後の再検証を記録する。

このPhaseではOpenAI APIを呼ばない。Workflowsで半日を超える統合障害が起きた場合だけ、縮退経路を`SPEC.md`へ事前記録し、ユーザー判断を得る。

### Phase 2の進捗（2026-07-21）

- [x] `main/apps/api-worker/migrations/0001_initial.sql`へ、Phase 1のD1テーブル・制約・インデックスを初期マイグレーションとして追加。
- [x] 実ID、ホスト名、Secretを含まない`wrangler.template.toml`とデプロイ前提のREADMEを追加。
- [x] SQLiteメモリDBでマイグレーション適用と20秒録音上限を検証するテストを追加。Python品質検査とpytest 22件を通過。
- [x] Workspace内mise/Node/pnpm環境、Worker/API、Access JWT、HMACデバイス認証、D1/R2、モック解析Workflow、管理画面をTerraで実装し、Solレビューの重大指摘を修正。
- [x] Sol修正後にVitest 25件、pytest 22件、Ruff、format、mypy、pyright、Wrangler dry-run、`git diff --check`を再実行して成功（2026-07-21）。
- [x] Cloudflare Workers無料プランとR2 Standardを確認し、非公開R2バケット`little-echoes-demo-media`とAPAC D1データベース`little-echoes-demo`を作成。Worker公開、DNS変更、Secret投入、書き込み有効化は未実施。
- [x] R2、全子表、辞典再集計、トゥームストーン、最大3回の有限再試行を一体化した30日完全削除Workflowを実装する。手動削除と1日1回・最大10件の期限削除予約を共通化し、`DEMO_WRITE_ENABLED=false`でも後始末を実行する。
- [x] 承認後にTypeScript 5.9.3（Apache-2.0）をWorkspace内の開発依存として追加し、Wrangler公式型を都度生成する`pnpm run typecheck`（`tsc --noEmit`）を品質ゲートへ追加する。
- [x] Sol独立レビューで、削除Workflowの同一ID再調停、総削除予算3回、同時実行lease、期限候補の枯渇行除外、実行中処理の無効化、辞典の`captured_at`順再計算を修正。最終確認で、起動・終了不明3回後の同一ID隔離、24時間停止時の旧Workflow終了確認、日次10件中再調停最大5件と同一cron内除外による公平性を追加。Vitest 39件、pytest 24件、Python品質4ゲート、TypeScript型検査、Wrangler dry-run、公式生成型の再現性を確認（2026-07-22）。
- [x] Fable5レビュー第1回を実施（2026-07-22、`c36e553`対象）。全検証ゲートの再現（Vitest 39件、pytest 24件、ruff/format/mypy/pyright、`tsc --noEmit`）と、読み取り専用APIによるD1 `little-echoes-demo`・R2 `little-echoes-demo-media`の実在・トークン有効を確認（D1はテーブル数0＝実環境マイグレーション未適用）。High 1件: 解析ステップのat-least-once再実行で、前回attemptが`running`のまま残ると再実行側が自attemptを同時実行と誤認してジョブのみ`failed`（`STALE_ANALYSIS_JOB`）とし、録音が`transcribing`で恒久停止する。以後`/process`は500固定で、SPECの状態取得APIによる非終端ジョブ収束（SPEC 1177）が未実装。Medium 3件: (1) R2保存前クラッシュで`upload_status='reserved'`が収束せず同一`client_capture_id`が409固定（SPEC 887の`failed`収束が未実装）、(2) `delete_failed`が確認待ち一覧・詳細のどこにも表示されず手動再削除へ到達できない（cron再試行は最長30日後）、(3) キルスイッチ`DEMO_WRITE_ENABLED`と2026-09-01期限のnegativeテスト欠落。Minor: 音声/review.js応答の相関IDヘッダーキー誤記（計算プロパティでなく文字列キー）、review.jsへのCSP/nosniff欠落、音声のHTTP Range未対応（スマートフォン実機再生の確認要）、Workflows `retries.limit`意味論の公式確認記録なし（SPEC 701）、`jwtVerify`の許可アルゴリズム未固定、相関ID接頭辞のSPEC`corr_`とコード`cor_`不整合、tasks.md「生涯上限」のSPEC未定義。Pythonテスト構造: 20秒上限テストが任意のIntegrityErrorで通る偽陽性構造、ユニーク制約・トリガーの未検証。
- [x] Fable5指摘のうち明白な不具合を即日修正（2026-07-22）。相関IDヘッダーを`[CORRELATION_ID_HEADER]`計算プロパティへ修正し、review.js応答へCSP/nosniff/Referrer-Policyを追加。キルスイッチ403、期限境界（2026-08-31T15:00Z）、相関ヘッダー回帰、冪等キー・非終端ジョブユニーク制約、日次30件トリガーの31件目拒否と翌UTC日リセット、attempt活性化トリガーの並行拒否、duration境界（20.0受理/20.1拒否・match付き）のテストを追加。Vitest 42件、pytest 28件、Python品質4ゲート、TypeScript型検査を再実行して成功。
- [x] Fable5のHigh 1件とMedium (1)(2)を安全側で実装（2026-07-22、`ab8062a`）。SPECへ収束仕様を先に追記（解析15分・削除24時間の想定時間、`reserved`10分収束、ステップ再実行時の自attempt引き取り＝ジョブ終端化が結果と同一原子バッチのため非終端なら未コミットと判定）。実装は (1) ステップ再実行時に同一ジョブのrunning attemptを`STEP_REEXECUTED`で終端して予算内で再開、(2) 状態取得APIで15分停止ジョブをWorkflow照合し終了済みなら`UPSTREAM_RESULT_UNKNOWN`で`failed`へ収束（実行中確認時は`updated_at`更新のみ、照合不明時は無変更）、(3) `reserved`10分超を同一`client_capture_id`再送時に`failed`へ原子収束、(4) review-queueへ`failed_deletions`（recording_id/captured_at/version）を追加しreview.jsに削除再試行ボタンを実装、(5) Access JWTをRS256固定。Vitest 52件・pytest 28件・型検査・Python品質4ゲート通過。
- [x] 実Cloudflareへデプロイし縦断確認を完了（2026-07-22、ユーザー承認済み）。実D1へマイグレーション適用（17テーブル。`wrangler d1 migrations apply --remote`はトリガーで`incomplete input`となる既知の癖があり、`d1 execute --file`で適用して`d1_migrations`へ手動記録。`PRAGMA foreign_keys`は実D1が受理）。`DEVICE_TOKEN_HMAC_SECRET`をSecret投入、カスタムドメイン`app.in0ho1no.com`（Access保護・302確認）と`ingest.in0ho1no.com`を作成。縦断確認: 固定WAV作成201→冪等再送200→`/process`202→Workflow→`ready`、D1にモック文字起こし・単語候補、想定外パス404、キルスイッチ403。実環境でのみ再現する重大バグを発見・修正（`44f7ad7`）: D1の`meta.changes`はBEFORE INSERTトリガーの書き込みを含むため`===1`厳密比較が誤作動し、録音作成が常に409・解析が常に失敗した。`changes===0`のみを未挿入と判定するよう修正し回帰テスト追加。stale `reserved`収束も本番で実証（初回409で詰まった行が10分後の再送で自動復旧し200）。検証後に`DEMO_WRITE_ENABLED=false`へ戻して再デプロイ、403を実測。デバイストークン・HMAC Secret・シードSQLはgitignore済み`.tools/secrets/`に保存。管理者はAccess `user_uuid`を`management_principals`へ登録済み。
- [x] `DELETE_WORKFLOW_DISPATCH_QUARANTINED`の検知・復旧手順を`main/apps/api-worker/README.md`へ整備（2026-07-22）。検知クエリ、旧Workflowの終端確認、同一IDでの再調停再開SQL、終端不明時は再開しない規則を記載。Phase 2は手動チェック（実データ書き込み有効化の前提条件＋デモ期間中週1回）とし、通知自動化はPhase 7で判断する。隔離データを削除済みとは扱わない。
- [x] スマートフォン実機の音声再生を確認（2026-07-22、ユーザー実測）。PCブラウザとiPhone 15 Plus Safariの両方で、`ready`/`pending`の録音のテストトーン再生とモック文字起こし「りんご、たべたい」の表示を確認。現行の2秒WAVはHTTP Range未対応のままiOS Safariで再生可能。20秒・約1.1MBの実サイズWAVでの再生はPhase 4以降のデモ準備時に再確認する。
- [x] Fable5レビュー第2回を実施（2026-07-22、`c36e553..a0087db`と実デプロイ差分対象、独立エージェント併用）。High 0件、Medium 2件、Minor 4件。Medium両方を即日修正し再デプロイ（`d038345`）: (1) 15分収束バッチのrecordings更新をジョブ終端化の成立へ連動させ（`EXISTS(job failed)`ガード＋`meta.changes`確認で`converged`判定）、並行着地したsucceeded結果の`failed`上書きを防止、(2) `failBeforeAttempt`で同一ジョブのrunning attemptを同時終端し、キルスイッチ切替と重なった場合の恒久`transcribing`残存経路を閉鎖。Minor対応: `upload_status`書き込み4箇所へ`reserved`状態ガード、stale `dispatch_pending`のGET側同一ID再確認、SPECへ`retryable`の意味（自動再送可否・慎重側false）と`dispatch_pending`収束を明記、review.js削除再試行の回帰テスト追加。相関ID接頭辞はopenapi.json契約の`corr_`へコードを修正済み（`a0087db`）。`retries.limit`は公式ドキュメントの意味論が曖昧（ステップ毎最大10,000retryの記載のみ）だが、D1側attempt予算（解析・削除とも合計3回）が二重防壁としてコストを有界化することを確認・記録。Vitest 58件、pytest 28件、TypeScript型検査、Python品質4ゲート通過。既知の限界: 10分/15分閾値の実効境界はSQL文字列モックでは検証できないため、実SQLiteでの収束シナリオ再現テストはPhase 3のD1テスト拡充時に検討する。削除E2E（実環境の削除Workflow完走）は管理画面の削除再試行ボタンまたは30日期限cronで確認可能であり、Phase 3の承認フロー実装時に併せて実施する。

## Phase 3 — 承認・日時・辞典

- [x] `PATCH /review`で下書きの文字起こし・場面・親メモ・録音日時・タイムゾーンを保存し、長さ、形式、楽観ロック、監査イベントを検証する。
- [x] 過去日時を含む日時編集を実装し、ファイル時刻ではなく`captured_at_original`とユーザー編集値を区別して保持する。
- [x] 承認トランザクションを実装し、`Transcript`、採用単語、`WordOccurrence`、`DiaryEntry`下書きを一貫して更新する。
- [x] 辞典の初出/`NEW`を、承認済み・日時順・同日時の登録順で再計算する。録音日時変更と並行承認で不整合を残さない。
- [x] 発話履歴・辞典APIと画面を実装し、承認済みデータだけを世帯境界内で返す。ページ上限と空状態・失敗表示を追加する。
- [x] 文字起こし空・単語候補0件でも、場面と親メモを承認できる経路を実装する。
- [x] 日時境界、重複単語、同時編集の`VERSION_CONFLICT`、IDOR、削除済み録音をテストする。
- [x] Fable5レビューと指摘修正後の再検証を実施（2026-07-22、`49b7632`対象、独立エージェント併用）。主張された全ゲート（Vitest 67件、pytest 30件、ruff/format/mypy/pyright、型検査）の再現を確認。High 2件: (1) 楽観ロック敗者の後続文が着地する — 後続文の`version = 期待値+1`ガードは、同じ基底versionで競合した敗者でも勝者の作った現在値と一致して成立するため、敗者のtranscript・候補・発話・監査がVERSION_CONFLICT応答の裏で書き込まれる（独立エージェントは「正しい」と誤判定しFable5精読で検出）、(2) 辞典単語のDELETE（件数0）が`deleting`/`delete_failed`録音の発話FK参照と衝突し、該当単語を含む承認・編集が削除完了まで恒久500化する。Medium: 削除側辞典再計算が全statusを集計しSPECの承認済み限定と不一致、openapi契約違反3系統（承認応答の`deduplicated`未定義、review-queueの`failed_deletions`未定義、`INVALID_LIMIT`等のcode enum欠落と`next_action`のenum/自由文不一致）、テストの偽陽性構造（SQL文字列一致・手書きSQLコピー）。Minor: 再承認が`diary_status`を毎回`not_started`へ戻す（Phase 6で状態機械違反になる）、saveReviewの許可判定とSQLガードの不一致、`meta.changes`厳密比較、辞典応答`is_first`のセマンティクス曖昧。
- [x] Fable5指摘を安全側で修正し再検証（2026-07-22、`99099f5`）。SPECへ「削除中の発話は辞典集計に含めない・参照が残る単語行は削除しない」「楽観ロック不成立時はバッチ全体を中止し、version+1一致を後続文の成立条件に使わない」を先に追記。実装は (1) 初文UPDATE直後に`(SELECT changes()) = 0`でNOT NULL違反を起こす番兵文を置き、敗者バッチ全体をロールバック（`recording_tombstones`エラーだけをVERSION_CONFLICTへ写像、他のD1障害は500のまま）、(2) 辞典DELETEへ発話参照のNOT EXISTSガード追加（review/delete両側）、(3) 削除側再計算を承認済み限定・`captured_at`順へ統一、(4) 承認応答から`deduplicated`を除去し、openapiへ`failed_deletions`スキーマと全ワイヤーコードのenumを追加、`next_action`は自由文（maxLength 300）を正と決定、(5) `diary_status`は初回承認時のみ`not_started`、(6) saveReviewをpending限定へ整合。テスト追加: 番兵のロールバックと勝者経路の実SQLite検証、辞典FK拒否の実SQLite検証、削除中・削除失敗録音の編集/承認拒否、承認応答の契約形状、番兵の配置順序、`captured_at_source`のmanual遷移。Vitest 71件、pytest 32件、Python品質4ゲート、TypeScript型検査を通過。既知の残課題: review.ts本番SQLの実SQLite結合テストは手書きコピー検証のままでドリフト検知不可（Phase 4以降のテスト基盤整備で解消を検討）、辞典応答`is_first`の名称/意味はPhase 6の画面実装時に再確認。

### Phase 3の進捗（2026-07-22）

- [x] Phase 3とPhase 6の境界をSPECへ明記。承認は辞典・日記下書きまでを同期的に`200 OK`で確定し、日記・画像WorkflowはPhase 6へ分離した。外部AI呼び出し、AsyncJob作成、Cloudflare設定変更は行わない。
- [x] 厳格JSON・実本文16 KiB上限・UTF-8検証、IANAタイムゾーン、日時範囲、文字列長、NFKC正規化、重複語、世帯境界、処理中/削除中拒否、楽観ロックを実装した。
- [x] 承認・承認済み録音の日時編集で、確定単語、日時監査、`DiaryEntry`下書き、辞典の初出・件数を同一D1 batchで更新する。`force_new`/`force_not_new`は表示だけを上書きし、辞典の時系列集計は変更しない。
- [x] 辞典一覧・単語詳細・発話履歴と、確認・辞典の最小管理画面を追加。承認済み録音の再編集では`WordOccurrence`を復元して確定語と`NEW`上書きを保持する。
- [x] Terra実装、Sol独立レビュー、修正後の検証を完了。Vitest 67件、pytest 30件、Ruff、format、mypy、pyright、TypeScript型検査、Wrangler dry-run、`git diff --check`が成功。Fable5は未実施。

## Phase 4 — PC参照クライアント

- [ ] GUIライブラリを選定する。`tkinter`以外の依存追加はユーザー承認後にだけ行う。
- [ ] Phase 1A音声部品を製品用へ分離し、実際の押下/解放イベント、1.5秒進捗、複数押し無視、10秒前録り・5秒後録りをPC状態遷移どおりに実装する。
- [ ] 待機、長押し成立、後録り、保存、送信、処理待ち、成功、失敗、未送信件数、再試行、デバイス切断を画面で明示する。
- [ ] WAVとメタデータJSONのローカルスプールを実装し、OSユーザー限定権限、20件/25 MiB/7日、有界キュー、成功後削除を強制する。
- [ ] デバイストークンは環境変数または起動時秘密入力からのみ受け取り、画面・ログ・ファイル名へ出さない。
- [ ] HTTPSデバイスAPIへのアップロード、1回だけの自動再試行、明示的な再試行操作、`client_capture_id`冪等性、状態ポーリングを実装する。
- [ ] 固定サンプル送信と実マイク送信を分離し、デモでは固定サンプルだけで再現できるようにする。
- [ ] スプール満杯、ネットワーク失敗、期限切れトークン、切断、再起動復旧、音声をログに出さないことをテストする。
- [ ] Terra実装・Solレビュー・Fable5レビュー・実機確認・修正後の再検証を記録する。

## Phase 5 — OpenAI解析

- [ ] OpenAI APIキーをSecretとして設定する手順を用意する。実際のSecret投入、SDK依存追加、実API有効化はユーザー承認後にだけ行う。
- [ ] 文字起こしWorkflowを実装し、固定WAV、サイズ・時間上限、録音別試行上限、日次上限、期限、`DEMO_WRITE_ENABLED`をAPI呼び出し直前に強制する。
- [ ] 単語候補抽出を構造化出力で実装し、JSON Schema検証、候補数・文字数上限、禁止語/空結果の`partial`処理を実装する。
- [ ] システム指示と音声・文字起こし・親メモを明確に区切り、ユーザーデータを命令として扱わない。プロンプトと出力をログへ残さない。
- [ ] OpenAI呼び出しを`store: false`、background mode不使用、SDK再試行0回に固定し、Workflow側の有限再試行と二重にならないようにする。
- [ ] `ProcessingAttempt`、コストカウンター、相関ID、終端エラー、結果不明タイムアウトを記録し、無制限再送を禁止する。
- [ ] 正常、空文字起こし、スキーマ不正、上限到達、期限切れ、緊急停止、上流障害を固定データでテストする。
- [ ] ユーザー承認済みの固定サンプルだけで実APIを最小回数検証し、使用量と結果を記録する。
- [ ] Terra実装・Solレビュー・Fable5レビュー・修正後の再検証を記録する。

## Phase 6 — 日記・画像

- [ ] 承認済みの文字起こし・単語・場面・親メモだけから日記文を非同期生成し、下書き、手動編集、失敗時の回復操作を実装する。
- [ ] 日記生成にも入力分離、構造化出力検証、`store: false`、有限試行、録音別/日別上限を適用する。
- [ ] 画像生成は明示ボタンと確認ダイアログからだけ受け付け、未承認データ・自動再生成・並列生成を拒否する。
- [ ] 1日記1枚だけを有効にし、置換は新画像の保存成功後に実施する。失敗時は既存画像を保持する。
- [ ] 画像サイズ`1024x1024`・品質`low`、録音別/日別上限、有限再試行、非公開R2保存、認可済み再生を実装する。
- [ ] 日記一覧・詳細画面で、生成中、失敗、置換確認、空状態を表示する。
- [ ] 承認前拒否、上限、並行置換、生成失敗、R2削除、世帯越境をテストする。
- [ ] Terra実装・Solレビュー・Fable5レビュー・修正後の再検証を記録する。

## Phase 7 — セキュリティ・提出強化

- [ ] 認証・認可・ホスト分離・Access JWT・デバイストークン・IDOR・CSRF・CORS・XSS・入力上限・不正WAV/JSONを負のテストで検証する。
- [ ] ログ、エラー、Workflow状態、静的資産、Git履歴にトークン、APIキー、音声、文字起こし、親メモ、R2キーがないことを検査する。
- [ ] 日次/生涯/録音別上限、有限再試行、`DEMO_WRITE_ENABLED`、2026-09-01期限、削除例外、上流障害を結合テストする。
- [ ] 固定3音声、復旧手順、読み取り専用デモ、`reference/`なしの再現手順を準備し、実データを使わずに通しデモする。
- [ ] README、Project Story、Testing instructionsへ英語でデータ取り扱い、`store: false`の範囲、最大30日の監視保持可能性、実在児童データ不使用を記載する。
- [ ] 審査用Accessを完全一致の名指しアドレスだけに設定し、デバイストークンの配布・期限・失効手順をTesting instructionsへ記載する。設定変更はユーザー承認後にだけ実施する。
- [ ] 動画、スクリーンショット、提出用Session ID、公開/非公開共有、OSSライセンス判断を準備する。公開・提出・Secret投入はユーザーの明示指示後にだけ実施する。
- [ ] Terra実装・Solレビュー・Fable5レビュー・最終回帰テストを記録する。

## Phase 8 — Atom VoiceS3R（任意）

- [ ] Phase 4〜7が安定し、実機、書込み手段、Wi-Fi、デバイストークン発行方法が利用可能か確認する。ファームウェア依存追加・書込み・ネットワーク設定はユーザー承認後にだけ行う。
- [ ] 参照実装を実行時依存にせず、必要部分は新規実装または許可済みコピーとして隔離する。
- [ ] PSRAM配置、10秒リングバッファ、24 kHz基準形式、物理ボタン長押し、LED/画面状態表示、複数押し無視を実装する。
- [ ] Wi-Fi、HTTPS、デバイストークン、ローカルスプール相当、有限再試行、切断時復旧、固定音声送信をPC共通APIへ接続する。
- [ ] Unit HEX表示、デバッグログの機密情報非出力、書込み失敗時の安全な復旧手順を実装する。
- [ ] 実機で音声形式、長押し、ネットワーク断、再起動、上限、認可、固定サンプル、PC/Webとの縦断動作を確認する。
- [ ] Terra実装・Solレビュー・Fable5レビュー・実機再検証を記録し、完成した場合だけ提出物のBuilt during OpenAI Build Weekへ追加する。

## 自動検証計画

変更ごとに最小範囲を、Phase境界で該当スイート全体を実行する。Pythonの対象はPCクライアント配置に統一する。

```powershell
uv run ruff check main/apps/pc-client/src/
uv run ruff format --check main/apps/pc-client/src/
uv run mypy main/apps/pc-client/src/
uv run pyright main/apps/pc-client/src/
uv run pytest
```

- 単体: リングバッファ、同時スナップショット、前後録り、長押し、48→24 kHz、WAV、スプール、状態、冪等性、ロック、日時、辞典、削除、上限、期限。
- 結合: 固定WAV→`202`→Workflowポーリング→モック解析、世帯/デバイス分離、非公開R2再生、承認→日記→画像、非同期削除。
- 安全性/再現性: 不正JWT・失効トークン・IDOR・CSRF・CORS・不正WAV/JSON・プロンプト注入・XSS・ログ漏えいを拒否。固定3音声（明瞭な単語、短文、不明瞭な発話）を使う。

## デモ・提出

提出期限は **2026-07-21 17:00 PDT（2026-07-22 09:00 JST）**。カテゴリは **Apps for Your Life**。提出直前にDevpostの最新要件を再確認する。動画は公開YouTubeで3分未満、音声ナレーション付きとする。日本語会話を使う場合は英語字幕と英語（または英語TTS）のナレーションを付ける。開発者本人または合成データだけを使い、PCリングバッファ→録音→保存/非同期処理→スマートフォン確認→承認→日記/画像→辞典を示す。Atomは実装・検証できた場合だけ追加する。

公開前には、英語のProject Story、公開動画、Codex/GPT-5.6の利用説明、ソースへのアクセス、固定サンプル、審査手順、秘密情報がないこと、Accessを名指しアドレスだけにすること、英語のTesting instructions、`DEMO_WRITE_ENABLED`と2026-09-01までの失効、OpenAIデータ開示3箇所、`reference/`なしの再現、公開/非公開共有方針、OSSライセンス、`/feedback` Session IDを確認する。

### 提出前チェックリスト

- [ ] 公開リポジトリと公開READMEのどこにもトークン・秘密情報がない。
- [ ] Cloudflare Accessは完全一致の名指しアドレスだけを許可し、ドメイン単位の許可をしない。この事実をTesting instructionsへ英語で書く。
- [ ] 審査用Testing instructionsに、許可済みアドレス、ワンタイムPIN手順、デバイストークン入力方法と有効期限、別アドレスの場合の連絡先を英語で書く。
- [ ] デモ書込み期限（遅くとも2026-09-01 00:00 JST）と`DEMO_WRITE_ENABLED`キルスイッチが動く。
- [ ] 機能別の送信データ、既定の学習非利用、最大30日の不正利用監視保持可能性、`store: false`の範囲、実在児童データを使わないことを、README・Project Story・Testing instructionsの英語3箇所へ書く。
- [ ] `reference/`なしでビルド、テスト、デモを再現できる。公開、または非公開で`testing@devpost.com`と`build-week-event@openai.com`へ共有する方針を実行する。

### 詳細な検証観点

- Workflowのジョブ重複排除、明示的再試行上限、終端エラー、`UPSTREAM_RESULT_UNKNOWN`、古いジョブの収束、Workflow状態に機密データを置かないことを検証する。
- OpenAI SDKの暗黙再試行を無効にし、上限・失効・キルスイッチ・`store: false`を検証する。
- 承認から日記Workflow、画像置換、並行画像要求、非同期削除を結合テストする。
- 正常、`partial`、`failed`の各経路で、人が編集・手動入力・有限再試行などの回復操作へ到達できることを確認する。
- 不正/失効デバイストークン、誤ったAccess JWT、IDOR、CSRF、不要なCORS、不正WAV/JSON、プロンプト注入、XSSを拒否し、ログ・応答・Workflow状態へトークン、音声、文字起こし、メモ、R2キーを出さないことを確認する。

## スキルとカスタムエージェント

- `little-echoes-phase`: Phase実行、仕様/計画同期、レビュー手順。
- `sk-python-quality`: Pythonの静的解析。
- `ag-little-echoes-architecture-review`: セキュリティ、有限コスト、UX、状態、非同期の横断レビュー。

反復的・壊れやすい作業が生じた場合のみ、ユーザー承認の範囲でスキルまたはカスタムエージェントを追加し、発火条件・検証方法を本書へ記録する。

### 追加判断の目安

| 発火条件 | 候補 | 作成してよい段階 |
| --- | --- | --- |
| Cloudflareデプロイ/設定を繰り返す | Cloudflareデプロイスキル | Phase 2で実際のWrangler設定と承認済みデプロイ手順ができてから |
| ブラウザE2E確認を繰り返す | ブラウザE2Eエージェント/スキル | 安定したWeb UIと再現可能なテストデータができてから |
| Atom実機デバッグが反復する | Atomハードウェアレビューエージェント | Phase 8開始後に機器固有の失敗が繰り返されてから |

新スキルは`.agents/skills`へ置き、skill-creator手順で作成・検証する。新カスタムエージェントは`.github/agents`へ置き、役割を狭くして既存エージェントと重複させない。Claude Code用に提供するものは`.claude/skills`と`.claude/agents`へ対応形式でミラーし、`.agents/`または`.github/agents/`の更新と同じコミットで同期する。

## 作業規則と未決事項

- 大きな実装の前に短い計画を示し、変更は小さく機能単位でコミットする。
- 予定を理由に安全性、プライバシー、コスト、UX要件を弱めない。外部形式は実績あるライブラリを優先し、依存追加には承認を得る。
- `reference/`を実行時に読み込み、同梱、参照しない。提出用の`/feedback` Session IDと主要実装セッションを保存する。
- Python製品コードとテストは`main/apps/pc-client/src/`へ置く。
- デモPCのキャプチャ形式は24 kHz直接入力に確定済み（2026-07-21実測、`SPEC.md`決定記録参照）。`tkinter`の採否はPhase 4のGUI実装開始時に判断する。公開デモの初期データはPhase 7で定義する。Atom PSRAM配置はPhase 8開始時だけ判断する。
- OSSライセンスは法務・製品判断であり、エージェントが仮定しない。提出前にユーザーが決定する。
