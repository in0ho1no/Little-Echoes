CREATE TABLE image_cleanup_jobs (
  id TEXT PRIMARY KEY,
  household_id TEXT NOT NULL REFERENCES households(id),
  diary_image_id TEXT NOT NULL UNIQUE REFERENCES diary_images(id),
  image_object_key TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('dispatch_pending','dispatched','running','succeeded','failed')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 3),
  last_error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  finished_at TEXT
);
CREATE INDEX image_cleanup_pending ON image_cleanup_jobs(status, updated_at) WHERE status IN ('dispatch_pending','dispatched','running','failed');
CREATE UNIQUE INDEX one_manual_diary_retry ON async_jobs(recording_id)
  WHERE job_type = 'diary' AND manual_retry = 1;
