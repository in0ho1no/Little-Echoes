"""task8 USB TX停止問題の無人ストレステスト（相手: firmware stress_main.cpp）。

マイコン→PCの大きな0x01送信が末尾で停止する間欠問題（docs/task8_verification.md G）を
ボタン操作なしで反復再現・計測する。ストレスFW（`pio run -e atom_echos3r_txstress -t upload`）
を書き込んだデバイスに対し、以下を繰り返す:

- パターン往復: 0x02(4B LEサイズ)を送る → FWが決定論パターンの0x01を返す → 内容照合
- echo往復: 実録音WAV(debug_recordings)のPCMを0x03で送り込み → 0x7E ack →
  0x04で送り返させ → バイト一致照合（host→device方向の負荷も兼ねる）

結果は1往復1行でログファイルへ記録する。パーサの無進捗タイムアウト破棄
（transport.packetのwarning）も同じログに入る。

使い方:
    uv run python scripts/task8_txstress.py --rounds 60
    uv run python scripts/task8_txstress.py --rounds 60 --port COM8 --log scripts/manual_check_output/txstress.log
"""

import argparse
import logging
import sys
import time
import wave
from datetime import datetime
from pathlib import Path

import serial

_SRC_DIR = Path(__file__).resolve().parent.parent / 'src'
if str(_SRC_DIR) not in sys.path:
    sys.path.insert(0, str(_SRC_DIR))

from device.port_discovery import NoPortAvailableError, select_port  # noqa: E402
from transport.packet import Packet  # noqa: E402
from transport.serial_transport import DEFAULT_BAUDRATE, READ_POLL_INTERVAL_SEC, SerialTransport  # noqa: E402

logger = logging.getLogger('txstress')

CMD_RECORDED_AUDIO = 0x01
CMD_SEND_PATTERN = 0x02
CMD_STORE_ECHO = 0x03
CMD_SEND_ECHO = 0x04
CMD_READY = 0x06
CMD_SET_LED = 0x10
CMD_SET_MIC = 0x11
CMD_REBOOT_BOOTLOADER = 0x7D
CMD_ECHO_STORED = 0x7E
CMD_DIAG = 0x7F

MAX_PAYLOAD_BYTES = 1_440_000

# 実際に停止が観測されたサイズ（docs/task8_verification.md G）＋境界確認用の小さめサイズ。
PATTERN_SIZES = [4096, 186368, 207872, 231424, 269312, 326656, 626688, 1_440_000]

ECHO_EVERY_N_ROUNDS = 5
READY_TIMEOUT_SEC = 5.0
POLL_INTERVAL_SEC = 0.02
DEFAULT_LOG_PATH = Path('scripts/manual_check_output/task8_txstress.log')
RECORDINGS_DIR = Path('debug_recordings')


def build_pattern(size: int, table: bytes) -> bytes:
    """FW側 fillPattern と同じ決定論パターン（seq部4バイトを除く）を返す。"""
    return table[:size]


def make_pattern_table(max_size: int) -> bytes:
    """位置依存パターン body[i] = (i*151) ^ (i>>8) の事前計算テーブルを作る。"""
    return bytes(((i * 151) ^ (i >> 8)) & 0xFF for i in range(max_size))


def load_echo_payloads() -> list[tuple[str, bytes]]:
    """debug_recordings のWAVからRAW PCMを取り出し、echo試験のペイロードにする。"""
    payloads: list[tuple[str, bytes]] = []
    for path in sorted(RECORDINGS_DIR.glob('*.wav')):
        with wave.open(str(path), 'rb') as wav_file:
            frames = wav_file.readframes(wav_file.getnframes())
        if 0 < len(frames) <= MAX_PAYLOAD_BYTES:
            payloads.append((path.name, frames))
    return payloads


POLL_LIKE_PIPELINE = False
"""Trueのとき、実PC側パイプライン（pipeline.py）と同じ「recv_packet(timeout=0)＋50ms sleep」の
ノンブロッキングポーリングで受信する。ブロッキングread常駐（既定）との差でUSB停止の
発生有無を切り分ける。"""


def recv_until(transport: SerialTransport, wanted_cmds: set[int], timeout_sec: float) -> Packet | None:
    """指定コマンドのパケットが届くまで受信する。診断(0x7F)は解読ログして待ち続ける。"""
    deadline = time.monotonic() + timeout_sec
    while time.monotonic() < deadline:
        if POLL_LIKE_PIPELINE:
            packet = transport.recv_packet(timeout=0)
            if packet is None:
                time.sleep(0.05)
                continue
        else:
            packet = transport.recv_packet(timeout=POLL_INTERVAL_SEC)
        if packet is None:
            continue
        if packet.cmd == CMD_DIAG and CMD_DIAG not in wanted_cmds:
            _log_diag(packet)
            continue
        if packet.cmd in wanted_cmds:
            return packet
        logger.warning('unexpected packet cmd=0x%02X size=%d', packet.cmd, len(packet.body))
    return None


def _log_diag(packet: Packet) -> None:
    if len(packet.body) == 5:
        reason = packet.body[0]
        detail = int.from_bytes(packet.body[1:5], 'little')
        logger.warning('FW diag: reason=0x%02X detail=%d', reason, detail)
    else:
        logger.warning('FW diag with unexpected body: %s', packet.body.hex())


def run_pattern_round(transport: SerialTransport, size: int, table: bytes, deaf_window_sec: float = 0.0) -> bool:
    """パターン往復を1回行い、成否を返す。

    deaf_window_sec > 0 の場合、要求送信後にその秒数だけ受信を止めてから読み始める。
    実機で「PC側がRealtimeセッション破棄（connection.close 約2秒）中にシリアルを
    読まない間、マイコンの0x01送信が停止する」事象を模擬する切り分け用。
    """
    started = time.monotonic()
    transport.send_packet(CMD_SEND_PATTERN, size.to_bytes(4, 'little'))
    if deaf_window_sec > 0:
        time.sleep(deaf_window_sec)
    timeout = 10.0 + size / 100_000  # 最低100KB/s想定＋余裕
    packet = recv_until(transport, {CMD_RECORDED_AUDIO}, timeout)
    elapsed = time.monotonic() - started
    if packet is None:
        logger.error('PATTERN size=%d FAILED: no packet within %.1fs', size, timeout)
        return False
    body = packet.body
    if len(body) != size:
        logger.error('PATTERN size=%d FAILED: received %d bytes', size, len(body))
        return False
    seq = int.from_bytes(body[:4], 'little')
    if body[4:] != table[4:size]:
        mismatch = next(i for i in range(4, size) if body[i] != table[i])
        logger.error('PATTERN size=%d seq=%d FAILED: content mismatch at offset %d', size, seq, mismatch)
        return False
    logger.info('PATTERN size=%d seq=%d OK %.2fs (%.0f KB/s)', size, seq, elapsed, size / max(elapsed, 1e-6) / 1000)
    return True


def run_echo_round(transport: SerialTransport, name: str, payload: bytes) -> bool:
    """実録音PCMのecho往復を1回行い、成否を返す。"""
    started = time.monotonic()
    transport.send_packet(CMD_STORE_ECHO, payload)
    ack = recv_until(transport, {CMD_ECHO_STORED}, 10.0 + len(payload) / 100_000)
    if ack is None or int.from_bytes(ack.body, 'little') != len(payload):
        logger.error('ECHO %s FAILED: store ack missing or size mismatch (%s)', name, ack.body.hex() if ack else 'timeout')
        return False
    transport.send_packet(CMD_SEND_ECHO)
    packet = recv_until(transport, {CMD_RECORDED_AUDIO}, 10.0 + len(payload) / 100_000)
    elapsed = time.monotonic() - started
    if packet is None:
        logger.error('ECHO %s FAILED: no echo within timeout', name)
        return False
    if packet.body != payload:
        logger.error('ECHO %s FAILED: %d bytes returned, mismatch=%s', name, len(packet.body), packet.body != payload)
        return False
    logger.info('ECHO %s size=%d OK %.2fs round-trip', name, len(payload), elapsed)
    return True


def run(args: argparse.Namespace) -> int:
    """ポートを開いてREADYを待ち、指定回数の往復試験を行う。"""
    if args.port is not None:
        port = args.port
    else:
        try:
            port = select_port().device
        except NoPortAvailableError as exc:
            logger.error('port not found: %s', exc)
            return 1

    if args.reboot_bootloader:
        connection = serial.Serial(port=port, baudrate=DEFAULT_BAUDRATE, timeout=1.0, write_timeout=5.0)
        SerialTransport(connection).send_packet(CMD_REBOOT_BOOTLOADER)
        logger.info('sent 0x7D (reboot to bootloader) to %s; device should re-enumerate as ROM bootloader', port)
        connection.close()
        return 0

    table = make_pattern_table(MAX_PAYLOAD_BYTES)
    echo_payloads = load_echo_payloads()
    logger.info('=== txstress start: port=%s rounds=%d echo_payloads=%d ===', port, args.rounds, len(echo_payloads))

    connection = serial.Serial()
    connection.port = port
    connection.baudrate = DEFAULT_BAUDRATE
    connection.timeout = READ_POLL_INTERVAL_SEC
    connection.write_timeout = 60.0
    connection.dtr = True
    connection.rts = True
    connection.open()
    if args.rx_buffer > 0:
        connection.set_buffer_size(rx_size=args.rx_buffer)
        logger.info('set_buffer_size(rx_size=%d)', args.rx_buffer)
    transport = SerialTransport(connection)

    failures = 0
    successes = 0
    try:
        if recv_until(transport, {CMD_READY}, READY_TIMEOUT_SEC) is None:
            logger.warning('READY not received within %.0fs; continuing anyway', READY_TIMEOUT_SEC)
        else:
            logger.info('READY received')

        for enabled, cmd, label in ((args.fw_led, CMD_SET_LED, 'LED'), (args.fw_mic, CMD_SET_MIC, 'MIC')):
            if enabled:
                transport.send_packet(cmd, b'\x01')
                ack = recv_until(transport, {CMD_DIAG}, 5.0)
                logger.info('FW %s mode enabled (ack=%s)', label, ack.body.hex() if ack else 'none')

        for round_index in range(args.rounds):
            if echo_payloads and round_index % ECHO_EVERY_N_ROUNDS == ECHO_EVERY_N_ROUNDS - 1:
                name, payload = echo_payloads[(round_index // ECHO_EVERY_N_ROUNDS) % len(echo_payloads)]
                ok = run_echo_round(transport, name, payload)
            else:
                size = PATTERN_SIZES[round_index % len(PATTERN_SIZES)]
                ok = run_pattern_round(transport, size, table, deaf_window_sec=args.deaf_window)
            successes += ok
            failures += not ok
            time.sleep(args.interval)
    except KeyboardInterrupt:
        logger.info('interrupted')
    except serial.SerialException as exc:
        logger.error('serial error: %s', exc)
        failures += 1
    finally:
        transport.close()

    logger.info('=== txstress done: %d OK / %d FAILED ===', successes, failures)
    return 0 if failures == 0 else 1


def main() -> int:
    """引数を解釈し、ログを設定して run を呼ぶ。"""
    parser = argparse.ArgumentParser(description='task8 USB TXストレステスト（要ストレスFW）')
    parser.add_argument('--port', default=None, help='シリアルポート名（省略時は自動検出）')
    parser.add_argument('--rounds', type=int, default=60, help='往復回数')
    parser.add_argument('--interval', type=float, default=0.2, help='往復間の待機秒数')
    parser.add_argument('--log', type=Path, default=DEFAULT_LOG_PATH, help='追記ログファイル')
    parser.add_argument(
        '--reboot-bootloader',
        action='store_true',
        help='0x7Dを送ってROMブートローダーへ再起動させる（遠隔書き込み用。0x7D対応FWが必要）',
    )
    parser.add_argument(
        '--deaf-window',
        type=float,
        default=0.0,
        help='パターン要求後にこの秒数受信を止めてから読む（PC側read停止の再現。実機のセッション破棄約2秒を模擬）',
    )
    parser.add_argument('--fw-led', action='store_true', help='FWのNeoPixel演出を有効化する（アプリ環境の切り分け用）')
    parser.add_argument('--fw-mic', action='store_true', help='FWのマイク録音モードを有効化する（各送信前に約1.6秒の実録音）')
    parser.add_argument(
        '--poll-like-pipeline',
        action='store_true',
        help='実パイプラインと同じノンブロッキングポーリング（timeout=0＋50ms sleep）で受信する（USB停止の切り分け用）',
    )
    parser.add_argument('--rx-buffer', type=int, default=0, help='>0でpyserialのset_buffer_sizeにrx_sizeとして渡す（対策検証用）')
    args = parser.parse_args()
    global POLL_LIKE_PIPELINE
    POLL_LIKE_PIPELINE = args.poll_like_pipeline

    args.log.parent.mkdir(parents=True, exist_ok=True)
    logging.basicConfig(
        level=logging.INFO,
        format='%(asctime)s %(levelname)s %(name)s: %(message)s',
        handlers=[logging.StreamHandler(), logging.FileHandler(args.log, encoding='utf-8')],
    )
    logger.info('--- session %s ---', datetime.now().isoformat(timespec='seconds'))
    return run(args)


if __name__ == '__main__':
    raise SystemExit(main())
