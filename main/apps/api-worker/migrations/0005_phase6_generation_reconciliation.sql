-- Generation jobs retain the exact approved state they were reserved against.
ALTER TABLE async_jobs ADD COLUMN expected_recording_version INTEGER;
ALTER TABLE async_jobs ADD COLUMN expected_diary_version INTEGER;

CREATE INDEX diary_image_dispatch_reconcile ON async_jobs(job_type, status, updated_at)
  WHERE job_type IN ('diary', 'image') AND status IN ('dispatch_pending', 'dispatched', 'running');
