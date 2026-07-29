-- Persist bounded reconciliation so failed cleanup work cannot starve later objects.
ALTER TABLE async_jobs ADD COLUMN orphan_cleanup_status TEXT
  CHECK (orphan_cleanup_status IS NULL OR orphan_cleanup_status IN ('pending','running','succeeded','failed'));
ALTER TABLE async_jobs ADD COLUMN orphan_cleanup_attempt_count INTEGER NOT NULL DEFAULT 0
  CHECK (orphan_cleanup_attempt_count BETWEEN 0 AND 3);
ALTER TABLE async_jobs ADD COLUMN orphan_cleanup_last_error TEXT;
ALTER TABLE async_jobs ADD COLUMN orphan_cleanup_finished_at TEXT;

CREATE INDEX image_orphan_cleanup_pending ON async_jobs(orphan_cleanup_status, updated_at)
  WHERE job_type = 'image' AND status = 'failed' AND orphan_cleanup_attempt_count < 3;

ALTER TABLE image_cleanup_jobs ADD COLUMN dispatch_reconcile_count INTEGER NOT NULL DEFAULT 0
  CHECK (dispatch_reconcile_count BETWEEN 0 AND 3);
ALTER TABLE image_cleanup_jobs ADD COLUMN dispatch_lease_until TEXT;

CREATE INDEX image_cleanup_dispatch_reconcile
  ON image_cleanup_jobs(status, updated_at, dispatch_reconcile_count)
  WHERE status IN ('dispatch_pending','dispatched','running');
