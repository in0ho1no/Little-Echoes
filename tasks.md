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
| 1A — PC音声スパイク | 未着手 | Phase 1と並行。PCクライアント配置は確定済み |
| 2 — 固定データ縦断スライス | 未着手 | Cloudflareのカスタムドメインとゾーン設定が必要 |
| 3 — 承認・日時・辞典 | 未着手 | Phase 2の縦断スライス確認後 |
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

## Phase 2 — 固定データ縦断スライス

1. Worker、Workflows、D1、R2を作成し、Wranglerの`compatibility_date`を固定する。
2. 管理/デバイスホストを分離し、認可とAccess JWTの署名・`iss`・`aud`・`exp`検証を実装する。
3. 固定WAVをR2/D1へ保存する。
4. モックWorkflowを`202 Accepted`と状態ポーリングで動かし、モック文字起こし・単語候補を追加する。
5. 認可済み状態取得、音声再生、確認キュー/詳細、状態・エラー表示を追加する。
6. `client_capture_id`と`AsyncJob.id`を重複排除する。

このPhaseでOpenAI APIは呼ばない。先に認証、状態、UI、データ境界を決定的にテストする。Workflowsを第一選択とし、半日超の統合障害時だけ `SPEC.md` の縮退経路を、事前更新と復旧制限の記録を伴って検討する。

## Phase 3 — 承認・日時・辞典

下書き・日時編集の監査、承認トランザクション、WordOccurrenceと初出/`NEW`再計算、辞典・発話履歴、重複/競合/過去日時承認テストを実装する。

## Phase 4 — PC参照クライアント

Phase 1Aの録音機能を製品化し、`tkinter` GUI、状態/長押し表示、ローカルスプール、自動アップロード、有限再試行、復旧操作、固定音声送信を追加する。

## Phase 5 — OpenAI解析

文字起こしと構造化単語抽出を実装する。ユーザーデータを命令から分離し、JSON Schema検証、`store: false`、SDK再試行無効化、background mode不使用、有限Workflow再試行、`partial`、試行/上限記録を確認する。実APIは固定サンプルだけで検証する。

## Phase 6 — 日記・画像

承認済みデータから日記を非同期生成し、手動編集と明示的画像生成を追加する。有効画像は1枚だけとし、置換確認、失敗時保持、録音別/日別上限を実装する。

## Phase 7 — セキュリティ・提出強化

認証・認可・IDOR・CSRF・XSS・入力上限・ホスト分離・Access JWT、コスト上限・有限再試行・期限・`DEMO_WRITE_ENABLED`を確認する。固定サンプル、復旧手順、`reference/`なしのデモ、審査手順、読み取り専用デモ、動画を準備する。README、Project Story、Testing instructionsにはOpenAIのデータ取り扱いを英語で記載する。

## Phase 8 — Atom VoiceS3R（任意）

PC/バックエンド/Webが安定した後に開始する。音声メモリ、専用リングバッファ、Wi-Fi、HTTPS、固定音声、長押し、Unit HEX表示、共通API接続、実機デモを確認する。

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
- `tkinter`、24 kHz直接取得と48 kHzフォールバックの最終選択はPhase 1A後に行う。公開デモの初期データはPhase 7で定義する。Atom PSRAM配置はPhase 8開始時だけ判断する。
- OSSライセンスは法務・製品判断であり、エージェントが仮定しない。提出前にユーザーが決定する。
