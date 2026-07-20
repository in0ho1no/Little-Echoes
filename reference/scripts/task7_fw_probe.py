"""task7（マイコン側メイン状態遷移統合）の段階2実機確認用 PC側ダミースクリプト。

`docs/task7_verification.md` の「段階2」で使う。OpenAI Realtime API は使わず（課金なし・
自動テスト対象外。`src/tests/` には置かない）、マイコンの相手役として最小限のハンドシェイクと
コマンド応答だけを行い、以下を実機確認できるようにする。

- READY(0x06) のハンドシェイク（ポートオープンからの受信タイミング）
- `0x01`（録音音声）受信 → タイムスタンプ付きWAVで保存（録音音質・マイクゲイン確認）
- `0x02`/`0x03`/`0x04` の返送で、考え中スピナー・再生（青明滅/お祝いレインボー）・
  エラー表示のLEDと再生音質を確認
- `0x02`/`0x03` をわざと返さないモードで、3秒/35秒タイムアウト→エラー復帰を確認
- `0x05`（キャンセル＝トリプルクリック）受信のログ

再利用: `port_discovery`（ポート検出）・`SerialTransport`/`packet`（送受信）・
`wav_utils`（PCM→WAV）。

## 使い方（PowerShell）

    uv run python scripts/task7_fw_probe.py                 # 自動検出・normalモード
    uv run python scripts/task7_fw_probe.py --port COM7     # ポート指定
    uv run python scripts/task7_fw_probe.py --mode no-accept # 3秒タイムアウト確認
    uv run python scripts/task7_fw_probe.py --mode accept-only # 35秒タイムアウト確認
    uv run python scripts/task7_fw_probe.py --mode error    # 0x04エラー確認
    uv run python scripts/task7_fw_probe.py --effect 1 --reply scripts/pre_rec_thanks.wav
    uv run python scripts/task7_fw_probe.py --inject garbage # パーサ再同期確認（task8項目22）
    uv run python scripts/task7_fw_probe.py --inject stall   # BODY無進捗5秒タイムアウト確認（同上）

Ctrl+C で終了する。既定では DTR/RTS をアサートして開く（`ARDUINO_USB_MODE=0`/USB-OTG CDC は
DTRアサート時のみマイコンが送信するため。実PC側 `open_serial_transport()` と同じ挙動）。
MODE=1/HW CDC-JTAG のファームを相手にする場合や、オープン時のリセットを避けたい場合は
`--no-assert-dtr` で非アサート開きにできる。マイコンが起動済みで最初のREADYを取りこぼした場合は、
基板のリセットボタンを押すと新しいREADYが飛び、本スクリプトがその受信タイミングをログする
（§3.4の救済に相当）。
"""

import argparse
import sys
import time
import wave
from datetime import datetime
from pathlib import Path

import serial

_SRC_DIR = Path(__file__).resolve().parent.parent / 'src'
if str(_SRC_DIR) not in sys.path:
    sys.path.insert(0, str(_SRC_DIR))

from audio.wav_utils import pcm_to_wav_bytes  # noqa: E402
from device.port_discovery import NoPortAvailableError, select_port  # noqa: E402
from transport.packet import BODY_TIMEOUT_SEC, HEADER_SIZE, Command, Packet, encode_packet  # noqa: E402
from transport.serial_transport import (  # noqa: E402
    DEFAULT_BAUDRATE,
    READ_POLL_INTERVAL_SEC,
    SerialTransport,
)

SAMPLE_RATE_HZ = 24000
"""録音・再生の固定サンプリングレート（docs/SPEC.md §4）。"""

SAMPLE_WIDTH_BYTES = 2  # 16-bit
CHANNELS = 1  # モノラル

READY_TIMEOUT_SEC = 5.0
"""ポートオープン後にREADYを待つ上限（docs/SPEC.md §3.4）。"""

WRITE_TIMEOUT_SEC_LARGE = 60.0
"""大きな0x03（最大約1.44MB）の送信用の書き込みタイムアウト。デバイスがバックプレッシャーで
受信を絞ると1回のwrite()が既定5秒を超えてSerialTimeoutExceptionになるため、余裕を持たせる。"""

DEFAULT_THINK_SEC = 2.0
"""`normal`/`error` モードで 0x02 送信後に待つ「考え中」時間。スピナーを目視する余裕を持たせる。"""

DEFAULT_REPLY_PATH = Path('scripts/canned_thanks.pcm')
"""既定の応答PCM（ヘッダなしRAW、24kHz/16bit/モノラル）。"""

DEFAULT_OUTPUT_DIR = Path('scripts/manual_check_output')
"""受信録音WAVの保存先（.gitignore対象の使い捨て。manual_realtime_check.py と共用）。"""

POLL_INTERVAL_SEC = 0.05

GARBAGE_BYTES = (
    b'\x00\xff\x10\x20'  # SYNCを含まない無関係バイト
    b'\x5a\xa5\x00'  # 順序が逆のSYNC＋SYNC1の後が続かない壊れたSYNC
    b'\xa5\x00'  # SYNC1のみで壊れたSYNC
    b'\xa5\x5a\x03\xff\xff\xff\xff'  # SIZE(約4GB)が上限2MB超過の不正ヘッダー → パーサリセット
    b'\x11\x22'  # リセット後に読み捨てられるべき残骸（末尾を0xA5にしない: 直後の正規SYNCと連結させない）
)
"""`--inject garbage` で正規パケットの直前に流す汚染バイト列（task8項目22: パーサ再同期の実地確認）。"""

STALL_CLAIMED_BODY_BYTES = 64 * 1024
"""`--inject stall` の不完全パケットがヘッダーで宣言するBODYサイズ。"""

STALL_SENT_BODY_BYTES = 1024
"""`--inject stall` で実際に送るBODYの先頭バイト数（残りを送らずに停止する）。"""

STALL_NO_PROGRESS_SEC = BODY_TIMEOUT_SEC + 1.5
"""`--inject stall` の停止秒数。BODY無進捗タイムアウト（5秒）を確実に超えさせる。"""


def _log(message: str) -> None:
    """タイムスタンプ付きでコンソールへ出力する。"""
    print(f'[{datetime.now().strftime("%H:%M:%S.%f")[:-3]}] {message}', flush=True)


def open_probe_serial(port: str, *, assert_lines: bool) -> serial.Serial:
    """ポートを開く。DTR/RTS の状態を選べる。

    既定（assert_lines=True）は、USB-OTG CDCが接続済みと判定できるようDTR/RTSをアサートする。
    MODE=1/HW CDC-JTAGのファームを相手にする場合など、明示的に非アサートで開く必要があるときだけ
    `--no-assert-dtr`を指定する。

    Args:
        port: シリアルポート名（例: "COM7"）。
        assert_lines: True で DTR/RTS をアサートして開く。

    Returns:
        オープン済みの `serial.Serial`。
    """
    connection = serial.Serial()
    connection.port = port
    connection.baudrate = DEFAULT_BAUDRATE
    connection.timeout = READ_POLL_INTERVAL_SEC
    # 大きな0x03（最大1.44MB）の送信でバックプレッシャーにより1回のwrite()が長引いても
    # SerialTimeoutExceptionにならないよう、既定5秒より大きめにする。
    connection.write_timeout = WRITE_TIMEOUT_SEC_LARGE
    # オープン前に設定しておくことで、オープン時のDTR/RTS状態を制御する。
    connection.dtr = assert_lines
    connection.rts = assert_lines
    connection.open()
    return connection


def load_reply_pcm(path: Path) -> bytes:
    """応答用PCMを読み込む。`.wav` はフォーマット検証のうえRAW PCMを取り出す。

    Args:
        path: `.wav`（24kHz/16bit/モノラル）またはヘッダなしRAW PCMファイル。

    Returns:
        ヘッダなしRAW PCMバイト列。

    Raises:
        ValueError: `.wav` のフォーマットが 24kHz/16bit/モノラルでない場合。
    """
    if path.suffix.lower() == '.wav':
        with wave.open(str(path), 'rb') as wav_file:
            rate = wav_file.getframerate()
            width = wav_file.getsampwidth()
            channels = wav_file.getnchannels()
            if (rate, width, channels) != (SAMPLE_RATE_HZ, SAMPLE_WIDTH_BYTES, CHANNELS):
                raise ValueError(f'{path} は 24kHz/16bit/モノラルではありません (rate={rate}, width={width}, channels={channels})')
            return wav_file.readframes(wav_file.getnframes())
    return path.read_bytes()


def _duration_sec(pcm_bytes: int) -> float:
    """PCMバイト数から秒数を求める（24kHz/16bit/モノラル前提）。"""
    return pcm_bytes / SAMPLE_WIDTH_BYTES / SAMPLE_RATE_HZ


def save_recording(body: bytes, output_dir: Path) -> Path:
    """受信した録音RAW PCMをタイムスタンプ付きWAVで保存する。

    Args:
        body: `0x01` のBODY（ヘッダなしRAW PCM）。
        output_dir: 保存先ディレクトリ（なければ作成する）。

    Returns:
        保存したWAVファイルのパス。
    """
    output_dir.mkdir(parents=True, exist_ok=True)
    path = output_dir / f'fw_rec_{datetime.now().strftime("%Y%m%d_%H%M%S_%f")}.wav'
    # 奇数長（1サンプルに満たない端数）はWAVフレーム境界に載らないため末尾を切り捨てる。
    aligned = body[: len(body) - (len(body) % SAMPLE_WIDTH_BYTES)]
    path.write_bytes(pcm_to_wav_bytes(aligned, SAMPLE_RATE_HZ))
    return path


def wait_for_ready(transport: SerialTransport, timeout: float) -> bool:
    """READY(0x06) を timeout 秒まで待つ。待つ間に届いた他パケットはログする。

    Args:
        transport: 受信に使うTransport。
        timeout: 待機上限（秒）。

    Returns:
        READY を受信できたら True。
    """
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        packet = transport.recv_packet(timeout=POLL_INTERVAL_SEC)
        if packet is None:
            continue
        if packet.cmd == Command.READY:
            return True
        _log(f'READY待ち中に想定外のパケットを受信: cmd=0x{packet.cmd:02x} size={len(packet.body)}')
    return False


def _sleep_watching_cancel(transport: SerialTransport, seconds: float) -> bool:
    """指定秒数待つ間に 0x05（キャンセル）が来たら True を返して打ち切る。

    実PC側と同様、考え中の待ち時間中にキャンセルを受けたら応答（0x03）を送らないようにする。

    Args:
        transport: 受信に使うTransport。
        seconds: 待機秒数。

    Returns:
        待機中に 0x05 を受信したら True、しなければ False。
    """
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        packet = transport.recv_packet(timeout=POLL_INTERVAL_SEC)
        if packet is None:
            continue
        if packet.cmd == Command.CANCEL:
            _log('考え中の待機中に 0x05（キャンセル）を受信。応答送信を中止する。')
            return True
        _log(f'考え中の待機中に想定外のパケットを受信: cmd=0x{packet.cmd:02x} size={len(packet.body)}')
    return False


def _send(transport: SerialTransport, cmd: Command, body: bytes = b'') -> bool:
    """パケットを送信し、失敗（部分書き込み・タイムアウト等）を握りつぶさず明示ログする。

    Args:
        transport: 送信に使うTransport。
        cmd: 制御命令。
        body: ボディ。

    Returns:
        送信に成功したら True。失敗したら False（原因をログ済み）。
    """
    try:
        transport.send_packet(cmd, body)
    except (serial.SerialException, serial.SerialTimeoutException) as exc:
        _log(f'!! 送信失敗 cmd=0x{int(cmd):02x} ({len(body)}bytes): {exc}')
        _log('   USB CDCの接続状態と、--no-assert-dtrを指定していないことを確認してください。')
        return False
    return True


def _send_play_audio(transport: SerialTransport, connection: serial.Serial, body: bytes, send_chunk: int, send_delay_ms: float) -> None:
    """0x03 を送信する。send_chunk>0 のときはチャンク分割＋間隔でペーシング送信する。

    ペーシング送信は「ホストが一気に流すのではなく、間隔を空けて送る」ことで、マイコン側の
    受信取りこぼし（バースト）を避けられるかの切り分けに使う。

    Args:
        transport: 通常送信に使うTransport（send_chunk<=0のとき）。
        connection: ペーシング送信で直接書き込む生のシリアル接続。
        body: 0x03 のBODY（エフェクトID＋PCM）。
        send_chunk: >0 ならこのバイト数ごとに分割送信する。<=0 なら一括送信。
        send_delay_ms: チャンク間の待機ミリ秒。
    """
    if send_chunk <= 0:
        if _send(transport, Command.PLAY_AUDIO, body):
            _log('0x03 送信完了。マイコンで再生（青明滅/お祝い）が始まるはず。')
        return

    packet = encode_packet(Command.PLAY_AUDIO, body)
    _log(f'0x03 をペーシング送信: 全{len(packet)}bytes を {send_chunk}Bごと {send_delay_ms:.0f}ms間隔で送る')
    try:
        for offset in range(0, len(packet), send_chunk):
            connection.write(packet[offset : offset + send_chunk])
            if send_delay_ms > 0:
                time.sleep(send_delay_ms / 1000.0)
    except (serial.SerialException, serial.SerialTimeoutException) as exc:
        _log(f'!! ペーシング送信失敗: {exc}')
        return
    _log('0x03 ペーシング送信完了。マイコンで再生が始まるはず。')


def _inject_before_play(connection: serial.Serial, inject: str) -> None:
    """正規の 0x03 送信直前に、パーサ堅牢性確認用の不正データを直接書き込む（task8項目22）。

    どちらの注入でも、直後に送る正規の 0x03 が再生されれば「不正データを破棄して
    SYNCへ再同期できた」ことの実地証明になる。再生されず35秒タイムアウトのエラー点滅に
    なる場合は、不正データがパーサ状態を巻き込んだまま復帰できていない。

    Args:
        connection: 生のシリアル接続（Transportのフレーミングを迂回して書き込む）。
        inject: 'garbage'（汚染バイト→即・正規パケット）または
            'stall'（不完全パケット→無進捗タイムアウト超え停止→正規パケット）。
    """
    if inject == 'garbage':
        _log(f'[inject=garbage] 汚染バイト {len(GARBAGE_BYTES)}bytes（壊れたSYNC・SIZE上限超過ヘッダー入り）を送信し、続けて正規の0x03を送る。')
        connection.write(GARBAGE_BYTES)
        return

    # inject == 'stall'
    partial = encode_packet(Command.PLAY_AUDIO, bytes(STALL_CLAIMED_BODY_BYTES))[: HEADER_SIZE + STALL_SENT_BODY_BYTES]
    _log(
        f'[inject=stall] BODY {STALL_CLAIMED_BODY_BYTES}bytes を宣言するヘッダー＋先頭 {STALL_SENT_BODY_BYTES}bytes '
        f'だけ送って {STALL_NO_PROGRESS_SEC:.1f}秒停止する（無進捗タイムアウト {BODY_TIMEOUT_SEC:.0f}秒の発火待ち）…'
    )
    connection.write(partial)
    time.sleep(STALL_NO_PROGRESS_SEC)
    _log('[inject=stall] 停止終了。マイコン側は不完全パケットを破棄済みのはず。続けて正規の0x03を送る。')


def respond_to_recording(
    transport: SerialTransport,
    connection: serial.Serial,
    args: argparse.Namespace,
    reply_pcm: bytes,
) -> None:
    """`0x01` 受信後の応答を、モードに応じて返す。

    Args:
        transport: 送受信に使うTransport。
        connection: ペーシング送信用の生シリアル接続。
        args: CLI引数（mode/effect/think/send_chunk/send_delay を参照）。
        reply_pcm: `normal` で再生させるRAW PCM。
    """
    if args.mode == 'no-accept':
        _log('[no-accept] 0x02 を返さない。マイコンは約3秒後に受理タイムアウト→エラー点滅→待機のはず。')
        return

    _log('0x02（受理・考え中要求）を送信。マイコンは考え中スピナーへ移行するはず。')
    if not _send(transport, Command.ACCEPT_PROCESSING):
        return

    if args.mode == 'accept-only':
        _log('[accept-only] 0x03/0x04 を返さない。マイコンは約35秒後に応答タイムアウト→エラー点滅のはず。')
        return

    if _sleep_watching_cancel(transport, args.think):
        return  # 考え中にキャンセルされたので応答しない

    if args.mode == 'error':
        _log('[error] 0x04（エラー通知）を送信。マイコンはエラー点滅→待機のはず。')
        _send(transport, Command.ERROR)
        return

    # mode == 'normal'
    if args.inject != 'none':
        _inject_before_play(connection, args.inject)
    body = bytes([args.effect]) + reply_pcm
    _log(
        f'0x03（再生要求）を送信中… effect={args.effect} '
        f'({"お祝いレインボー" if args.effect == 1 else "通常=青明滅"}) '
        f'BODY={len(body)}bytes（PCM {len(reply_pcm)}bytes ≈ {_duration_sec(len(reply_pcm)):.2f}s）'
    )
    _send_play_audio(transport, connection, body, args.send_chunk, args.send_delay)


FAKE_PRESS_CMD = 0x7C
"""疑似ボタン押下コマンド（デバッグ用・SPEC外）。BODY=4B LEの押下保持ミリ秒。"""


def run_auto_cycles(
    transport: SerialTransport,
    connection: serial.Serial,
    args: argparse.Namespace,
    reply_pcm: bytes,
) -> int:
    """疑似ボタン押下（0x7C）で会話サイクルを無人反復する（task8のUSB停止問題の再現用）。

    1サイクル = 0x7C送信 → 実録音（FW側、保持時間ぶん）→ 0x01受信 → 0x02+0x03応答 →
    再生完了待ち。0x01が届かなければ停止の疑いとして数える。

    Returns:
        全サイクル成功なら0、失敗があれば1。
    """
    failures = 0
    for cycle in range(args.auto_cycles):
        transport.send_packet(FAKE_PRESS_CMD, args.auto_press.to_bytes(4, 'little'))
        deadline = time.monotonic() + args.auto_press / 1000.0 + 15.0
        recorded = None
        while time.monotonic() < deadline:
            packet = transport.recv_packet(timeout=POLL_INTERVAL_SEC)
            if packet is None:
                continue
            if packet.cmd == Command.RECORDED_AUDIO:
                recorded = packet
                break
            _log(f'cycle {cycle + 1}: 受信 cmd=0x{packet.cmd:02x} size={len(packet.body)} body={packet.body[:8].hex()}')
        if recorded is None:
            failures += 1
            _log(f'!! cycle {cycle + 1}/{args.auto_cycles}: 0x01が届かない（送信停止の疑い）')
            continue
        _log(f'cycle {cycle + 1}/{args.auto_cycles}: 0x01受信 {len(recorded.body)}bytes ≈ {_duration_sec(len(recorded.body)):.2f}s')
        respond_to_recording(transport, connection, args, reply_pcm)
        time.sleep(_duration_sec(len(reply_pcm)) + 1.5)  # 再生完了→待機復帰を待つ
    _log(f'auto done: {args.auto_cycles - failures} OK / {failures} FAILED')
    return 0 if failures == 0 else 1


def run(args: argparse.Namespace) -> int:
    """メイン処理。ポートを開き、READYを待ち、コマンド受信ループを回す。"""
    if args.port is not None:
        port = args.port
    else:
        try:
            port = select_port().device
        except NoPortAvailableError as exc:
            _log(f'ポートが見つかりません: {exc}')
            return 1

    reply_pcm = load_reply_pcm(args.reply)
    if args.pcm_bytes is not None:
        # 大きい0x03が届かない切り分け用に、先頭Nバイト（偶数へ丸める）だけ送る。
        limit = args.pcm_bytes - (args.pcm_bytes % SAMPLE_WIDTH_BYTES)
        reply_pcm = reply_pcm[:limit]
        _log(f'--pcm-bytes 指定: 応答PCMを先頭 {len(reply_pcm)}bytes に切り詰めて送信する')
    _log(f'応答PCM: {args.reply} ({len(reply_pcm)}bytes ≈ {_duration_sec(len(reply_pcm)):.2f}s)')

    dtr_desc = 'DTR/RTS アサート（リセットし得る）' if args.assert_dtr else 'DTR/RTS 非アサート'
    _log(f'{port} を{dtr_desc}で開く（モード={args.mode}）')
    connection = open_probe_serial(port, assert_lines=args.assert_dtr)
    transport = SerialTransport(connection)

    try:
        opened_at = time.monotonic()
        if wait_for_ready(transport, READY_TIMEOUT_SEC):
            _log(f'READY(0x06) を受信（オープンから {time.monotonic() - opened_at:.2f}s）。リンク確立。')
        else:
            _log(
                f'{READY_TIMEOUT_SEC:.0f}秒以内にREADYを受信できず。'
                'マイコンが起動済みで取りこぼした可能性（§3.4救済）。'
                '基板のリセットボタンを押すと新しいREADYを受信できる。受信待機を継続する。'
            )

        if args.auto_press > 0:
            return run_auto_cycles(transport, connection, args, reply_pcm)

        _log('受信待機中。マイコンで長押し録音してください。Ctrl+C で終了。')
        while True:
            packet = transport.recv_packet(timeout=POLL_INTERVAL_SEC)
            if packet is None:
                continue
            _handle_packet(transport, connection, packet, args, reply_pcm)
    except KeyboardInterrupt:
        _log('終了します。')
        return 0
    finally:
        transport.close()


def _handle_packet(
    transport: SerialTransport,
    connection: serial.Serial,
    packet: Packet,
    args: argparse.Namespace,
    reply_pcm: bytes,
) -> None:
    """受信した1パケットを種別ごとに処理する。"""
    if packet.cmd == Command.RECORDED_AUDIO:
        duration = _duration_sec(len(packet.body))
        saved = save_recording(packet.body, args.output_dir)
        _log(f'0x01（録音音声）を受信: {len(packet.body)}bytes ≈ {duration:.2f}s → {saved}')
        respond_to_recording(transport, connection, args, reply_pcm)
    elif packet.cmd == Command.CANCEL:
        _log('0x05（キャンセル＝トリプルクリック強制リセット）を受信。')
    elif packet.cmd == Command.READY:
        _log('0x06（READY）を再受信（マイコンが再起動した模様）。')
    else:
        _log(f'想定外のパケットを受信: cmd=0x{packet.cmd:02x} size={len(packet.body)}')


def main() -> int:
    """引数を解釈して run を呼ぶ。"""
    parser = argparse.ArgumentParser(description='task7 マイコン側 段階2実機確認用ダミー（PC側相手役）')
    parser.add_argument('--port', default=None, help='シリアルポート名（省略時は自動検出）')
    parser.add_argument(
        '--mode',
        choices=('normal', 'no-accept', 'accept-only', 'error'),
        default='normal',
        help='normal=0x02→0x03再生 / no-accept=3秒タイムアウト確認 / accept-only=35秒タイムアウト確認 / error=0x04エラー確認',
    )
    parser.add_argument('--effect', type=int, choices=(0, 1), default=0, help='0x03のエフェクトID（0=通常, 1=お祝い）')
    parser.add_argument('--reply', type=Path, default=DEFAULT_REPLY_PATH, help='normalで再生させるPCM/WAV')
    parser.add_argument('--think', type=float, default=DEFAULT_THINK_SEC, help='0x02送信後の考え中待ち秒数')
    parser.add_argument('--output-dir', type=Path, default=DEFAULT_OUTPUT_DIR, help='受信録音WAVの保存先')
    parser.add_argument(
        '--no-assert-dtr',
        dest='assert_dtr',
        action='store_false',
        help='DTR/RTSを立てずに開く（MODE=1/HW CDC-JTAG用）。既定はアサート（MODE=0/OTG CDCでは送信に必須）',
    )
    parser.set_defaults(assert_dtr=True)
    parser.add_argument(
        '--pcm-bytes',
        type=int,
        default=None,
        help='応答PCMを先頭Nバイトに切り詰めて送る（切り分け用。小さい0x03が届くか確認する）',
    )
    parser.add_argument(
        '--send-chunk',
        type=int,
        default=0,
        help='0x03をNバイトごとに分割送信する（>0で有効。受信取りこぼしのバースト切り分け用）',
    )
    parser.add_argument(
        '--send-delay',
        type=float,
        default=5.0,
        help='--send-chunk指定時のチャンク間待機ミリ秒（既定5ms）',
    )
    parser.add_argument(
        '--auto-press',
        type=int,
        default=0,
        metavar='MS',
        help='疑似ボタン押下(0x7C)をこの保持ミリ秒で送り、会話サイクルを無人反復する（0x7C対応FWが必要）',
    )
    parser.add_argument('--auto-cycles', type=int, default=30, help='--auto-press時のサイクル数')
    parser.add_argument(
        '--inject',
        choices=('none', 'garbage', 'stall'),
        default='none',
        help=(
            'task8項目22: 正規の0x03の直前に不正データを流す。'
            'garbage=汚染バイト（壊れたSYNC・SIZE上限超過）でパーサ再同期を確認 / '
            'stall=不完全パケット送信後に停止しBODY無進捗5秒タイムアウトを確認。'
            'どちらも直後の正規0x03が再生されれば合格（normalモード専用）'
        ),
    )
    args = parser.parse_args()
    if args.inject != 'none' and args.mode != 'normal':
        parser.error('--inject は --mode normal（既定）でのみ使用できます')
    return run(args)


if __name__ == '__main__':
    raise SystemExit(main())
