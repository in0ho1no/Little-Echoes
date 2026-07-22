"""transport.packet のテスト。"""

import logging

import pytest

from transport.packet import (
    HEADER_SIZE,
    MAX_BODY_SIZE,
    SYNC,
    Command,
    PacketParser,
    encode_packet,
)


class FakeClock:
    """テスト用の手動進行クロック。"""

    def __init__(self, start: float = 0.0) -> None:
        """開始時刻を設定する。"""
        self.now = start

    def __call__(self) -> float:
        return self.now

    def advance(self, seconds: float) -> None:
        self.now += seconds


class SequencedClock:
    """呼び出しごとに指定した値を順に返すテスト用クロック。

    最後の値に達した後は同じ値を返し続ける。time_func の呼び出し回数と
    タイミングを厳密に制御し、内部実装の呼び出し回数に依存した回帰を
    検出するために使う。
    """

    def __init__(self, values: list[float]) -> None:
        """返す値の並びを設定する。"""
        self._values = values
        self._index = 0

    def __call__(self) -> float:
        value = self._values[min(self._index, len(self._values) - 1)]
        self._index += 1
        return value


class TestEncodePacket:
    @pytest.mark.parametrize('cmd', [0, 0xFF])
    def test_accepts_command_boundary_values(self, cmd: int) -> None:
        data = encode_packet(cmd)
        assert data[2] == cmd

    @pytest.mark.parametrize('cmd', [-1, 0x100])
    def test_rejects_command_outside_byte_range(self, cmd: int) -> None:
        with pytest.raises(ValueError, match='valid range'):
            encode_packet(cmd)

    def test_roundtrip_with_body(self) -> None:
        data = encode_packet(Command.RECORDED_AUDIO, b'\x00\x01\x02\x03')
        parser = PacketParser()
        packets = parser.feed(data)
        assert len(packets) == 1
        assert packets[0].cmd == Command.RECORDED_AUDIO
        assert packets[0].body == b'\x00\x01\x02\x03'

    def test_roundtrip_with_empty_body(self) -> None:
        data = encode_packet(Command.ACCEPT_PROCESSING)
        parser = PacketParser()
        packets = parser.feed(data)
        assert len(packets) == 1
        assert packets[0].cmd == Command.ACCEPT_PROCESSING
        assert packets[0].body == b''

    def test_header_layout(self) -> None:
        data = encode_packet(Command.READY, b'\xaa\xbb')
        assert data[:2] == SYNC
        assert data[2] == Command.READY
        assert int.from_bytes(data[3:7], 'big') == 2
        assert data[7:] == b'\xaa\xbb'

    def test_raises_when_body_exceeds_max_size(self) -> None:
        oversized = b'\x00' * (MAX_BODY_SIZE + 1)
        try:
            encode_packet(Command.RECORDED_AUDIO, oversized)
        except ValueError:
            pass
        else:
            raise AssertionError('ValueError が送出されなかった')


class TestPacketParserStreaming:
    def test_multiple_packets_in_single_feed(self) -> None:
        data = encode_packet(Command.READY) + encode_packet(Command.CANCEL)
        parser = PacketParser()
        packets = parser.feed(data)
        assert [p.cmd for p in packets] == [Command.READY, Command.CANCEL]

    def test_packet_split_across_multiple_feeds(self) -> None:
        data = encode_packet(Command.PLAY_AUDIO, b'PCM_BODY_DATA')
        parser = PacketParser()
        packets: list = []
        for i in range(len(data)):
            packets += parser.feed(data[i : i + 1])
        assert len(packets) == 1
        assert packets[0].cmd == Command.PLAY_AUDIO
        assert packets[0].body == b'PCM_BODY_DATA'

    def test_resync_skips_garbage_prefix(self) -> None:
        garbage = b'\x00\xff\xa5\x00garbage'
        data = garbage + encode_packet(Command.READY)
        parser = PacketParser()
        packets = parser.feed(data)
        assert len(packets) == 1
        assert packets[0].cmd == Command.READY

    def test_oversized_size_field_triggers_resync(self) -> None:
        bad_size = (MAX_BODY_SIZE + 1).to_bytes(4, 'big')
        bad_header = SYNC + bytes([Command.RECORDED_AUDIO]) + bad_size
        data = bad_header + encode_packet(Command.READY)
        parser = PacketParser()
        packets = parser.feed(data)
        assert len(packets) == 1
        assert packets[0].cmd == Command.READY

    def test_body_timeout_resets_parser_and_recovers(self) -> None:
        clock = FakeClock()
        parser = PacketParser(time_func=clock)

        header_only = SYNC + bytes([Command.RECORDED_AUDIO]) + (10).to_bytes(4, 'big')
        assert parser.feed(header_only) == []

        clock.advance(5.1)
        assert parser.poll_timeout() is True

        recovered = parser.feed(encode_packet(Command.READY))
        assert len(recovered) == 1
        assert recovered[0].cmd == Command.READY

    def test_body_timeout_discards_partial_body_before_recovery(self) -> None:
        clock = FakeClock()
        parser = PacketParser(time_func=clock)

        embedded_packet = encode_packet(Command.READY)
        incomplete = SYNC + bytes([Command.RECORDED_AUDIO]) + (100).to_bytes(4, 'big') + embedded_packet
        assert parser.feed(incomplete) == []

        clock.advance(5.1)
        recovered = parser.feed(encode_packet(Command.CANCEL))

        assert len(recovered) == 1
        assert recovered[0].cmd == Command.CANCEL

    def test_no_timeout_within_deadline(self) -> None:
        clock = FakeClock()
        parser = PacketParser(time_func=clock)

        data = encode_packet(Command.PLAY_AUDIO, b'body')
        header = data[:HEADER_SIZE]
        assert parser.feed(header) == []

        clock.advance(4.9)
        assert parser.poll_timeout() is False

    def test_body_timeout_discard_logs_warning(self, caplog: 'pytest.LogCaptureFixture') -> None:
        # 無進捗タイムアウトでの途中破棄は、パケット消失の唯一の痕跡としてログに残る。
        clock = FakeClock()
        parser = PacketParser(time_func=clock)

        header_and_partial = SYNC + bytes([Command.RECORDED_AUDIO]) + (100).to_bytes(4, 'big') + b'\x00' * 30
        assert parser.feed(header_and_partial) == []

        clock.advance(5.1)
        with caplog.at_level(logging.WARNING, logger='transport.packet'):
            assert parser.poll_timeout() is True

        assert 'Discarding stalled partial packet' in caplog.text
        assert 'cmd=0x01' in caplog.text
        assert 'expected_body=100' in caplog.text
        assert 'buffered=30' in caplog.text

    def test_feed_checks_timeout_only_once_per_call(self) -> None:
        # poll_timeout()はfeed()冒頭で1回だけ呼ばれる想定。もし_drain()内で
        # 再度呼ばれる退行が起きると、この2回目の呼び出しがexpired値を
        # 受け取ってしまい、追加直後のBODYごと誤って破棄されてしまう。
        clock = SequencedClock([0.0, 4.0, 1_000_000.0])
        parser = PacketParser(time_func=clock)

        data = encode_packet(Command.PLAY_AUDIO, b'body')
        header, rest = data[:HEADER_SIZE], data[HEADER_SIZE:]

        # 1回目のtime_func呼び出し(0.0)でdeadline=5.0が設定される。
        assert parser.feed(header) == []

        # 2回目のtime_func呼び出し(4.0)はfeed()冒頭のpoll_timeoutチェックのみで
        # 消費されるはず。ここでbodyが完成する。
        packets = parser.feed(rest)

        assert len(packets) == 1
        assert packets[0].cmd == Command.PLAY_AUDIO
        assert packets[0].body == b'body'

    def test_slow_body_with_progress_does_not_time_out(self) -> None:
        # BODYタイムアウトは「新しいデータがBODY_TIMEOUT_SEC届かない」停滞の検知（§3.2 v1.3.2）。
        # 遅いリンクで大きなBODYが合計5秒超をかけて届いても、進捗があれば破棄しないこと
        # （マイコン→PCの最大約1.44MB送信の受信途中で誤破棄された実機不具合の再発防止）。
        clock = FakeClock()
        parser = PacketParser(time_func=clock)

        body = bytes(range(10))
        data = encode_packet(Command.RECORDED_AUDIO, body)
        header, rest = data[:HEADER_SIZE], data[HEADER_SIZE:]
        assert parser.feed(header) == []

        packets = []
        for value in rest:
            clock.advance(4.0)  # 各バイトの間隔は期限未満だが、総計40秒は旧仕様の期限超
            packets = parser.feed(bytes([value]))

        assert len(packets) == 1
        assert packets[0].cmd == Command.RECORDED_AUDIO
        assert packets[0].body == body
