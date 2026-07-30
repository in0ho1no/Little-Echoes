"""Phase 7固定3音声の再現性と安全な形式を検証する。"""

import hashlib
import json
import runpy
import wave
from collections.abc import Callable
from pathlib import Path
from typing import cast

MAIN_ROOT = Path(__file__).resolve().parents[4]
SAMPLES_ROOT = MAIN_ROOT / 'samples'
EXPECTED_FILES = {'audio/clear-word.wav', 'audio/short-sentence.wav', 'audio/unclear-utterance.wav'}


def test_phase7_fixed_samples_are_canonical_adult_voice_fixtures() -> None:
    """固定3音声は成人音声由来と宣言され、サーバー受理形式に収まる。"""
    manifest = json.loads((SAMPLES_ROOT / 'expected' / 'phase7.json').read_text(encoding='utf-8'))
    assert manifest['contains_real_child_data'] is False
    assert {sample['file'] for sample in manifest['samples']} == EXPECTED_FILES
    for sample in manifest['samples']:
        relative_path = sample['file']
        path = SAMPLES_ROOT / relative_path
        assert path.stat().st_size <= 1_100_000
        with path.open('rb') as binary:
            assert hashlib.file_digest(binary, 'sha256').hexdigest() == sample['sha256']
        with wave.open(str(path), 'rb') as source:
            assert source.getparams()[:3] == (1, 2, 24_000)
            assert source.getnframes() == sample['frames']
    unclear = next(sample for sample in manifest['samples'] if sample['file'] == 'audio/unclear-utterance.wav')
    assert unclear['derived_from'] == 'audio/clear-word.wav'
    assert 'seed=7202607' in unclear['transformation']


def test_phase7_sample_builder_reproduces_reviewed_bytes(tmp_path: Path) -> None:
    """生成器は承認済み成人音声だけを入力にし、同じbyte列を再生成する。"""
    builder_path = SAMPLES_ROOT / 'build_fixed_audio.py'
    module = runpy.run_path(str(builder_path))
    source = cast(Path, module['SOURCE'])
    build = cast(Callable[[Path], None], module['build'])
    manifest = json.loads((SAMPLES_ROOT / 'expected' / 'phase7.json').read_text(encoding='utf-8'))
    expected_source = MAIN_ROOT / 'apps' / 'pc-client' / 'src' / 'assets' / 'sample.wav'
    assert source.resolve() == expected_source.resolve()
    assert manifest['source'] == expected_source.relative_to(MAIN_ROOT.parent).as_posix()
    with source.open('rb') as binary:
        assert hashlib.file_digest(binary, 'sha256').hexdigest() == manifest['source_sha256']

    first = tmp_path / 'first'
    second = tmp_path / 'second'
    build(first)
    build(second)
    for sample in manifest['samples']:
        name = Path(sample['file']).name
        reviewed_bytes = (SAMPLES_ROOT / sample['file']).read_bytes()
        assert (first / name).read_bytes() == reviewed_bytes
        assert (second / name).read_bytes() == reviewed_bytes
