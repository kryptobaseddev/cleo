use anyhow::{Context, Result};
use async_trait::async_trait;
use sqlx::Row;
use uuid::Uuid;

use signaldock_protocol::message::NewMessage;

use super::sqlite::SqliteStore;
use super::sqlite_helpers::{now_ts, row_to_message, serialize_enum};
use crate::traits::MessageRepository;
use crate::types::{MessageQuery, Page};

/// Sanitizes user input for FTS5 MATCH queries.
///
/// Strips FTS5 operators (AND, OR, NOT, NEAR), removes special
/// characters that could cause parse errors, enforces max length,
/// and wraps each word in double quotes for literal matching.
pub fn sanitize_fts5_query(input: &str) -> String {
    // Enforce max length
    let truncated = if input.len() > 256 {
        &input[..256]
    } else {
        input
    };

    // Split into words, filter out FTS5 operators and special chars
    let words: Vec<String> = truncated
        .split_whitespace()
        .filter(|w| {
            let upper = w.to_uppercase();
            !matches!(upper.as_str(), "AND" | "OR" | "NOT" | "NEAR")
        })
        .map(|w| {
            // Strip FTS5 special chars: *, ^, quotes, parens, colons
            let clean: String = w
                .chars()
                .filter(|c| c.is_alphanumeric() || *c == '-' || *c == '_' || *c == '.')
                .collect();
            // Wrap in quotes for literal matching
            format!("\"{clean}\"")
        })
        .filter(|w| w.len() > 2) // Skip empty quoted strings
        .take(10) // Max 10 terms
        .collect();

    words.join(" ")
}

#[async_trait]
impl MessageRepository for SqliteStore {
    async fn create(&self, message: NewMessage) -> Result<signaldock_protocol::message::Message> {
        let id = Uuid::new_v4();
        let now = now_ts();
        let content_type = serialize_enum(&message.content_type);
        let attachments = serde_json::to_string(&message.attachments)?;

        let group_id_str = message.group_id.map(|g| g.to_string());
        let metadata_json = message
            .metadata
            .as_ref()
            .map(serde_json::to_string)
            .transpose()?
            .unwrap_or_else(|| "{}".to_string());

        let reply_to_str = message.reply_to.map(|r| r.to_string());

        sqlx::query(
            "INSERT INTO messages \
             (id, conversation_id, from_agent_id, \
             to_agent_id, content, content_type, \
             status, created_at, attachments, group_id, metadata, reply_to) \
             VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?)",
        )
        .bind(id.to_string())
        .bind(message.conversation_id.to_string())
        .bind(&message.from_agent_id)
        .bind(&message.to_agent_id)
        .bind(&message.content)
        .bind(&content_type)
        .bind(now)
        .bind(&attachments)
        .bind(&group_id_str)
        .bind(&metadata_json)
        .bind(&reply_to_str)
        .execute(self.pool())
        .await?;

        MessageRepository::find_by_id(self, id)
            .await?
            .context("message not found after insert")
    }

    async fn find_by_id(&self, id: Uuid) -> Result<Option<signaldock_protocol::message::Message>> {
        let row = sqlx::query("SELECT * FROM messages WHERE id = ?")
            .bind(id.to_string())
            .fetch_optional(self.pool())
            .await?;
        row.as_ref().map(row_to_message).transpose()
    }

    async fn list_for_conversation(
        &self,
        query: MessageQuery,
    ) -> Result<Page<signaldock_protocol::message::Message>> {
        use crate::types::SortDirection;

        let conv_id = query
            .conversation_id
            .context("conversation_id required for list_for_conversation")?;

        let conv_str = conv_id.to_string();

        // Build optional WHERE clause for after_timestamp filter.
        let after_ts = query.after_timestamp.map(|ts| ts.timestamp());

        // Count only unique logical messages (dedup fan-out copies by group_id),
        // respecting the after_timestamp filter when present.
        let total: i64 = if let Some(ts) = after_ts {
            sqlx::query_scalar(
                "SELECT COUNT(*) FROM (\
                   SELECT COALESCE(group_id, id) AS gkey \
                   FROM messages WHERE conversation_id = ? AND created_at > ? \
                   GROUP BY gkey\
                 )",
            )
            .bind(&conv_str)
            .bind(ts)
            .fetch_one(self.pool())
            .await?
        } else {
            sqlx::query_scalar(
                "SELECT COUNT(*) FROM (\
                   SELECT COALESCE(group_id, id) AS gkey \
                   FROM messages WHERE conversation_id = ? \
                   GROUP BY gkey\
                 )",
            )
            .bind(&conv_str)
            .fetch_one(self.pool())
            .await?
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

        // Return one row per logical message, deduplicating fan-out copies.
        // Uses GROUP BY directly on the outer query with MIN/MAX aggregation
        // to pick representative values for each logical message group.
        // COALESCE(group_id, id) ensures 1-on-1 messages (NULL group_id)
        // each form their own group.
        let rows = if let Some(ts) = after_ts {
            sqlx::query(&format!(
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
            .bind(&conv_str)
            .bind(ts)
            .bind(query.limit as i64)
            .bind(offset as i64)
            .fetch_all(self.pool())
            .await?
        } else {
            sqlx::query(&format!(
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
            .bind(&conv_str)
            .bind(query.limit as i64)
            .bind(offset as i64)
            .fetch_all(self.pool())
            .await?
        };

        let messages = rows
            .iter()
            .map(row_to_message)
            .collect::<Result<Vec<_>>>()?;

        Ok(Page::new(messages, total as u64, query.page, query.limit))
    }

    async fn poll_new(
        &self,
        agent_id: &str,
        since_id: Option<Uuid>,
    ) -> Result<Vec<signaldock_protocol::message::Message>> {
        let rows = if let Some(since) = since_id {
            let since_row = sqlx::query("SELECT created_at FROM messages WHERE id = ?")
                .bind(since.to_string())
                .fetch_optional(self.pool())
                .await?;

            let since_ts: i64 = since_row
                .map(|r| r.get::<i64, _>("created_at"))
                .unwrap_or(0);

            sqlx::query(
                "SELECT * FROM messages \
                 WHERE to_agent_id = ? AND created_at > ? \
                 ORDER BY created_at ASC",
            )
            .bind(agent_id)
            .bind(since_ts)
            .fetch_all(self.pool())
            .await?
        } else {
            sqlx::query(
                "SELECT * FROM messages \
                 WHERE to_agent_id = ? \
                 AND status = 'pending' \
                 ORDER BY created_at ASC",
            )
            .bind(agent_id)
            .fetch_all(self.pool())
            .await?
        };

        rows.iter().map(row_to_message).collect()
    }

    async fn mark_delivered(&self, id: Uuid) -> Result<()> {
        let now = now_ts();
        sqlx::query(
            "UPDATE messages \
             SET status = 'delivered', delivered_at = ? \
             WHERE id = ?",
        )
        .bind(now)
        .bind(id.to_string())
        .execute(self.pool())
        .await?;
        Ok(())
    }

    async fn mark_read(&self, id: Uuid) -> Result<()> {
        let now = now_ts();
        sqlx::query(
            "UPDATE messages \
             SET status = 'read', read_at = ? \
             WHERE id = ?",
        )
        .bind(now)
        .bind(id.to_string())
        .execute(self.pool())
        .await?;
        Ok(())
    }

    async fn search(
        &self,
        query: &str,
        conversation_id: Option<Uuid>,
        limit: u32,
    ) -> Result<Vec<signaldock_protocol::message::Message>> {
        // Sanitize FTS5 query: strip operators, enforce max length,
        // quote the input to prevent FTS5 syntax injection.
        let sanitized = sanitize_fts5_query(query);
        if sanitized.is_empty() {
            return Ok(vec![]);
        }

        let rows = if let Some(cid) = conversation_id {
            sqlx::query(
                "SELECT m.* FROM messages m \
                 JOIN messages_fts f ON m.rowid = f.rowid \
                 WHERE messages_fts MATCH ? AND m.conversation_id = ? \
                 ORDER BY rank \
                 LIMIT ?",
            )
            .bind(&sanitized)
            .bind(cid.to_string())
            .bind(limit as i64)
            .fetch_all(self.pool())
            .await?
        } else {
            sqlx::query(
                "SELECT m.* FROM messages m \
                 JOIN messages_fts f ON m.rowid = f.rowid \
                 WHERE messages_fts MATCH ? \
                 ORDER BY rank \
                 LIMIT ?",
            )
            .bind(&sanitized)
            .bind(limit as i64)
            .fetch_all(self.pool())
            .await?
        };

        rows.iter().map(row_to_message).collect()
    }
}
