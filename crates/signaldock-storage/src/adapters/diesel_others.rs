//! [`UserRepository`], [`ClaimRepository`], and [`ConnectionRepository`]
//! implementations for [`DieselStore`].
//!
//! Grouped in a single file because each trait is small (2-4 methods).

use anyhow::{Context, Result};
use async_trait::async_trait;
use chrono::{DateTime, Utc};
use diesel::prelude::*;
use diesel_async::RunQueryDsl;
use uuid::Uuid;

use signaldock_protocol::claim::ClaimCode;
use signaldock_protocol::connection::{Connection, ConnectionStatus, NewConnection};
use signaldock_protocol::user::User;

use super::diesel_helpers::*;
use super::diesel_store::DieselStore;
use crate::models::*;
use crate::schema::*;
use crate::traits::{ClaimRepository, ConnectionRepository, UserRepository};

// ============================================================================
// UserRepository — macro-generated for each backend
// ============================================================================

macro_rules! impl_user_repository {
    ($conn:ty) => {
        #[async_trait]
        impl UserRepository for DieselStore<$conn> {
            async fn create(
                &self,
                email: &str,
                password_hash: &str,
                name: Option<&str>,
            ) -> Result<User> {
                let id = Uuid::new_v4();
                let now = now_ts();

                let new_row = NewUserRow {
                    id: id.to_string(),
                    email: email.to_string(),
                    password_hash: password_hash.to_string(),
                    name: name.map(String::from),
                    slug: None,
                    default_agent_id: None,
                    username: None,
                    display_username: None,
                    email_verified: false,
                    image: None,
                    role: "user".to_string(),
                    banned: false,
                    ban_reason: None,
                    ban_expires: None,
                    two_factor_enabled: false,
                    metadata: None,
                    created_at: now,
                    updated_at: now,
                };

                let mut conn = self.pool.get().await.map_err(pool_err)?;
                diesel::insert_into(users::table)
                    .values(&new_row)
                    .execute(&mut conn)
                    .await
                    .map_err(diesel_err)?;

                self.find_by_id(id)
                    .await?
                    .context("user not found after insert")
            }

            async fn find_by_id(&self, id: Uuid) -> Result<Option<User>> {
                let mut conn = self.pool.get().await.map_err(pool_err)?;
                let row: Option<UserRow> = users::table
                    .find(id.to_string())
                    .first(&mut conn)
                    .await
                    .optional()
                    .map_err(diesel_err)?;
                Ok(row.map(user_from_row))
            }

            async fn find_by_email(&self, email: &str) -> Result<Option<User>> {
                let mut conn = self.pool.get().await.map_err(pool_err)?;
                let row: Option<UserRow> = users::table
                    .filter(users::email.eq(email))
                    .first(&mut conn)
                    .await
                    .optional()
                    .map_err(diesel_err)?;
                Ok(row.map(user_from_row))
            }

            async fn set_default_agent(
                &self,
                user_id: Uuid,
                agent_id: Option<&str>,
            ) -> Result<User> {
                let now = now_ts();
                let mut conn = self.pool.get().await.map_err(pool_err)?;
                diesel::update(users::table.find(user_id.to_string()))
                    .set((
                        users::default_agent_id.eq(agent_id.map(String::from)),
                        users::updated_at.eq(now),
                    ))
                    .execute(&mut conn)
                    .await
                    .map_err(diesel_err)?;

                self.find_by_id(user_id)
                    .await?
                    .context("user not found after update")
            }
        }
    };
}

#[cfg(feature = "sqlite")]
impl_user_repository!(SqliteConn);

#[cfg(feature = "postgres")]
impl_user_repository!(PgConn);

// ============================================================================
// ClaimRepository — macro-generated for each backend
// ============================================================================

macro_rules! impl_claim_repository {
    ($conn:ty) => {
        #[async_trait]
        impl ClaimRepository for DieselStore<$conn> {
            async fn create_code(
                &self,
                agent_id: Uuid,
                code: &str,
                expires_at: DateTime<Utc>,
            ) -> Result<ClaimCode> {
                let id = Uuid::new_v4();
                let now = now_ts();
                let expires_ts = expires_at.timestamp();

                let new_row = NewClaimCodeRow {
                    id: id.to_string(),
                    agent_id: agent_id.to_string(),
                    code: code.to_string(),
                    expires_at: expires_ts,
                    used_at: None,
                    used_by: None,
                    created_at: now,
                };

                let mut conn = self.pool.get().await.map_err(pool_err)?;
                diesel::insert_into(claim_codes::table)
                    .values(&new_row)
                    .execute(&mut conn)
                    .await
                    .map_err(diesel_err)?;

                self.find_code(code)
                    .await?
                    .context("claim code not found after insert")
            }

            async fn find_code(&self, code: &str) -> Result<Option<ClaimCode>> {
                let mut conn = self.pool.get().await.map_err(pool_err)?;
                let row: Option<ClaimCodeRow> = claim_codes::table
                    .filter(claim_codes::code.eq(code))
                    .first(&mut conn)
                    .await
                    .optional()
                    .map_err(diesel_err)?;
                Ok(row.map(claim_from_row))
            }

            async fn redeem_code(&self, code: &str, user_id: Uuid) -> Result<ClaimCode> {
                let now = now_ts();
                let mut conn = self.pool.get().await.map_err(pool_err)?;
                diesel::update(
                    claim_codes::table
                        .filter(claim_codes::code.eq(code))
                        .filter(claim_codes::used_at.is_null()),
                )
                .set((
                    claim_codes::used_at.eq(Some(now)),
                    claim_codes::used_by.eq(Some(user_id.to_string())),
                ))
                .execute(&mut conn)
                .await
                .map_err(diesel_err)?;

                self.find_code(code)
                    .await?
                    .context("claim code not found after redeem")
            }

            async fn invalidate_expired(&self) -> Result<u64> {
                let now = now_ts();
                let mut conn = self.pool.get().await.map_err(pool_err)?;
                let deleted = diesel::delete(
                    claim_codes::table
                        .filter(claim_codes::expires_at.lt(now))
                        .filter(claim_codes::used_at.is_null()),
                )
                .execute(&mut conn)
                .await
                .map_err(diesel_err)?;
                Ok(deleted as u64)
            }
        }
    };
}

#[cfg(feature = "sqlite")]
impl_claim_repository!(SqliteConn);

#[cfg(feature = "postgres")]
impl_claim_repository!(PgConn);

// ============================================================================
// ConnectionRepository — macro-generated for each backend
// ============================================================================

macro_rules! impl_connection_repository {
    ($conn:ty) => {
        #[async_trait]
        impl ConnectionRepository for DieselStore<$conn> {
            async fn create(&self, conn_req: NewConnection) -> Result<Connection> {
                let id = Uuid::new_v4();
                let now = now_ts();

                let new_row = NewConnectionRow {
                    id: id.to_string(),
                    agent_a: conn_req.agent_a.to_string(),
                    agent_b: conn_req.agent_b.to_string(),
                    status: "pending".to_string(),
                    initiated_by: conn_req.initiated_by.to_string(),
                    created_at: now,
                    updated_at: now,
                };

                let mut conn = self.pool.get().await.map_err(pool_err)?;
                diesel::insert_into(connections::table)
                    .values(&new_row)
                    .execute(&mut conn)
                    .await
                    .map_err(diesel_err)?;

                let row: ConnectionRow = connections::table
                    .find(id.to_string())
                    .first(&mut conn)
                    .await
                    .map_err(diesel_err)?;
                Ok(connection_from_row(row))
            }

            async fn find_by_agents(
                &self,
                agent_a: Uuid,
                agent_b: Uuid,
            ) -> Result<Option<Connection>> {
                let a = agent_a.to_string();
                let b = agent_b.to_string();
                let mut conn = self.pool.get().await.map_err(pool_err)?;

                let row: Option<ConnectionRow> = connections::table
                    .filter(
                        connections::agent_a
                            .eq(&a)
                            .and(connections::agent_b.eq(&b))
                            .or(connections::agent_a.eq(&b).and(connections::agent_b.eq(&a))),
                    )
                    .first(&mut conn)
                    .await
                    .optional()
                    .map_err(diesel_err)?;

                Ok(row.map(connection_from_row))
            }

            async fn update_status(
                &self,
                id: Uuid,
                status: ConnectionStatus,
            ) -> Result<Connection> {
                let now = now_ts();
                let status_str = serialize_enum(&status);
                let mut conn = self.pool.get().await.map_err(pool_err)?;
                diesel::update(connections::table.find(id.to_string()))
                    .set((
                        connections::status.eq(&status_str),
                        connections::updated_at.eq(now),
                    ))
                    .execute(&mut conn)
                    .await
                    .map_err(diesel_err)?;

                let row: ConnectionRow = connections::table
                    .find(id.to_string())
                    .first(&mut conn)
                    .await
                    .map_err(diesel_err)?;
                Ok(connection_from_row(row))
            }

            async fn list_for_agent(&self, agent_id: Uuid) -> Result<Vec<Connection>> {
                let id_str = agent_id.to_string();
                let mut conn = self.pool.get().await.map_err(pool_err)?;
                let rows: Vec<ConnectionRow> = connections::table
                    .filter(
                        connections::agent_a
                            .eq(&id_str)
                            .or(connections::agent_b.eq(&id_str)),
                    )
                    .order(connections::created_at.desc())
                    .load(&mut conn)
                    .await
                    .map_err(diesel_err)?;
                Ok(rows.into_iter().map(connection_from_row).collect())
            }
        }
    };
}

#[cfg(feature = "sqlite")]
impl_connection_repository!(SqliteConn);

#[cfg(feature = "postgres")]
impl_connection_repository!(PgConn);
