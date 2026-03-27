use anyhow::{Context, Result};
use async_trait::async_trait;
use chrono::{DateTime, Utc};
use uuid::Uuid;

use signaldock_protocol::{
    claim::ClaimCode,
    connection::{Connection, ConnectionStatus, NewConnection},
    user::User,
};

use super::sqlite::SqliteStore;
use super::sqlite_helpers::{
    dt_to_ts, now_ts, row_to_claim_code, row_to_connection, row_to_user, serialize_enum,
};
use crate::traits::{ClaimRepository, ConnectionRepository, UserRepository};

#[async_trait]
impl UserRepository for SqliteStore {
    async fn create(&self, email: &str, password_hash: &str, name: Option<&str>) -> Result<User> {
        let id = Uuid::new_v4();
        let now = now_ts();

        sqlx::query(
            "INSERT INTO users \
             (id, email, password_hash, name, \
             created_at, updated_at) \
             VALUES (?, ?, ?, ?, ?, ?)",
        )
        .bind(id.to_string())
        .bind(email)
        .bind(password_hash)
        .bind(name)
        .bind(now)
        .bind(now)
        .execute(self.pool())
        .await?;

        UserRepository::find_by_id(self, id)
            .await?
            .context("user not found after insert")
    }

    async fn find_by_id(&self, id: Uuid) -> Result<Option<User>> {
        let row = sqlx::query("SELECT * FROM users WHERE id = ?")
            .bind(id.to_string())
            .fetch_optional(self.pool())
            .await?;
        row.as_ref().map(row_to_user).transpose()
    }

    async fn find_by_email(&self, email: &str) -> Result<Option<User>> {
        let row = sqlx::query("SELECT * FROM users WHERE email = ?")
            .bind(email)
            .fetch_optional(self.pool())
            .await?;
        row.as_ref().map(row_to_user).transpose()
    }

    async fn set_default_agent(&self, user_id: Uuid, agent_id: Option<&str>) -> Result<User> {
        let now = now_ts();
        sqlx::query("UPDATE users SET default_agent_id = ?, updated_at = ? WHERE id = ?")
            .bind(agent_id)
            .bind(now)
            .bind(user_id.to_string())
            .execute(self.pool())
            .await
            .context("failed to set default agent")?;

        self.find_by_id(user_id)
            .await?
            .context("user not found after update")
    }
}

#[async_trait]
impl ClaimRepository for SqliteStore {
    async fn create_code(
        &self,
        agent_id: Uuid,
        code: &str,
        expires_at: DateTime<Utc>,
    ) -> Result<ClaimCode> {
        let id = Uuid::new_v4();
        let now = now_ts();

        sqlx::query(
            "INSERT INTO claim_codes \
             (id, agent_id, code, expires_at, created_at) \
             VALUES (?, ?, ?, ?, ?)",
        )
        .bind(id.to_string())
        .bind(agent_id.to_string())
        .bind(code)
        .bind(dt_to_ts(expires_at))
        .bind(now)
        .execute(self.pool())
        .await?;

        ClaimRepository::find_code(self, code)
            .await?
            .context("claim code not found after insert")
    }

    async fn find_code(&self, code: &str) -> Result<Option<ClaimCode>> {
        let row = sqlx::query("SELECT * FROM claim_codes WHERE code = ?")
            .bind(code)
            .fetch_optional(self.pool())
            .await?;
        row.as_ref().map(row_to_claim_code).transpose()
    }

    async fn redeem_code(&self, code: &str, user_id: Uuid) -> Result<ClaimCode> {
        let now = now_ts();
        sqlx::query(
            "UPDATE claim_codes \
             SET used_at = ?, used_by = ? \
             WHERE code = ? AND used_at IS NULL",
        )
        .bind(now)
        .bind(user_id.to_string())
        .bind(code)
        .execute(self.pool())
        .await?;

        ClaimRepository::find_code(self, code)
            .await?
            .context("claim code not found after redeem")
    }

    async fn invalidate_expired(&self) -> Result<u64> {
        let now = now_ts();
        let result = sqlx::query(
            "DELETE FROM claim_codes \
             WHERE expires_at < ? AND used_at IS NULL",
        )
        .bind(now)
        .execute(self.pool())
        .await?;
        Ok(result.rows_affected())
    }
}

#[async_trait]
impl ConnectionRepository for SqliteStore {
    async fn create(&self, conn: NewConnection) -> Result<Connection> {
        let id = Uuid::new_v4();
        let now = now_ts();

        sqlx::query(
            "INSERT INTO connections \
             (id, agent_a, agent_b, status, \
             initiated_by, created_at, updated_at) \
             VALUES (?, ?, ?, 'pending', ?, ?, ?)",
        )
        .bind(id.to_string())
        .bind(conn.agent_a.to_string())
        .bind(conn.agent_b.to_string())
        .bind(&conn.initiated_by)
        .bind(now)
        .bind(now)
        .execute(self.pool())
        .await?;

        let row = sqlx::query("SELECT * FROM connections WHERE id = ?")
            .bind(id.to_string())
            .fetch_one(self.pool())
            .await?;
        row_to_connection(&row)
    }

    async fn find_by_agents(&self, agent_a: Uuid, agent_b: Uuid) -> Result<Option<Connection>> {
        let row = sqlx::query(
            "SELECT * FROM connections \
             WHERE (agent_a = ? AND agent_b = ?) \
             OR (agent_a = ? AND agent_b = ?)",
        )
        .bind(agent_a.to_string())
        .bind(agent_b.to_string())
        .bind(agent_b.to_string())
        .bind(agent_a.to_string())
        .fetch_optional(self.pool())
        .await?;
        row.as_ref().map(row_to_connection).transpose()
    }

    async fn update_status(&self, id: Uuid, status: ConnectionStatus) -> Result<Connection> {
        let now = now_ts();
        let status_str = serialize_enum(&status);
        sqlx::query(
            "UPDATE connections \
             SET status = ?, updated_at = ? \
             WHERE id = ?",
        )
        .bind(&status_str)
        .bind(now)
        .bind(id.to_string())
        .execute(self.pool())
        .await?;

        let row = sqlx::query("SELECT * FROM connections WHERE id = ?")
            .bind(id.to_string())
            .fetch_one(self.pool())
            .await?;
        row_to_connection(&row)
    }

    async fn list_for_agent(&self, agent_id: Uuid) -> Result<Vec<Connection>> {
        let id_str = agent_id.to_string();
        let rows = sqlx::query(
            "SELECT * FROM connections \
             WHERE agent_a = ? OR agent_b = ? \
             ORDER BY created_at DESC",
        )
        .bind(&id_str)
        .bind(&id_str)
        .fetch_all(self.pool())
        .await?;
        rows.iter().map(row_to_connection).collect()
    }
}
