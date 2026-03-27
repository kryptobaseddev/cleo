use anyhow::{Context, Result};
use async_trait::async_trait;
use chrono::{DateTime, Utc};
use uuid::Uuid;

use signaldock_protocol::{
    claim::ClaimCode,
    connection::{Connection, ConnectionStatus, NewConnection},
    user::User,
};

use super::pg_helpers::*;
use super::postgres::PostgresStore;
use crate::traits::{ClaimRepository, ConnectionRepository, UserRepository};

#[async_trait]
impl UserRepository for PostgresStore {
    async fn create(&self, email: &str, password_hash: &str, name: Option<&str>) -> Result<User> {
        let id = Uuid::new_v4();
        let row = sqlx::query(
            "INSERT INTO users \
             (id, email, password_hash, name, \
              created_at, updated_at) \
             VALUES ($1,$2,$3,$4,NOW(),NOW()) \
             RETURNING *",
        )
        .bind(id)
        .bind(email)
        .bind(password_hash)
        .bind(name)
        .fetch_one(&self.pool)
        .await?;
        user_from_row(&row)
    }

    async fn find_by_id(&self, id: Uuid) -> Result<Option<User>> {
        let row = sqlx::query("SELECT * FROM users WHERE id = $1")
            .bind(id)
            .fetch_optional(&self.pool)
            .await?;
        row.as_ref().map(user_from_row).transpose()
    }

    async fn find_by_email(&self, email: &str) -> Result<Option<User>> {
        let row = sqlx::query("SELECT * FROM users WHERE email = $1")
            .bind(email)
            .fetch_optional(&self.pool)
            .await?;
        row.as_ref().map(user_from_row).transpose()
    }

    async fn set_default_agent(&self, user_id: Uuid, agent_id: Option<&str>) -> Result<User> {
        sqlx::query("UPDATE users SET default_agent_id = $1, updated_at = NOW() WHERE id = $2")
            .bind(agent_id)
            .bind(user_id)
            .execute(&self.pool)
            .await?;

        self.find_by_id(user_id)
            .await?
            .context("user not found after update")
    }
}

#[async_trait]
impl ClaimRepository for PostgresStore {
    async fn create_code(
        &self,
        agent_id: Uuid,
        code: &str,
        expires_at: DateTime<Utc>,
    ) -> Result<ClaimCode> {
        let id = Uuid::new_v4();
        let row = sqlx::query(
            "INSERT INTO claim_codes \
             (id, agent_id, code, expires_at, created_at) \
             VALUES ($1,$2,$3,$4,NOW()) RETURNING *",
        )
        .bind(id)
        .bind(agent_id)
        .bind(code)
        .bind(expires_at)
        .fetch_one(&self.pool)
        .await?;
        claim_from_row(&row)
    }

    async fn find_code(&self, code: &str) -> Result<Option<ClaimCode>> {
        let row = sqlx::query(
            "SELECT * FROM claim_codes \
             WHERE code = $1 \
             AND used_at IS NULL \
             AND expires_at > NOW()",
        )
        .bind(code)
        .fetch_optional(&self.pool)
        .await?;
        row.as_ref().map(claim_from_row).transpose()
    }

    async fn redeem_code(&self, code: &str, user_id: Uuid) -> Result<ClaimCode> {
        let row = sqlx::query(
            "UPDATE claim_codes SET \
             used_at = NOW(), used_by = $1 \
             WHERE code = $2 \
             AND used_at IS NULL \
             AND expires_at > NOW() \
             RETURNING *",
        )
        .bind(user_id)
        .bind(code)
        .fetch_one(&self.pool)
        .await
        .context("Claim code not found or expired")?;
        claim_from_row(&row)
    }

    async fn invalidate_expired(&self) -> Result<u64> {
        let r = sqlx::query(
            "DELETE FROM claim_codes \
             WHERE expires_at <= NOW() \
             AND used_at IS NULL",
        )
        .execute(&self.pool)
        .await?;
        Ok(r.rows_affected())
    }
}

#[async_trait]
impl ConnectionRepository for PostgresStore {
    async fn create(&self, conn: NewConnection) -> Result<Connection> {
        let id = Uuid::new_v4();
        let row = sqlx::query(
            "INSERT INTO connections \
             (id, agent_a, agent_b, status, \
              initiated_by, created_at, updated_at) \
             VALUES ($1,$2,$3,'pending',$4,NOW(),NOW()) \
             RETURNING *",
        )
        .bind(id)
        .bind(conn.agent_a)
        .bind(conn.agent_b)
        .bind(&conn.initiated_by)
        .fetch_one(&self.pool)
        .await?;
        connection_from_row(&row)
    }

    async fn find_by_agents(&self, a: Uuid, b: Uuid) -> Result<Option<Connection>> {
        let row = sqlx::query(
            "SELECT * FROM connections \
             WHERE (agent_a=$1 AND agent_b=$2) \
             OR (agent_a=$2 AND agent_b=$1) \
             LIMIT 1",
        )
        .bind(a)
        .bind(b)
        .fetch_optional(&self.pool)
        .await?;
        row.as_ref().map(connection_from_row).transpose()
    }

    async fn update_status(&self, id: Uuid, status: ConnectionStatus) -> Result<Connection> {
        let row = sqlx::query(
            "UPDATE connections SET \
             status=$1, updated_at=NOW() \
             WHERE id=$2 RETURNING *",
        )
        .bind(connection_status_to_str(&status))
        .bind(id)
        .fetch_one(&self.pool)
        .await?;
        connection_from_row(&row)
    }

    async fn list_for_agent(&self, agent_id: Uuid) -> Result<Vec<Connection>> {
        let rows = sqlx::query(
            "SELECT * FROM connections \
             WHERE agent_a=$1 OR agent_b=$1 \
             ORDER BY created_at DESC",
        )
        .bind(agent_id)
        .fetch_all(&self.pool)
        .await?;
        rows.iter().map(connection_from_row).collect()
    }
}
