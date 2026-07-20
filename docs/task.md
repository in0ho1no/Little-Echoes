# PC側（Windows）実装タスク（全完了）

`docs/SPEC.md` v1.3系（§7.2 PC側処理フロー・§9 Transport抽象化）に基づくPC側実装のタスク記録。

**タスク1〜13すべて完了・コミット済み（2026-07-12）。実機結合（マイコン側task8、
`docs/task_マイコン.md`）も完了（2026-07-14）し、残タスクはない。**

本ファイルは完了記録として、確定した設計判断・実装中に踏んだ不具合・環境依存の注意点を残す。
コードコメントが「docs/task.md 申し送りN」の形式で参照しているため、申し送りの番号体系は
維持している。実装の時系列な経緯はgit履歴を参照。

## 確定した前提

- OpenAI API キーは環境変数 **`OPENAI_API_KEY_VIG`** を直接参照する
  （`OPENAI_API_KEY` ではない。ユーザーが専用キーを別名で登録したため）。
- 自動テストは OpenAI API 呼び出し部分をモック化する（課金・ネットワーク依存を排除）。
  実APIの疎通・イベントスキーマの整合は `scripts/manual_realtime_check.py` で確認済み。
- 実機の相手役は `MemoryTransport`（インメモリ双方向Transport）で模擬してテストする。

## 採用モデルの確定（タスク7完了後・2026-07-11決定）

**`gpt-realtime-mini`（OpenAI Realtime API、speech-to-speech）に確定。**

- 経緯: 旧構成（whisper-1 → gpt-4o-mini → tts-1 の直列3段）の実測が
  STT 9.33秒＋LLM 3.59秒＋TTS 1.42秒＝合計14.34秒となり、応答レイテンシの
  大半をSTTが占めることが判明。Reasoningモデルは推論時間の観点で除外し、
  STT/応答生成/TTSを一貫処理できるRealtime系を採用。詳細な選定比較・コスト試算は
  `docs/openai_realtime_model_selection.md` 参照。
- 実機E2Eの実測（2026-07-14）: Realtime応答約3〜4.5秒（セッション新規確立込み）。
  旧構成の14.34秒から大幅改善。

### Realtime API 調査結果（2026-07-11、実装時の前提）

1. PCM入力は **pcm16: 24kHz/16bit/モノラル/リトルエンディアン固定**（16kHz不可。
   他はG.711 μ-law/A-law 8kHzのみ）。出力もpcm16は24kHz。
   → SPEC v1.3で録音を24kHzに統一済み（マイコン側I2Sのレート切替も不要になった）。
2. サーバーVADは `turn_detection: null` で無効化できる。手動ターン制御は各ターンで
   `input_audio_buffer.clear` → `input_audio_buffer.append`（base64、チャンク最大15MB）→ `input_audio_buffer.commit`
   → `response.create` のpush-to-talkパターン（公式サポート）。
3. function calling: `session.tools` に関数を定義。モデルがツールを呼ぶと
   `response.done` に関数名・引数・`call_id` が入る。「ありがとう」インテント検知は
   これで実現（旧JSONモード構造化出力の代替）。
4. 会話状態はセッション内でサーバー側保持（接続は最大60分）。
   1セッション=1サイクル方式の採用により、履歴リセットは「セッション破棄」で
   実現するため `conversation.item.delete` による項目管理は不要になった。
5. openai SDK 2.45.0 に `client.realtime.connect(model=...)` あり。
   `websockets` は `uv add "openai[realtime]"` で導入済み（15.0.1）。
6. 応答音声の30秒上限（§4.2）はPC側で担保: instructionsで短い返答を指示し、
   受信音声が30秒相当（24kHz/16bit/monoで1,440,000バイト）を超えたら
   `response.cancel` して打ち切る。30秒はパケットSIZE上限2MBの範囲内。

出典: developers.openai.com のRealtimeガイド、
[`gpt-realtime-mini`モデルページ](https://developers.openai.com/api/docs/models/gpt-realtime-mini)、
[公式価格ページ](https://developers.openai.com/api/docs/pricing)。

## ディレクトリ構成（実状）

```text
src/
  transport/
    packet.py            # SYNC/CMD/SIZE/BODY のエンコード・デコード
    base.py              # Transport ABC
    serial_transport.py  # pyserial実装（実機用。常駐リーダースレッド方式）
    memory_transport.py  # インメモリ双方向Transport
  device/
    port_discovery.py    # VID 0x303A 自動検出
    handshake.py         # READY待ち5秒ロジック
  audio/
    wav_utils.py         # RAW PCM → WAVヘッダ付与（デバッグ保存用）
  openai_client/
    errors.py            # ApiClientError 共通基底
    realtime_client.py   # Realtimeセッション管理＋push-to-talk往復
    canned_audio.py      # 定型応答PCMの管理
  debug_utils.py         # デバッグWAV保存・応答サマリーログ
  pipeline.py            # 0x01受信→0x02→Realtime→0x03、キャンセル/エラー処理
  main.py                # 実機接続時のエントリポイント
  tests/                 # pytest 一式
scripts/
  manual_realtime_check.py  # 実API疎通用の手動確認スクリプト（自動テスト対象外）
  canned_thanks.pcm         # 定型応答PCM（gen-thanksで生成。コミット対象）
  pre_rec_*.wav             # 手動確認用の事前録音フィクスチャ（コミット対象）
```

## 実装知見（再発防止・保守に効くもののみ）

タスク1〜13の詳細な完了経緯はgit履歴参照。以下は将来の変更時に把握しておくべき知見。

- ハンドシェイク: `wait_for_ready()` は `HandshakeResult(ready_received, pending_recording)`
  を返す（READY待機中の録音は最新1件保持・CANCELで破棄。§3.4）。
- Realtimeクライアント: `cancel()` は進行中の `respond_to_audio()` タスクを**直接キャンセル**する
  （接続クローズを接続障害と誤認して古い音声で再試行する問題の防止）。
  応答音声が30秒上限ちょうどは正常完了とし、上限を超えるdeltaを受信した場合のみ
  切り詰めて `response.cancel` を送る。
- パイプライン受信: `recv_packet(timeout=0)` の非ブロッキングポーリング＋ `asyncio.sleep()`
  に統一（`_wait_for_packet()`）。**踏んだ重大バグ**: 受信待機分岐が
  `recv_packet(timeout=idle_poll_interval)` を同期ブロッキング呼び出ししており、
  イベントループへ制御が返らず `asyncio.wait_for`/`Task.cancel()` が永久に効かなくなっていた。
  同期ブロッキング呼び出しをasyncioイベントループへ混ぜないこと。
- デバッグ保存: 0x02送信をデバッグWAV保存より先に行い、保存失敗（`OSError`/`ValueError`）は
  警告ログに落として対話を継続するbest-effort処理とする。
- 定型応答アセットの生成（`gen-thanks`）: completed応答・非空・16-bit境界・SIZE上限を検証し、
  同一ディレクトリの一時ファイルから原子的に置換。失敗時は既存アセットを保持して非0終了。
- `SerialTransport`:
  - `serial.Serial` に `write_timeout=5秒` を設定し、Windows版pyserialで無期限待機になり得る
    `flush()` は使わない。**pyserial win32の注意**: `write_timeout` 設定時も
    `ERROR_OPERATION_ABORTED` では例外を出さず実書き込みバイト数を返す経路があるため、
    `written != len(packet)` チェックは必須の防御。
  - 実 `serial.Serial` 互換オブジェクトでの検証には `serial.serial_for_url('loop://')`
    （pyserial組み込みループバック、実機不要）が使える。
  - 受信は**常駐リーダースレッド**方式（task8で改修）: ブロッキングread（64KB要求・50ms
    タイムアウト）を常時発行して内部バッファへ蓄積し、`recv_packet()` はバッファから
    パケットを組み立てるだけ。ポーリング受信だとWindows usbserドライバのUSB IN転送が
    停滞しデバイス側の不具合を誘発する（経緯の全記録: `docs/task8_verification.md` G）。
- 終了処理: `main._run()` はRealtimeセッションを破棄（websocket接続リーク防止）し、
  その終了処理が失敗してもシリアル接続を必ず閉じる。

## 申し送り事項

有効なもの（番号はコードコメントから参照されているため維持）:

4. CANCEL解釈と「最新優先」はhandshake層に固定済み（確定設計判断）。
   パイプラインは`pending_recording`を確定済みの録音1件として扱う。
8. Realtimeクライアントの例外は`ApiClientError`を継承し、パイプラインは
   `except ApiClientError:`で一括捕捉→0x04送信（確定設計判断）。
9. OpenAI SDKの既定タイムアウト（10分）・自動再接続・自動再試行は使わない。
   Realtime応答待ちは25秒。接続断時のみアプリケーション側で新セッションを作り、
   1回だけ再試行する（確定設計判断・2026-07-11ユーザー決定）。
10. 実測値の記録: 旧構成でSTT 9.33秒/LLM 3.59秒/TTS 1.42秒（合計14.34秒）。
    マイコン§3.5は35秒、PC側応答待ちは25秒とし、別定数で個別調整可能とする（確定）。
11. 会話履歴・セッション管理は「1セッション=1サイクル（最大3往復）」方式とする
    （確定設計判断・2026-07-11ユーザー決定）。
    - 破棄条件: 成功3往復完了／**応答再生の終了（推定）から**15秒アイドル
      （SPEC v1.3.3で起点を「受信完了」から改訂。受信完了起点だと15秒超の応答の再生中に
      期限が来て履歴が消えるため。2026-07-14、task8実機E2Eで判明）／0x05受信
      （トリプルクリック=強制リセット。待機中の会話終了と処理中の中断を兼ねる）／APIエラー。
      いずれもセッションごと破棄し、次の発話は新セッション（まっさら）で開始。
    - 常駐セッションは不採用: アイドル中の接続死（NATタイムアウト・PCスリープ）や
      60分上限により「気付かないうちに履歴が消える」齟齬が生じるため。
      1セッション=1サイクルなら履歴の寿命=接続の寿命となり、この問題が構造的に消える。
    - スライディングウィンドウ（常に直近3往復保持）も不採用: 忘却の瞬間が会話の
      途中に紛れ込みユーザーの認識と齟齬を生むため。
    - 「3往復で必ず全部忘れる」「15秒黙ったら別の会話」「キャンセルしたら全部忘れる」
      という明確なルールで、期待を裏切る瞬間を作らないことを最優先する。
    - ボタン操作の最終確定（2026-07-11、再検討の経緯込みで記録・蒸し返さない）:
      - 単押し（1.5秒未満×1〜2回）: 何もしない（録音破棄・黄点滅は§4.1の従来動作を維持）
      - 長押し（1.5秒以上）: 録音。セッションなし=新規会話、生存中=会話の継続
      - トリプルクリック（1.2秒窓に3回、全状態有効）: 強制リセット（0x05送信、
        受理フィードバックはマゼンタ短点滅2回）。待機中の「会話を今すぐ終える」もこの操作で行う
      - 不採用案1「録音のたびに新会話（完全ステートレス）」: 続きの質問が一切
        通じなくなるため、ユーザーが3往復維持を選択
      - 不採用案2「長押しで既存セッションを破棄してから新規会話」: 3往復サイクルと
        構造的に両立しない（セッションが2往復目を迎えられない）ため不採用。
        認識齟齬の根本は対話モデルの相違（ユーザーはハンズフリー継続を想定、
        SPECはpush-to-talk）で、v1はpush-to-talkで確定（§9に将来拡張として記録）
      - 不採用案3「ダブルクリック=会話終了」: 一旦採用したが、push-to-talk確定後に
        見直した結果、待機中のトリプルクリックと効果が完全に同一（どちらも0x05送信
        →セッション破棄→待機継続）であることから冗長と判断し削除。
        会話終了の明示手段はトリプルクリックに一本化
13. 実API疎通確認で判明した知見（2026-07-12）:
    - 感謝インテント検出（`notify_thanks_intent`関数呼び出し）が起きたターンで、
      モデルが音声を一切生成せず`reply.audio_pcm`が空（0バイト）になることがある
      （実測: output_tokens=15と極端に少ない）。instructionsで「関数呼び出しと
      あわせて発話する」旨を指示しているが、instructionsは必ず守られるとは限らない。
    - パイプラインは`thanks_detected=True`の場合`reply.audio_pcm`を使わず事前生成した
      `canned_audio.pcm`を送る設計のため、実害はない。今後モデルやinstructionsを
      見直す際は、感謝ターンでの音声生成に依存する設計にしないこと。
    - 追記（2026-07-13、task8 E2Eで対応）: **通常ターン**で音声が空の場合、空PCMの0x03が
      マイコンで「何も鳴らさず待機復帰」となり無応答に見えるため、`pipeline.py`に
      空応答ガードを追加した（0x03を送らずセッション破棄＋0x04でターン失敗を明示。
      `docs/task8_verification.md` D-2参照）。
14. 実機結合時の確認事項 → **task8で消化済み（2026-07-14）**:
    - DTRリセット後の起動〜READY送信は5秒に収まる（READYのDTR検知200ms後自動再送で担保）。
    - 最大サイズの音声送信は`write_timeout`5秒以内に完了する（実測: 307KBで0.59秒、約700KB/s）。
    - マイコンリセット時はUSBデバイスごと再列挙されるため、pyserialが`SerialException`を
      投げて`main.py`は明確なエラー終了する。**v1は自動再接続を実装せず
      「切断＝明確なエラー終了→再起動で復帰」を正とする**（確定設計判断）。

解決済み（番号のみ維持。詳細はgit履歴）:

- 1. 分割/汚染バイトのE2E検証 → タスク10でTransport越しのE2Eテストを追加済み。
- 2. プロトコルタイムアウト時のパーサ状態フラッシュ方針 → 受信を`recv_packet(timeout=0)`の
  定期ポーリングに統一したため、パーサのBODY 5秒無進捗タイムアウトが自然に発火する。
  明示的なフラッシュは不要（`src/pipeline.py`冒頭のdocstringに記録）。
- 3. `pending_recording`の処理 → タスク10で実装、タスク13で`main.py`から`run_pipeline()`へ引き継ぎ。
- 12. 30秒超応答の打ち切り直後のサーバー側error競合 → 実APIで30秒超応答を意図的に発生させて
  確認。上限ちょうど（1,440,000バイト）に切り詰められて正常終了し、競合は発生しなかった。
- 5〜7. Whisper・ConversationHistory・systemプロンプト関連 → v1.3のRealtime化で根拠が消滅し廃止。

## 環境依存の既知の注意点

- Windows環境でテスト用に `serial.tools.list_ports_common.ListPortInfo` を
  実在しないCOMポート名で構築する際は、`skip_link_detection=True` を必ず指定する。
  指定しないと `os.path.islink()` が数秒〜十数秒ブロックする
  （`src/tests/test_port_discovery.py` の `make_port()` で対応済み）。
- PowerShellツールのセッションはコマンドごとに環境変数がリセットされる。
  `OPENAI_API_KEY_VIG` はユーザーレベルのレジストリに登録済みだが、
  スクリプト実行時は同一コマンド内で
  `$env:OPENAI_API_KEY_VIG = [Environment]::GetEnvironmentVariable("OPENAI_API_KEY_VIG", "User")`
  を先に実行する必要がある。
- 日本語を含むAPI応答をPowerShellコンソールに`print`すると文字化けして
  見えることがある（データ自体は正常。表示エンコーディングの問題）。
