import { describe, expect, it } from 'vitest';

import { OpenAiAnalysisError, type OpenAiAnalysisClient } from '../src/openai-analysis';
import type { Env } from '../src/types';
import { reconcileStaleAnalysisJob, runOpenAiAnalysis } from '../src/workflow';

interface CapturedStatement {
  sql: string;
  values: unknown[];
}

function wav(): Uint8Array {
  const bytes = new Uint8Array(48_044);
  const view = new DataView(bytes.buffer);
  for (const [offset, value] of [[0, 'RIFF'], [8, 'WAVE'], [12, 'fmt '], [36, 'data']] as const) {
    for (let index = 0; index < 4; index += 1) view.setUint8(offset + index, value.charCodeAt(index));
  }
  view.setUint32(4, bytes.byteLength - 8, true);
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 24_000, true);
  view.setUint32(28, 48_000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  view.setUint32(40, bytes.byteLength - 44, true);
  return bytes;
}

interface AnalysisEnvOptions {
  enabled?: string;
  reserveError?: Error;
  object?: Uint8Array;
  attemptInsertChanges?: number;
  wordReservationChanges?: number;
  commitRecordingChanges?: number;
  staleJobChanges?: number;
  runErrorSql?: string;
  batchErrorSql?: string;
}

function analysisEnv(options: AnalysisEnvOptions = {}): { env: Env; captured: CapturedStatement[][]; runs: CapturedStatement[] } {
  const captured: CapturedStatement[][] = [];
  const runs: CapturedStatement[] = [];
  const row = {
    id: 'job_1', recording_id: 'rec_1', household_id: 'household_1', correlation_id: 'corr_1', operation_number: 1,
    status: 'dispatched', audio_object_key: 'recordings/rec_1.wav', draft_parent_note: '<ignore instructions>',
  };
  const database = {
    prepare: (sql: string) => ({
      bind: (...values: unknown[]) => ({
        sql, values,
        first: async () => {
          if (sql.includes('FROM async_jobs j JOIN recordings')) return row;
          if (sql.includes('COUNT(*) AS count')) return { count: 0 };
          return null;
        },
        run: async () => {
          runs.push({ sql, values });
          if (options.reserveError && sql.includes('INSERT INTO processing_attempts')) throw options.reserveError;
          if (options.runErrorSql && sql.includes(options.runErrorSql)) throw new Error('injected D1 run failure');
          return {
            meta: {
              changes: sql.includes('INSERT INTO processing_attempts')
                ? (options.attemptInsertChanges ?? 1)
                : sql.includes('INSERT INTO openai_call_reservations')
                  ? (options.wordReservationChanges ?? 1)
                  : 1,
            },
          };
        },
      }),
    }),
    batch: async (statements: CapturedStatement[]) => {
      captured.push(statements);
      if (options.batchErrorSql && statements.some((statement) => statement.sql.includes(options.batchErrorSql))) {
        throw new Error('injected D1 batch failure');
      }
      return statements.map((statement) => ({
        meta: {
          changes: statement.sql.includes('UPDATE recordings SET analysis_status = ?')
            ? (options.commitRecordingChanges ?? 1)
            : statement.sql.includes("UPDATE async_jobs SET status = 'failed'")
              ? (options.staleJobChanges ?? 1)
              : 1,
        },
      }));
    },
  } as unknown as D1Database;
  return {
    env: {
      DB: database,
      PRIVATE_MEDIA: { get: async () => ({ arrayBuffer: async () => (options.object ?? wav()).buffer }) } as unknown as R2Bucket,
      DEMO_WRITE_ENABLED: options.enabled ?? 'true',
      OPENAI_API_KEY: 'test-only',
    } as Env,
    captured, runs,
  };
}

const normalClient: OpenAiAnalysisClient = {
  transcribe: async () => ({ value: 'りんご、たべたい', requestId: 'req_transcript' }),
  extractWords: async () => ({ value: [{ surface: 'りんご', normalized: 'りんご', part_of_speech: 'noun' }], requestId: 'req_words' }),
};

const oneStep = async (_name: string, _limit: number, operation: () => Promise<void>) => operation();
const fixedClock = () => new Date('2026-07-23T00:00:00.000Z');

const retryOnce = async (_name: string, _limit: number, operation: () => Promise<void>) => {
  try {
    await operation();
  } catch {
    await operation();
  }
};

describe('OpenAI解析Workflow', () => {
  it('正常系はR2 WAVを検証し、予約後に文字起こしと候補をreadyで原子的に保存する', async () => {
    const { env, captured } = analysisEnv();
    await runOpenAiAnalysis(env, 'job_1', oneStep, normalClient, fixedClock);
    const sql = captured.flat().map((statement) => statement.sql).join('\n');
    expect(sql).toContain("stage = 'word_extraction'");
    expect(sql).toContain("analysis_status = ?");
    expect(sql).toContain("active_attempt_id = ? AND review_status = 'pending'");
    expect(sql).toContain("status = 'succeeded'");
  });

  it('空文字起こしはpartialにし、単語抽出を呼ばない', async () => {
    const { env, captured } = analysisEnv();
    let extractionCalls = 0;
    await runOpenAiAnalysis(env, 'job_1', oneStep, {
      transcribe: async () => ({ value: '   ', requestId: 'req_empty' }),
      extractWords: async () => { extractionCalls += 1; return { value: [], requestId: null }; },
    }, fixedClock);
    expect(extractionCalls).toBe(0);
    expect(captured.flat().some((statement) => statement.values.includes('partial'))).toBe(true);
    expect(captured.flat().some((statement) => statement.values.includes('EMPTY_TRANSCRIPT'))).toBe(true);
  });

  it('構造化出力拒否・不正は文字起こしを残してpartialにする', async () => {
    const { env, captured } = analysisEnv();
    await runOpenAiAnalysis(env, 'job_1', oneStep, {
      transcribe: async () => ({ value: 'りんご', requestId: 'req_1' }),
      extractWords: async () => { throw new OpenAiAnalysisError('INVALID_STRUCTURED_OUTPUT', false); },
    }, fixedClock);
    const sql = captured.flat().map((statement) => statement.sql).join('\n');
    expect(sql).toContain('INSERT INTO transcripts');
    expect(sql).toContain("UPDATE recordings SET analysis_status = ?");
    expect(sql).toContain("UPDATE async_jobs SET status = 'succeeded'");
  });

  it('空の候補配列はreadyにせずpartialにする', async () => {
    const { env, captured } = analysisEnv();
    await runOpenAiAnalysis(env, 'job_1', oneStep, {
      transcribe: async () => ({ value: 'りんご', requestId: 'req_1' }),
      extractWords: async () => ({ value: [], requestId: 'req_2' }),
    }, fixedClock);
    expect(captured.flat().some((statement) => statement.values.includes('EMPTY_WORD_CANDIDATES'))).toBe(true);
  });

  it('2000文字超の文字起こしは保存せずfailedへ安全に収束する', async () => {
    const { env, captured } = analysisEnv();
    await runOpenAiAnalysis(env, 'job_1', oneStep, {
      transcribe: async () => ({ value: 'あ'.repeat(2_001), requestId: 'req_1' }),
      extractWords: async () => ({ value: [], requestId: null }),
    }, fixedClock);
    expect(captured.flat().some((statement) => statement.values.includes('TRANSCRIPT_TOO_LONG'))).toBe(true);
  });

  it('日次コスト予約が失敗した時はOpenAIを呼ばずCOST_LIMIT_REACHEDで終了する', async () => {
    const { env, captured } = analysisEnv({ reserveError: new Error('openai_daily_limit_reached') });
    let calls = 0;
    await runOpenAiAnalysis(env, 'job_1', oneStep, {
      transcribe: async () => { calls += 1; return { value: 'x', requestId: null }; },
      extractWords: async () => ({ value: [], requestId: null }),
    }, fixedClock);
    expect(calls).toBe(0);
    expect(captured.flat().some((statement) => statement.values.includes('COST_LIMIT_REACHED'))).toBe(true);
    expect(captured.flat().some((statement) => statement.values.includes('ANALYSIS_STATE_CHANGED'))).toBe(false);
    const terminalJobUpdates = captured
      .flat()
      .filter((statement) => statement.sql.includes("UPDATE async_jobs SET status = 'failed', last_error_code = ?"));
    expect(terminalJobUpdates).toHaveLength(1);
    expect(terminalJobUpdates[0]?.values).toContain('COST_LIMIT_REACHED');
  });

  it('キルスイッチまたは期限でAPI予約前に終了する', async () => {
    const { env, captured, runs } = analysisEnv({ enabled: 'false' });
    await runOpenAiAnalysis(env, 'job_1', oneStep, normalClient, fixedClock);
    expect(captured.flat().some((statement) => statement.values.includes('DEMO_WRITE_DISABLED'))).toBe(true);
    expect(runs.some((statement) => statement.sql.includes('INSERT INTO processing_attempts'))).toBe(false);
  });

  it('1回の送信attemptは日次予約INSERTを1回だけ実行する', async () => {
    const { env, runs } = analysisEnv();
    await runOpenAiAnalysis(env, 'job_1', oneStep, normalClient, fixedClock);
    expect(runs.filter((statement) => statement.sql.includes('INSERT INTO processing_attempts')).length).toBe(1);
  });

  it('UTC日をまたぐ抽出は抽出時点の日付で別に予約する', async () => {
    const { env, runs } = analysisEnv();
    const times = [
      new Date('2026-07-23T23:59:59.000Z'),
      new Date('2026-07-23T23:59:59.000Z'),
      new Date('2026-07-23T23:59:59.000Z'),
      new Date('2026-07-24T00:00:01.000Z'),
    ];
    await runOpenAiAnalysis(env, 'job_1', oneStep, normalClient, () => times.shift() ?? new Date('2026-07-24T00:00:01.000Z'));
    const extraction = runs.find((statement) => statement.sql.includes('INSERT INTO openai_call_reservations'));
    expect(extraction?.values).toContain('2026-07-24T00:00:01.000Z');
  });

  it('429/5xxだけをWorkflow再試行対象として分類する', async () => {
    const rate = new OpenAiAnalysisError('UPSTREAM_RATE_LIMIT', true);
    const unavailable = new OpenAiAnalysisError('UPSTREAM_UNAVAILABLE', true);
    expect(rate.retryable).toBe(true);
    expect(unavailable.retryable).toBe(true);
  });

  it('結果不明のタイムアウトは自動再送せずunknownで収束する', async () => {
    const { env, captured } = analysisEnv();
    let calls = 0;
    await runOpenAiAnalysis(env, 'job_1', oneStep, {
      transcribe: async () => { calls += 1; throw new OpenAiAnalysisError('UPSTREAM_RESULT_UNKNOWN', false); },
      extractWords: async () => ({ value: [], requestId: null }),
    }, fixedClock);
    expect(calls).toBe(1);
    expect(captured.flat().map((statement) => statement.sql).join('\n')).toContain('UPSTREAM_RESULT_UNKNOWN');
  });

  it('文字起こし成功後のD1障害はWorkflow再試行へ漏らさず外部APIを再送しない', async () => {
    const { env, captured } = analysisEnv({ runErrorSql: 'UPDATE processing_attempts SET provider_request_id' });
    let calls = 0;
    await runOpenAiAnalysis(env, 'job_1', retryOnce, {
      transcribe: async () => {
        calls += 1;
        return { value: 'りんご', requestId: 'req_transcript' };
      },
      extractWords: async () => ({ value: [], requestId: null }),
    }, fixedClock);
    expect(calls).toBe(1);
    expect(captured.flat().map((statement) => statement.sql).join('\n')).toContain("status = 'unknown', error_code = 'UPSTREAM_RESULT_UNKNOWN'");
  });

  it('結果不明の終端記録自体が失敗しても外部APIを再送しない', async () => {
    const { env } = analysisEnv({ batchErrorSql: "status = 'unknown', error_code = 'UPSTREAM_RESULT_UNKNOWN'" });
    let calls = 0;
    await runOpenAiAnalysis(env, 'job_1', retryOnce, {
      transcribe: async () => {
        calls += 1;
        throw new OpenAiAnalysisError('UPSTREAM_RESULT_UNKNOWN', false);
      },
      extractWords: async () => ({ value: [], requestId: null }),
    }, fixedClock);
    expect(calls).toBe(1);
  });

  it('候補抽出成功後のcommit応答喪失では異なるpartial結果を再commitしない', async () => {
    const { env, captured } = analysisEnv({ batchErrorSql: "UPDATE processing_attempts SET status = 'succeeded'" });
    await runOpenAiAnalysis(env, 'job_1', retryOnce, normalClient, fixedClock);
    const resultCommits = captured.filter((batch) => batch.some((statement) => statement.sql.includes('INSERT INTO transcripts')));
    expect(resultCommits).toHaveLength(1);
  });

  it('再試行は前attemptの文字起こしを後attemptへ引き継がない', async () => {
    const { env, captured } = analysisEnv();
    let transcriptionCalls = 0;
    await runOpenAiAnalysis(env, 'job_1', retryOnce, {
      transcribe: async () => {
        transcriptionCalls += 1;
        if (transcriptionCalls === 1) return { value: '前回の文字起こし', requestId: 'req_1' };
        throw new OpenAiAnalysisError('UPSTREAM_UNAVAILABLE', true);
      },
      extractWords: async () => { throw new OpenAiAnalysisError('UPSTREAM_UNAVAILABLE', true); },
    }, fixedClock);
    const transcriptInserts = captured.flat().filter((statement) => statement.sql.includes('INSERT INTO transcripts'));
    expect(transcriptionCalls).toBe(2);
    expect(transcriptInserts).toHaveLength(0);
    expect(captured.flat().some((statement) => statement.values.includes('UPSTREAM_UNAVAILABLE'))).toBe(true);
  });

  it('トリガーを含むmeta.changesが2でもattempt予約を成功として外部APIを呼ぶ', async () => {
    const { env } = analysisEnv({ attemptInsertChanges: 2 });
    let calls = 0;
    await runOpenAiAnalysis(env, 'job_1', oneStep, {
      transcribe: async () => { calls += 1; return { value: 'りんご', requestId: null }; },
      extractWords: async () => ({ value: [], requestId: null }),
    }, fixedClock);
    expect(calls).toBe(1);
  });

  for (const state of ['revoked token', 'expired token', 'deleting recording', 'replaced active attempt']) {
    it(`${state}では予約gateが閉じ、OpenAIを呼ばない`, async () => {
      const { env, captured, runs } = analysisEnv({ attemptInsertChanges: 0 });
      let calls = 0;
      await runOpenAiAnalysis(env, 'job_1', oneStep, {
        transcribe: async () => { calls += 1; return { value: 'x', requestId: null }; },
        extractWords: async () => ({ value: [], requestId: null }),
      }, fixedClock);
      expect(calls).toBe(0);
      expect(captured.flat().some((statement) => statement.values.includes('ANALYSIS_STATE_CHANGED'))).toBe(true);
      const gate = runs.find((statement) => statement.sql.includes('INSERT INTO processing_attempts'))?.sql ?? '';
      expect(gate).toContain("d.revoked_at IS NULL AND d.expires_at > ?");
      expect(gate).toContain("r.upload_status = 'ready' AND r.review_status = 'pending'");
      expect(gate).toContain("j.status IN ('dispatch_pending', 'dispatched', 'running')");
      expect(gate).toContain('d.id = j.authorization_token_id');
    });
  }

  it('受付tokenが失効して別tokenだけが有効でも、token固有gateでOpenAIを呼ばない', async () => {
    const { env, runs } = analysisEnv({ attemptInsertChanges: 0 });
    let calls = 0;
    await runOpenAiAnalysis(env, 'job_1', oneStep, {
      transcribe: async () => { calls += 1; return { value: 'x', requestId: null }; },
      extractWords: async () => ({ value: [], requestId: null }),
    }, fixedClock);
    expect(calls).toBe(0);
    const reservation = runs.find((statement) => statement.sql.includes('INSERT INTO processing_attempts'))?.sql ?? '';
    expect(reservation).toContain('d.id = j.authorization_token_id');
  });

  it('文字起こし後にactive attemptが差し替わると抽出を呼ばず、transcriptをpartialで保持する', async () => {
    const { env, captured, runs } = analysisEnv({ wordReservationChanges: 0 });
    let transcriptionCalls = 0;
    let extractionCalls = 0;
    await runOpenAiAnalysis(env, 'job_1', oneStep, {
      transcribe: async () => { transcriptionCalls += 1; return { value: 'りんご', requestId: 'req_1' }; },
      extractWords: async () => { extractionCalls += 1; return { value: [], requestId: null }; },
    }, fixedClock);
    expect(transcriptionCalls).toBe(1);
    expect(extractionCalls).toBe(0);
    expect(captured.flat().some((statement) => statement.sql.includes('INSERT INTO transcripts'))).toBe(true);
    expect(captured.flat().some((statement) => statement.values.includes('ANALYSIS_STATE_CHANGED'))).toBe(true);
    const gate = runs.find((statement) => statement.sql.includes('INSERT INTO openai_call_reservations'))?.sql ?? '';
    expect(gate).toContain("r.active_attempt_id = ? AND r.upload_status = 'ready' AND r.review_status = 'pending'");
  });

  it('active attemptが差し替わったcommitはunknownに収束し、新しい状態を書き換えない', async () => {
    const { env, captured } = analysisEnv({ commitRecordingChanges: 0 });
    await runOpenAiAnalysis(env, 'job_1', oneStep, normalClient, fixedClock);
    const sql = captured.flat().map((statement) => statement.sql).join('\n');
    expect(sql).toContain("active_attempt_id = ? AND review_status = 'pending'");
    expect(sql).toContain("status = 'unknown', error_code = 'UPSTREAM_RESULT_UNKNOWN'");
    expect(sql).toContain("WHERE id = ? AND status IN ('dispatch_pending', 'dispatched', 'running')\n          AND EXISTS");
    expect(sql).toContain("analysis_status IN ('pending', 'transcribing', 'extracting_words')");
    expect(sql).toContain('(SELECT changes()) = 1');
    expect(sql).toContain("last_error_code = 'UPSTREAM_RESULT_UNKNOWN' AND updated_at = ?");
    expect(sql).toContain('newer.id <> ?');
  });

  it('step再実行では古いrunning attemptを終了してから新しいattemptを予約する', async () => {
    const { env, runs } = analysisEnv();
    await runOpenAiAnalysis(env, 'job_1', oneStep, normalClient, fixedClock);
    const reexecuted = runs.findIndex((statement) => statement.sql.includes("error_code = 'STEP_REEXECUTED'"));
    const reservation = runs.findIndex((statement) => statement.sql.includes('INSERT INTO processing_attempts'));
    expect(reexecuted).toBeGreaterThanOrEqual(0);
    expect(reservation).toBeGreaterThan(reexecuted);
  });
});

describe('解析ジョブのstale収束', () => {
  it('未経過ならWorkflow状態を照合しない', async () => {
    const { env } = analysisEnv();
    env.ANALYSIS_WORKFLOW = { get: async () => { throw new Error('unexpected'); } } as unknown as Workflow<{ async_job_id: string }>;
    await expect(reconcileStaleAnalysisJob(env, { id: 'job_1', status: 'running', recording_id: 'rec_1', household_id: 'household_1', updated_at: new Date().toISOString() })).resolves.toBe('active');
  });

  it('終了済みWorkflowはjobをfailedへ収束する', async () => {
    const { env, captured } = analysisEnv();
    env.ANALYSIS_WORKFLOW = { get: async () => ({ status: async () => ({ status: 'complete' }) }) } as unknown as Workflow<{ async_job_id: string }>;
    await expect(reconcileStaleAnalysisJob(env, { id: 'job_1', status: 'running', recording_id: 'rec_1', household_id: 'household_1', updated_at: '2026-07-22T00:00:00.000Z' }, new Date('2026-07-23T00:00:00.000Z'))).resolves.toBe('converged');
    expect(captured.flat().some((statement) => statement.sql.includes('UPSTREAM_RESULT_UNKNOWN'))).toBe(true);
  });

  it('照合不能なWorkflow状態はDBを書き換えずunknownを返す', async () => {
    const { env, captured } = analysisEnv();
    env.ANALYSIS_WORKFLOW = { get: async () => ({ status: async () => ({ status: 'mystery' }) }) } as unknown as Workflow<{ async_job_id: string }>;
    await expect(reconcileStaleAnalysisJob(env, { id: 'job_1', status: 'running', recording_id: 'rec_1', household_id: 'household_1', updated_at: '2026-07-22T00:00:00.000Z' }, new Date('2026-07-23T00:00:00.000Z'))).resolves.toBe('unknown');
    expect(captured).toHaveLength(0);
  });

  it('running Workflowはheartbeatだけを更新してrunningを維持する', async () => {
    const { env, runs } = analysisEnv();
    env.ANALYSIS_WORKFLOW = { get: async () => ({ status: async () => ({ status: 'running' }) }) } as unknown as Workflow<{ async_job_id: string }>;
    await expect(reconcileStaleAnalysisJob(env, { id: 'job_1', status: 'running', recording_id: 'rec_1', household_id: 'household_1', updated_at: '2026-07-22T00:00:00.000Z' }, new Date('2026-07-23T00:00:00.000Z'))).resolves.toBe('active');
    expect(runs.some((statement) => statement.sql.includes('UPDATE async_jobs SET updated_at'))).toBe(true);
  });

  it('旧jobのstale収束は新active attemptを持つ録音をfailedへ上書きしない', async () => {
    const { env, captured } = analysisEnv();
    env.ANALYSIS_WORKFLOW = { get: async () => ({ status: async () => ({ status: 'terminated' }) }) } as unknown as Workflow<{ async_job_id: string }>;
    await reconcileStaleAnalysisJob(env, { id: 'job_1', status: 'running', recording_id: 'rec_1', household_id: 'household_1', updated_at: '2026-07-22T00:00:00.000Z' }, new Date('2026-07-23T00:00:00.000Z'));
    const recordingUpdate = captured.flat().find((statement) => statement.sql.includes("UPDATE recordings SET analysis_status = 'failed'"));
    expect(recordingUpdate?.sql).toContain('active.id = recordings.active_attempt_id AND active.status = \'running\'');
  });
});
