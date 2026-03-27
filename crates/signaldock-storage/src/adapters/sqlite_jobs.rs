//! [`DeliveryJobRepository`] implementation for [`SqliteStore`].
//!
//! Stores delivery jobs in the `delivery_jobs` table and moves
//! exhausted jobs to `dead_letters`.  Backoff is computed as
//! `base_delay * 2^attempts`, capped at 32 seconds.
//!
//! [`DeliveryJobRepository`]: crate::traits::DeliveryJobRepository

use anyhow::{Context, Result};
use async_trait::async_trait;
use chrono::Utc;
use sqlx::Row;
use uuid::Uuid;

use super::sqlite::SqliteStore;
use super::sqlite_helpers::{now_ts, ts_to_dt};
use crate::traits::DeliveryJobRepository;
use crate::types::DeliveryJob;

/// Base delay in seconds for the first retry.
const BASE_DELAY_S: u64 = 1;
/// Maximum backoff delay in seconds (2^5 = 32 s).
const MAX_DELAY_S: u64 = 32;

/// Computes the backoff delay for an attempt count (0-indexed).
///
/// Returns `BASE_DELAY_S * 2^attempts`, capped at `MAX_DELAY_S`.
fn backoff_secs(attempts: u32) -> u64 {
    let exp = attempts as u64;
    (BASE_DELAY_S * 2u64.pow(exp as u32)).min(MAX_DELAY_S)
}

fn row_to_job(row: &sqlx::sqlite::SqliteRow) -> Result<DeliveryJob> {
    let id: String = row.get("id");
    let message_id: String = row.get("message_id");
    Ok(DeliveryJob {
        id: Uuid::parse_str(&id).context("invalid job id")?,
        message_id: Uuid::parse_str(&message_id).context("invalid message_id")?,
        payload: row.get("payload"),
        status: row.get("status"),
        attempts: row.get::<i64, _>("attempts") as u32,
        max_attempts: row.get::<i64, _>("max_attempts") as u32,
        next_attempt_at: ts_to_dt(row.get::<i64, _>("next_attempt_at")),
        last_error: row.get("last_error"),
        created_at: ts_to_dt(row.get::<i64, _>("created_at")),
    })
}

#[async_trait]
impl DeliveryJobRepository for SqliteStore {
    async fn enqueue_job(&self, message_id: Uuid, payload: &str) -> Result<Uuid> {
        let id = Uuid::new_v4();
        let now = now_ts();

        sqlx::query(
            "INSERT INTO delivery_jobs \
             (id, message_id, payload, status, attempts, max_attempts, \
              next_attempt_at, created_at, updated_at) \
             VALUES (?, ?, ?, 'pending', 0, 6, ?, ?, ?)",
        )
        .bind(id.to_string())
        .bind(message_id.to_string())
        .bind(payload)
        .bind(now) // next_attempt_at = now (eligible immediately)
        .bind(now)
        .bind(now)
        .execute(self.pool())
        .await?;

        Ok(id)
    }

    async fn fetch_ready_jobs(&self, limit: u32) -> Result<Vec<DeliveryJob>> {
        let now = Utc::now().timestamp();
        let rows = sqlx::query(
            "SELECT * FROM delivery_jobs \
             WHERE status = 'pending' AND next_attempt_at <= ? \
             ORDER BY next_attempt_at ASC \
             LIMIT ?",
        )
        .bind(now)
        .bind(limit as i64)
        .fetch_all(self.pool())
        .await?;

        rows.iter().map(row_to_job).collect()
    }

    async fn complete_job(&self, job_id: Uuid) -> Result<()> {
        let now = now_ts();
        sqlx::query(
            "UPDATE delivery_jobs \
             SET status = 'done', updated_at = ? \
             WHERE id = ?",
        )
        .bind(now)
        .bind(job_id.to_string())
        .execute(self.pool())
        .await?;
        Ok(())
    }

    async fn fail_job(&self, job_id: Uuid, error: &str) -> Result<()> {
        // First, read the current attempt count and max to decide
        // whether to reschedule or dead-letter.
        let row = sqlx::query(
            "SELECT attempts, max_attempts, message_id \
             FROM delivery_jobs WHERE id = ?",
        )
        .bind(job_id.to_string())
        .fetch_optional(self.pool())
        .await?
        .context("delivery job not found")?;

        let attempts: u32 = row.get::<i64, _>("attempts") as u32 + 1;
        let max_attempts: u32 = row.get::<i64, _>("max_attempts") as u32;
        let now = now_ts();

        if attempts >= max_attempts {
            // Promote to dead letter.
            self.dead_letter_job(job_id, error).await?;
        } else {
            let delay = backoff_secs(attempts);
            let next_attempt_at = now + delay as i64;

            sqlx::query(
                "UPDATE delivery_jobs \
                 SET attempts = ?, last_error = ?, \
                     next_attempt_at = ?, updated_at = ? \
                 WHERE id = ?",
            )
            .bind(attempts as i64)
            .bind(error)
            .bind(next_attempt_at)
            .bind(now)
            .bind(job_id.to_string())
            .execute(self.pool())
            .await?;
        }

        Ok(())
    }

    async fn dead_letter_job(&self, job_id: Uuid, reason: &str) -> Result<()> {
        let row = sqlx::query("SELECT attempts, message_id FROM delivery_jobs WHERE id = ?")
            .bind(job_id.to_string())
            .fetch_optional(self.pool())
            .await?
            .context("delivery job not found for dead-lettering")?;

        let attempts: i64 = row.get("attempts");
        let message_id: String = row.get("message_id");
        let dl_id = Uuid::new_v4();
        let now = now_ts();

        sqlx::query(
            "INSERT INTO dead_letters \
             (id, message_id, job_id, reason, attempts, created_at) \
             VALUES (?, ?, ?, ?, ?, ?)",
        )
        .bind(dl_id.to_string())
        .bind(&message_id)
        .bind(job_id.to_string())
        .bind(reason)
        .bind(attempts)
        .bind(now)
        .execute(self.pool())
        .await?;

        sqlx::query("DELETE FROM delivery_jobs WHERE id = ?")
            .bind(job_id.to_string())
            .execute(self.pool())
            .await?;

        Ok(())
    }
}
