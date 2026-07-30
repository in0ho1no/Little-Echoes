# Phase 7 セキュリティ・公開前運用

この文書は、ローカルで検証できる防御と、Cloudflare・公開先で所有者確認が必要な操作を分離する。Secret値、メールアドレス、実IDは記録しない。

## ローカル検証

Phase 7の負の試験は次を対象とする。

- 管理ホストとデバイスホストで認証方式を交差利用できない
- Access JWTの署名、`iss`、`aud`、`exp`、`sub`、RS256固定
- デバイストークンのHMAC比較、失効、期限、世帯・source束縛
- IDOR、CORS既定拒否、JSON強制によるCSRF防御、HTMLエスケープ、危険なDOM挿入API不使用
- JSON・WAV・Content-Length・文字列・配列の上限
- 予期しない例外の固定応答、Workflowへ不透明な`AsyncJob.id`だけを渡すこと、内容ログ不使用
- 日次・録音別・生涯上限、有限再試行、`DEMO_WRITE_ENABLED`、2026-09-01期限、削除例外、上流障害

現在のCIは固定バージョンのSemgrepとgitleaksを実行する。gitleaksは`fetch-depth: 0`で全履歴を取得し、`--redact`で値を出力しない。ローカルにDockerまたは各ツールがない場合、Git履歴を含む最終判定はCI成功を外部ゲートとする。

2026-07-30のローカル検査では、秘密値を表示しないファイル名ベースの現行ツリー・履歴検索で、検出対象は3つのミラーされたhook用ダミー検知テストだけだった。禁止対象名の追跡ファイルは0件、製品コードから`reference/`への依存は0件だった。これはgitleaksの代替ではなく、全履歴・検出ルールでの最終判定はCIで行う。

Semgrep抑止の許可一覧は1件だけである。

| ファイル | ルール | 根拠 |
| --- | --- | --- |
| `main/apps/pc-client/src/client/uploader.py` | `python.lang.security.audit.dynamic-urllib-use-detected.dynamic-urllib-use-detected` | コンストラクタと送信直前の両方でHTTPS、hostname、userinfo不在を検証する。`urllib.request.urlopen`を使うための構造上の検出であり、任意schemeへ到達しない |

新しい抑止は、構造で解消できず、根拠コメント、専用テスト、Phaseレビューが揃う場合だけ追加する。

## 固定3音声

`main/samples/audio/`の3件は、実在児童データを含まない既存の成人音声から決定的に生成する。manifestは元音声と各生成物のSHA-256、frame数、派生条件を固定し、pytestは一時ディレクトリへ2回再生成したbyte列が追跡済みWAVと一致することを検証する。成人音声という来歴自体はhashから判定できないため、公開前に所有者が元音声の来歴を確認する。

```powershell
uv run python main/samples/build_fixed_audio.py
```

期待値は`main/samples/expected/phase7.json`を正とする。不明瞭音声では特定の文字起こしを期待せず、空・部分失敗でも元音声と手動編集経路へ到達することを確認する。実OpenAI・Cloudflareを使う通しデモは費用と外部書き込みを伴うため、`DEMO_WRITE_ENABLED=true`への変更を含めて別途ユーザー承認後に行う。

`reference/`は生成・ビルド・テスト・デモの入力にしない。再現確認では一時的なリネームや削除を行わず、依存検索と`main/`だけを入力にしたコマンドで確認する。

## Cloudflare Access

設定変更はユーザー承認後にだけ実施する。

1. 管理アプリのAllowポリシーを確認し、所有者が承認したメールアドレスの完全一致だけを登録する。
2. ドメイン、Everyone、一時グループ、不要になった個別アドレスをAllow条件に含めない。
3. ワンタイムPINで対象アドレスだけがログインでき、未承認アドレスが拒否されることを確認する。
4. 一時許可は利用終了時に前倒しで削除し、遅くとも2026-09-01 00:00 JSTまでに失効させる。
5. Worker側でも`Cf-Access-Jwt-Assertion`の署名、issuer、audience、有効期限を検証し、Access設定だけに依存しない。
6. AccessアプリケーションのCORS設定が既定（クロスオリジン許可なし）のままであることを確認する。Accessがpreflightへ応答してOriginを許可すると、Workerの拒否より手前で境界が緩む。

## デバイストークンのライフサイクル

発行・配布:

- 256-bit以上の暗号学的乱数を使い、平文は発行時に一度だけ表示する
- D1には`DEVICE_TOKEN_HMAC_SECRET`によるHMAC-SHA-256だけを保存し、平文をSQL、ログ、ファイル、コマンド履歴へ残さない
- `household_id`と`source_id`へ束縛し、デモ用`expires_at`を2026-09-01 00:00 JSTより前に設定する
- 承認済みの安全な経路で対象利用者へ渡し、PCでは`LITTLE_ECHOES_DEVICE_TOKEN`環境変数またはマスク入力だけを使う

失効・再発行:

1. 対象を平文トークンではなくD1の不透明なtoken ID、世帯、sourceで特定する。
2. `revoked_at`を設定すると、次の認証から直ちに拒否されることを確認する。
3. 再発行は新しい乱数・新しいtoken IDで行い、旧行の失効を解除しない。
4. 失効後に`last_used_at`が更新されないこと、書き込み期限後は有効なトークンでも費用処理を開始できないことを確認する。

現時点では発行専用の管理APIを公開しない。手作業での発行を行う場合も、Secretの読み取り・投入とリモートD1更新は別途ユーザー承認を得る。

## 読み取り専用デモ

`DEMO_WRITE_ENABLED=false`は録音作成・編集・AI生成を停止する緊急停止であり、認可済み削除と期限データの後始末は継続する。したがって、これは公開読み取り専用デモ用の完全なルート分離ではない。

公開読み取り専用デモを用意する場合は、実データと別のD1/R2、合成データだけ、GET経路だけの別Worker設定を準備し、更新・生成・削除・アップロード経路をルーターから除外する。この設定追加と公開はユーザー承認前には行わない。準備できない場合はCloudflare Accessで保護した非公開デモを維持する。

## 障害時の復旧

- `DELETE_WORKFLOW_DISPATCH_QUARANTINED`: 録音を非表示のまま保持し、同一Workflow IDの終端とトゥームストーンを確認してから同一IDを再調停する。新しい削除IDを作らない
- `WORKFLOW_DISPATCH_UNKNOWN` / `UPSTREAM_RESULT_UNKNOWN`: 提供者へ再送せず、D1のジョブ・attempt・録音状態を照合する
- `GENERATION_DEADLINE_EXCEEDED` / `CLEANUP_DEADLINE_EXCEEDED`: 活性Workflowも終了済みであることを確認する。画像孤児は日次カーソルスイープへ委ねる
- R2削除失敗: D1の有限試行数とcleanupジョブを確認し、上限を手動でリセットする前に対象キーの参照有無と旧Workflow終端を確認する

リモート照合、再調停、Secret操作、書き込み有効化は外部状態を変えるため、個別のユーザー承認後に実施する。

## 公開判断

公開前に所有者が次を決定する。

- リポジトリの公開範囲と共有先
- スクリーンショットに実データ、メールアドレス、内部ID、相関IDが含まれないこと
- `reference/`を配布対象に含めるか。製品は同ディレクトリなしで成立する
- ルートリポジトリのOSSライセンス。依存パッケージのライセンス表示とは別に決定する
- Cloudflare Accessの許可対象と期限、公開読み取り専用デモを別環境で作るか

公開、Secret投入、Access変更、リモートD1/R2操作は、この文書の準備完了だけでは許可されない。
