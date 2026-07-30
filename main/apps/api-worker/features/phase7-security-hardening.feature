# Phase 7の公開前セキュリティ境界を実行テストと1:1で固定する。
# 各ScenarioタイトルはVitestの同名it()と対応し、対応漏れは
# test/feature-coverage.test.ts が検出する。
Feature: Phase 7 security hardening

  Scenario: rejects authentication mechanism reuse across separated hosts
    Given 管理ホストとデバイスホストは別の認証方式を使う
    When デバイストークンを管理ホストへ、Access JWTをデバイスホストへ送る
    Then 認証前提を満たさず両方とも拒否する

  Scenario: denies CORS preflight and simple cross-site mutations
    Given 両ホストはCORSを既定拒否し、管理更新APIはJSONだけを受け付ける
    When 外部Originからpreflightまたはsimple requestを送る
    Then CORS許可ヘッダーを返さず更新処理へ進めない

  Scenario: escapes user-controlled HTML and forbids unsafe DOM sinks
    Given 管理画面は文字起こし、親メモ、単語などの入力を表示する
    When HTMLとして解釈される文字列が入力に含まれる
    Then サーバーはエスケープし静的資産は危険なHTML挿入APIを使用しない

  Scenario: redacts unexpected exceptions and persists only opaque Workflow identifiers
    Given 内部例外にトークン、親メモ、R2キーが含まれる可能性がある
    When 例外応答またはWorkflow永続ペイロードを作る
    Then 応答へ内部値を出さずWorkflowには不透明なAsyncJob IDだけを保存する

  Scenario: inventories every semgrep suppression with a reviewed rationale
    Given 静的解析の抑止は構造で解消できない場合だけ許可する
    When 製品ソースのnosemgrepコメントを棚卸しする
    Then 許可済みの1件だけが理由と直前の入力検証を伴って存在する

  Scenario: configures redacted full-history secret scanning
    Given Git履歴には現在の作業ツリーから消えた秘密情報も残り得る
    When CIのgitleaks設定を検査する
    Then 全履歴checkout、redact、固定バージョンの検査が必須になっている
