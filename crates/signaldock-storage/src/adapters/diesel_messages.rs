//! [`MessageRepository`] implementation for [`DieselStore`].
//!
//! Translates the sqlx-based message queries into Diesel DSL.
//! Uses `diesel::sql_query` for FTS5 full-text search and
//! the GROUP BY deduplication query (not expressible in typed DSL).

use anyhow::{Context, Result};
use async_trait::async_trait;
use diesel::prelude::*;
use diesel_async::{AsyncConnection, RunQueryDsl};
use uuid::Uuid;

use signaldock_protocol::message::{Message, NewMessage};

use super::diesel_helpers::*;
use super::diesel_store::DieselStore;
use crate::models::*;
use crate::schema::*;
use crate::traits::MessageRepository;
use crate::types::{ActionItem, MessageQuery, Page, SortDirection, UnreadConversation};

/// Sanitizes user input for FTS5 MATCH queries.
///
/// Strips FTS5 operators (AND, OR, NOT, NEAR), removes special
/// characters that could cause parse errors, enforces max length,
/// and wraps each word in double quotes for literal matching.
fn sanitize_fts5_query(input: &str) -> String {
    let truncated = if input.len() > 256 {
        &input[..256]
    } else {
        input
    };

    let words: Vec<String> = truncated
        .split_whitespace()
        .filter(|w| {
            let upper = w.to_uppercase();
            !matches!(upper.as_str(), "AND" | "OR" | "NOT" | "NEAR")
        })
        .map(|w| {
            let clean: String = w
                .chars()
                .filter(|c| c.is_alphanumeric() || *c == '-' || *c == '_' || *c == '.')
                .collect();
            format!("\"{clean}\"")
        })
        .filter(|w| w.len() > 2)
        .take(10)
        .collect();

    words.join(" ")
}

#[async_trait]
impl<C> MessageRepository for DieselStore<C>
where
    C: AsyncConnection + 'static,
    C: diesel_async::AsyncConnection<Backend = diesel::sqlite::Sqlite>,
    C: diesel_async::pooled_connection::PoolableConnection,
{
    async fn create(&self, message: NewMessage) -> Result<Message> {
        // T246: Validate from/to agent_ids exist in agents table
        let mut conn = self.pool.get().await.map_err(pool_err)?;
        let from_exists: Option<AgentRow> = agents::table
            .filter(agents::agent_id.eq(&message.from_agent_id))
            .first(&mut conn)
            .await
            .optional()
            .map_err(diesel_err)?;
        if from_exists.is_none() {
            anyhow::bail!(
                "Write-guard: from_agent_id '{}' does not exist in agents table",
                message.from_agent_id
            );
        }
        let to_exists: Option<AgentRow> = agents::table
            .filter(agents::agent_id.eq(&message.to_agent_id))
            .first(&mut conn)
            .await
            .optional()
            .map_err(diesel_err)?;
        if to_exists.is_none() {
            anyhow::bail!(
                "Write-guard: to_agent_id '{}' does not exist in agents table",
                message.to_agent_id
            );
        }
        drop(conn);

        let id = Uuid::new_v4();
        let now = now_ts();
        let content_type = serialize_enum(&message.content_type);
        let attachments_json = serde_json::to_string(&message.attachments)?;
        let metadata_json = message
            .metadata
            .as_ref()
            .map(serde_json::to_string)
            .transpose()?
            .unwrap_or_else(|| "{}".to_string());

        let new_row = NewMessageRow {
            id: id.to_string(),
            conversation_id: message.conversation_id.to_string(),
            from_agent_id: message.from_agent_id.clone(),
            to_agent_id: message.to_agent_id.clone(),
            content: message.content.clone(),
            content_type,
            status: "pending".to_string(),
            attachments: attachments_json,
            group_id: message.group_id.map(|g| g.to_string()),
            metadata: Some(metadata_json),
            reply_to: message.reply_to.map(|r| r.to_string()),
            created_at: now,
            delivered_at: None,
            read_at: None,
        };

        let mut conn = self.pool.get().await.map_err(pool_err)?;
        diesel::insert_into(messages::table)
            .values(&new_row)
            .execute(&mut conn)
            .await
            .map_err(diesel_err)?;

        self.find_by_id(id)
            .await?
            .context("message not found after insert")
    }

    async fn find_by_id(&self, id: Uuid) -> Result<Option<Message>> {
        let mut conn = self.pool.get().await.map_err(pool_err)?;
        let row: Option<MessageRow> = messages::table
            .find(id.to_string())
            .first(&mut conn)
            .await
            .optional()
            .map_err(diesel_err)?;
        Ok(row.map(message_from_row))
    }

    async fn list_for_conversation(&self, query: MessageQuery) -> Result<Page<Message>> {
        let conv_id = query
            .conversation_id
            .context("conversation_id required for list_for_conversation")?;
        let conv_str = conv_id.to_string();
        let after_ts = query.after_timestamp.map(|ts| ts.timestamp());

        let mut conn = self.pool.get().await.map_err(pool_err)?;

        // Count unique logical messages (dedup fan-out copies by group_id).
        let total: i64 = if let Some(ts) = after_ts {
            diesel::sql_query(
                "SELECT COUNT(*) AS count FROM (\
                   SELECT COALESCE(group_id, id) AS gkey \
                   FROM messages WHERE conversation_id = ? AND created_at > ? \
                   GROUP BY gkey\
                 )",
            )
            .bind::<diesel::sql_types::Text, _>(&conv_str)
            .bind::<diesel::sql_types::BigInt, _>(ts)
            .get_result::<CountResult>(&mut conn)
            .await
            .map(|r| r.count)
            .map_err(diesel_err)?
        } else {
            diesel::sql_query(
                "SELECT COUNT(*) AS count FROM (\
                   SELECT COALESCE(group_id, id) AS gkey \
                   FROM messages WHERE conversation_id = ? \
                   GROUP BY gkey\
                 )",
            )
            .bind::<diesel::sql_types::Text, _>(&conv_str)
            .get_result::<CountResult>(&mut conn)
            .await
            .map(|r| r.count)
            .map_err(diesel_err)?
        };

        let offset = if query.page == 0 {
            0
        } else {
            (query.page.saturating_sub(1)) * query.limit
        };

        let order = match query.sort {
            SortDirection::Asc => "ASC",
            SortDirection::Desc => "DESC",
        };

        // Deduplicate fan-out copies using GROUP BY COALESCE(group_id, id).
        let rows: Vec<MessageRow> = if let Some(ts) = after_ts {
            diesel::sql_query(format!(
                "SELECT MIN(id) AS id, conversation_id, \
                   MIN(from_agent_id) AS from_agent_id, \
                   MIN(to_agent_id) AS to_agent_id, \
                   MIN(content) AS content, \
                   MIN(content_type) AS content_type, \
                   MIN(status) AS status, \
                   MIN(created_at) AS created_at, \
                   MIN(delivered_at) AS delivered_at, \
                   MIN(read_at) AS read_at, \
                   MIN(attachments) AS attachments, \
                   COALESCE(group_id, MIN(id)) AS group_id, \
                   MIN(metadata) AS metadata, \
                   MIN(reply_to) AS reply_to \
                 FROM messages \
                 WHERE conversation_id = ? AND created_at > ? \
                 GROUP BY COALESCE(group_id, id) \
                 ORDER BY MIN(created_at) {order} \
                 LIMIT ? OFFSET ?"
            ))
            .bind::<diesel::sql_types::Text, _>(&conv_str)
            .bind::<diesel::sql_types::BigInt, _>(ts)
            .bind::<diesel::sql_types::BigInt, _>(query.limit as i64)
            .bind::<diesel::sql_types::BigInt, _>(offset as i64)
            .load(&mut conn)
            .await
            .map_err(diesel_err)?
        } else {
            diesel::sql_query(format!(
                "SELECT MIN(id) AS id, conversation_id, \
                   MIN(from_agent_id) AS from_agent_id, \
                   MIN(to_agent_id) AS to_agent_id, \
                   MIN(content) AS content, \
                   MIN(content_type) AS content_type, \
                   MIN(status) AS status, \
                   MIN(created_at) AS created_at, \
                   MIN(delivered_at) AS delivered_at, \
                   MIN(read_at) AS read_at, \
                   MIN(attachments) AS attachments, \
                   COALESCE(group_id, MIN(id)) AS group_id, \
                   MIN(metadata) AS metadata, \
                   MIN(reply_to) AS reply_to \
                 FROM messages \
                 WHERE conversation_id = ? \
                 GROUP BY COALESCE(group_id, id) \
                 ORDER BY MIN(created_at) {order} \
                 LIMIT ? OFFSET ?"
            ))
            .bind::<diesel::sql_types::Text, _>(&conv_str)
            .bind::<diesel::sql_types::BigInt, _>(query.limit as i64)
            .bind::<diesel::sql_types::BigInt, _>(offset as i64)
            .load(&mut conn)
            .await
            .map_err(diesel_err)?
        };

        let msgs = rows.into_iter().map(message_from_row).collect();
        Ok(Page::new(msgs, total as u64, query.page, query.limit))
    }

    async fn poll_new(&self, agent_id: &str, since_id: Option<Uuid>) -> Result<Vec<Message>> {
        let mut conn = self.pool.get().await.map_err(pool_err)?;

        let rows: Vec<MessageRow> = if let Some(since) = since_id {
            // Look up the created_at of the cursor message.
            let since_ts: Option<i64> = messages::table
                .find(since.to_string())
                .select(messages::created_at)
                .first(&mut conn)
                .await
                .optional()
                .map_err(diesel_err)?;

            let ts = since_ts.unwrap_or(0);

            messages::table
                .filter(messages::to_agent_id.eq(agent_id))
                .filter(messages::created_at.gt(ts))
                .order(messages::created_at.asc())
                .load(&mut conn)
                .await
                .map_err(diesel_err)?
        } else {
            messages::table
                .filter(messages::to_agent_id.eq(agent_id))
                .filter(messages::status.eq("pending"))
                .order(messages::created_at.asc())
                .load(&mut conn)
                .await
                .map_err(diesel_err)?
        };

        Ok(rows.into_iter().map(message_from_row).collect())
    }

    async fn mark_delivered(&self, id: Uuid) -> Result<()> {
        let now = now_ts();
        let mut conn = self.pool.get().await.map_err(pool_err)?;
        diesel::update(messages::table.find(id.to_string()))
            .set((
                messages::status.eq("delivered"),
                messages::delivered_at.eq(Some(now)),
            ))
            .execute(&mut conn)
            .await
            .map_err(diesel_err)?;
        Ok(())
    }

    async fn mark_read(&self, id: Uuid) -> Result<()> {
        let now = now_ts();
        let mut conn = self.pool.get().await.map_err(pool_err)?;
        diesel::update(messages::table.find(id.to_string()))
            .set((messages::status.eq("read"), messages::read_at.eq(Some(now))))
            .execute(&mut conn)
            .await
            .map_err(diesel_err)?;
        Ok(())
    }

    async fn search(
        &self,
        query: &str,
        conversation_id: Option<Uuid>,
        limit: u32,
    ) -> Result<Vec<Message>> {
        let sanitized = sanitize_fts5_query(query);
        if sanitized.is_empty() {
            return Ok(vec![]);
        }

        let mut conn = self.pool.get().await.map_err(pool_err)?;

        // FTS5 requires raw SQL — not representable in Diesel typed DSL.
        let rows: Vec<MessageRow> = if let Some(cid) = conversation_id {
            diesel::sql_query(
                "SELECT m.* FROM messages m \
                 JOIN messages_fts f ON m.rowid = f.rowid \
                 WHERE messages_fts MATCH ? AND m.conversation_id = ? \
                 ORDER BY rank \
                 LIMIT ?",
            )
            .bind::<diesel::sql_types::Text, _>(&sanitized)
            .bind::<diesel::sql_types::Text, _>(cid.to_string())
            .bind::<diesel::sql_types::BigInt, _>(limit as i64)
            .load(&mut conn)
            .await
            .map_err(diesel_err)?
        } else {
            diesel::sql_query(
                "SELECT m.* FROM messages m \
                 JOIN messages_fts f ON m.rowid = f.rowid \
                 WHERE messages_fts MATCH ? \
                 ORDER BY rank \
                 LIMIT ?",
            )
            .bind::<diesel::sql_types::Text, _>(&sanitized)
            .bind::<diesel::sql_types::BigInt, _>(limit as i64)
            .load(&mut conn)
            .await
            .map_err(diesel_err)?
        };

        Ok(rows.into_iter().map(message_from_row).collect())
    }

    async fn count_unread(&self, agent_id: &str) -> Result<i64> {
        let mut conn = self.pool.get().await.map_err(pool_err)?;
        let count: i64 = messages::table
            .filter(messages::to_agent_id.eq(agent_id))
            .filter(messages::status.eq_any(&["pending", "delivered"]))
            .count()
            .get_result(&mut conn)
            .await
            .map_err(diesel_err)?;
        Ok(count)
    }

    async fn unread_by_conversation(&self, agent_id: &str) -> Result<Vec<UnreadConversation>> {
        // GROUP BY with aggregate functions requires raw SQL in Diesel
        // because the typed DSL does not support arbitrary GROUP BY projections.
        let mut conn = self.pool.get().await.map_err(pool_err)?;
        let rows: Vec<UnreadConversationRow> = diesel::sql_query(
            "SELECT conversation_id, COUNT(*) AS unread, MAX(created_at) AS last_at \
             FROM messages \
             WHERE to_agent_id = ? AND status IN ('pending', 'delivered') \
             GROUP BY conversation_id \
             ORDER BY last_at DESC",
        )
        .bind::<diesel::sql_types::Text, _>(agent_id)
        .load(&mut conn)
        .await
        .map_err(diesel_err)?;

        Ok(rows
            .into_iter()
            .map(|r| UnreadConversation {
                conversation_id: r.conversation_id,
                unread: r.unread,
                last_at: r.last_at,
            })
            .collect())
    }

    async fn action_items(&self, agent_id: &str, limit: i64) -> Result<Vec<ActionItem>> {
        // SUBSTR and complex WHERE conditions on nullable JSON columns
        // require raw SQL — the Diesel typed DSL does not support SUBSTR.
        let mut conn = self.pool.get().await.map_err(pool_err)?;
        let rows: Vec<ActionItemRow> = diesel::sql_query(
            "SELECT id, from_agent_id, conversation_id, \
                    SUBSTR(content, 1, 200) AS preview, metadata, created_at \
             FROM messages \
             WHERE to_agent_id = ? AND status IN ('pending', 'delivered') \
                   AND metadata IS NOT NULL AND metadata != '{}' AND metadata != 'null' \
             ORDER BY created_at DESC \
             LIMIT ?",
        )
        .bind::<diesel::sql_types::Text, _>(agent_id)
        .bind::<diesel::sql_types::BigInt, _>(limit)
        .load(&mut conn)
        .await
        .map_err(diesel_err)?;

        Ok(rows
            .into_iter()
            .map(|r| ActionItem {
                id: r.id,
                from_agent_id: r.from_agent_id,
                conversation_id: r.conversation_id,
                preview: r.preview,
                metadata: r.metadata,
                created_at: r.created_at,
            })
            .collect())
    }
}

/// Helper struct for extracting COUNT(*) from raw SQL queries.
#[derive(QueryableByName, Debug)]
struct CountResult {
    #[diesel(sql_type = diesel::sql_types::BigInt)]
    count: i64,
}

/// Row projection for the `unread_by_conversation` GROUP BY query.
#[derive(QueryableByName, Debug)]
struct UnreadConversationRow {
    #[diesel(sql_type = diesel::sql_types::Text)]
    conversation_id: String,
    #[diesel(sql_type = diesel::sql_types::BigInt)]
    unread: i64,
    #[diesel(sql_type = diesel::sql_types::BigInt)]
    last_at: i64,
}

/// Row projection for the `action_items` query.
#[derive(QueryableByName, Debug)]
struct ActionItemRow {
    #[diesel(sql_type = diesel::sql_types::Text)]
    id: String,
    #[diesel(sql_type = diesel::sql_types::Text)]
    from_agent_id: String,
    #[diesel(sql_type = diesel::sql_types::Text)]
    conversation_id: String,
    #[diesel(sql_type = diesel::sql_types::Text)]
    preview: String,
    #[diesel(sql_type = diesel::sql_types::Text)]
    metadata: String,
    #[diesel(sql_type = diesel::sql_types::BigInt)]
    created_at: i64,
}
