import { MAX_AUDIO_BYTES, MAX_DURATION_SECONDS } from './limits';

export interface ValidWav {
  bytes: Uint8Array;
  durationSeconds: number;
  sha256: string;
}

export class WavValidationError extends Error {}

function readFourCC(view: DataView, offset: number): string {
  return String.fromCharCode(view.getUint8(offset), view.getUint8(offset + 1), view.getUint8(offset + 2), view.getUint8(offset + 3));
}

export async function validateCanonicalWav(bytes: Uint8Array): Promise<ValidWav> {
  if (bytes.byteLength > MAX_AUDIO_BYTES) {
    throw new WavValidationError('音声ファイルが上限を超えています。');
  }
  if (bytes.byteLength < 44) {
    throw new WavValidationError('WAVヘッダーが不正です。');
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (readFourCC(view, 0) !== 'RIFF' || readFourCC(view, 8) !== 'WAVE' || view.getUint32(4, true) !== bytes.byteLength - 8) {
    throw new WavValidationError('固定WAV形式ではありません。');
  }
  if (readFourCC(view, 12) !== 'fmt ' || view.getUint32(16, true) !== 16 || readFourCC(view, 36) !== 'data') {
    throw new WavValidationError('固定WAV形式ではありません。');
  }

  const audioFormat = view.getUint16(20, true);
  const channels = view.getUint16(22, true);
  const sampleRate = view.getUint32(24, true);
  const byteRate = view.getUint32(28, true);
  const blockAlign = view.getUint16(32, true);
  const bitsPerSample = view.getUint16(34, true);
  const dataLength = view.getUint32(40, true);
  if (
    audioFormat !== 1 ||
    channels !== 1 ||
    sampleRate !== 24_000 ||
    byteRate !== 48_000 ||
    blockAlign !== 2 ||
    bitsPerSample !== 16 ||
    dataLength !== bytes.byteLength - 44 ||
    dataLength % blockAlign !== 0
  ) {
    throw new WavValidationError('24 kHz / 16-bit / mono のWAVだけを受け付けます。');
  }
  const durationSeconds = dataLength / byteRate;
  if (durationSeconds <= 0 || durationSeconds > MAX_DURATION_SECONDS) {
    throw new WavValidationError('録音時間が上限を超えています。');
  }
  const digestInput = new Uint8Array(bytes.byteLength);
  digestInput.set(bytes);
  const digest = await crypto.subtle.digest('SHA-256', digestInput);
  const sha256 = Array.from(new Uint8Array(digest), (part) => part.toString(16).padStart(2, '0')).join('');
  return { bytes, durationSeconds, sha256 };
}
