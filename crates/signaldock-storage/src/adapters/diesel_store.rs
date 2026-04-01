//! Unified Diesel adapter for SignalDock storage.
//!
//! Uses `diesel-async` with `RunQueryDsl` for async query execution.
//! Backend-agnostic: works with both SQLite (`SyncConnectionWrapper`)
//! and PostgreSQL (`AsyncPgConnection`) via feature flags.
//!
//! Connection pooling via `deadpool`.

use anyhow::{Context, Result};
use async_trait::async_trait;
use diesel::prelude::*;
use diesel_async::pooled_connection::AsyncDieselConnectionManager;
use diesel_async::pooled_connection::deadpool::Pool;
use diesel_async::{AsyncConnection, RunQueryDsl};
use uuid::Uuid;

use signaldock_protocol::agent::{Agent, AgentUpdate, NewAgent};

use crate::models::*;
use crate::schema::*;
use crate::traits::AgentRepository;
use crate::types::{AgentQuery, OnlineAgent, Page, StatsDelta};

use super::diesel_helpers::*;

/// Backend-agnostic Diesel storage adapter.
///
/// Generic over `C: AsyncConnection` — instantiate with:
/// - `SyncConnectionWrapper<SqliteConnection>` for SQLite
/// - `AsyncPgConnection` for PostgreSQL
/// The struct requires the full deadpool `Manager` bound set so that
/// `Pool<C>` is a valid type. These bounds are automatically satisfied
/// by `SyncConnectionWrapper<SqliteConnection>` and `AsyncPgConnection`.
pub struct DieselStore<C>
where
    C: AsyncConnection + diesel_async::pooled_connection::PoolableConnection + Send + 'static,
    diesel::query_builder::SqlQuery:
        diesel::query_builder::QueryFragment<<C as diesel_async::AsyncConnectionCore>::Backend>,
    diesel::dsl::select<diesel::dsl::AsExprOf<i32, diesel::sql_types::Integer>>:
        diesel_async::methods::ExecuteDsl<C>,
{
    pub(crate) pool: Pool<C>,
}

// Manual Clone impl to avoid requiring all bounds in the derive.
impl<C> Clone for DieselStore<C>
where
    C: AsyncConnection + diesel_async::pooled_connection::PoolableConnection + Send + 'static,
    diesel::query_builder::SqlQuery:
        diesel::query_builder::QueryFragment<<C as diesel_async::AsyncConnectionCore>::Backend>,
    diesel::dsl::select<diesel::dsl::AsExprOf<i32, diesel::sql_types::Integer>>:
        diesel_async::methods::ExecuteDsl<C>,
{
    fn clone(&self) -> Self {
        Self {
            pool: self.pool.clone(),
        }
    }
}

// ── SQLite constructor ──────────────────────────────────────────
#[cfg(feature = "sqlite")]
impl DieselStore<SqliteConn> {
    /// Connect to SQLite and run embedded migrations.
    ///
    /// # Errors
    ///
    /// Returns an error if the pool cannot be built or migrations fail.
    pub async fn sqlite(database_url: &str) -> Result<Self> {
        use diesel::connection::SimpleConnection;

        // Build connection manager with a post_create hook that sets
        // PRAGMAs on EVERY new connection (not just the first).
        // Without this, pooled connections miss WAL mode and busy_timeout,
        // causing "database is locked" under concurrent writes.
        let manager = AsyncDieselConnectionManager::<SqliteConn>::new(database_url);
        let pool = Pool::builder(manager)
            .post_create(deadpool::managed::Hook::async_fn(
                |conn: &mut SqliteConn, _| {
                    Box::pin(async move {
                        conn.spawn_blocking(|c: &mut diesel::SqliteConnection| {
                            c.batch_execute(
                                "PRAGMA journal_mode=WAL;\
                                     PRAGMA foreign_keys=ON;\
                                     PRAGMA busy_timeout=5000;\
                                     PRAGMA synchronous=NORMAL;",
                            )
                            .map_err(|_| {
                                deadpool::managed::HookError::message("PRAGMA setup failed")
                            })
                        })
                        .await
                        .map_err(|_| {
                            deadpool::managed::HookError::message("spawn_blocking failed")
                        })?;
                        Ok(())
                    })
                },
            ))
            .build()
            .map_err(|e| anyhow::anyhow!("Failed to build SQLite pool: {e}"))?;

        // Run migrations on the first checkout
        let mut conn = pool
            .get()
            .await
            .map_err(|e| anyhow::anyhow!("Pool get: {e}"))?;
        conn.spawn_blocking(|conn| {
            use diesel_migrations::{EmbeddedMigrations, MigrationHarness, embed_migrations};
            const MIGRATIONS: EmbeddedMigrations = embed_migrations!("src/migrations/sqlite");
            conn.run_pending_migrations(MIGRATIONS)
                .map_err(|e| diesel::result::Error::QueryBuilderError(e.into()))?;
            Ok::<_, diesel::result::Error>(())
        })
        .await
        .map_err(|e| anyhow::anyhow!("Migration error: {e}"))?;

        Ok(Self { pool })
    }
}

// ── PostgreSQL constructor ──────────────────────────────────────
#[cfg(feature = "postgres")]
impl DieselStore<PgConn> {
    /// Connect to PostgreSQL with deadpool and run embedded migrations.
    ///
    /// # Errors
    ///
    /// Returns an error if the pool cannot be built or migrations fail.
    pub async fn postgres(database_url: &str) -> Result<Self> {
        let config = AsyncDieselConnectionManager::<PgConn>::new(database_url);
        let pool = Pool::builder(config)
            .build()
            .map_err(|e| anyhow::anyhow!("Failed to build Postgres pool: {e}"))?;

        // Run embedded PostgreSQL migrations
        {
            use diesel::Connection;
            use diesel_migrations::{EmbeddedMigrations, MigrationHarness, embed_migrations};
            const PG_MIGRATIONS: EmbeddedMigrations = embed_migrations!("src/migrations/postgres");
            let mut sync_conn = diesel::PgConnection::establish(database_url)
                .map_err(|e| anyhow::anyhow!("PG sync connect for migrations: {e}"))?;
            sync_conn
                .run_pending_migrations(PG_MIGRATIONS)
                .map_err(|e| anyhow::anyhow!("PG migration error: {e}"))?;
        }

        // Verify async pool connectivity
        let _conn = pool
            .get()
            .await
            .map_err(|e| anyhow::anyhow!("PG pool connect: {e}"))?;

        Ok(Self { pool })
    }
}

impl<C> DieselStore<C>
where
    C: AsyncConnection + diesel_async::pooled_connection::PoolableConnection + Send + 'static,
    diesel::query_builder::SqlQuery:
        diesel::query_builder::QueryFragment<<C as diesel_async::AsyncConnectionCore>::Backend>,
    diesel::dsl::select<diesel::dsl::AsExprOf<i32, diesel::sql_types::Integer>>:
        diesel_async::methods::ExecuteDsl<C>,
{
    /// Returns a reference to the connection pool.
    pub fn pool(&self) -> &Pool<C> {
        &self.pool
    }
}

// ============================================================================
// AgentRepository — macro-generated for each backend
// ============================================================================

/// Generates `AgentRepository` impl for a concrete connection type.
macro_rules! impl_agent_repository {
    ($conn:ty) => {
        #[async_trait]
        impl AgentRepository for DieselStore<$conn> {
            async fn find_by_agent_id(&self, aid: &str) -> Result<Option<Agent>> {
                let mut conn = self.pool.get().await.map_err(pool_err)?;
                let row: Option<AgentRow> = agents::table
                    .filter(agents::agent_id.eq(aid))
                    .first(&mut conn)
                    .await
                    .optional()
                    .map_err(diesel_err)?;
                Ok(row.map(agent_from_row))
            }

            async fn find_by_id(&self, id: Uuid) -> Result<Option<Agent>> {
                let mut conn = self.pool.get().await.map_err(pool_err)?;
                let row: Option<AgentRow> = agents::table
                    .find(id.to_string())
                    .first(&mut conn)
                    .await
                    .optional()
                    .map_err(diesel_err)?;
                Ok(row.map(agent_from_row))
            }

            async fn create(&self, agent: NewAgent) -> Result<Agent> {
                let id = Uuid::new_v4();
                let now = now_ts();
                let new_row = NewAgentRow {
                    id: id.to_string(),
                    agent_id: agent.agent_id.clone(),
                    name: agent.name.clone(),
                    description: agent.description.clone(),
                    class: serialize_enum(&agent.class),
                    privacy_tier: serialize_enum(&agent.privacy_tier),
                    owner_id: None,
                    endpoint: agent.endpoint.clone(),
                    webhook_secret: agent.webhook_secret.clone(),
                    capabilities: serde_json::to_string(&agent.capabilities)?,
                    skills: serde_json::to_string(&agent.skills)?,
                    avatar: agent.avatar.clone(),
                    messages_sent: 0,
                    messages_received: 0,
                    conversation_count: 0,
                    friend_count: 0,
                    status: "online".to_string(),
                    last_seen: Some(now),
                    payment_config: agent
                        .payment_config
                        .as_ref()
                        .map(serde_json::to_string)
                        .transpose()?,
                    api_key_hash: None,
                    organization_id: None,
                    transport_type: "http".to_string(),
                    api_key_encrypted: None,
                    api_base_url: "https://api.signaldock.io".to_string(),
                    classification: None,
                    transport_config: "{}".to_string(),
                    is_active: true,
                    last_used_at: Some(now),
                    created_at: now,
                    updated_at: now,
                };

                let mut conn = self.pool.get().await.map_err(pool_err)?;
                diesel::insert_into(agents::table)
                    .values(&new_row)
                    .execute(&mut conn)
                    .await
                    .map_err(diesel_err)?;

                AgentRepository::find_by_id(self, id)
                    .await?
                    .context("agent not found after insert")
            }

            async fn update(&self, id: Uuid, update: AgentUpdate) -> Result<Agent> {
                let existing = AgentRepository::find_by_id(self, id)
                    .await?
                    .context("agent not found")?;
                let now = now_ts();

                let changeset = UpdateAgentRow {
                    name: Some(update.name.unwrap_or(existing.name)),
                    description: Some(update.description.or(existing.description)),
                    class: Some(serialize_enum(&update.class.unwrap_or(existing.class))),
                    privacy_tier: Some(serialize_enum(
                        &update.privacy_tier.unwrap_or(existing.privacy_tier),
                    )),
                    endpoint: Some(update.endpoint.or(existing.endpoint)),
                    webhook_secret: Some(update.webhook_secret.or(existing.webhook_secret)),
                    capabilities: Some(serde_json::to_string(
                        &update.capabilities.unwrap_or(existing.capabilities),
                    )?),
                    skills: Some(serde_json::to_string(
                        &update.skills.unwrap_or(existing.skills),
                    )?),
                    avatar: Some(update.avatar.or(existing.avatar)),
                    status: Some(serialize_enum(&update.status.unwrap_or(existing.status))),
                    payment_config: Some(
                        update
                            .payment_config
                            .or(existing.payment_config)
                            .as_ref()
                            .map(serde_json::to_string)
                            .transpose()?,
                    ),
                    api_key_hash: Some(update.api_key_hash.or(existing.api_key_hash)),
                    organization_id: Some(update.organization_id.or(existing.organization_id)),
                    updated_at: Some(now),
                    ..Default::default()
                };

                let mut conn = self.pool.get().await.map_err(pool_err)?;
                diesel::update(agents::table.find(id.to_string()))
                    .set(&changeset)
                    .execute(&mut conn)
                    .await
                    .map_err(diesel_err)?;

                AgentRepository::find_by_id(self, id)
                    .await?
                    .context("agent not found after update")
            }

            async fn delete(&self, id: Uuid) -> Result<()> {
                let mut conn = self.pool.get().await.map_err(pool_err)?;
                diesel::delete(agents::table.find(id.to_string()))
                    .execute(&mut conn)
                    .await
                    .map_err(diesel_err)?;
                Ok(())
            }

            async fn list(&self, query: AgentQuery) -> Result<Page<Agent>> {
                let mut conn = self.pool.get().await.map_err(pool_err)?;

                // Build filtered query (shared between count and fetch)
                let mut boxed = agents::table.into_boxed();

                if let Some(ref search) = query.search {
                    let pattern = format!("%{search}%");
                    boxed = boxed.filter(
                        agents::name
                            .like(pattern.clone())
                            .or(agents::agent_id.like(pattern.clone()))
                            .or(agents::description.like(pattern)),
                    );
                }
                if let Some(ref class) = query.class {
                    boxed = boxed.filter(agents::class.eq(serialize_enum(class)));
                }
                if let Some(ref tier) = query.privacy_tier {
                    boxed = boxed.filter(agents::privacy_tier.eq(serialize_enum(tier)));
                }
                if let Some(ref status) = query.status {
                    boxed = boxed.filter(agents::status.eq(serialize_enum(status)));
                }
                if let Some(ref owner) = query.owner_id {
                    boxed = boxed.filter(agents::owner_id.eq(owner.to_string()));
                }
                // Capability/skill filters use JSON LIKE on the serialized arrays.
                // Junction table joins are complex in boxed queries; LIKE on the
                // JSON column is simple and correct for moderate dataset sizes.
                if let Some(ref cap) = query.capability {
                    let pattern = format!("%\"{cap}\"%");
                    boxed = boxed.filter(agents::capabilities.like(pattern));
                }
                if let Some(ref skill) = query.skill {
                    let pattern = format!("%\"{skill}\"%");
                    boxed = boxed.filter(agents::skills.like(pattern));
                }

                // Count total matching the filters (not global count)
                // Re-run the same filters on a separate count query since
                // Diesel's boxed queries can't be cloned.
                let total: i64 = {
                    let mut count_q = agents::table.into_boxed();
                    if let Some(ref search) = query.search {
                        let p = format!("%{search}%");
                        count_q = count_q.filter(
                            agents::name
                                .like(p.clone())
                                .or(agents::agent_id.like(p.clone()))
                                .or(agents::description.like(p)),
                        );
                    }
                    if let Some(ref class) = query.class {
                        count_q = count_q.filter(agents::class.eq(serialize_enum(class)));
                    }
                    if let Some(ref tier) = query.privacy_tier {
                        count_q = count_q.filter(agents::privacy_tier.eq(serialize_enum(tier)));
                    }
                    if let Some(ref status) = query.status {
                        count_q = count_q.filter(agents::status.eq(serialize_enum(status)));
                    }
                    if let Some(ref owner) = query.owner_id {
                        count_q = count_q.filter(agents::owner_id.eq(owner.to_string()));
                    }
                    if let Some(ref cap) = query.capability {
                        let p = format!("%\"{cap}\"%");
                        count_q = count_q.filter(agents::capabilities.like(p));
                    }
                    if let Some(ref skill) = query.skill {
                        let p = format!("%\"{skill}\"%");
                        count_q = count_q.filter(agents::skills.like(p));
                    }
                    count_q
                        .count()
                        .get_result(&mut conn)
                        .await
                        .map_err(diesel_err)?
                };

                // Apply sort + pagination to the filtered query
                match query.sort {
                    crate::types::AgentSortField::Messages => {
                        boxed = boxed.order(agents::messages_sent.desc());
                    }
                    crate::types::AgentSortField::LastSeen => {
                        boxed = boxed.order(agents::last_seen.desc());
                    }
                    crate::types::AgentSortField::Created => {
                        boxed = boxed.order(agents::created_at.desc());
                    }
                }

                let rows: Vec<AgentRow> = boxed
                    .limit(query.limit as i64)
                    .offset(query.offset() as i64)
                    .load(&mut conn)
                    .await
                    .map_err(diesel_err)?;

                let agents_list = rows.into_iter().map(agent_from_row).collect();
                Ok(Page::new(
                    agents_list,
                    total as u64,
                    query.page,
                    query.limit,
                ))
            }

            async fn increment_stats(&self, id: Uuid, delta: StatsDelta) -> Result<()> {
                let now = now_ts();
                let mut conn = self.pool.get().await.map_err(pool_err)?;
                diesel::update(agents::table.find(id.to_string()))
                    .set((
                        agents::messages_sent
                            .eq(agents::messages_sent + delta.messages_sent as i32),
                        agents::messages_received
                            .eq(agents::messages_received + delta.messages_received as i32),
                        agents::conversation_count
                            .eq(agents::conversation_count + delta.conversation_count as i32),
                        agents::friend_count.eq(agents::friend_count + delta.friend_count as i32),
                        agents::updated_at.eq(now),
                    ))
                    .execute(&mut conn)
                    .await
                    .map_err(diesel_err)?;
                Ok(())
            }

            async fn set_owner(&self, id: Uuid, owner_id: Uuid) -> Result<Agent> {
                let now = now_ts();
                let mut conn = self.pool.get().await.map_err(pool_err)?;
                diesel::update(agents::table.find(id.to_string()))
                    .set((
                        agents::owner_id.eq(Some(owner_id.to_string())),
                        agents::updated_at.eq(now),
                    ))
                    .execute(&mut conn)
                    .await
                    .map_err(diesel_err)?;
                AgentRepository::find_by_id(self, id)
                    .await?
                    .context("agent not found after set_owner")
            }

            async fn update_last_seen(&self, id: Uuid) -> Result<()> {
                let now = now_ts();
                let mut conn = self.pool.get().await.map_err(pool_err)?;
                diesel::update(agents::table.find(id.to_string()))
                    .set((agents::last_seen.eq(Some(now)), agents::updated_at.eq(now)))
                    .execute(&mut conn)
                    .await
                    .map_err(diesel_err)?;
                Ok(())
            }

            async fn list_online(&self, threshold_epoch: i64) -> Result<Vec<OnlineAgent>> {
                let mut conn = self.pool.get().await.map_err(pool_err)?;
                let rows: Vec<(String, String, Option<i64>)> = agents::table
                    .filter(agents::status.ne("offline"))
                    .filter(agents::last_seen.gt(threshold_epoch))
                    .select((agents::agent_id, agents::status, agents::last_seen))
                    .order(agents::last_seen.desc())
                    .load(&mut conn)
                    .await
                    .map_err(diesel_err)?;

                Ok(rows
                    .into_iter()
                    .map(|(agent_id, status, last_seen)| OnlineAgent {
                        agent_id,
                        status,
                        last_seen: last_seen.unwrap_or(0),
                    })
                    .collect())
            }
        }
    };
}

#[cfg(feature = "sqlite")]
impl_agent_repository!(SqliteConn);

#[cfg(feature = "postgres")]
impl_agent_repository!(PgConn);

// ============================================================================
// Platform count queries — macro-generated for each backend
// ============================================================================

/// Generates platform count helper methods for a concrete connection type.
macro_rules! impl_platform_counts {
    ($conn:ty) => {
        impl DieselStore<$conn> {
            /// Count all rows in the agents table.
            pub async fn count_agents(&self) -> Result<i64> {
                let mut conn = self.pool.get().await.map_err(pool_err)?;
                agents::table
                    .count()
                    .get_result(&mut conn)
                    .await
                    .map_err(diesel_err)
            }

            /// Count agents claimed by a user (owner_id IS NOT NULL).
            pub async fn count_claimed_agents(&self) -> Result<i64> {
                let mut conn = self.pool.get().await.map_err(pool_err)?;
                agents::table
                    .filter(agents::owner_id.is_not_null())
                    .count()
                    .get_result(&mut conn)
                    .await
                    .map_err(diesel_err)
            }

            /// Count agents active within a time window (last_seen > cutoff).
            pub async fn count_active_agents(&self, cutoff_epoch: i64) -> Result<i64> {
                let mut conn = self.pool.get().await.map_err(pool_err)?;
                agents::table
                    .filter(agents::last_seen.gt(cutoff_epoch))
                    .count()
                    .get_result(&mut conn)
                    .await
                    .map_err(diesel_err)
            }

            /// Count all rows in the messages table.
            pub async fn count_messages(&self) -> Result<i64> {
                let mut conn = self.pool.get().await.map_err(pool_err)?;
                messages::table
                    .count()
                    .get_result(&mut conn)
                    .await
                    .map_err(diesel_err)
            }

            /// Count all rows in the conversations table.
            pub async fn count_conversations(&self) -> Result<i64> {
                let mut conn = self.pool.get().await.map_err(pool_err)?;
                conversations::table
                    .count()
                    .get_result(&mut conn)
                    .await
                    .map_err(diesel_err)
            }

            /// Count conversations with a specific visibility.
            pub async fn count_conversations_by_visibility(&self, visibility: &str) -> Result<i64> {
                let mut conn = self.pool.get().await.map_err(pool_err)?;
                conversations::table
                    .filter(conversations::visibility.eq(visibility))
                    .count()
                    .get_result(&mut conn)
                    .await
                    .map_err(diesel_err)
            }

            /// Count all rows in the users table.
            pub async fn count_users(&self) -> Result<i64> {
                let mut conn = self.pool.get().await.map_err(pool_err)?;
                users::table
                    .count()
                    .get_result(&mut conn)
                    .await
                    .map_err(diesel_err)
            }

            /// Count online agents (status = 'online').
            pub async fn count_online_agents(&self) -> Result<i64> {
                let mut conn = self.pool.get().await.map_err(pool_err)?;
                agents::table
                    .filter(agents::status.eq("online"))
                    .count()
                    .get_result(&mut conn)
                    .await
                    .map_err(diesel_err)
            }
        }
    };
}

#[cfg(feature = "sqlite")]
impl_platform_counts!(SqliteConn);

#[cfg(feature = "postgres")]
impl_platform_counts!(PgConn);

// ============================================================================
// Placeholder impls for remaining traits — will be filled in next files
// ============================================================================

// MessageRepository, ConversationRepository, UserRepository,
// ClaimRepository, ConnectionRepository, DeliveryJobRepository
// implementations follow the same pattern as AgentRepository above.
// Each uses diesel DSL with RunQueryDsl .await on the pooled connection.
//
// These are split into separate files to stay under the 800-line limit:
// - diesel_messages.rs
// - diesel_conversations.rs
// - diesel_others.rs (User, Claim, Connection)
// - diesel_jobs.rs (DeliveryJob)
// - diesel_connections_agent.rs (AgentConnection)
