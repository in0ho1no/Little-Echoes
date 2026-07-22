"""パケット構造（同期マーカー＋ヘッダ＋ボディ方式）のエンコード・デコード。

docs/SPEC.md §3.2, §3.3 に基づく実装。

パケット構造:
    SYNC (2byte, 固定値 0xA5 0x5A) + CMD (1byte) + SIZE (4byte, ビッグエンディアン) + BODY (可変長)

受信側の堅牢性ルール:
    1. 受信パーサは常に SYNC を探索して読み捨て再同期する。
    2. SIZE上限は 2MB。超過時は不正パケットとみなしパーサをリセットして再同期する。
    3. BODY待ちの間、新しいデータが BODY_TIMEOUT_SEC 届かない場合はパケットを破棄し
       パーサをリセットする（§3.2 v1.3.2: 停滞した送信元の検知が目的。大きなBODYが
       遅いリンクで合計 BODY_TIMEOUT_SEC 超をかけて届くこと自体は正常として扱う。
       旧仕様の「ヘッダ受信後5秒以内にBODY全体」は、マイコン→PCの最大約1.44MB送信が
       5秒を超えると正常な転送を破棄してしまうため改めた）。
"""

import logging
import time
from collections.abc import Callable
from dataclasses import dataclass
from enum import IntEnum

logger = logging.getLogger(__name__)

SYNC = b'\xa5\x5a'
HEADER_SIZE = len(SYNC) + 1 + 4  # SYNC + CMD + SIZE
MAX_BODY_SIZE = 2 * 1024 * 1024  # 2,097,152 バイト
BODY_TIMEOUT_SEC = 5.0


class Command(IntEnum):
    """CMD（制御命令）の定義。docs/SPEC.md §3.3 参照。"""

    RECORDED_AUDIO = 0x01
    """マイコン→PC: 録音音声データ送信（ボタン長押し終了時）。"""
    ACCEPT_PROCESSING = 0x02
    """PC→マイコン: 受理・処理開始（「考え中」LEDアニメーション開始要求）。"""
    PLAY_AUDIO = 0x03
    """PC→マイコン: 音声再生要求。"""
    ERROR = 0x04
    """PC→マイコン: エラー通知。"""
    CANCEL = 0x05
    """マイコン→PC: キャンセル通知。"""
    READY = 0x06
    """マイコン→PC: READY（起動完了通知）。"""


@dataclass(frozen=True)
class Packet:
    """デコード済みの1パケット。"""

    cmd: int
    body: bytes


def encode_packet(cmd: int, body: bytes = b'') -> bytes:
    """CMDとBODYからパケットのバイト列を組み立てる。

    Args:
        cmd: 制御命令（0〜255）。
        body: ボディデータ。省略時は空（SIZE=0）。

    Returns:
        SYNC+CMD+SIZE+BODY を連結したバイト列。

    Raises:
        ValueError: cmd が0〜255の範囲外、またはbodyがMAX_BODY_SIZEを超える場合。
    """
    if not 0 <= cmd <= 0xFF:
        raise ValueError(f'cmd {cmd} is outside the valid range 0..255')
    if len(body) > MAX_BODY_SIZE:
        raise ValueError(f'body size {len(body)} exceeds MAX_BODY_SIZE {MAX_BODY_SIZE}')
    return SYNC + bytes([cmd]) + len(body).to_bytes(4, 'big') + body


class PacketParser:
    """ストリーミングでバイト列を受け取り、パケットへデコードするパーサ。

    シリアル受信のように断片的に届くバイト列を `feed()` で逐次投入する想定。
    ヘッダ受信後にBODYが届かないまま時間切れになるケースを検知するため、
    データが届かない間も `poll_timeout()` を定期的に呼び出す必要がある。
    """

    def __init__(self, time_func: Callable[[], float] = time.monotonic) -> None:
        """パーサを初期化する。

        Args:
            time_func: 現在時刻を返す関数。テスト時は差し替え可能。
        """
        self._buffer = bytearray()
        self._time_func = time_func
        self._header_cmd: int | None = None
        self._header_size: int | None = None
        self._header_deadline: float | None = None

    def feed(self, data: bytes) -> list[Packet]:
        """受信バイト列を投入し、完成したパケットのリストを返す。

        Args:
            data: シリアル等から受信した生バイト列。

        Returns:
            このfeed呼び出しまでにバッファ内で完成したパケットのリスト（0件以上）。
        """
        # 前回までに受信したBODY断片が期限切れなら、新しいデータを追加する前に
        # 破棄する。追加後に判定すると、新しい正常パケットまで失われてしまう。
        # タイムアウト判定はこの1箇所のみで行う（_drain内では行わない）。
        # 仮に_drain内でも判定してしまうと、このfeed呼び出しで追加した直後の
        # データが、極めて短い時間経過（あるいはテストでの時刻操作）により
        # 巻き添えで破棄されるレースが理論上発生し得るため。
        self.poll_timeout()
        self._buffer.extend(data)
        # BODY待ち中に新しいデータが届いたら期限を延長する（無進捗タイムアウト。
        # モジュールdocstringの堅牢性ルール3参照）。
        if data and self._header_deadline is not None:
            self._header_deadline = self._time_func() + BODY_TIMEOUT_SEC
        return self._drain()

    def poll_timeout(self) -> bool:
        """BODY受信タイムアウトを判定し、必要ならヘッダ状態をリセットする。

        新規データが届かない間もタイムアウトを検知できるよう、呼び出し側が
        定期的に呼び出すことを想定している。

        Returns:
            タイムアウトによりリセットが発生した場合 True。
        """
        if self._header_deadline is not None and self._time_func() >= self._header_deadline:
            # 現在のバッファは未完了パケットのBODY断片なので、ヘッダ状態と一緒に
            # 破棄する。残すとBODY内のSYNC相当値を次のパケットと誤認し得る。
            # この破棄は「送信元が途中で停止した」異常の唯一の痕跡なので、必ずログに残す
            # （無言で破棄すると、パケット消失の切り分けが不可能になる）。
            logger.warning(
                'Discarding stalled partial packet: cmd=0x%02X expected_body=%s buffered=%d bytes (no progress for %.0fs)',
                self._header_cmd if self._header_cmd is not None else 0,
                self._header_size,
                len(self._buffer),
                BODY_TIMEOUT_SEC,
            )
            self._buffer.clear()
            self._reset_header()
            return True
        return False

    def _drain(self) -> list[Packet]:
        packets: list[Packet] = []
        while True:
            if self._header_cmd is None:
                if not self._resync():
                    break
                if len(self._buffer) < HEADER_SIZE:
                    break
                cmd = self._buffer[2]
                size = int.from_bytes(self._buffer[3:7], 'big')
                if size > MAX_BODY_SIZE:
                    # 不正なSIZE。SYNCの2バイトを読み捨てて再同期を試みる。
                    del self._buffer[: len(SYNC)]
                    continue
                del self._buffer[:HEADER_SIZE]
                self._header_cmd = cmd
                self._header_size = size
                self._header_deadline = self._time_func() + BODY_TIMEOUT_SEC
            else:
                assert self._header_size is not None
                if len(self._buffer) < self._header_size:
                    break
                body = bytes(self._buffer[: self._header_size])
                del self._buffer[: self._header_size]
                packets.append(Packet(self._header_cmd, body))
                self._reset_header()
        return packets

    def _resync(self) -> bool:
        """バッファの先頭がSYNCになるまで読み捨てる。

        Returns:
            SYNCが見つかりバッファ先頭に整合できた場合 True。
            データ不足等で見つからなかった場合 False。
        """
        idx = self._buffer.find(SYNC)
        if idx == -1:
            # 末尾がSYNC先頭バイトと一致する可能性があるため1バイトだけ残す。
            if self._buffer and self._buffer[-1] == SYNC[0]:
                del self._buffer[:-1]
            else:
                self._buffer.clear()
            return False
        del self._buffer[:idx]
        return True

    def _reset_header(self) -> None:
        self._header_cmd = None
        self._header_size = None
        self._header_deadline = None
