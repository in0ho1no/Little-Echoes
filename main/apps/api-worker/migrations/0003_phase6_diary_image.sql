-- Phase 6 keeps diary/image quotas in D1 so concurrent Workers cannot bypass them.
ALTER TABLE diary_entries ADD COLUMN last_generation_error TEXT;

CREATE TRIGGER reserve_diary_openai_daily_limit
BEFORE INSERT ON processing_attempts
WHEN NEW.processing_kind = 'diary'
BEGIN
  INSERT INTO usage_counters (counter_key, household_id, scope, usage_day, used_count, reserved_count, updated_at)
  VALUES ('demo-global:openai_non_image', NULL, 'openai_non_image', strftime('%Y-%m-%d', NEW.started_at), 1, 0, NEW.started_at)
  ON CONFLICT(counter_key, usage_day) DO UPDATE SET used_count = used_count + 1, updated_at = excluded.updated_at
    WHERE used_count < 100;
  SELECT CASE WHEN changes() <> 1 THEN RAISE(ABORT, 'openai_daily_limit_reached') END;
END;

CREATE TRIGGER reserve_image_generation_limits
BEFORE INSERT ON processing_attempts
WHEN NEW.processing_kind = 'image'
BEGIN
  INSERT INTO usage_counters (counter_key, household_id, scope, usage_day, used_count, reserved_count, updated_at)
  VALUES ('demo-global:image_generation', NULL, 'image_generation', strftime('%Y-%m-%d', NEW.started_at), 1, 0, NEW.started_at)
  ON CONFLICT(counter_key, usage_day) DO UPDATE SET used_count = used_count + 1, updated_at = excluded.updated_at
    WHERE used_count < 20;
  SELECT CASE WHEN changes() <> 1 THEN RAISE(ABORT, 'image_daily_limit_reached') END;
  INSERT INTO usage_counters (counter_key, household_id, scope, usage_day, used_count, reserved_count, updated_at)
  VALUES ('recording:' || NEW.recording_id || ':image', NULL, 'image_lifetime', 'lifetime', 1, 0, NEW.started_at)
  ON CONFLICT(counter_key, usage_day) DO UPDATE SET used_count = used_count + 1, updated_at = excluded.updated_at
    WHERE used_count < 5;
  SELECT CASE WHEN changes() <> 1 THEN RAISE(ABORT, 'image_lifetime_limit_reached') END;
END;
