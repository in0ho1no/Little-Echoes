"""OpenAI APIクライアント共通の例外基底。

docs/SPEC.md §7.2-8:「Realtime API呼び出しでエラーが発生した場合、
0x04（エラー通知）を送信し、セッションを破棄して受信待機に戻る」に対応するため、
各クライアント（realtime_client.py の `RealtimeError` 等）の例外はこの基底クラスを
継承する。呼び出し側（タスク10のパイプライン）は `except ApiClientError:` の
1箇所でAPI起因のエラーを一括捕捉できる。
"""


class ApiClientError(Exception):
    """OpenAI APIクライアントの呼び出し失敗を表す例外の共通基底。"""
