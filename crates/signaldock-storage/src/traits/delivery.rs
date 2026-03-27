//! Repository trait for the delivery job queue.

use async_trait::async_trait;
use uuid::Uuid;

use anyhow::Result;

use crate::types::DeliveryJob;

/// Persistence operations for the delivery job queue.
///
/// Implementations back the background
/// `signaldock_sdk::services::delivery_worker` that retries failed
/// message deliveries with exponential backoff.
#[async_trait]
pub trait DeliveryJobRepository: Send + Sync {
    /// Enqueues a new delivery job for `message_id`.
    ///
    /// `payload` is the JSON-serialized `DeliveryJobPayload`
    /// containing the [`DeliveryEvent`] and
    /// `signaldock_transport::traits::DeliveryTarget`.
    ///
    /// Returns the UUID assigned to the new job row.
    ///
    /// # Errors
    ///
    /// Returns `anyhow::Error` on database failure.
    ///
    /// [`DeliveryEvent`]: signaldock_protocol::message::DeliveryEvent
    async fn enqueue_job(&self, message_id: Uuid, payload: &str) -> Result<Uuid>;

    /// Fetches up to `limit` jobs that are ready to be processed.
    ///
    /// A job is ready when `status = 'pending'` and
    /// `next_attempt_at <= now`.
    ///
    /// # Errors
    ///
    /// Returns `anyhow::Error` on database failure.
    async fn fetch_ready_jobs(&self, limit: u32) -> Result<Vec<DeliveryJob>>;

    /// Marks a job as successfully completed (`status = 'done'`).
    ///
    /// # Errors
    ///
    /// Returns `anyhow::Error` on database failure.
    async fn complete_job(&self, job_id: Uuid) -> Result<()>;

    /// Records a failed attempt for a job.
    ///
    /// Increments `attempts` and sets `next_attempt_at` using
    /// exponential backoff (`1s * 2^attempts`, capped at 32 s).
    /// If `attempts >= max_attempts`, the job is dead-lettered
    /// instead of rescheduled.
    ///
    /// # Errors
    ///
    /// Returns `anyhow::Error` on database failure.
    async fn fail_job(&self, job_id: Uuid, error: &str) -> Result<()>;

    /// Moves a job to the `dead_letters` table.
    ///
    /// The original job row is deleted after the dead-letter record
    /// is inserted.
    ///
    /// # Errors
    ///
    /// Returns `anyhow::Error` on database failure.
    async fn dead_letter_job(&self, job_id: Uuid, reason: &str) -> Result<()>;
}
