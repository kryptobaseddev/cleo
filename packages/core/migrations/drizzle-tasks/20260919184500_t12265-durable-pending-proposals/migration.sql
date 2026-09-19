-- T12265: preserve authentic resumable inputs in the existing active job table.
-- Historical rows retain NULL payload: a hash cannot reconstruct original bytes.
-- The separate tasks_background_jobs history and its timestamp encoding are untouched.
ALTER TABLE background_jobs ADD COLUMN proposal_json TEXT;
