# firmware ビルド・書き込み手順書

`firmware/`（PlatformIOプロジェクト）のビルド・実機書き込み・動作確認の手順をまとめる。
環境依存のハマりどころは「5. 既知の注意点」を参照。

## 前提環境

- PlatformIO Core導入済み（`uv tool install platformio --with pip`。`--with pip`が
  無いとesptoolパッケージのpostinstallが失敗する）。`pio`コマンドは
  `%USERPROFILE%\.local\bin` にある
- 対象ボード: M5Stack Atom EchoS3R（Atom VoiceS3R, SKU C126-ECHO）。
  MCU: ESP32-S3-PICO-1-N8R8（Flash 8MB quad / PSRAM 8MB octal）
- OS: Windows（PowerShell）

## ディレクトリ構成

```text
firmware/
  platformio.ini   env定義（atom_echos3r=実機、native=ホスト側ユニットテスト）
  src/             ファームウェア本体
  test/            PlatformIO native環境向けUnityテスト（ハードウェア非依存ロジックのみ）
```

## 1. ホスト側ユニットテスト（実機不要）

パケットパーサ・ハンドシェイクタイマー等のハードウェア非依存ロジックのテスト。

```powershell
pio test -e native -d firmware
```

初回のみUnityフレームワークのダウンロードが走る（ウィルス対策ソフトの通知が出ることがある。
「5. 既知の注意点」参照）。2回目以降は数秒で完了する。

## 2. 実機向けビルド（書き込みなし、コンパイル確認のみ）

実機を接続していなくても実行できる。コードが実機環境向けにコンパイルできることだけを
確認したいときに使う。

```powershell
pio run -e atom_echos3r -d firmware
```

## 3. 実機書き込み

### 3-1. 初回書き込み時の注意（工場出荷ファームウェアの場合）

工場出荷ファームウェアは書き込み用の自動リセットシーケンスに応答しない。

1. USBケーブルで接続する
2. 本体のリセットボタンを**約2秒長押し**する（内部の緑LEDが点灯し、ダウンロードモードに入る）
3. ダウンロードモード中はUSBがROMブートローダー（VID `0x303A` / PID `0x1001`）として
   再列挙され、**COMポート番号が変わることがある**（実測例: COM5→COM7）。デバイスマネージャー
   等で書き込み先のポート番号を確認しておく
4. 通常どおり書き込みコマンドを実行する（ポート自動検出に失敗する場合は
   `--upload-port` で明示する）:

   ```powershell
   pio run -e atom_echos3r -d firmware -t upload
   # 自動検出に失敗する場合
   pio run -e atom_echos3r -d firmware -t upload --upload-port COM7
   ```

5. 手動でダウンロードモードに入れた場合、書き込み後の自動リセットが効かないことがある。
   その場合はリセットボタンを短押しして手動で再起動する

### 3-2. 2回目以降（本ファームウェア書き込み済みの場合）

本ファームウェアは `ARDUINO_USB_MODE=0`（TinyUSB USB-OTG CDC）を使う（task7段階2で、内蔵
HW CDC/JTAGのhost→deviceバルク受信が遅く大きな音声を受信できなかったため切替。詳細は
`docs/task7_verification.md`）。**この構成では書き込み用の自動リセットが効かない**ため、初回と同様に
手動でダウンロードモードへ入れてから書き込む（実測手順、2026-07-12。USBは接続したままでよい）:

1. USB接続したまま、本体のリセットボタンを**2秒以上長押し**してダウンロードモードに入る
2. 書き込みコマンドを実行する:

   ```powershell
   pio run -e atom_echos3r -d firmware -t upload
   # 自動検出に失敗する場合は書き込み先を明示（COM番号はデバイスマネージャー等で確認）
   pio run -e atom_echos3r -d firmware -t upload --upload-port COM7
   ```

3. 書き込み完了後、**リセットボタンを短押し**してアプリを起動する

列挙は引き続き VID `0x303A`（PIDは変わり得る）。`port_discovery.py` のVID判定はそのまま有効だが、
COMポート番号が変わることがあるので接続時に確認する。

## 4. シリアルモニタでの動作確認

```powershell
pio device monitor -e atom_echos3r -d firmware
```

終了は `Ctrl+C`。ボーレートは`platformio.ini`の`monitor_speed=115200`を使用するが、
USBネイティブCDCのため実効速度には影響しない名目値。

## 5. 既知の注意点

- **ウィルス対策ソフトによるレジストリミラー遮断**: PlatformIOレジストリのミラー
  `sin1.contabostorage.com` が遮断されることがある。大量のブロック通知が出るが実害はなく、
  公式の別ミラーへ自動フォールバックされる。通知の氾濫を避けるため、ライブラリ類
  （M5GFX / M5Unified / Adafruit NeoPixel）はレジストリ経由ではなくGitHubリリースzipを
  `platformio.ini`の`lib_deps`に直接指定している。Unity（nativeテスト用）等、今後
  追加するライブラリの初回ダウンロード時も同様の通知が出る可能性がある
- **esptoolのPython依存が壊れた場合の復旧**:

  ```powershell
  uv tool run --from platformio python -m pip install --no-compile -t `
      "$env:USERPROFILE\.platformio\packages\tool-esptoolpy\_contrib" <依存一覧>
  ```

- **DTR/RTS（`ARDUINO_USB_MODE=0`）**: 本ファームは USB-OTG CDC のため、**DTRをアサートして
  開いたときだけマイコンが送信する**（TinyUSB CDCの`tud_cdc_connected()`がDTRに連動）。PC側
  `SerialTransport`（`open_serial_transport`）は既定でDTRを立てて開くためそのまま疎通する。
  段階2プローブ（`scripts/task7_fw_probe.py`）も既定でDTRアサート。旧`ARDUINO_USB_MODE=1`向けの
  「DTR非アサートで開く」注意は不要になった（MODE=0では逆にアサートが必須）

## 6. よく使うコマンド一覧

| コマンド | 内容 |
| :--- | :--- |
| `pio test -e native -d firmware` | ホスト側ユニットテストのみ実行（実機不要） |
| `pio run -e atom_echos3r -d firmware` | 実機向けビルド（書き込みなし） |
| `pio run -e atom_echos3r -d firmware -t upload` | ビルド＋書き込み |
| `pio device monitor -e atom_echos3r -d firmware` | シリアルモニタ |
| `pio run -e atom_echos3r -d firmware -t clean` | ビルド成果物のクリーン |
