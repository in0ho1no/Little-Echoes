import { describe, expect, it } from 'vitest';

import { validateCanonicalWav, WavValidationError } from '../src/wav';

function wav(samples = 24_000, sampleRate = 24_000): Uint8Array {
  const bytes = new Uint8Array(44 + samples * 2);
  const view = new DataView(bytes.buffer);
  const text = (offset: number, value: string): void => Array.from(value).forEach((part, index) => view.setUint8(offset + index, part.charCodeAt(0)));
  text(0, 'RIFF');
  view.setUint32(4, bytes.byteLength - 8, true);
  text(8, 'WAVE');
  text(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, 'data');
  view.setUint32(40, samples * 2, true);
  return bytes;
}

describe('固定WAV検証', () => {
  it('24 kHz / 16-bit / mono のWAVを受理する', async () => {
    const result = await validateCanonicalWav(wav());
    expect(result.durationSeconds).toBe(1);
    expect(result.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('非24 kHzと20秒超過を拒否する', async () => {
    await expect(validateCanonicalWav(wav(24_000, 48_000))).rejects.toBeInstanceOf(WavValidationError);
    await expect(validateCanonicalWav(wav(480_001))).rejects.toBeInstanceOf(WavValidationError);
  });
});

export { wav };
