use anyhow::{Context, Result};
use async_trait::async_trait;
use sqlx::{PgPool, Row};
use uuid::Uuid;

use signaldock_protocol::agent::{Agent, AgentUpdate, NewAgent};

use super::pg_helpers::*;
use crate::traits::AgentRepository;
use crate::types::{AgentQuery, Page, StatsDelta};

/// `PostgreSQL`-backed storage adapter.
///
/// Wraps a [`PgPool`] and implements all repository traits.
/// On construction via [`PostgresStore::new`], embedded
/// `PostgreSQL` migrations are executed automatically.
#[derive(Clone)]
pub struct PostgresStore {
    pub(super) pool: PgPool,
}

impl PostgresStore {
    /// Connects to `PostgreSQL` at `database_url` and runs
    /// all embedded migrations.
    ///
    /// # Errors
    ///
    /// Returns `anyhow::Error` if the connection or
    /// migrations fail.
    pub async fn new(database_url: &str) -> Result<Self> {
        let pool = PgPool::connect(database_url)
            .await
            .context("Failed to connect to `PostgreSQL`")?;
        sqlx::migrate!("src/migrations/postgres")
            .run(&pool)
            .await
            .context("Failed to run migrations")?;
        Ok(Self { pool })
    }

    /// Wraps an existing [`PgPool`] without running
    /// migrations.
    ///
    /// Useful when the caller has already configured the
    /// pool or migrations are managed externally.
    pub fn from_pool(pool: PgPool) -> Self {
        Self { pool }
    }
}

#[async_trait]
impl AgentRepository for PostgresStore {
    async fn find_by_agent_id(&self, agent_id: &str) -> Result<Option<Agent>> {
        let q = "SELECT * FROM agents WHERE agent_id = $1";
        let row = sqlx::query(q)
            .bind(agent_id)
            .fetch_optional(&self.pool)
            .await?;
        row.as_ref().map(agent_from_row).transpose()
    }

    async fn find_by_id(&self, id: Uuid) -> Result<Option<Agent>> {
        let row = sqlx::query("SELECT * FROM agents WHERE id = $1")
            .bind(id)
            .fetch_optional(&self.pool)
            .await?;
        row.as_ref().map(agent_from_row).transpose()
    }

    async fn create(&self, agent: NewAgent) -> Result<Agent> {
        let id = Uuid::new_v4();
        let caps = serde_json::to_value(&agent.capabilities)?;
        let sk = serde_json::to_value(&agent.skills)?;
        let cls = agent_class_to_str(&agent.class);
        let priv_t = privacy_tier_to_str(&agent.privacy_tier);

        let row = sqlx::query(
            "INSERT INTO agents \
             (id, agent_id, name, description, class, \
              privacy_tier, endpoint, capabilities, skills, \
              avatar, payment_config, created_at, updated_at) \
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, \
                     NOW(), NOW()) \
             RETURNING *",
        )
        .bind(id)
        .bind(&agent.agent_id)
        .bind(&agent.name)
        .bind(&agent.description)
        .bind(cls)
        .bind(priv_t)
        .bind(&agent.endpoint)
        .bind(&caps)
        .bind(&sk)
        .bind(&agent.avatar)
        .bind(&agent.payment_config)
        .fetch_one(&self.pool)
        .await?;

        agent_from_row(&row)
    }

    async fn update(&self, id: Uuid, update: AgentUpdate) -> Result<Agent> {
        let cur = AgentRepository::find_by_id(self, id)
            .await?
            .context("Agent not found")?;
        let name = update.name.unwrap_or(cur.name);
        let desc = update.description.or(cur.description);
        let cls = update
            .class
            .as_ref()
            .map(agent_class_to_str)
            .unwrap_or_else(|| agent_class_to_str(&cur.class));
        let pt = update
            .privacy_tier
            .as_ref()
            .map(privacy_tier_to_str)
            .unwrap_or_else(|| privacy_tier_to_str(&cur.privacy_tier));
        let ep = update.endpoint.or(cur.endpoint);
        let caps = serde_json::to_value(update.capabilities.unwrap_or(cur.capabilities))?;
        let sk = serde_json::to_value(update.skills.unwrap_or(cur.skills))?;
        let av = update.avatar.or(cur.avatar);
        let st = update
            .status
            .as_ref()
            .map(agent_status_to_str)
            .unwrap_or_else(|| agent_status_to_str(&cur.status));
        let payment_config = update.payment_config.or(cur.payment_config);
        let api_key_hash = update.api_key_hash.or(cur.api_key_hash);

        let row = sqlx::query(
            "UPDATE agents SET \
             name=$1, description=$2, class=$3, \
             privacy_tier=$4, endpoint=$5, \
             capabilities=$6, skills=$7, avatar=$8, \
             payment_config=$9, status=$10, api_key_hash=$11, \
             updated_at=NOW() \
             WHERE id=$12 RETURNING *",
        )
        .bind(&name)
        .bind(&desc)
        .bind(cls)
        .bind(pt)
        .bind(&ep)
        .bind(&caps)
        .bind(&sk)
        .bind(&av)
        .bind(&payment_config)
        .bind(st)
        .bind(&api_key_hash)
        .bind(id)
        .fetch_one(&self.pool)
        .await?;

        agent_from_row(&row)
    }

    async fn delete(&self, id: Uuid) -> Result<()> {
        sqlx::query("DELETE FROM agents WHERE id = $1")
            .bind(id)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    async fn list(&self, q: AgentQuery) -> Result<Page<Agent>> {
        let base = "\
            WHERE ($1::TEXT IS NULL OR \
              (name ILIKE '%'||$1||'%' \
               OR agent_id ILIKE '%'||$1||'%')) \
            AND ($2::TEXT IS NULL OR class = $2) \
            AND ($3::TEXT IS NULL OR privacy_tier = $3) \
            AND ($4::UUID IS NULL OR owner_id = $4) \
            AND ($5::TEXT IS NULL OR status = $5)";

        let cnt_sql = format!("SELECT COUNT(*) as total FROM agents {base}");
        let sel_sql = format!(
            "SELECT * FROM agents {base} \
             ORDER BY created_at DESC \
             LIMIT $6 OFFSET $7"
        );

        let search = q.search.as_deref();
        let cls = q.class.as_ref().map(agent_class_to_str);
        let pt = q.privacy_tier.as_ref().map(privacy_tier_to_str);
        let st = q.status.as_ref().map(agent_status_to_str);

        let total: i64 = sqlx::query(&cnt_sql)
            .bind(search)
            .bind(cls)
            .bind(pt)
            .bind(q.owner_id)
            .bind(st)
            .fetch_one(&self.pool)
            .await?
            .try_get("total")?;

        let rows = sqlx::query(&sel_sql)
            .bind(search)
            .bind(cls)
            .bind(pt)
            .bind(q.owner_id)
            .bind(st)
            .bind(q.limit as i64)
            .bind(q.offset() as i64)
            .fetch_all(&self.pool)
            .await?;

        let items: Vec<Agent> = rows.iter().map(agent_from_row).collect::<Result<_>>()?;
        Ok(Page::new(items, total as u64, q.page, q.limit))
    }

    async fn increment_stats(&self, id: Uuid, d: StatsDelta) -> Result<()> {
        sqlx::query(
            "UPDATE agents SET \
             messages_sent = messages_sent + $1, \
             messages_received = messages_received + $2, \
             conversation_count = conversation_count + $3, \
             friend_count = friend_count + $4, \
             updated_at = NOW() WHERE id = $5",
        )
        .bind(d.messages_sent)
        .bind(d.messages_received)
        .bind(d.conversation_count)
        .bind(d.friend_count)
        .bind(id)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    async fn set_owner(&self, id: Uuid, owner_id: Uuid) -> Result<Agent> {
        let row = sqlx::query(
            "UPDATE agents SET owner_id=$1, \
             updated_at=NOW() WHERE id=$2 RETURNING *",
        )
        .bind(owner_id)
        .bind(id)
        .fetch_one(&self.pool)
        .await?;
        agent_from_row(&row)
    }

    async fn update_last_seen(&self, id: Uuid) -> Result<()> {
        sqlx::query("UPDATE agents SET last_seen=NOW() WHERE id=$1")
            .bind(id)
            .execute(&self.pool)
            .await?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::traits::{
        ClaimRepository, ConnectionRepository, ConversationRepository, MessageRepository,
        UserRepository,
    };

    fn _assert_agent<T: AgentRepository>() {}
    fn _assert_msg<T: MessageRepository>() {}
    fn _assert_conv<T: ConversationRepository>() {}
    fn _assert_user<T: UserRepository>() {}
    fn _assert_claim<T: ClaimRepository>() {}
    fn _assert_conn<T: ConnectionRepository>() {}

    fn _check() {
        _assert_agent::<PostgresStore>();
        _assert_msg::<PostgresStore>();
        _assert_conv::<PostgresStore>();
        _assert_user::<PostgresStore>();
        _assert_claim::<PostgresStore>();
        _assert_conn::<PostgresStore>();
    }
}
