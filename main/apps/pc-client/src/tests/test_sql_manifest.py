"""api-workerが実行する本番SQLを実SQLiteでコンパイル検証する。"""

import json
import sqlite3
from pathlib import Path

import pytest

API_WORKER_ROOT = Path(__file__).parents[3] / 'api-worker'
MANIFEST_PATH = API_WORKER_ROOT / 'sql-manifest.json'
MIGRATION_PATH = API_WORKER_ROOT / 'migrations' / '0001_initial.sql'


def apply_migration() -> sqlite3.Connection:
    """メモリ上のSQLiteへ初期マイグレーションを適用する。"""
    connection = sqlite3.connect(':memory:')
    connection.executescript(MIGRATION_PATH.read_text(encoding='utf-8'))
    return connection


def load_statements() -> list[str]:
    """vitestが書き出した捕捉済みSQL文の一覧を読み込む。"""
    manifest: dict[str, list[str]] = json.loads(MANIFEST_PATH.read_text(encoding='utf-8'))
    return manifest['statements']


def test_manifest_exists_and_is_populated() -> None:
    """マニフェストが生成済みで、十分な数の文を含む。"""
    statements = load_statements()
    assert len(statements) > 25


@pytest.mark.parametrize('sql', load_statements(), ids=lambda sql: str(sql)[:60])
def test_production_sql_compiles_against_real_schema(sql: str) -> None:
    """全本番SQL文が実スキーマ上でコンパイルできる（曖昧列名・構文非互換の検出）。"""
    connection = apply_migration()
    parameters = [None] * sql.count('?')
    connection.execute(f'EXPLAIN {sql}', parameters)
