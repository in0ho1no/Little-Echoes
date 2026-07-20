# Realtimeモデル比較手順（gpt-realtime-mini vs gpt-realtime-2.1-mini）

非Reasoningモデル `gpt-realtime-mini`（現行採用）とReasoningモデル `gpt-realtime-2.1-mini` を
同一条件で比較するための手順。両エントリポイントに `--model` 引数があり、
**モデルの切り替えはスクリプトの再実行で行う**（実行中の切り替えは想定しない）。

採用モデルの選定経緯・コスト試算は `docs/openai_realtime_model_selection.md` を参照。

## 事前準備

実APIを呼ぶため課金が発生する。APIキーはPowerShellの同一コマンド内で読み込む
（コマンドごとに環境変数がリセットされるため。`docs/task.md`「環境依存の既知の注意点」）:

```powershell
$env:OPENAI_API_KEY_VIG = [Environment]::GetEnvironmentVariable("OPENAI_API_KEY_VIG", "User")
```

## 方法1: 実機なしの比較（推奨・まずはこちら）

同一の事前録音WAVを両モデルに投げ、条件を完全に揃えて比較する。
入力の用意方法は `scripts/recording_memo.md` 参照（24kHz/16bit/モノラルWAV）。

```powershell
# 非Reasoning（既定）
uv run python scripts/manual_realtime_check.py respond --input scripts/pre_rec_test24sec.wav

# Reasoning
uv run python scripts/manual_realtime_check.py respond --input scripts/pre_rec_test24sec.wav --model gpt-realtime-2.1-mini
```

出力の見方:

- `Using Realtime model: ...` — 使用モデルの確認
- `Realtime response: transcript=..., duration=X.XXs, usage=[...]` — **duration がレイテンシ**
  （接続確立込みの1往復）、usage がコスト比較の材料（`input_tokens`/`output_tokens`）
- 応答音声WAVは `scripts/manual_check_output/` にタイムスタンプ付きで保存される。
  聞き比べで応答品質（内容・声質・話速）を確認する

ばらつきがあるため、**同一入力で各モデル3回程度**実行して比較するとよい。

## 方法2: 実機での比較（体感確認）

マイコンを接続し、モデルを替えて `main.py` を起動し直す。

```powershell
# 非Reasoning（既定）
uv run python src/main.py

# Reasoning（比較時はCtrl+Cで止めてから起動し直す）
uv run python src/main.py --model gpt-realtime-2.1-mini
```

- 起動時ログ `Using Realtime model: ...` と、往復ごとの `Realtime response: duration=...` で
  レイテンシを記録する。「ボタン解放→再生開始」の体感はストップウォッチで別途測る
  （参考値: gpt-realtime-miniの実測はRealtime応答約3〜4.5秒。`docs/task.md`）。
- 会話サイクル（3往復・15秒アイドル・トリプルクリック）の挙動はモデルに依存しないため、
  比較観点はレイテンシ・応答品質・コスト（usage）に絞ってよい。

## 実測記録（2026-07-14、方法1で各モデル3回）

入力: `scripts/pre_rec_test24sec.wav`（24.03秒、1,153,568バイト）。instructionsは既定
（簡潔応答指示）。durationは新規セッション確立込みの1往復完了までの時間。

### gpt-realtime-mini（非Reasoning・現行採用）

| 回 | duration | output_tokens | total_tokens | 応答音声 |
| :-- | --: | --: | --: | --: |
| 1 | 4.78s | 240 | 613 | 441,600B（9.2s） |
| 2 | 4.52s | 250 | 623 | 463,200B（9.7s） |
| 3 | 3.72s | 194 | 567 | 355,200B（7.4s） |
| **平均** | **4.34s** | **228** | **601** | **420,000B（8.8s）** |

input_tokensは3回とも373。

### gpt-realtime-2.1-mini（Reasoning）

| 回 | duration | output_tokens | total_tokens | 応答音声 |
| :-- | --: | --: | --: | --: |
| 1 | 5.39s | 595 | 1,252 | 952,800B（19.9s） |
| 2 | 5.56s | 588 | 1,245 | 955,200B（19.9s） |
| 3 | 6.44s | 775 | 1,432 | 1,245,600B（26.0s） |
| **平均** | **5.80s** | **653** | **1,310** | **1,051,200B（21.9s）** |

input_tokensは3回とも657。

### 読み取れること

- **レイテンシ**: 平均で 4.34s vs 5.80s（2.1-miniが約1.5秒・34%遅い）。
  ただし応答長が大きく違う（8.8s vs 21.9s）ため、この差は推論時間だけでなく
  **応答が長いことによる生成・受信時間**を含む。応答1秒あたりのdurationはむしろ
  2.1-miniが小さく（約0.26s/s vs 約0.50s/s）、生成スループット自体は速い。
- **応答の長さ**: 同じ既定instructions（簡潔応答指示）でも2.1-miniは約2.5倍長く話す。
  本ガジェットの「短い返答」方針とは相性が悪く、採用するならinstructionsの強化が必要。
  応答30秒上限（打ち切り）にも近づきやすい（3回目は26秒）。
- **タイムアウト**: 全6回とも25秒の応答待ちに対し十分収まった（最大6.44s）。
  この応答長の範囲ではタイムアウトの心配はない。
- **コスト**: 同一入力でinput_tokensが373 vs 657、output_tokensは平均228 vs 653。
  音声単価（入力$10/出力$20 per 1Mトークン）で概算すると1往復あたり約$0.008 vs
  約$0.020で**2.1-miniが約2.4倍**（usageは音声・テキスト合算のため上振れ側の概算）。
- **結論（この実測時点）**: レイテンシ・コスト・応答長の制御性のいずれも
  gpt-realtime-mini優位で、採用判断（`docs/openai_realtime_model_selection.md`）を
  変える材料はなし。応答品質（内容の充実度）を重視する用途なら2.1-miniに利がある。

## 実測記録（2026-07-14、方法2で3往復会話を各モデル1回）

実機で同じ3発話の会話を両モデルに投げた（1セッション=3往復。3往復目で設計どおり
セッション破棄を確認）。発話内容:

1. 「会議を短くしたい。でも、発言は減らしたくない。どうすればいい？」
2. 「準備の手間も増やしたくありません。別の案はありますか？」
3. 「その案の弱点も教えてください」

durationは0x01受信→応答受信完了までの時間（1往復目のみ新規セッション確立込み）。
応答音声の秒数は0x03のPCMバイト数（エフェクトID 1バイトを除く）÷48,000から算出。

### gpt-realtime-mini（非Reasoning・現行採用）

| 往復 | 発話長 | duration | input_tokens | output_tokens | 応答音声 |
| :-- | --: | --: | --: | --: | --: |
| 1 | 8.28s | 4.16s | 215 | 289 | 10.8s |
| 2 | 7.34s | 1.41s | 587 | 171 | 6.2s |
| 3 | 4.93s | 3.78s | 586 | 196 | 7.2s |
| **平均** | | **3.12s** | | **219** | **8.0s** |

### gpt-realtime-2.1-mini（Reasoning）

| 往復 | 発話長 | duration | input_tokens | output_tokens | 応答音声 |
| :-- | --: | --: | --: | --: | --: |
| 1 | 8.62s | 3.47s | 503 | 438 | 15.6s |
| 2 | 7.49s | 3.00s | 670 | 514 | 17.8s |
| 3 | 5.40s | 4.69s | 822 | 449 | 15.4s |
| **平均** | | **3.72s** | | **467** | **16.2s** |

### 読み取れること（方法1の結果への追加分）

- **会話継続時のレイテンシ差は小さい**: 平均3.12s vs 3.72s。2往復目以降はセッション
  再利用で確立コストがなく、両モデルとも方法1（毎回新規セッション）より速い。
  1ターンあたりのレイテンシ差は実機の体感では大差にならない水準。
- **応答長の傾向は会話でも同じ**: 2.1-miniは約2倍長く話す（平均16.2s vs 8.0s）。
  往復のテンポを重視する本ガジェットでは、応答が長いぶん「聞いている時間」が
  支配的になり、durationの差以上に会話全体が長くなる。
- **履歴によるinput_tokensの伸びも2.1-miniが大きい**（215→587→586 vs 503→670→822）。
  3往復の合計トークンは 2,044 vs 3,396 で約1.7倍。コスト差は方法1と同傾向。
- **応答内容**: 2.1-miniは「発言は減らさない」「準備は増やさない」という前段の制約を
  引き継いだ回答を返す傾向が見られた。一方どちらのモデルも話題を文章・プレゼンの
  短縮と解釈しており、「会議」という文脈の取り違えは両者で発生。内容品質の優劣は
  この1試行では断定しない。
- **結論は方法1と同じ**: 実機でもgpt-realtime-miniの採用判断を変える材料はなし。
  会話継続時はレイテンシ差が縮むため、応答の掘り下げを重視する用途なら
  2.1-mini＋応答長を抑えるinstructions強化、という選択肢は残る。

## 比較時の注意点

- **PC側の応答待ちタイムアウトは25秒固定**（SPEC §7.2。マイコン側35秒との10秒マージン）。
  Reasoningモデルの推論で25秒を超えたターンは `RealtimeError` → 0x04（実機では赤点滅3回）
  になる。頻発する場合の調整点は `src/openai_client/realtime_client.py` の
  `RESPONSE_TIMEOUT_SEC` だが、マイコン側`0x02`受信後35秒（`firmware/src/serial_link.h`）
  との整合が必要。まず既定値のまま実測して判断する。
- 30秒を超える応答はどちらのモデルでも上限ちょうど（1,440,000バイト）で打ち切られる
  （§4.2。`Response audio exceeded the ... byte cap` ログで判別）。
- 定型応答アセット（`scripts/canned_thanks.pcm`）の再生成（`gen-thanks`）は
  意図的に `--model` 非対応。本番既定モデルの声で固定するため。
- 日本語transcriptがコンソールで文字化けして見えることがあるが表示のみの問題
  （`docs/task.md`「環境依存の既知の注意点」）。
