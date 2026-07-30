// パケットエンコード・デコードの実装。挙動はPC側 src/transport/packet.py と
// 完全一致させること（乖離させる場合は両方を直す）。
#include "packet.h"

#include <utility>

namespace transport {

bool encodePacket(uint8_t cmd, const uint8_t* body, size_t bodySize, std::vector<uint8_t>& out) {
    if (bodySize > kMaxBodySize) {
        return false;
    }
    out.clear();
    out.reserve(kHeaderSize + bodySize);
    out.push_back(kSync[0]);
    out.push_back(kSync[1]);
    out.push_back(cmd);
    const auto size32 = static_cast<uint32_t>(bodySize);
    out.push_back(static_cast<uint8_t>(size32 >> 24));
    out.push_back(static_cast<uint8_t>(size32 >> 16));
    out.push_back(static_cast<uint8_t>(size32 >> 8));
    out.push_back(static_cast<uint8_t>(size32));
    if (bodySize > 0) {
        out.insert(out.end(), body, body + bodySize);
    }
    return true;
}

bool encodePacket(uint8_t cmd, std::vector<uint8_t>& out) {
    return encodePacket(cmd, nullptr, 0, out);
}

PacketParser::PacketParser(TimeFunc timeFunc) : timeFunc_(std::move(timeFunc)) {}

std::vector<Packet> PacketParser::feed(const uint8_t* data, size_t size) {
    // 前回までに受信したBODY断片が期限切れなら、新しいデータを追加する前に
    // 破棄する。追加後に判定すると、新しい正常パケットまで失われてしまう。
    // タイムアウト判定はこの1箇所のみで行う（drain内では行わない）。
    // 仮にdrain内でも判定してしまうと、このfeed呼び出しで追加した直後の
    // データが、極めて短い時間経過（あるいはテストでの時刻操作）により
    // 巻き添えで破棄されるレースが理論上発生し得るため。
    pollTimeout();
    // 空vectorのdata()や「受信なし」を表す呼び出しではdataがnullptrになり得る。
    // nullptr + 0も未定義動作なので、空入力時は範囲自体を生成しない。
    if (size > 0) {
        buffer_.insert(buffer_.end(), data, data + size);
        // BODY待ち中に新しいデータが届いたら期限を延長する（無進捗タイムアウト。
        // packet.h の堅牢性ルール3参照）。
        if (awaitingBody_) {
            bodyStartMs_ = timeFunc_();
        }
    }
    return drain();
}

bool PacketParser::pollTimeout() {
    if (!awaitingBody_) {
        return false;
    }
    // 経過時間を符号なし減算で求めることで、millis()の32bitラップアラウンド
    // （約49日周期）をまたいでも正しく判定できる
    if (timeFunc_() - bodyStartMs_ >= kBodyTimeoutMs) {
        // 現在のバッファは未完了パケットのBODY断片なので、ヘッダ状態と一緒に
        // 破棄する。残すとBODY内のSYNC相当値を次のパケットと誤認し得る。
        buffer_.clear();
        resetHeader();
        return true;
    }
    return false;
}

std::vector<Packet> PacketParser::drain() {
    std::vector<Packet> packets;
    while (true) {
        if (!awaitingBody_) {
            if (!resync()) {
                break;
            }
            if (buffer_.size() < kHeaderSize) {
                break;
            }
            const uint8_t cmd = buffer_[2];
            const uint32_t size = (static_cast<uint32_t>(buffer_[3]) << 24) |
                                  (static_cast<uint32_t>(buffer_[4]) << 16) |
                                  (static_cast<uint32_t>(buffer_[5]) << 8) |
                                  static_cast<uint32_t>(buffer_[6]);
            if (size > kMaxBodySize) {
                // 不正なSIZE。SYNCの2バイトを読み捨てて再同期を試みる。
                buffer_.erase(buffer_.begin(), buffer_.begin() + sizeof(kSync));
                continue;
            }
            buffer_.erase(buffer_.begin(), buffer_.begin() + kHeaderSize);
            headerCmd_ = cmd;
            headerSize_ = size;
            bodyStartMs_ = timeFunc_();
            awaitingBody_ = true;
        } else {
            if (buffer_.size() < headerSize_) {
                break;
            }
            Packet packet;
            packet.cmd = headerCmd_;
            if (buffer_.size() == headerSize_) {
                // 最大BODYでPSRAMを二重確保しないよう、後続データが無ければ受信領域ごと譲渡する。
                packet.body = std::move(buffer_);
                buffer_.clear();  // moved-from内容を実装依存にせず、次の再同期を常に空から始める。
            } else {
                packet.body.assign(buffer_.begin(), buffer_.begin() + headerSize_);
                buffer_.erase(buffer_.begin(), buffer_.begin() + headerSize_);
            }
            packets.push_back(std::move(packet));
            resetHeader();
        }
    }
    return packets;
}

bool PacketParser::resync() {
    // バッファの先頭がSYNCになるまで読み捨てる。
    for (size_t i = 0; i + 1 < buffer_.size(); ++i) {
        if (buffer_[i] == kSync[0] && buffer_[i + 1] == kSync[1]) {
            buffer_.erase(buffer_.begin(), buffer_.begin() + i);
            return true;
        }
    }
    // 末尾がSYNC先頭バイトと一致する可能性があるため1バイトだけ残す。
    if (!buffer_.empty() && buffer_.back() == kSync[0]) {
        buffer_.erase(buffer_.begin(), buffer_.end() - 1);
    } else {
        buffer_.clear();
    }
    return false;
}

void PacketParser::resetHeader() {
    awaitingBody_ = false;
    headerCmd_ = 0;
    headerSize_ = 0;
    bodyStartMs_ = 0;
}

}  // namespace transport
