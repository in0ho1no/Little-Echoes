# 事前録音音声による動作確認

## Audacityを利用して音声を用意する

書き出し時に以下指定
・サンプリングレート24000Hz
・モノラル
・16-bit PCM WAV

## 挙動確認

### 最初に環境変数の設定

新規WindowsTerminalなど起動して環境変数を設定する

```ps
$env:OPENAI_API_KEY_VIG = [Environment]::GetEnvironmentVariable("OPENAI_API_KEY_VIG", "User")
```

### 単純に音声生成の確認

一番安価、スキーマ・イベント名の整合性確認になる

```ps
uv run python scripts/manual_realtime_check.py gen-thanks
```

実行時ログ

```ps
[in0ho1no] PS D:\work\Em\03VoiceInteractionGadget\prj> uv run python scripts/manual_realtime_check.py gen-thanks
Saved canned audio (81600 bytes) to scripts\manual_check_output\canned_thanks.pcm
Transcript: 'どういたしまして！'
Validated: file loads successfully via CannedAudio.
[in0ho1no] PS D:\work\Em\03VoiceInteractionGadget\prj>
```

注記: 上記ログはレビュー対応前の実行記録。現在の既定保存先は
`scripts/canned_thanks.pcm`（タスク13の`main.py`が既定で参照する固定アセット）に
変更されており、`scripts/manual_check_output/`には保存されない。

### 事前用意した録音ファイルに対する応答を確認する

#### ありがとう

ありがとうを入力として挙動確認

```ps
uv run python scripts/manual_realtime_check.py respond --input scripts/pre_rec_thanks.wav
```

thanks_detected=trueで検知できているとみられるが、応答音声は0bytesになる挙動を確認できた。

```ps
[in0ho1no] PS D:\work\Em\03VoiceInteractionGadget\prj> uv run python scripts/manual_realtime_check.py respond --input scripts/pre_rec_thanks.wav
Loaded input PCM: 188918 bytes (~3.94s at 24000Hz/16bit/mono)
2026-07-12 02:34:18,803 INFO openai_client.realtime_client: Realtime session established (model=gpt-realtime-mini).
2026-07-12 02:34:20,043 INFO debug_utils: Realtime response: transcript=None, duration=4.97s, usage=[input_tokens=172, output_tokens=15, total_tokens=187]
thanks_detected: True
response audio: 0 bytes
No response audio received (empty).
[in0ho1no] PS D:\work\Em\03VoiceInteractionGadget\prj>
```

#### 長い応答1

応答が30秒に満たない場合は、その分きっちり応答してくれる。

```ps
uv run python scripts/manual_realtime_check.py respond --input scripts/pre_rec_test24sec.wav --instructions "できるだけ長く、詳細に、日本語で話し続けてください。"
```

以下実行時のログ

```ps
[in0ho1no] PS D:\work\Em\03VoiceInteractionGadget\prj> uv run python scripts/manual_realtime_check.py respond --input scripts/pre_rec_test24sec.wav --instructions "できるだけ長く、詳細に、日本語で話し続けてください。"
Loaded input PCM: 1153568 bytes (~24.03s at 24000Hz/16bit/mono)
2026-07-12 02:51:46,392 INFO openai_client.realtime_client: Realtime session established (model=gpt-realtime-mini).
2026-07-12 02:51:51,332 INFO debug_utils: Realtime response: transcript='承知しました。OpenAIのAPIは、利用者の音声を録音したデータを保存しない方針になっています。つまり、ユーザーの音声は一時的に処理に必要な分だけ使用され、一定期間が過ぎると削除されます。そのため、録音データが長期的に保存されたり、他の用途に使用されたりすることはありません。もしさらに詳しい情報が必要であれば、公式のドキュメントを参照するか、プライバシーポリシーをご確認いただくのも良いと思います。何か他に気になる点はありますか？', duration=6.42s, usage=[input_tokens=321, output_tokens=775, total_tokens=1096]
thanks_detected: False
response audio: 1416000 bytes
Saved response audio to scripts\manual_check_output\response_20260712_025151_333282.wav
[in0ho1no] PS D:\work\Em\03VoiceInteractionGadget\prj>
```

#### 長い応答2

応答が30秒を超過する場合は、30秒丁度で打ち切る応答になることの確認

```ps
uv run python scripts/manual_realtime_check.py respond --input scripts/pre_rec_expect_response_over30sec.wav --instructions "できるだけ長く、詳細に、日本語で話し続けてください。"
```

以下実行時のログ

```ps
[in0ho1no] PS D:\work\Em\03VoiceInteractionGadget\prj> uv run python scripts/manual_realtime_check.py respond --input scripts/pre_rec_expect_response_over30sec.wav --instructions "できるだけ長く、詳細に、日本語で話し続けてください。"
Loaded input PCM: 1202462 bytes (~25.05s at 24000Hz/16bit/mono)
2026-07-12 03:00:25,660 INFO openai_client.realtime_client: Realtime session established (model=gpt-realtime-mini).
2026-07-12 03:00:30,572 INFO openai_client.realtime_client: Response audio exceeded the 1440000 byte cap; requesting cancellation.
2026-07-12 03:00:30,739 INFO debug_utils: Realtime response: transcript='確かに、生成AIの登場は目覚ましいスピードで社会や技術に影響を与えていますよね。これまでにもAIには様々な発展段階がありました。例えば、機械学習のブームや、ディープラーニングの登場なども大きな転換点と言えるでしょう。今回生成AIがここまで注目されている理由は、大規模なデータセットの蓄積と、計算能力の飛躍的向上、そして高度なモデルの開発が組み合わさった結果と言えるでしょう。単語や文章を理解し生成する能力が飛躍的に向上しているので、応用範囲', duration=6.83s, usage=[input_tokens=331, output_tokens=827, total_tokens=1158]
thanks_detected: False
response audio: 1440000 bytes
Saved response audio to scripts\manual_check_output\response_20260712_030030_739864.wav
[in0ho1no] PS D:\work\Em\03VoiceInteractionGadget\prj>
```
