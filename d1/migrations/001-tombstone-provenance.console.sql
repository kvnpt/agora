ALTER TABLE schedule_overrides ADD COLUMN source TEXT NOT NULL DEFAULT 'human';
ALTER TABLE adapter_runs ADD COLUMN window_from TEXT;
ALTER TABLE adapter_runs ADD COLUMN window_to TEXT;
ALTER TABLE adapter_runs ADD COLUMN tombstones_refused TEXT;
