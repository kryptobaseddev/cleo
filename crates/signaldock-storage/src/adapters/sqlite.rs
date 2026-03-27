use anyhow::{Context, Result};
use async_trait::async_trait;
use sqlx::SqlitePool;
use uuid::Uuid;

use signaldock_protocol::agent::{Agent, AgentUpdate, NewAgent};

use super::sqlite_helpers::{now_ts, row_to_agent, serialize_enum};
use crate::traits::AgentRepository;
use crate::types::{AgentQuery, Page, StatsDelta};

/// SQLite-backed storage adapter.
///
/// Wraps a [`SqlitePool`] and implements all repository
/// traits. On construction, WAL mode and foreign keys are
/// enabled and embedded migrations are executed.
#[derive(Clone)]
pub struct SqliteStore {
    pool: SqlitePool,
}

impl SqliteStore {
    /// Connects to the `SQLite` database at `database_url` and
    /// prepares it for use.
    ///
    /// This method:
    /// 1. Opens a connection pool.
    /// 2. Enables WAL journal mode for concurrent reads.
    /// 3. Turns on foreign-key enforcement.
    /// 4. Runs all embedded `SQLite` migrations.
    ///
    /// # Errors
    ///
    /// Returns `anyhow::Error` if the connection, PRAGMA
    /// statements, or migrations fail.
    pub async fn new(database_url: &str) -> Result<Self> {
        let pool = SqlitePool::connect(database_url).await?;
        sqlx::query("PRAGMA journal_mode=WAL;")
            .execute(&pool)
            .await?;
        sqlx::query("PRAGMA foreign_keys=ON;")
            .execute(&pool)
            .await?;
        sqlx::migrate!("src/migrations/sqlite").run(&pool).await?;

        // Ensure FTS5 triggers exist and index is current.
        // Triggers can be lost if the database was restored or copied
        // without them. Re-creating with IF NOT EXISTS is safe.
        sqlx::query(
            "CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN \
                INSERT INTO messages_fts(rowid, content, from_agent_id) \
                VALUES (new.rowid, new.content, new.from_agent_id); \
             END",
        )
        .execute(&pool)
        .await
        .ok();

        // Rebuild the FTS5 index to catch any unindexed messages.
        sqlx::query("INSERT INTO messages_fts(messages_fts) VALUES('rebuild')")
            .execute(&pool)
            .await
            .ok();

        Ok(Self { pool })
    }

    /// Returns a reference to the underlying connection pool.
    pub fn pool(&self) -> &SqlitePool {
        &self.pool
    }
}

#[async_trait]
impl AgentRepository for SqliteStore {
    async fn find_by_agent_id(&self, agent_id: &str) -> Result<Option<Agent>> {
        let row = sqlx::query("SELECT * FROM agents WHERE agent_id = ?")
            .bind(agent_id)
            .fetch_optional(&self.pool)
            .await?;
        row.as_ref().map(row_to_agent).transpose()
    }

    async fn find_by_id(&self, id: Uuid) -> Result<Option<Agent>> {
        let row = sqlx::query("SELECT * FROM agents WHERE id = ?")
            .bind(id.to_string())
            .fetch_optional(&self.pool)
            .await?;
        row.as_ref().map(row_to_agent).transpose()
    }

    async fn create(&self, agent: NewAgent) -> Result<Agent> {
        let id = Uuid::new_v4();
        let now = now_ts();
        let class = serialize_enum(&agent.class);
        let privacy = serialize_enum(&agent.privacy_tier);
        let caps = serde_json::to_string(&agent.capabilities)?;
        let skills = serde_json::to_string(&agent.skills)?;
        let payment_config = agent
            .payment_config
            .as_ref()
            .map(serde_json::to_string)
            .transpose()?;

        sqlx::query(
            "INSERT INTO agents \
             (id, agent_id, name, description, class, \
             privacy_tier, endpoint, webhook_secret, capabilities, skills, \
             avatar, payment_config, status, last_seen, created_at, \
             updated_at) \
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, \
             'online', ?, ?, ?)",
        )
        .bind(id.to_string())
        .bind(&agent.agent_id)
        .bind(&agent.name)
        .bind(&agent.description)
        .bind(&class)
        .bind(&privacy)
        .bind(&agent.endpoint)
        .bind(&agent.webhook_secret)
        .bind(&caps)
        .bind(&skills)
        .bind(&agent.avatar)
        .bind(payment_config)
        .bind(now)
        .bind(now)
        .bind(now)
        .execute(&self.pool)
        .await?;

        AgentRepository::find_by_id(self, id)
            .await?
            .context("agent not found after insert")
    }

    async fn update(&self, id: Uuid, update: AgentUpdate) -> Result<Agent> {
        let existing = AgentRepository::find_by_id(self, id)
            .await?
            .context("agent not found")?;
        let now = now_ts();

        let name = update.name.unwrap_or(existing.name);
        let description = update.description.or(existing.description);
        let class = serialize_enum(&update.class.unwrap_or(existing.class));
        let privacy = serialize_enum(&update.privacy_tier.unwrap_or(existing.privacy_tier));
        let endpoint = update.endpoint.or(existing.endpoint);
        let webhook_secret = update.webhook_secret.or(existing.webhook_secret);
        let caps = serde_json::to_string(&update.capabilities.unwrap_or(existing.capabilities))?;
        let skills = serde_json::to_string(&update.skills.unwrap_or(existing.skills))?;
        let avatar = update.avatar.or(existing.avatar);
        let status = serialize_enum(&update.status.unwrap_or(existing.status));
        let payment_config = update
            .payment_config
            .or(existing.payment_config)
            .as_ref()
            .map(serde_json::to_string)
            .transpose()?;
        let api_key_hash = update.api_key_hash.or(existing.api_key_hash);
        let organization_id = update.organization_id.or(existing.organization_id);

        sqlx::query(
            "UPDATE agents SET name = ?, description = ?, \
             class = ?, privacy_tier = ?, endpoint = ?, \
             webhook_secret = ?, \
             capabilities = ?, skills = ?, avatar = ?, \
             payment_config = ?, status = ?, api_key_hash = ?, \
             organization_id = ?, \
             updated_at = ? WHERE id = ?",
        )
        .bind(&name)
        .bind(&description)
        .bind(&class)
        .bind(&privacy)
        .bind(&endpoint)
        .bind(&webhook_secret)
        .bind(&caps)
        .bind(&skills)
        .bind(&avatar)
        .bind(payment_config)
        .bind(&status)
        .bind(&api_key_hash)
        .bind(&organization_id)
        .bind(now)
        .bind(id.to_string())
        .execute(&self.pool)
        .await?;

        AgentRepository::find_by_id(self, id)
            .await?
            .context("agent not found after update")
    }

    async fn delete(&self, id: Uuid) -> Result<()> {
        sqlx::query("DELETE FROM agents WHERE id = ?")
            .bind(id.to_string())
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    async fn list(&self, query: AgentQuery) -> Result<Page<Agent>> {
        // Build parameterized WHERE clauses to prevent SQL injection.
        // All user-provided values use ? placeholders with bind().
        let mut conditions = Vec::new();
        let mut bind_values: Vec<String> = Vec::new();

        if let Some(ref search) = query.search {
            let pattern = format!("%{search}%");
            conditions.push("(name LIKE ? OR agent_id LIKE ? OR description LIKE ?)".to_string());
            bind_values.push(pattern.clone());
            bind_values.push(pattern.clone());
            bind_values.push(pattern);
        }
        if let Some(ref class) = query.class {
            conditions.push("class = ?".to_string());
            bind_values.push(serialize_enum(class));
        }
        if let Some(ref privacy) = query.privacy_tier {
            conditions.push("privacy_tier = ?".to_string());
            bind_values.push(serialize_enum(privacy));
        }
        if let Some(ref owner_id) = query.owner_id {
            conditions.push("owner_id = ?".to_string());
            bind_values.push(owner_id.to_string());
        }
        if let Some(ref status) = query.status {
            conditions.push("status = ?".to_string());
            bind_values.push(serialize_enum(status));
        }
        if let Some(ref org_id) = query.organization_id {
            conditions.push("organization_id = ?".to_string());
            bind_values.push(org_id.clone());
        }
        if let Some(ref capability) = query.capability {
            // Support comma-separated AND filter: ?capability=chat,tools
            for cap in capability.split(',') {
                let cap = cap.trim();
                if !cap.is_empty() {
                    conditions.push("capabilities LIKE ?".to_string());
                    bind_values.push(format!("%\"{cap}\"%"));
                }
            }
        }
        if let Some(ref skill) = query.skill {
            // Support comma-separated AND filter: ?skill=typescript,rust
            for skl in skill.split(',') {
                let skl = skl.trim();
                if !skl.is_empty() {
                    conditions.push("skills LIKE ?".to_string());
                    bind_values.push(format!("%\"{skl}\"%"));
                }
            }
        }

        let where_clause = if conditions.is_empty() {
            String::new()
        } else {
            format!(" WHERE {}", conditions.join(" AND "))
        };

        let order_by = match query.sort {
            crate::types::AgentSortField::Messages => "messages_sent DESC",
            crate::types::AgentSortField::LastSeen => "last_seen DESC",
            crate::types::AgentSortField::Created => "created_at DESC",
        };

        let count_sql = format!("SELECT COUNT(*) FROM agents{where_clause}");
        let select_sql = format!(
            "SELECT * FROM agents{where_clause} ORDER BY {order_by} LIMIT {} OFFSET {}",
            query.limit,
            query.offset()
        );

        let mut count_q = sqlx::query_scalar::<_, i64>(&count_sql);
        for v in &bind_values {
            count_q = count_q.bind(v);
        }
        let total: i64 = count_q.fetch_one(&self.pool).await?;

        let mut sel_q = sqlx::query(&select_sql);
        for v in &bind_values {
            sel_q = sel_q.bind(v);
        }
        let rows = sel_q.fetch_all(&self.pool).await?;
        let agents = rows.iter().map(row_to_agent).collect::<Result<Vec<_>>>()?;

        Ok(Page::new(agents, total as u64, query.page, query.limit))
    }

    async fn increment_stats(&self, id: Uuid, delta: StatsDelta) -> Result<()> {
        let now = now_ts();
        sqlx::query(
            "UPDATE agents \
             SET messages_sent = messages_sent + ?, \
             messages_received = messages_received + ?, \
             conversation_count = conversation_count + ?, \
             friend_count = friend_count + ?, \
             updated_at = ? WHERE id = ?",
        )
        .bind(delta.messages_sent)
        .bind(delta.messages_received)
        .bind(delta.conversation_count)
        .bind(delta.friend_count)
        .bind(now)
        .bind(id.to_string())
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    async fn set_owner(&self, id: Uuid, owner_id: Uuid) -> Result<Agent> {
        let now = now_ts();
        sqlx::query(
            "UPDATE agents \
             SET owner_id = ?, updated_at = ? \
             WHERE id = ?",
        )
        .bind(owner_id.to_string())
        .bind(now)
        .bind(id.to_string())
        .execute(&self.pool)
        .await?;

        AgentRepository::find_by_id(self, id)
            .await?
            .context("agent not found after set_owner")
    }

    async fn update_last_seen(&self, id: Uuid) -> Result<()> {
        let now = now_ts();
        sqlx::query(
            "UPDATE agents \
             SET last_seen = ?, updated_at = ? \
             WHERE id = ?",
        )
        .bind(now)
        .bind(now)
        .bind(id.to_string())
        .execute(&self.pool)
        .await?;
        Ok(())
    }
}
