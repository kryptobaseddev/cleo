//! Repository trait for agent claim codes.

use async_trait::async_trait;
use uuid::Uuid;

use anyhow::Result;
use signaldock_protocol::claim::ClaimCode;

/// Persistence operations for agent claim codes.
///
/// Claim codes allow a human user to prove ownership of an
/// agent through a one-time redemption flow.
#[async_trait]
pub trait ClaimRepository: Send + Sync {
    /// Generates a new claim code for an agent.
    ///
    /// # Errors
    ///
    /// Returns `anyhow::Error` on database failure.
    async fn create_code(
        &self,
        agent_id: Uuid,
        code: &str,
        expires_at: chrono::DateTime<chrono::Utc>,
    ) -> Result<ClaimCode>;

    /// Looks up a claim code by its string value.
    ///
    /// # Errors
    ///
    /// Returns `anyhow::Error` on database failure.
    async fn find_code(&self, code: &str) -> Result<Option<ClaimCode>>;

    /// Redeems a claim code, binding the agent to a user.
    ///
    /// # Errors
    ///
    /// Returns `anyhow::Error` if the code is invalid,
    /// expired, or on database failure.
    async fn redeem_code(&self, code: &str, user_id: Uuid) -> Result<ClaimCode>;

    /// Invalidates all expired claim codes.
    ///
    /// Returns the number of codes invalidated.
    ///
    /// # Errors
    ///
    /// Returns `anyhow::Error` on database failure.
    async fn invalidate_expired(&self) -> Result<u64>;
}
