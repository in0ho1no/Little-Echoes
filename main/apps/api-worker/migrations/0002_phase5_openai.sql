ALTER TABLE async_jobs ADD COLUMN authorization_token_id TEXT REFERENCES device_tokens(id) ON DELETE SET NULL;
ALTER TABLE async_jobs ADD COLUMN manual_retry INTEGER NOT NULL DEFAULT 0 CHECK (manual_retry IN (0, 1));
CREATE UNIQUE INDEX one_manual_analysis_retry ON async_jobs(recording_id)
  WHERE job_type = 'analysis' AND manual_retry = 1;

-- A job reservation and the visible return to pending must commit together.
CREATE TRIGGER mark_analysis_pending_on_job_reservation
AFTER INSERT ON async_jobs
WHEN NEW.job_type = 'analysis' AND NEW.status = 'dispatch_pending'
BEGIN
  UPDATE recordings SET analysis_status = 'pending',
                        version = version + CASE WHEN analysis_status IN ('partial', 'failed') THEN 1 ELSE 0 END,
                        updated_at = NEW.updated_at
   WHERE id = NEW.recording_id AND household_id = NEW.household_id AND review_status = 'pending'
     AND analysis_status IN ('pending', 'partial', 'failed');
  SELECT CASE WHEN changes() <> 1 THEN RAISE(ABORT, 'analysis_retry_state_changed') END;
END;

-- Each provider request is reserved separately. The primary key prevents a
-- Workflow replay from charging the same attempt stage twice.
CREATE TABLE openai_call_reservations (
  attempt_id TEXT NOT NULL REFERENCES processing_attempts(id) ON DELETE CASCADE,
  stage TEXT NOT NULL CHECK (stage IN ('transcription', 'word_extraction')),
  usage_day TEXT NOT NULL CHECK (
    length(usage_day) = 10
    AND usage_day GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
    AND usage_day = strftime('%Y-%m-%d', usage_day)
  ),
  created_at TEXT NOT NULL,
  PRIMARY KEY (attempt_id, stage)
);

CREATE TRIGGER reserve_transcription_openai_daily_limit
BEFORE INSERT ON processing_attempts
WHEN NEW.processing_kind = 'analysis'
BEGIN
  INSERT INTO usage_counters (counter_key, household_id, scope, usage_day, used_count, reserved_count, updated_at)
  VALUES ('demo-global:openai_non_image', NULL, 'openai_non_image', strftime('%Y-%m-%d', NEW.started_at), 1, 0, NEW.started_at)
  ON CONFLICT(counter_key, usage_day) DO UPDATE
    SET used_count = used_count + 1, updated_at = excluded.updated_at
    WHERE used_count < 100;
  SELECT CASE WHEN changes() <> 1 THEN RAISE(ABORT, 'openai_daily_limit_reached') END;
  INSERT INTO openai_call_reservations (attempt_id, stage, usage_day, created_at)
  VALUES (NEW.id, 'transcription', strftime('%Y-%m-%d', NEW.started_at), NEW.started_at);
END;

CREATE TRIGGER reserve_word_extraction_openai_daily_limit
BEFORE INSERT ON openai_call_reservations
WHEN NEW.stage = 'word_extraction'
BEGIN
  SELECT CASE
    WHEN NEW.usage_day <> strftime('%Y-%m-%d', NEW.created_at)
    THEN RAISE(ABORT, 'openai_usage_day_mismatch')
  END;
  INSERT INTO usage_counters (counter_key, household_id, scope, usage_day, used_count, reserved_count, updated_at)
  VALUES ('demo-global:openai_non_image', NULL, 'openai_non_image', NEW.usage_day, 1, 0, NEW.created_at)
  ON CONFLICT(counter_key, usage_day) DO UPDATE
    SET used_count = used_count + 1, updated_at = excluded.updated_at
    WHERE used_count < 100;
  SELECT CASE WHEN changes() <> 1 THEN RAISE(ABORT, 'openai_daily_limit_reached') END;
END;
