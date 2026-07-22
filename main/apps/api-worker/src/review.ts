export interface ReviewWordInput {
  displayName: string;
  normalized: string;
  newOverride: 'auto' | 'force_new' | 'force_not_new';
}

export interface ReviewInput {
  version: number;
  reviewedText: string;
  words: ReviewWordInput[];
  capturedAt: string;
  capturedTimezone: string;
  scene: string | null;
  parentNote: string | null;
}

export interface ReviewTarget {
  id: string;
  householdId: string;
  version: number;
  reviewStatus: string;
  analysisStatus: string;
  capturedAt: string;
}

export type ReviewMutationResult = 'saved' | 'version_conflict' | 'not_reviewable';

function opaqueId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll('-', '')}`;
}

function allowedForReview(target: ReviewTarget): boolean {
  // 承認済みの再編集はapproveReviewだけが扱う。SQLガード('pending')と同じ条件に保つ。
  return target.reviewStatus === 'pending' && ['ready', 'partial', 'failed'].includes(target.analysisStatus);
}

function allowedForApproval(target: ReviewTarget): boolean {
  return ['pending', 'approved'].includes(target.reviewStatus) && ['ready', 'partial', 'failed'].includes(target.analysisStatus);
}

function recordingGuard(reviewStates: string): string {
  return `id = ? AND household_id = ? AND version = ? AND review_status IN (${reviewStates})`;
}

// 楽観ロック不成立時にNOT NULL違反でバッチ全体を中止する番兵。後続文の
// `version = 期待値+1` ガードは、同じ基底versionで競合した敗者でも勝者が
// 作った現在値と一致して成立してしまうため、成立条件として信用できない。
function versionConflictSentinel(db: D1Database): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO recording_tombstones (recording_id, household_id, review_status, deleted_at)
       SELECT NULL, NULL, NULL, NULL WHERE (SELECT changes()) = 0`,
    )
    .bind();
}

function isVersionConflictAbort(error: unknown): boolean {
  return error instanceof Error && error.message.includes('recording_tombstones');
}

function candidateStatements(db: D1Database, target: ReviewTarget, input: ReviewInput, nextVersion: number): D1PreparedStatement[] {
  const guard = recordingGuard("'pending'");
  const statements: D1PreparedStatement[] = [
    db.prepare(
      `DELETE FROM word_candidates
        WHERE recording_id = ? AND EXISTS (SELECT 1 FROM recordings WHERE ${guard})`,
    ).bind(target.id, target.id, target.householdId, nextVersion),
  ];
  for (const word of input.words) {
    statements.push(
      db.prepare(
        `INSERT INTO word_candidates (id, recording_id, surface, normalized, part_of_speech, is_new_candidate)
         SELECT ?, r.id, ?, ?, NULL,
                CASE WHEN EXISTS (SELECT 1 FROM dictionary_words dw WHERE dw.household_id = r.household_id AND dw.normalized = ?) THEN 0 ELSE 1 END
           FROM recordings r WHERE ${guard}`,
      ).bind(opaqueId('candidate'), word.displayName, word.normalized, word.normalized, target.id, target.householdId, nextVersion),
    );
  }
  return statements;
}

function transcriptStatement(db: D1Database, target: ReviewTarget, input: ReviewInput, reviewStates: string, nextVersion: number, now: string): D1PreparedStatement {
  const guard = recordingGuard(reviewStates);
  return db
    .prepare(
      `INSERT INTO transcripts (recording_id, raw_text, reviewed_text, language, model, prompt_version, created_at, updated_at)
       SELECT r.id, NULL, ?, NULL, NULL, NULL, ?, ? FROM recordings r
        WHERE ${guard}
       ON CONFLICT(recording_id) DO UPDATE SET reviewed_text = excluded.reviewed_text, updated_at = excluded.updated_at`,
    )
    .bind(input.reviewedText, now, now, target.id, target.householdId, nextVersion);
}

function auditStatement(db: D1Database, target: ReviewTarget, input: ReviewInput, reviewStates: string, nextVersion: number, correlationId: string, actorId: string, now: string): D1PreparedStatement | null {
  if (target.capturedAt === input.capturedAt) return null;
  const guard = recordingGuard(reviewStates);
  return db
    .prepare(
      `INSERT INTO audit_events (id, household_id, recording_id, event_type, actor_type, actor_id, before_captured_at, after_captured_at, correlation_id, created_at)
       SELECT ?, r.household_id, r.id, 'captured_at_changed', 'management_user', ?, ?, ?, ?, ? FROM recordings r
        WHERE ${guard}`,
    )
    .bind(opaqueId('audit'), actorId, target.capturedAt, input.capturedAt, correlationId, now, target.id, target.householdId, nextVersion);
}

function reindexStatements(db: D1Database, householdId: string, normalizations: string[]): D1PreparedStatement[] {
  if (normalizations.length === 0) return [];
  const placeholders = normalizations.map(() => '?').join(',');
  const wordFilter = `SELECT id FROM dictionary_words WHERE household_id = ? AND normalized IN (${placeholders})`;
  return [
    db.prepare(
      `WITH ranked AS (
         SELECT wo.id,
                ROW_NUMBER() OVER (PARTITION BY wo.dictionary_word_id ORDER BY r.captured_at, r.created_at, wo.recording_id) AS rank,
                r.captured_at AS captured_at
           FROM word_occurrences wo
           JOIN recordings r ON r.id = wo.recording_id AND r.household_id = wo.household_id
          WHERE wo.dictionary_word_id IN (${wordFilter}) AND r.review_status = 'approved'
       )
       UPDATE word_occurrences
          SET is_first = CASE WHEN id IN (SELECT id FROM ranked WHERE rank = 1) THEN 1 ELSE 0 END,
              spoken_at = (SELECT captured_at FROM ranked WHERE ranked.id = word_occurrences.id)
        WHERE dictionary_word_id IN (${wordFilter})
          AND EXISTS (
            SELECT 1 FROM recordings approved
             WHERE approved.id = word_occurrences.recording_id
               AND approved.household_id = word_occurrences.household_id
               AND approved.review_status = 'approved'
          )`,
    ).bind(householdId, ...normalizations, householdId, ...normalizations),
    db.prepare(
      `UPDATE dictionary_words
          SET occurrence_count = (
                SELECT COUNT(*) FROM word_occurrences wo
                 JOIN recordings r ON r.id = wo.recording_id AND r.household_id = wo.household_id
                WHERE wo.dictionary_word_id = dictionary_words.id AND r.review_status = 'approved'
              ),
              first_recording_id = (
                SELECT wo.recording_id FROM word_occurrences wo
                 JOIN recordings r ON r.id = wo.recording_id AND r.household_id = wo.household_id
                WHERE wo.dictionary_word_id = dictionary_words.id AND r.review_status = 'approved'
                ORDER BY r.captured_at, r.created_at, wo.recording_id LIMIT 1
              ),
              first_spoken_at = (
                SELECT r.captured_at FROM word_occurrences wo
                 JOIN recordings r ON r.id = wo.recording_id AND r.household_id = wo.household_id
                WHERE wo.dictionary_word_id = dictionary_words.id AND r.review_status = 'approved'
                ORDER BY r.captured_at, r.created_at, wo.recording_id LIMIT 1
              )
        WHERE id IN (${wordFilter})`,
    ).bind(householdId, ...normalizations),
    db.prepare(
      `DELETE FROM dictionary_words WHERE household_id = ? AND normalized IN (${placeholders}) AND occurrence_count = 0
        AND NOT EXISTS (SELECT 1 FROM word_occurrences wo WHERE wo.dictionary_word_id = dictionary_words.id)`,
    ).bind(householdId, ...normalizations),
  ];
}

export async function saveReview(
  db: D1Database,
  target: ReviewTarget,
  input: ReviewInput,
  actorId: string,
  correlationId: string,
): Promise<ReviewMutationResult> {
  if (!allowedForReview(target)) return 'not_reviewable';
  const now = new Date().toISOString();
  const nextVersion = input.version + 1;
  const changedAt = target.capturedAt !== input.capturedAt;
  const guard = recordingGuard("'pending'");
  const statements: D1PreparedStatement[] = [
    db
      .prepare(
        `UPDATE recordings
            SET captured_at = ?, captured_timezone = ?, captured_at_source = CASE WHEN captured_at <> ? THEN 'manual' ELSE captured_at_source END,
                draft_scene = ?, draft_parent_note = ?, version = version + 1, updated_at = ?
          WHERE ${guard}`,
      )
      .bind(input.capturedAt, input.capturedTimezone, input.capturedAt, input.scene, input.parentNote, now, target.id, target.householdId, input.version),
    versionConflictSentinel(db),
    transcriptStatement(db, target, input, "'pending'", nextVersion, now),
    ...candidateStatements(db, target, input, nextVersion),
  ];
  const audit = auditStatement(db, target, input, "'pending'", nextVersion, correlationId, actorId, now);
  if (changedAt && audit) statements.push(audit);
  let results;
  try {
    results = await db.batch(statements);
  } catch (error) {
    if (isVersionConflictAbort(error)) return 'version_conflict';
    throw error;
  }
  // D1のmeta.changesはトリガーの書き込みを含み得るため、1との厳密比較はしない。
  return (results[0]?.meta.changes ?? 0) >= 1 ? 'saved' : 'version_conflict';
}

export async function approveReview(
  db: D1Database,
  target: ReviewTarget,
  input: ReviewInput,
  actorId: string,
  correlationId: string,
): Promise<ReviewMutationResult> {
  if (!allowedForApproval(target)) return 'not_reviewable';
  const priorNormalizations = (
    await db.prepare(
      `SELECT dw.normalized FROM word_occurrences wo JOIN dictionary_words dw ON dw.id = wo.dictionary_word_id
        WHERE wo.recording_id = ? AND wo.household_id = ?`,
    )
      .bind(target.id, target.householdId)
      .all<{ normalized: string }>()
  ).results.map((row) => row.normalized);
  const normalizations = [...new Set([...priorNormalizations, ...input.words.map((word) => word.normalized)])];
  const now = new Date().toISOString();
  const nextVersion = input.version + 1;
  const states = "'pending', 'approved'";
  const guard = recordingGuard(states);
  const updatedGuard = recordingGuard("'approved'");
  const statements: D1PreparedStatement[] = [
    db
      .prepare(
        `UPDATE recordings
            SET captured_at = ?, captured_timezone = ?, captured_at_source = CASE WHEN captured_at <> ? THEN 'manual' ELSE captured_at_source END,
                draft_scene = ?, draft_parent_note = ?, review_status = 'approved',
                diary_status = CASE WHEN review_status = 'pending' THEN 'not_started' ELSE diary_status END,
                version = version + 1, updated_at = ?
          WHERE ${guard}`,
      )
      .bind(input.capturedAt, input.capturedTimezone, input.capturedAt, input.scene, input.parentNote, now, target.id, target.householdId, input.version),
    versionConflictSentinel(db),
    transcriptStatement(db, target, input, "'approved'", nextVersion, now),
    db.prepare(`DELETE FROM word_occurrences WHERE recording_id = ? AND household_id = ? AND EXISTS (SELECT 1 FROM recordings WHERE ${updatedGuard})`)
      .bind(target.id, target.householdId, target.id, target.householdId, nextVersion),
  ];
  for (const word of input.words) {
    statements.push(
      db.prepare(
        `INSERT INTO dictionary_words (id, household_id, normalized, display_name, occurrence_count)
         SELECT ?, r.household_id, ?, ?, 0 FROM recordings r WHERE ${updatedGuard}
         ON CONFLICT(household_id, normalized) DO UPDATE SET display_name = excluded.display_name`,
      ).bind(opaqueId('word'), word.normalized, word.displayName, target.id, target.householdId, nextVersion),
      db.prepare(
        `INSERT INTO word_occurrences (id, household_id, recording_id, dictionary_word_id, surface, spoken_at, new_override, is_first, created_at, updated_at)
         SELECT ?, r.household_id, r.id, dw.id, ?, r.captured_at, ?, 0, ?, ?
           FROM recordings r JOIN dictionary_words dw ON dw.household_id = r.household_id AND dw.normalized = ?
          WHERE ${updatedGuard}`,
      ).bind(opaqueId('occurrence'), word.displayName, word.newOverride, now, now, word.normalized, target.id, target.householdId, nextVersion),
    );
  }
  statements.push(
    db.prepare(
      `INSERT INTO diary_entries (id, recording_id, scene, parent_note, diary_text, model, prompt_version, version, created_at, updated_at)
       SELECT ?, r.id, ?, ?, NULL, NULL, NULL, 1, ?, ? FROM recordings r
        WHERE ${updatedGuard}
       ON CONFLICT(recording_id) DO UPDATE SET scene = excluded.scene, parent_note = excluded.parent_note, updated_at = excluded.updated_at`,
    ).bind(opaqueId('diary'), input.scene, input.parentNote, now, now, target.id, target.householdId, nextVersion),
    ...reindexStatements(db, target.householdId, normalizations),
  );
  const audit = auditStatement(db, target, input, "'approved'", nextVersion, correlationId, actorId, now);
  if (audit) statements.push(audit);
  let results;
  try {
    results = await db.batch(statements);
  } catch (error) {
    if (isVersionConflictAbort(error)) return 'version_conflict';
    throw error;
  }
  // D1のmeta.changesはトリガーの書き込みを含み得るため、1との厳密比較はしない。
  return (results[0]?.meta.changes ?? 0) >= 1 ? 'saved' : 'version_conflict';
}
