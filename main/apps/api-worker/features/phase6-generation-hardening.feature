# Phase 6 Fable5レビュー指摘（2026-07-29）の再発防止シナリオ。
# 各ScenarioタイトルはVitestのテスト名と1:1で対応し、対応漏れは
# test/feature-coverage.test.ts が検出する。テスト名を変える場合は本ファイルも更新すること。
Feature: Phase 6 generation hardening

  Scenario: forbids strict meta.changes comparisons that break under D1 triggers
    Given 実D1のmeta.changesはトリガーの書き込み行数を加算する
    When src配下のコードがmeta.changesを厳密比較（=== 1 / !== 1）で判定しようとする
    Then 静的ガードテストが失敗し、>= 1 か === 0 への書き換えを強制する

  Scenario: rejects aliases of meta.changes
    Given meta.changesの値が別の変数へ代入されている
    When その変数を1と厳密比較して静的ガードを回避しようとする
    Then 別名化した時点で静的ガードが失敗する

  Scenario: ignores commented tests and rejects duplicate implementations
    Given Scenarioと同名のitがコメント内または複数箇所に記述されている
    When featureカバレッジを検査する
    Then コメントは実テストに数えず同名テストが0件または複数なら失敗する

  Scenario: reserves an attempt when D1 reports trigger-inflated changes
    Given D1のmeta.changesはBEFORE INSERTトリガーの書き込み分だけ増える
    When 日記生成Workflowがattemptを予約する
    Then 予約はブロックと誤判定されず生成が完了する

  Scenario: terminates a stale running attempt with STEP_REEXECUTED before starting a new one
    Given 前回のステップ実行が送信前（stage未送信）のrunning attemptを残したままクラッシュした
    When 同じジョブのステップが再実行される
    Then 残存attemptはSTEP_REEXECUTEDで終端され恒久的な非終端行が残らない

  Scenario: does not resend a provider call after a crash between send and commit
    Given 前回のattemptが送信済みマーカー付きのままrunningで残っている
    When 同じジョブのステップが再実行される
    Then 提供者への再送は行わずUPSTREAM_RESULT_UNKNOWNで終端する（二重課金を防ぐ）

  Scenario: converges a generation job that exceeds the absolute deadline
    Given 生成ジョブが作成から30分の絶対期限を超えて非終端のままである
    When dispatch再調停がそのジョブを初回観測する
    Then 観測回数カウンタを待たず活性なWorkflowでも終了させGENERATION_DEADLINE_EXCEEDEDで即時終端する

  Scenario: terminates an image cleanup job that exceeds the absolute deadline
    Given 画像cleanupジョブが作成から30分の絶対期限を超えて非終端のままである
    When 起動照合がそのジョブを観測する
    Then 活性なWorkflowでも延命せず終了させCLEANUP_DEADLINE_EXCEEDEDで終端し、対象オブジェクトは日次スイープが回収する

  Scenario: converges the attempt and releases the manual retry when the daily limit aborts the reservation
    Given 手動再生成ジョブの予約が日次上限トリガーで中止された
    When Workflowが失敗を収束させる
    Then ジョブはCOST_LIMIT_REACHEDで終端し手動再生成権は消費されない

  Scenario: routes an exhausted image attempt budget to the lifetime limit convergence
    Given 録音の画像attempt予算5回が使い切られている
    When 画像生成Workflowが予約に失敗する
    Then image_statusはlimit_reachedへ収束しrunning attemptも終端される

  Scenario: passes the image-specific 120-second timeout to the provider
    Given 画像生成はテキスト系の30秒タイムアウトでは完了しないことがある
    When OpenAIへ画像生成を要求する
    Then 要求単位で120秒のタイムアウトが指定される

  Scenario: terminates running attempts when dispatch reconciliation fails a job
    Given dispatch再調停が3回の観測失敗でジョブを終端する
    When ジョブがWORKFLOW_DISPATCH_UNKNOWNで失敗する
    Then 同一ジョブのrunning attemptも同時に終端される

  Scenario: maps only optimistic lock aborts to a version conflict response
    Given 日記の保存バッチがD1エラーで失敗した
    When エラーが楽観ロック番兵によるものではない
    Then 409ではなく500 INTERNAL_ERRORを返す

  Scenario: keeps the approval response successful when the initial diary reservation fails
    Given 承認トランザクションは成立済みである
    When 初回日記jobの予約が一過性のD1エラーで失敗する
    Then 承認応答は失敗せずcron補償に委ねる

  Scenario: blocks image deletion while a diary generation job is active
    Given 日記生成ジョブが非終端で存在する
    When 画像DELETEが要求される
    Then 3つの更新文すべてがdiary/image両ジョブの非終端を排他条件に含む

  Scenario: sweeps only unreferenced day-old image objects
    Given R2にD1参照のない24時間以上前の画像オブジェクトが残っている
    When 日次スイープが実行される
    Then 参照のないオブジェクトだけが削除され新しいオブジェクトと参照付きは残る

  Scenario: advances the sweep cursor across pages so later orphans are reachable
    Given R2一覧が1ページに収まらない
    When スイープが1ページを処理し終える
    Then カーソルをD1へ永続化し翌日以降のスイープが後続ページへ到達できる

  Scenario: runs retention and sweep only on the daily cron
    Given cronは日次と毎時の2本が登録されている
    When 毎時トリガーが発火する
    Then 保持期限削除とR2スイープは実行されず日次トリガーだけが実行する

  Scenario: fails the scheduled invocation when a scheduled task rejects
    Given いずれかの定期タスクが失敗する
    When 全タスクの完了後に結果を集約する
    Then scheduled invocationは失敗として記録され監視から見える
