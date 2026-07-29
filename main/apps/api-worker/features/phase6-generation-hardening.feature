# Phase 6 Fable5レビュー指摘（2026-07-29）の再発防止シナリオ。
# 各ScenarioタイトルはVitestのテスト名と1:1で対応し、対応漏れは
# test/feature-coverage.test.ts が検出する。テスト名を変える場合は本ファイルも更新すること。
Feature: Phase 6 generation hardening

  Scenario: reserves an attempt when D1 reports trigger-inflated changes
    Given D1のmeta.changesはBEFORE INSERTトリガーの書き込み分だけ増える
    When 日記生成Workflowがattemptを予約する
    Then 予約はブロックと誤判定されず生成が完了する

  Scenario: terminates a stale running attempt with STEP_REEXECUTED before starting a new one
    Given 前回のステップ実行がrunningのattemptを残したままクラッシュした
    When 同じジョブのステップが再実行される
    Then 残存attemptはSTEP_REEXECUTEDで終端され恒久的な非終端行が残らない

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
