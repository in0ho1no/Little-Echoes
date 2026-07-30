# マイコン側（Arduino/C++、M5Stack Atom EchoS3R）実装タスク（全完了）

`docs/SPEC.md` v1.3系に基づくマイコン側（ファームウェア）実装タスクの記録。

**task0〜8すべて完了（2026-07-14）。マイコン側・PC側（`docs/task.md`）ともに残タスクはない。**

本ファイルは完了記録として、確定した開発環境・設計判断・踏んだ不具合・環境依存の注意点を残す。
firmwareのコードコメントが本ファイルの「申し送り事項」を参照しているため、当該セクションは
維持している。実装の時系列な経緯はgit履歴を参照。

実機確認・障害調査の詳細記録:

- ビルド・書き込み手順: `docs/how_to_setup_fw.md`
- task7（状態遷移統合）の実機確認と設計判断: `docs/task7_verification.md`
- task8（実機E2E）のチェックリストと間欠USB停止問題の全記録: `docs/task8_verification.md`
- USBスループット問題（44KB/s→512KB/s）の根本原因分析: `docs/issue_usb_throughput.md`

## 開発環境・ツール（確定・2026-07-12ユーザー決定）

1. 開発環境: PlatformIO（native環境でのホスト側ユニットテストが組みやすいため）。
   導入手順・ハマりどころは「環境依存の既知の注意点」参照。
2. ライブラリ: M5Unified 0.2.18（Mic/Speaker/Button統合クラス）＋
   Adafruit NeoPixel 1.15.5（Unit HEX駆動。M5Unifiedは外付けLEDストリップの駆動機能を
   持たない）。いずれもGitHubリリースzipを`lib_deps`に直接指定（レジストリミラー遮断の回避）。
3. C++言語標準: native・実機ターゲットともC++17に統一。Arduino-ESP32 2.0.17の実機向け
   既定値はC++11のため、`build_unflags`で除去して`-std=gnu++17`を指定。
   ヘッダー定数には`inline constexpr`を使う。
4. テスト方針: ハードウェア非依存ロジック（パケットパーサ、クリック判定、状態機械等）は
   PlatformIO native環境（Unity）でユニットテスト、ハードウェア依存部分
   （I2S/NeoPixel/GPIO/実USBシリアル）は実機チェックリストで確認。
   最終状態: `pio test -e native` 157件全パス。

## ハードウェア確定事項（task0で実機確認済み）

- EchoS3R = ESP32-S3-PICO-1-N8R8（Flash 8MB quad / PSRAM 8MB octal →
  board設定は`esp32-s3-devkitc-1`ベース＋`memory_type=qio_opi`）。
- ピンマップ: ボタン=G41、Grove=G2/G1、ES8311コーデック WS=G3/BCLK=G17/MCLK=G11/
  DOUT=G48/DIN=G4/アンプ制御=G18、IR=G47。**内蔵RGB LEDは無い**。
- Unit HEX（SK6812×37灯、Grove接続）のデータピンは**G2**で動作（`kLedDataPin`で1箇所変更可）。

## ディレクトリ構成（実状）

```text
firmware/
  platformio.ini          # env: atom_echos3r（実機）/ atom_echos3r_txstress（ストレスFW）/ native（ホストテスト）
  src/
    main.cpp               # エントリーポイント、Action翻訳、モジュール配線
    stress_main.cpp        # ストレステストFW（task8のUSB停止調査用。txstress環境でのみビルド）
    button_input.h/.cpp    # デバウンス・クリック判定（単押し/長押し/トリプルクリック）
    led_controller.h/.cpp  # NeoPixel演出（8状態、RMT駆動、輝度制限）
    audio_record.h/.cpp    # I2S録音（24kHz/16bit/モノラル、PSRAMバッファ）
    audio_playback.h/.cpp  # I2S再生（リングバッファ＋チャンクプール）
    packet.h/.cpp          # PC側 src/transport/packet.py と対になるC++移植
    serial_link.h/.cpp     # 独自TinyUSB CDC・READY送信・ハンドシェイクタイマー
    state_machine.h/.cpp   # 待機/録音/考え中/再生/エラー/キャンセルの状態遷移
  test/                    # PlatformIO nativeテスト（Unity。ハードウェア非依存ロジック対象）
```

## 設計判断・実装知見（モジュール別）

将来の変更時に把握しておくべきもののみ。詳細な完了経緯はgit履歴参照。

全モジュール共通:

- 時刻はミリ秒単位の`TimeFunc`（`std::function<uint32_t()>`）注入で、実機では`millis`を渡す。
  経過判定は符号なし減算のため32bitラップアラウンド（約49日）安全。
- C++の「ポインター＋サイズ」APIでは、サイズ0のときにポインター演算や範囲生成を行わない。
  空の`vector::data()`や受信0バイトでは`nullptr`になり得るため、`size > 0`を確認してから
  `data + size`等を評価する。空入力の回帰テストを設ける。

各モジュール:

- **packet**: PC側 `src/transport/packet.py` が正本で挙動を完全一致させる
  （SYNC再同期・SIZE上限2MB・BODY 5秒**無進捗**タイムアウト）。差分は言語都合の2点のみ
  （cmd範囲チェックは`uint8_t`型で代替、encode失敗はValueErrorでなく`bool`戻り値）。
- **serial_link**: USBスループット問題の解決に伴い**独自TinyUSB CDCドライバへ全面書き換え**
  （`ARDUINO_USB_CDC_ON_BOOT=0`。**以後 Serial（USBCDC/UART）はFWで使用禁止**＝リンク衝突。
  platformio.iniコメント参照）。READYはポートオープン（DTR）検知の**200ms後**に自動再送
  （検知直後の送信はホストのオープン処理中のパージに飲まれる）。
  TX送信は間欠停止対策のストリーミング方式＋3.5秒打ち切り（変遷の全記録:
  `docs/task8_verification.md` G、`serial_link.cpp`のコメント）。
  `HandshakeTimer`は受信イベント処理時にも期限を判定し、待ち状態でない時の受信は無視する
  （遅延到着した0x02がタイマーを誤って再スタートする等の誤遷移を防ぐ）。
- **button_input**: `kDebounceMs=40`、`kLongPressMs=1500`（§4.1最短録音長と同値）、
  `kMultiClickWindowMs=1200`。トリプルは3回目の押下エッジで即時確定（その押下で録音を
  開始しないこと）、単押し（1〜2回）は窓満了時に確定、長押しは解放時に保持時間で確定。
  状態非依存の純粋な検出器とし、「待機中以外は無視」等のアプリ状態フィルタは上位層の責務。
- **led_controller**: `kMaxBrightness=80`（≈31%。`static_assert`で30〜50%域に固定、§2.2対策1）。
  全状態を交互配置の最大19灯に制限し37灯同時点灯を構造的に回避（§2.2対策2）。白も生成しない。
  NeoPixel更新は20ms間隔（最大50fps）に制限。一過性演出（エラー/破棄/キャンセル）は
  `isTransientFinished()`で完了を通知し上位層が待機復帰に使う。
- **audio_record**: 24kHz/16bit/モノラル、`kMinRecordingMs=1500`（`static_assert`で
  `button_input::kLongPressMs`と同値を担保）、`kMaxRecordingMs=30000`、バッファ1.44MBは
  PSRAM（`MALLOC_CAP_SPIRAM`）。録音ゲイン`kMicMagnification=32`（既定16では小さかった）。
  録音データ量はサンプル数ベースで管理し、実時間（`millis`）でも30秒を監視
  （DMA停止・サンプル欠落時にも終了させる二重の安全策）。
- **audio_playback**: 「リングバッファ＋再生タスク」構造（§9。将来のストリーミング化は
  受信部が`startStream`→`appendPcm`→`finishStream`を逐次呼ぶ変更のみで済む）。
  **M5.Speaker.playRaw()は供給バッファを参照して再生する**ため、DMA完了まで生存する
  固定チャンクプール（3段×512サンプル。プール段数はスピーカーの同時保持数(最大2)より多い）
  を順に回す。音量`kSpeakerVolume=220`（`begin()`で`setVolume()`必須。未設定だと無音）。
  マイクとスピーカーはI2S共有のため、再生開始はマイクを、録音開始はスピーカーを停止する（対）。
- **state_machine / main.cpp**: 0x01の物理送信成功後に3秒タイマーを開始し、0x02受信で
  考え中スピナーへ。0x03は0x02受信後かつ35秒期限内だけ受理。送信/破棄の判定は録音サンプル数
  （`StopResult`）を正本とし、`kLongPress`ジェスチャでは駆動しない（DMA取りこぼし時の
  薄い音声の誤送信防止）。録音赤LEDは押下から1.5秒（長押し確定）後に点灯
  （タップでの一瞬赤を構造的に排除。録音データ自体は押下時点から取り込む）。
  ジェスチャは押下エッジより先に処理する（トリプル3回目の押下で録音を開始しない）。
  起動音（880Hz・約1秒・音量50、`kBootTone*`）は再起動に気づく目安＋スピーカー疎通確認。
  設計判断の詳細は `docs/task7_verification.md`「設計上の決定」参照。
- **デバッグ用コマンド（SPEC外）**: `0x7C`=疑似ボタン押下（BODY=4B LE保持ms。無人E2E用）、
  `0x7D`=ブートローダー再起動（物理ボタンなしの遠隔書き込み用）、`0x7F`=診断通知
  （エラー遷移の全経路で理由コード＋詳細をPCへ通知。`pipeline.py`が警告ログに解読）。
  アプリFW/ストレスFW共通。無人検証スクリプトは `scripts/task8_txstress.py`・
  `scripts/task8_e2e_autorun.py`・`scripts/task7_fw_probe.py --auto-press`。

## task7〜8で解決した大きな問題（要点）

1. **USBスループット問題**: PC→マイコンが約44KB/s（音声レート48KB/s未満）で頭打ち。
   Arduinoコア2.0.17のUSBCDC受信のper-byteキュー実装が原因と特定し、独自TinyUSB CDC
   ドライバへ全面書き換えで実測512KB/sに改善。詳細: `docs/issue_usb_throughput.md`。
2. **BODYタイムアウトの設計欠陥**: 「ヘッダ後5秒で全体」が30秒録音（1.44MB）の正常送信を
   破棄していた。両側とも無進捗判定（新データが5秒来ない場合のみ破棄）へ改訂
   （SPEC §3.2 v1.3.2）。
3. **間欠USB停止（マイコン→PC転送の末尾停止）**: 根本原因は「PC側のノンブロッキング
   ポーリング受信がusbserドライバのUSB IN転送を止め、デバイス側USBスタック（dcd_esp32sx）の
   不具合を誘発する」。PC側`SerialTransport`へ常駐リーダースレッドを導入して根本解決
   （実`main.py`＋Realtimeの無人E2E 15サイクル全成功で確認）。切り分けの全記録:
   `docs/task8_verification.md` G。
4. UX調整（実機確認で判明）: 録音赤LEDは長押し確定（1.5秒）で点灯、キャンセル受理は
   青→マゼンタ（SPEC v1.3.1。再生中の青と区別のため）、起動音の常設、
   音量`kSpeakerVolume=220`・録音ゲイン32。

レイテンシ実測（task8 E2E、2026-07-14）: Realtime応答約3〜4.5秒、USB転送約700KB/s
（旧構成のクラウド処理14.34秒から大幅改善）。

## 申し送り事項（PC側から引き継ぐべき情報）

- パケット仕様は `src/transport/packet.py`（PC側）が正本。C++移植時は挙動を
  完全一致させること（SIZE上限2MB、BODY5秒無進捗タイムアウト、SYNC再同期ロジック）。
- PC側 `Transport.recv_packet(timeout=0)` は非ブロッキング前提
  （PC側タスク10のasyncio多重待機のため）。マイコン側の受信実装自体には
  直接影響しないが、マイコン側が`0x05`送信を遅延なく行えるようにすること
  （PC側は0x05受信を最優先で監視する設計）。
- タイムアウト値: PC側Realtime応答待ち25秒、マイコン側`0x02`受信後35秒
  （10秒の余裕を持たせた設計）。`0x01`送信後3秒は`0x02`受理確認用。
  両者は個別の定数として調整可能にすること。
- エフェクトID（`0x03` BODY先頭1バイト）: `0x00`=通常応答、`0x01`=感謝定型応答（§3.3）。
- ボタン操作の最終仕様（§6、2026-07-11確定・蒸し返さない）:
  単押し（1〜2回）=何もしない、長押し=録音、トリプルクリック=強制リセット。
  ダブルクリック＝会話終了案は不採用（待機中トリプルクリックと効果が同一のため）。
- 電源対策（§2.2）: HEXボード37灯フル点灯（特に白）は電圧降下リスクがあるため、
  輝度30〜50%制限と「常に一部のみ点灯」の演出方針を厳守すること。
- PC側はポートオープン後、READY(`0x06`)を5秒以内に受信できないとエラー終了する
  （`wait_for_ready`）。リセット後の起動〜READY送信が5秒に収まる必要がある
  （DTR検知200ms後の自動再送で担保済み。task8で実機確認済み）。
- PC側のシリアル送信には`write_timeout`5秒が設定されている（PC側タスク13）。
  マイコン側がUSB CDCの受信読み出しを長時間止めるとPC側の`0x03`送信
  （最大約2MB）が失敗し得るため、BODY受信中は停滞なく読み続けること。

## 環境依存の既知の注意点

- PlatformIOは`uv tool install platformio --with pip`で導入済み（`pio`は
  `%USERPROFILE%\.local\bin`にある）。`--with pip`が無いとesptoolパッケージの
  postinstall（`python -m pip`）が失敗し`MissingPackageManifestError`になる。
- ウィルス対策ソフトがPlatformIOレジストリのミラー`sin1.contabostorage.com`を
  遮断する（大量のブロック通知が出るが実害はなく、公式の別ミラーへ自動フォールバック
  される）。通知の氾濫を避けるため、ライブラリ類はレジストリではなくGitHubリリース
  zipを`lib_deps`に直接指定する方針とした。新規ライブラリの初回ダウンロード時も
  同様の通知が出る可能性がある。
- esptoolのPython依存が壊れた場合は
  `uv tool run --from platformio python -m pip install --no-compile -t
  %USERPROFILE%\.platformio\packages\tool-esptoolpy\_contrib <依存一覧>`で復旧できる。
- 書き込み: `ARDUINO_USB_MODE=0`では自動リセットが効かない場合があり、BOOT長押し＋
  リセットのダウンロードモードで書き込む（手順: `docs/how_to_setup_fw.md`）。
  遠隔書き込みはデバッグコマンド`0x7D`（ブートローダー再起動）で物理操作なしに可能。
  ダウンロードモード時はROMブートローダー（VID 0x303A/PID 0x1001）として再列挙され、
  COMポート番号が変わり得る。
- **USBモードは`ARDUINO_USB_MODE=0`（TinyUSB USB-OTG CDC）**（task7段階2で確定。
  当初のMODE=1=内蔵HW CDC/JTAGはhost→deviceバルク受信が遅く大きな`0x03`を受信できなかった）。
  - 列挙は引き続きVID 0x303A（PIDは変わり得る）。PC側`port_discovery.py`のVID判定は
    そのまま有効だが、COMポート番号は変わり得るので実機接続時に確認する。
  - MODE=0では**DTRアサート時のみマイコンが送信する**（TinyUSB CDCの`tud_cdc_connected()`が
    DTRに連動）。PC側`SerialTransport`（`open_serial_transport`）は既定でDTRを立てて開くため
    そのまま疎通する。
