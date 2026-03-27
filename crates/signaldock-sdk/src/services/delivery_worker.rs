//! Background delivery worker with persistent job queue.
//!
//! `DeliveryWorker` polls the `delivery_jobs` table every second
//! and processes pending jobs by re-invoking the
//! `DeliveryOrchestrator`.  Completed jobs are marked done;
//! failed jobs are rescheduled with exponential backoff; jobs that
//! exhaust all attempts are moved to the `dead_letters` table.
//!
//! # Job payload
//!
//! Each job stores a JSON-encoded `DeliveryJobPayload` that
//! contains the full `DeliveryEvent` and `DeliveryTarget`
//! needed to re-attempt delivery without querying the database.
//!
//! # Lifecycle
//!
//! Call `DeliveryWorker::run` and drive it alongside the HTTP
//! server with `tokio::select!`.  The method runs until cancelled
//! or until an unrecoverable internal error occurs.

use std::sync::Arc;

use anyhow::Result;
use serde::{Deserialize, Serialize};
use signaldock_protocol::message::DeliveryEvent;
use signaldock_storage::traits::{DeliveryJobRepository, MessageRepository};
use signaldock_transport::traits::DeliveryTarget;
use tokio::time::{Duration, sleep};
use tracing::{error, info, warn};

use super::delivery_service::{DeliveryOrchestrator, DeliveryOutcome};

/// Poll interval between worker ticks.
const POLL_INTERVAL: Duration = Duration::from_secs(1);

/// Maximum jobs fetched per poll cycle.
const BATCH_SIZE: u32 = 50;

/// JSON payload stored in the `delivery_jobs.payload` column.
///
/// Contains everything required to re-attempt delivery without
/// additional database lookups.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeliveryJobPayload {
    /// The event describing the message to deliver.
    pub event: DeliveryEvent,
    /// Transport configuration for the recipient agent.
    pub target: DeliveryTarget,
}

/// Background worker that drains the persistent delivery queue.
///
/// Created once at server startup and driven by
/// `DeliveryWorker::run`.
pub struct DeliveryWorker<S> {
    store: Arc<S>,
    delivery: Arc<DeliveryOrchestrator<S>>,
}

impl<S> DeliveryWorker<S>
where
    S: DeliveryJobRepository
        + MessageRepository
        + signaldock_storage::traits::AgentRepository
        + Send
        + Sync
        + 'static,
{
    /// Creates a new `DeliveryWorker`.
    ///
    /// * `store` — shared store that implements
    ///   [`DeliveryJobRepository`] and [`MessageRepository`].
    /// * `delivery` — shared orchestrator used to attempt delivery.
    pub fn new(store: Arc<S>, delivery: Arc<DeliveryOrchestrator<S>>) -> Self {
        Self { store, delivery }
    }

    /// Runs the worker loop until an unrecoverable error occurs.
    ///
    /// Polls the job queue once per second.  Each iteration fetches
    /// up to 50 ready jobs and processes them
    /// concurrently inside `tokio::spawn` tasks.
    ///
    /// # Errors
    ///
    /// Returns `anyhow::Error` only on unexpected internal failures
    /// that prevent the loop from continuing.
    pub async fn run(&self) -> Result<()> {
        info!("delivery worker started");
        loop {
            match self.tick().await {
                Ok(n) if n > 0 => {
                    info!(jobs = n, "delivery worker processed batch");
                }
                Ok(_) => {}
                Err(e) => {
                    error!(error = %e, "delivery worker tick failed");
                }
            }
            sleep(POLL_INTERVAL).await;
        }
    }

    /// Fetches one batch of ready jobs and spawns a task per job.
    ///
    /// Returns the number of jobs dispatched in this tick.
    async fn tick(&self) -> Result<u32> {
        let jobs = self.store.fetch_ready_jobs(BATCH_SIZE).await?;
        let count = jobs.len() as u32;

        for job in jobs {
            let store = self.store.clone();
            let delivery = self.delivery.clone();

            tokio::spawn(async move {
                let job_id = job.id;

                // Deserialise the payload.
                let payload: DeliveryJobPayload = match serde_json::from_str(&job.payload) {
                    Ok(p) => p,
                    Err(e) => {
                        error!(
                            job_id = %job_id,
                            error = %e,
                            "failed to deserialise job payload; dead-lettering"
                        );
                        let _ = store
                            .dead_letter_job(job_id, &format!("bad payload: {e}"))
                            .await;
                        return;
                    }
                };

                // Attempt delivery.
                match delivery.deliver(&payload.event, &payload.target).await {
                    Ok(DeliveryOutcome::Sse) | Ok(DeliveryOutcome::Webhook { .. }) => {
                        info!(job_id = %job_id, "job delivered successfully");
                        let _ = store.complete_job(job_id).await;
                        let _ = store.mark_delivered(payload.event.message_id).await;
                    }
                    Ok(DeliveryOutcome::Polling) => {
                        // No transport available yet; reschedule.
                        let _ = store
                            .fail_job(job_id, "no active transport (polling fallback)")
                            .await;
                    }
                    Ok(DeliveryOutcome::DeadLetter { ref reason }) => {
                        warn!(job_id = %job_id, %reason, "delivery permanently failed");
                        let _ = store.dead_letter_job(job_id, reason).await;
                    }
                    Err(e) => {
                        warn!(job_id = %job_id, error = %e, "delivery attempt failed (transient)");
                        let _ = store.fail_job(job_id, &e.to_string()).await;
                    }
                }
            });
        }

        Ok(count)
    }
}
