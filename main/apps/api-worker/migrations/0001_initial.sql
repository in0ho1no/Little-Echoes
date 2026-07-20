PRAGMA foreign_keys = ON;

CREATE TABLE households (id TEXT PRIMARY KEY, created_at TEXT NOT NULL);
CREATE TABLE management_principals (
  access_subject TEXT NOT NULL, household_id TEXT NOT NULL REFERENCES households(id),
  created_at TEXT NOT NULL, revoked_at TEXT, PRIMARY KEY (access_subject, household_id)
);
CREATE TABLE sources (
  id TEXT PRIMARY KEY, household_id TEXT NOT NULL REFERENCES households(id),
  source_type TEXT NOT NULL CHECK (source_type IN ('pc','atom','sample')), created_at TEXT NOT NULL,
  UNIQUE (household_id, id)
);
CREATE TABLE device_tokens (
  id TEXT PRIMARY KEY, household_id TEXT NOT NULL REFERENCES households(id), source_id TEXT NOT NULL,
  token_hmac TEXT NOT NULL UNIQUE CHECK (length(token_hmac) = 64), expires_at TEXT NOT NULL,
  revoked_at TEXT, last_used_at TEXT, created_at TEXT NOT NULL,
  FOREIGN KEY (household_id, source_id) REFERENCES sources(household_id, id)
);
CREATE TABLE recordings (
  id TEXT PRIMARY KEY, household_id TEXT NOT NULL REFERENCES households(id), source_id TEXT NOT NULL,
  client_capture_id TEXT NOT NULL, captured_at TEXT NOT NULL, captured_at_original TEXT NOT NULL,
  captured_at_source TEXT NOT NULL CHECK (captured_at_source IN ('client_clock','device_clock','server_received','manual')),
  captured_timezone TEXT NOT NULL, received_at TEXT NOT NULL,
  pre_roll_seconds INTEGER NOT NULL CHECK (pre_roll_seconds BETWEEN 0 AND 10),
  post_roll_seconds INTEGER NOT NULL CHECK (post_roll_seconds BETWEEN 0 AND 5),
  post_roll_truncated INTEGER NOT NULL CHECK (post_roll_truncated IN (0,1)),
  duration_seconds REAL NOT NULL CHECK (duration_seconds > 0 AND duration_seconds <= 20),
  audio_object_key TEXT, audio_sha256 TEXT CHECK (audio_sha256 IS NULL OR length(audio_sha256) = 64),
  upload_status TEXT NOT NULL CHECK (upload_status IN ('reserved','ready','failed')),
  analysis_status TEXT NOT NULL CHECK (analysis_status IN ('pending','transcribing','extracting_words','ready','partial','failed')),
  review_status TEXT NOT NULL CHECK (review_status IN ('pending','approved','deleting','delete_failed','deleted')),
  draft_scene TEXT CHECK (draft_scene IS NULL OR length(draft_scene) <= 300),
  draft_parent_note TEXT CHECK (draft_parent_note IS NULL OR length(draft_parent_note) <= 2000),
  diary_status TEXT NOT NULL CHECK (diary_status IN ('not_started','generating','ready','failed')),
  image_status TEXT NOT NULL CHECK (image_status IN ('not_requested','generating','ready','failed','limit_reached')),
  active_attempt_id TEXT, version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, retention_delete_after TEXT, deleted_at TEXT,
  UNIQUE (household_id, source_id, client_capture_id), UNIQUE (household_id, id),
  FOREIGN KEY (household_id, source_id) REFERENCES sources(household_id, id)
);
CREATE INDEX recordings_household_visible ON recordings(household_id, review_status, captured_at);
CREATE INDEX recordings_retention_due ON recordings(retention_delete_after) WHERE deleted_at IS NULL;
CREATE TABLE transcripts (
  recording_id TEXT PRIMARY KEY REFERENCES recordings(id), raw_text TEXT, reviewed_text TEXT,
  language TEXT, model TEXT, prompt_version TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE word_candidates (
  id TEXT PRIMARY KEY, recording_id TEXT NOT NULL REFERENCES recordings(id), surface TEXT NOT NULL,
  normalized TEXT NOT NULL, part_of_speech TEXT, is_new_candidate INTEGER NOT NULL CHECK (is_new_candidate IN (0,1)),
  UNIQUE (recording_id, normalized)
);
CREATE TABLE dictionary_words (
  id TEXT PRIMARY KEY, household_id TEXT NOT NULL REFERENCES households(id), normalized TEXT NOT NULL,
  display_name TEXT NOT NULL, first_recording_id TEXT, first_spoken_at TEXT,
  occurrence_count INTEGER NOT NULL DEFAULT 0 CHECK (occurrence_count >= 0),
  UNIQUE (household_id, normalized), UNIQUE (household_id, id),
  FOREIGN KEY (household_id, first_recording_id) REFERENCES recordings(household_id, id)
);
CREATE TABLE word_occurrences (
  id TEXT PRIMARY KEY, household_id TEXT NOT NULL REFERENCES households(id),
  recording_id TEXT NOT NULL REFERENCES recordings(id), dictionary_word_id TEXT NOT NULL REFERENCES dictionary_words(id),
  surface TEXT NOT NULL, spoken_at TEXT NOT NULL,
  new_override TEXT NOT NULL CHECK (new_override IN ('auto','force_new','force_not_new')),
  is_first INTEGER NOT NULL CHECK (is_first IN (0,1)), created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  UNIQUE (recording_id, dictionary_word_id),
  FOREIGN KEY (household_id, recording_id) REFERENCES recordings(household_id, id),
  FOREIGN KEY (household_id, dictionary_word_id) REFERENCES dictionary_words(household_id, id)
);
CREATE TABLE diary_entries (
  id TEXT PRIMARY KEY, recording_id TEXT NOT NULL UNIQUE REFERENCES recordings(id), scene TEXT, parent_note TEXT,
  diary_text TEXT, model TEXT, prompt_version TEXT, version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE diary_images (
  id TEXT PRIMARY KEY, diary_entry_id TEXT NOT NULL REFERENCES diary_entries(id), image_object_key TEXT NOT NULL,
  generation_number INTEGER NOT NULL CHECK (generation_number BETWEEN 1 AND 5),
  is_active INTEGER NOT NULL CHECK (is_active IN (0,1)), model TEXT, prompt_version TEXT,
  created_at TEXT NOT NULL, deleted_at TEXT, UNIQUE (diary_entry_id, generation_number)
);
CREATE UNIQUE INDEX one_active_image ON diary_images(diary_entry_id) WHERE is_active = 1 AND deleted_at IS NULL;
CREATE TABLE async_jobs (
  id TEXT PRIMARY KEY, household_id TEXT NOT NULL REFERENCES households(id), recording_id TEXT NOT NULL,
  job_type TEXT NOT NULL CHECK (job_type IN ('analysis','diary','image','delete')),
  status TEXT NOT NULL CHECK (status IN ('dispatch_pending','dispatched','running','succeeded','failed')),
  workflow_instance_id TEXT, operation_number INTEGER NOT NULL CHECK (operation_number > 0),
  correlation_id TEXT NOT NULL, last_error_code TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  started_at TEXT, finished_at TEXT, UNIQUE (recording_id, job_type, operation_number), UNIQUE (household_id, id),
  FOREIGN KEY (household_id, recording_id) REFERENCES recordings(household_id, id)
);
CREATE UNIQUE INDEX one_nonterminal_job ON async_jobs(recording_id, job_type)
  WHERE status IN ('dispatch_pending','dispatched','running');
CREATE TABLE processing_attempts (
  id TEXT PRIMARY KEY, household_id TEXT NOT NULL REFERENCES households(id), recording_id TEXT NOT NULL,
  job_id TEXT NOT NULL, processing_kind TEXT NOT NULL CHECK (processing_kind IN ('analysis','diary','image','delete')),
  stage TEXT NOT NULL, attempt_number INTEGER NOT NULL CHECK ((processing_kind = 'image' AND attempt_number BETWEEN 1 AND 5) OR (processing_kind <> 'image' AND attempt_number BETWEEN 1 AND 3)),
  status TEXT NOT NULL CHECK (status IN ('running','succeeded','failed','unknown')),
  provider_request_id TEXT, error_code TEXT, retryable INTEGER NOT NULL CHECK (retryable IN (0,1)),
  correlation_id TEXT NOT NULL, started_at TEXT NOT NULL, finished_at TEXT,
  UNIQUE (job_id, attempt_number), UNIQUE (recording_id, processing_kind, attempt_number),
  FOREIGN KEY (household_id, recording_id) REFERENCES recordings(household_id, id),
  FOREIGN KEY (household_id, job_id) REFERENCES async_jobs(household_id, id)
);
CREATE TABLE usage_counters (
  counter_key TEXT NOT NULL, household_id TEXT REFERENCES households(id), scope TEXT NOT NULL, usage_day TEXT NOT NULL,
  used_count INTEGER NOT NULL DEFAULT 0 CHECK (used_count >= 0), reserved_count INTEGER NOT NULL DEFAULT 0 CHECK (reserved_count >= 0),
  updated_at TEXT NOT NULL, PRIMARY KEY (counter_key, usage_day),
  CHECK ((scope = 'image_lifetime' AND usage_day = 'lifetime') OR (scope <> 'image_lifetime' AND usage_day GLOB '????-??-??'))
);
CREATE TABLE audit_events (
  id TEXT PRIMARY KEY, household_id TEXT NOT NULL REFERENCES households(id), recording_id TEXT,
  event_type TEXT NOT NULL, actor_type TEXT NOT NULL CHECK (actor_type IN ('management_user','device','system')),
  actor_id TEXT NOT NULL, before_captured_at TEXT, after_captured_at TEXT, correlation_id TEXT NOT NULL,
  created_at TEXT NOT NULL, FOREIGN KEY (household_id, recording_id) REFERENCES recordings(household_id, id)
);
CREATE TABLE recording_tombstones (
  recording_id TEXT PRIMARY KEY, household_id TEXT NOT NULL REFERENCES households(id),
  review_status TEXT NOT NULL CHECK (review_status = 'deleted'), deleted_at TEXT NOT NULL
);
