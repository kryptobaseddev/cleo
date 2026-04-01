//! [`DeliveryJobRepository`] implementation for [`DieselStore`].
//!
//! Stores delivery jobs in the `delivery_jobs` table and moves
//! exhausted jobs to `dead_letters`. Backoff is computed as
//! `BASE_DELAY_S * 2^attempts`, capped at 32 seconds.

use anyhow::Result;
use async_trait::async_trait;
use chrono::Utc;
use diesel::prelude::*;
use diesel_async::RunQueryDsl;
use uuid::Uuid;

use super::diesel_helpers::*;
use super::diesel_store::DieselStore;
use crate::models::*;
use crate::schema::*;
use crate::traits::DeliveryJobRepository;
use crate::types::DeliveryJob;

/// Base delay in seconds for the first retry.
const BASE_DELAY_S: u64 = 1;
/// Maximum backoff delay in seconds (2^5 = 32 s).
const MAX_DELAY_S: u64 = 32;

/// Computes the backoff delay for an attempt count (0-indexed).
///
/// Returns `BASE_DELAY_S * 2^attempts`, capped at [`MAX_DELAY_S`].
fn backoff_secs(attempts: u32) -> u64 {
    (BASE_DELAY_S * 2u64.pow(attempts)).min(MAX_DELAY_S)
}

/// Generates `DeliveryJobRepository` impl for a concrete connection type.
macro_rules! impl_delivery_job_repository {
    ($conn:ty) => {
        #[async_trait]
        impl DeliveryJobRepository for DieselStore<$conn> {
            async fn enqueue_job(&self, message_id: Uuid, payload: &str) -> Result<Uuid> {
                let id = Uuid::new_v4();
                let now = now_ts();

                let new_row = NewDeliveryJobRow {
                    id: id.to_string(),
                    message_id: message_id.to_string(),
                    payload: payload.to_string(),
                    status: "pending".to_string(),
                    attempts: 0,
                    max_attempts: 6,
                    next_attempt_at: now,
                    last_error: None,
                    created_at: now,
                    updated_at: now,
                };

                let mut conn = self.pool.get().await.map_err(pool_err)?;
                diesel::insert_into(delivery_jobs::table)
                    .values(&new_row)
                    .execute(&mut conn)
                    .await
                    .map_err(diesel_err)?;

                Ok(id)
            }

            async fn fetch_ready_jobs(&self, limit: u32) -> Result<Vec<DeliveryJob>> {
                let now = Utc::now().timestamp();
                let mut conn = self.pool.get().await.map_err(pool_err)?;

                let rows: Vec<DeliveryJobRow> = delivery_jobs::table
                    .filter(delivery_jobs::status.eq("pending"))
                    .filter(delivery_jobs::next_attempt_at.le(now))
                    .order(delivery_jobs::next_attempt_at.asc())
                    .limit(limit as i64)
                    .load(&mut conn)
                    .await
                    .map_err(diesel_err)?;

                Ok(rows.into_iter().map(job_from_row).collect())
            }

            async fn complete_job(&self, job_id: Uuid) -> Result<()> {
                let now = now_ts();
                let mut conn = self.pool.get().await.map_err(pool_err)?;
                diesel::update(delivery_jobs::table.find(job_id.to_string()))
                    .set((
                        delivery_jobs::status.eq("done"),
                        delivery_jobs::updated_at.eq(now),
                    ))
                    .execute(&mut conn)
                    .await
                    .map_err(diesel_err)?;
                Ok(())
            }

            async fn fail_job(&self, job_id: Uuid, error: &str) -> Result<()> {
                let mut conn = self.pool.get().await.map_err(pool_err)?;

                let row: DeliveryJobRow = delivery_jobs::table
                    .find(job_id.to_string())
                    .first(&mut conn)
                    .await
                    .map_err(diesel_err)?;

                let attempts = row.attempts as u32 + 1;
                let max_attempts = row.max_attempts as u32;
                let now = now_ts();

                if attempts >= max_attempts {
                    self.dead_letter_job(job_id, error).await?;
                } else {
                    let delay = backoff_secs(attempts);
                    let next_attempt_at = now + delay as i64;

                    diesel::update(delivery_jobs::table.find(job_id.to_string()))
                        .set((
                            delivery_jobs::attempts.eq(attempts as i32),
                            delivery_jobs::last_error.eq(Some(error)),
                            delivery_jobs::next_attempt_at.eq(next_attempt_at),
                            delivery_jobs::updated_at.eq(now),
                        ))
                        .execute(&mut conn)
                        .await
                        .map_err(diesel_err)?;
                }

                Ok(())
            }

            async fn dead_letter_job(&self, job_id: Uuid, reason: &str) -> Result<()> {
                let mut conn = self.pool.get().await.map_err(pool_err)?;

                let row: DeliveryJobRow = delivery_jobs::table
                    .find(job_id.to_string())
                    .first(&mut conn)
                    .await
                    .map_err(diesel_err)?;

                let dl_id = Uuid::new_v4();
                let now = now_ts();

                let new_dl = NewDeadLetterRow {
                    id: dl_id.to_string(),
                    message_id: row.message_id.clone(),
                    job_id: job_id.to_string(),
                    reason: reason.to_string(),
                    attempts: row.attempts,
                    created_at: now,
                };

                diesel::insert_into(dead_letters::table)
                    .values(&new_dl)
                    .execute(&mut conn)
                    .await
                    .map_err(diesel_err)?;

                diesel::delete(delivery_jobs::table.find(job_id.to_string()))
                    .execute(&mut conn)
                    .await
                    .map_err(diesel_err)?;

                Ok(())
            }
        }
    };
}

#[cfg(feature = "sqlite")]
impl_delivery_job_repository!(SqliteConn);

#[cfg(feature = "postgres")]
impl_delivery_job_repository!(PgConn);
