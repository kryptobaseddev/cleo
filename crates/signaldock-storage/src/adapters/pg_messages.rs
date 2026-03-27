use anyhow::{Context, Result};
use async_trait::async_trait;
use sqlx::Row;
use uuid::Uuid;

use signaldock_protocol::message::{Message, NewMessage};

use super::pg_helpers::*;
use super::postgres::PostgresStore;
use crate::traits::MessageRepository;
use crate::types::{MessageQuery, Page};

#[async_trait]
impl MessageRepository for PostgresStore {
    async fn create(&self, msg: NewMessage) -> Result<Message> {
        let id = Uuid::new_v4();
        let ct = content_type_to_str(&msg.content_type);
        let attachments = serde_json::to_value(&msg.attachments)?;

        let metadata_json = msg
            .metadata
            .as_ref()
            .map(serde_json::to_value)
            .transpose()?
            .unwrap_or(serde_json::json!({}));

        let row = sqlx::query(
            "INSERT INTO messages \
             (id, conversation_id, from_agent_id, \
              to_agent_id, content, content_type, \
              status, created_at, attachments, group_id, metadata, reply_to) \
             VALUES ($1,$2,$3,$4,$5,$6,'pending',NOW(),$7,$8,$9,$10) \
             RETURNING *",
        )
        .bind(id)
        .bind(msg.conversation_id)
        .bind(&msg.from_agent_id)
        .bind(&msg.to_agent_id)
        .bind(&msg.content)
        .bind(ct)
        .bind(attachments)
        .bind(msg.group_id)
        .bind(metadata_json)
        .bind(msg.reply_to)
        .fetch_one(&self.pool)
        .await?;

        message_from_row(&row)
    }

    async fn find_by_id(&self, id: Uuid) -> Result<Option<Message>> {
        let row = sqlx::query("SELECT * FROM messages WHERE id = $1")
            .bind(id)
            .fetch_optional(&self.pool)
            .await?;
        row.as_ref().map(message_from_row).transpose()
    }

    async fn list_for_conversation(&self, q: MessageQuery) -> Result<Page<Message>> {
        use crate::types::SortDirection;

        let cid = q.conversation_id.context("conversation_id required")?;
        let offset = if q.page == 0 {
            0
        } else {
            (q.page.saturating_sub(1)) * q.limit
        };

        let after_ts = q.after_timestamp;

        // Count only unique logical messages (dedup fan-out copies by group_id).
        let total: i64 = if let Some(ts) = after_ts {
            sqlx::query(
                "SELECT COUNT(*) as total FROM (\
                   SELECT COALESCE(group_id, id) AS gkey \
                   FROM messages WHERE conversation_id = $1 AND created_at > $2 \
                   GROUP BY gkey\
                 ) sub",
            )
            .bind(cid)
            .bind(ts)
            .fetch_one(&self.pool)
            .await?
            .try_get("total")?
        } else {
            sqlx::query(
                "SELECT COUNT(*) as total FROM (\
                   SELECT COALESCE(group_id, id) AS gkey \
                   FROM messages WHERE conversation_id = $1 \
                   GROUP BY gkey\
                 ) sub",
            )
            .bind(cid)
            .fetch_one(&self.pool)
            .await?
            .try_get("total")?
        };

        // DISTINCT ON picks one row per logical message, preferring the
        // first copy (lowest id) for each group_id.
        // We wrap in a subquery to apply user-requested sort order.
        let order = match q.sort {
            SortDirection::Asc => "ASC",
            SortDirection::Desc => "DESC",
        };

        let rows = if let Some(ts) = after_ts {
            sqlx::query(&format!(
                "SELECT * FROM (\
                   SELECT DISTINCT ON (COALESCE(group_id, id)) * \
                   FROM messages \
                   WHERE conversation_id = $1 AND created_at > $4 \
                   ORDER BY COALESCE(group_id, id), created_at ASC\
                 ) sub \
                 ORDER BY created_at {order} \
                 LIMIT $2 OFFSET $3"
            ))
            .bind(cid)
            .bind(q.limit as i64)
            .bind(offset as i64)
            .bind(ts)
            .fetch_all(&self.pool)
            .await?
        } else {
            sqlx::query(&format!(
                "SELECT * FROM (\
                   SELECT DISTINCT ON (COALESCE(group_id, id)) * \
                   FROM messages \
                   WHERE conversation_id = $1 \
                   ORDER BY COALESCE(group_id, id), created_at ASC\
                 ) sub \
                 ORDER BY created_at {order} \
                 LIMIT $2 OFFSET $3"
            ))
            .bind(cid)
            .bind(q.limit as i64)
            .bind(offset as i64)
            .fetch_all(&self.pool)
            .await?
        };

        let items: Vec<Message> = rows.iter().map(message_from_row).collect::<Result<_>>()?;
        Ok(Page::new(items, total as u64, q.page, q.limit))
    }

    async fn poll_new(&self, agent_id: &str, since_id: Option<Uuid>) -> Result<Vec<Message>> {
        let rows = if let Some(since) = since_id {
            sqlx::query(
                "SELECT m.* FROM messages m \
                 WHERE m.to_agent_id = $1 \
                 AND m.status = 'pending' \
                 AND m.created_at > \
                   (SELECT created_at FROM messages \
                    WHERE id = $2) \
                 ORDER BY m.created_at ASC",
            )
            .bind(agent_id)
            .bind(since)
            .fetch_all(&self.pool)
            .await?
        } else {
            sqlx::query(
                "SELECT * FROM messages \
                 WHERE to_agent_id = $1 \
                 AND status = 'pending' \
                 ORDER BY created_at ASC",
            )
            .bind(agent_id)
            .fetch_all(&self.pool)
            .await?
        };

        rows.iter().map(message_from_row).collect()
    }

    async fn mark_delivered(&self, id: Uuid) -> Result<()> {
        sqlx::query(
            "UPDATE messages SET status = 'delivered', \
             delivered_at = NOW() WHERE id = $1",
        )
        .bind(id)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    async fn mark_read(&self, id: Uuid) -> Result<()> {
        sqlx::query(
            "UPDATE messages SET status = 'read', \
             read_at = NOW() WHERE id = $1",
        )
        .bind(id)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    async fn search(
        &self,
        query: &str,
        conversation_id: Option<Uuid>,
        limit: u32,
    ) -> Result<Vec<Message>> {
        let rows = if let Some(cid) = conversation_id {
            sqlx::query(
                "SELECT * FROM messages \
                 WHERE content ILIKE '%' || $1 || '%' \
                 AND conversation_id = $2 \
                 ORDER BY created_at DESC \
                 LIMIT $3",
            )
            .bind(query)
            .bind(cid)
            .bind(limit as i64)
            .fetch_all(&self.pool)
            .await?
        } else {
            sqlx::query(
                "SELECT * FROM messages \
                 WHERE content ILIKE '%' || $1 || '%' \
                 ORDER BY created_at DESC \
                 LIMIT $2",
            )
            .bind(query)
            .bind(limit as i64)
            .fetch_all(&self.pool)
            .await?
        };

        rows.iter().map(message_from_row).collect()
    }
}
