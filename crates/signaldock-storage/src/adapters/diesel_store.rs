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
use crate::types::{AgentQuery, Page, StatsDelta};

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
impl
    DieselStore<
        diesel_async::sync_connection_wrapper::SyncConnectionWrapper<diesel::SqliteConnection>,
    >
{
    /// Connect to SQLite and run embedded migrations.
    ///
    /// # Errors
    ///
    /// Returns an error if the pool cannot be built or migrations fail.
    pub async fn sqlite(database_url: &str) -> Result<Self> {
        use diesel::connection::SimpleConnection;
        use diesel_async::sync_connection_wrapper::SyncConnectionWrapper;

        type SqliteConn = SyncConnectionWrapper<diesel::SqliteConnection>;
        let config = AsyncDieselConnectionManager::<SqliteConn>::new(database_url);
        let pool = Pool::builder(config)
            .build()
            .map_err(|e| anyhow::anyhow!("Failed to build SQLite pool: {e}"))?;

        // Run migrations and set PRAGMAs on a checkout
        let mut conn = pool
            .get()
            .await
            .map_err(|e| anyhow::anyhow!("Pool get: {e}"))?;
        conn.spawn_blocking(|conn| {
            conn.batch_execute(
                "PRAGMA journal_mode=WAL;\
                 PRAGMA foreign_keys=ON;\
                 PRAGMA busy_timeout=5000;",
            )?;
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
impl DieselStore<diesel_async::AsyncPgConnection> {
    /// Connect to PostgreSQL with deadpool.
    ///
    /// # Errors
    ///
    /// Returns an error if the pool cannot be built.
    pub async fn postgres(database_url: &str) -> Result<Self> {
        let config =
            AsyncDieselConnectionManager::<diesel_async::AsyncPgConnection>::new(database_url);
        let pool = Pool::builder(config)
            .build()
            .map_err(|e| anyhow::anyhow!("Failed to build Postgres pool: {e}"))?;

        // Verify connectivity
        let _conn = pool
            .get()
            .await
            .map_err(|e| anyhow::anyhow!("PG connect: {e}"))?;

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
// AgentRepository
// ============================================================================

#[async_trait]
impl<C> AgentRepository for DieselStore<C>
where
    C: AsyncConnection + 'static,
    C: diesel_async::AsyncConnection<Backend = diesel::sqlite::Sqlite>,
    C: diesel_async::pooled_connection::PoolableConnection,
{
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
        // For complex dynamic queries with multiple optional filters,
        // use raw SQL via diesel::sql_query to maintain the existing
        // dynamic WHERE clause building pattern.
        let mut conn = self.pool.get().await.map_err(pool_err)?;

        // Simple case: fetch all with ordering + pagination
        let order_col = match query.sort {
            crate::types::AgentSortField::Messages => "messages_sent",
            crate::types::AgentSortField::LastSeen => "last_seen",
            crate::types::AgentSortField::Created => "created_at",
        };

        // Count total
        let total: i64 = agents::table
            .count()
            .get_result(&mut conn)
            .await
            .map_err(diesel_err)?;

        // Fetch page — use diesel sql_query for dynamic ordering
        let sql = format!(
            "SELECT * FROM agents ORDER BY {} DESC LIMIT {} OFFSET {}",
            order_col,
            query.limit,
            query.offset()
        );
        let rows: Vec<AgentRow> = diesel::sql_query(sql)
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
                agents::messages_sent.eq(agents::messages_sent + delta.messages_sent as i32),
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
}

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
