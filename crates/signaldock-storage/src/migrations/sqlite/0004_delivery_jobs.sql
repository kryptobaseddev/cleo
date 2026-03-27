-- Persistent delivery job queue.
-- Jobs are polled by the background delivery worker and retried
-- with exponential backoff.  Dead letters land in dead_letters.

CREATE TABLE IF NOT EXISTS delivery_jobs (
    id              TEXT    PRIMARY KEY,
    message_id      TEXT    NOT NULL,
    payload         TEXT    NOT NULL,
    status          TEXT    NOT NULL DEFAULT 'pending',
    attempts        INTEGER NOT NULL DEFAULT 0,
    max_attempts    INTEGER NOT NULL DEFAULT 6,
    next_attempt_at INTEGER NOT NULL,
    last_error      TEXT,
    created_at      INTEGER NOT NULL,
    updated_at      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_delivery_jobs_status
    ON delivery_jobs(status, next_attempt_at);

-- Permanently failed jobs that exhausted all retry attempts.
CREATE TABLE IF NOT EXISTS dead_letters (
    id         TEXT    PRIMARY KEY,
    message_id TEXT    NOT NULL,
    job_id     TEXT    NOT NULL,
    reason     TEXT    NOT NULL,
    attempts   INTEGER NOT NULL,
    created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_dead_letters_message
    ON dead_letters(message_id);
