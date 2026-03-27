//! Repository trait for user accounts.

use async_trait::async_trait;
use uuid::Uuid;

use anyhow::Result;

/// Persistence operations for user accounts.
#[async_trait]
pub trait UserRepository: Send + Sync {
    /// Creates a new user with the given credentials.
    ///
    /// # Errors
    ///
    /// Returns `anyhow::Error` on database failure or if
    /// the email is already registered.
    async fn create(
        &self,
        email: &str,
        password_hash: &str,
        name: Option<&str>,
    ) -> Result<signaldock_protocol::user::User>;

    /// Finds a user by their internal UUID.
    ///
    /// # Errors
    ///
    /// Returns `anyhow::Error` on database failure.
    async fn find_by_id(&self, id: Uuid) -> Result<Option<signaldock_protocol::user::User>>;

    /// Finds a user by their email address.
    ///
    /// # Errors
    ///
    /// Returns `anyhow::Error` on database failure.
    async fn find_by_email(&self, email: &str) -> Result<Option<signaldock_protocol::user::User>>;

    /// Sets the user's default sending agent.
    ///
    /// Pass `None` to clear the default (auto-select first owned agent).
    ///
    /// # Errors
    ///
    /// Returns `anyhow::Error` on database failure or if the agent
    /// is not owned by this user.
    async fn set_default_agent(
        &self,
        user_id: Uuid,
        agent_id: Option<&str>,
    ) -> Result<signaldock_protocol::user::User>;
}
