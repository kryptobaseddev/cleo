use anyhow::{Context, Result};
use async_trait::async_trait;
use uuid::Uuid;

use signaldock_protocol::conversation::{Conversation, ConversationVisibility};

use super::sqlite::SqliteStore;
use super::sqlite_helpers::{now_ts, row_to_conversation, serialize_enum};
use crate::traits::ConversationRepository;
use crate::types::{ConversationQuery, Page};

#[async_trait]
impl ConversationRepository for SqliteStore {
    async fn find_or_create(
        &self,
        participant_a: &str,
        participant_b: &str,
    ) -> Result<Conversation> {
        let mut parts = vec![participant_a.to_string(), participant_b.to_string()];
        parts.sort();
        let participants_json = serde_json::to_string(&parts)?;

        let existing = sqlx::query(
            "SELECT * FROM conversations \
             WHERE participants = ?",
        )
        .bind(&participants_json)
        .fetch_optional(self.pool())
        .await?;

        if let Some(row) = existing.as_ref() {
            return row_to_conversation(row);
        }

        let id = Uuid::new_v4();
        let now = now_ts();
        sqlx::query(
            "INSERT INTO conversations \
             (id, participants, visibility, \
             message_count, created_at, updated_at) \
             VALUES (?, ?, 'private', 0, ?, ?)",
        )
        .bind(id.to_string())
        .bind(&participants_json)
        .bind(now)
        .bind(now)
        .execute(self.pool())
        .await?;

        ConversationRepository::find_by_id(self, id)
            .await?
            .context("conversation not found after insert")
    }

    async fn find_by_id(&self, id: Uuid) -> Result<Option<Conversation>> {
        let row = sqlx::query("SELECT * FROM conversations WHERE id = ?")
            .bind(id.to_string())
            .fetch_optional(self.pool())
            .await?;
        row.as_ref().map(row_to_conversation).transpose()
    }

    async fn list_for_agent(&self, query: ConversationQuery) -> Result<Page<Conversation>> {
        let agent_id = query
            .participant_agent_id
            .as_deref()
            .context("participant_agent_id required")?;

        let pattern = format!("%\"{agent_id}\"%");

        let total: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM conversations \
             WHERE participants LIKE ?",
        )
        .bind(&pattern)
        .fetch_one(self.pool())
        .await?;

        let offset = if query.page == 0 {
            0
        } else {
            (query.page.saturating_sub(1)) * query.limit
        };

        let rows = sqlx::query(
            "SELECT * FROM conversations \
             WHERE participants LIKE ? \
             ORDER BY updated_at DESC \
             LIMIT ? OFFSET ?",
        )
        .bind(&pattern)
        .bind(query.limit as i64)
        .bind(offset as i64)
        .fetch_all(self.pool())
        .await?;

        let convs = rows
            .iter()
            .map(row_to_conversation)
            .collect::<Result<Vec<_>>>()?;

        Ok(Page::new(convs, total as u64, query.page, query.limit))
    }

    async fn increment_message_count(&self, id: Uuid) -> Result<()> {
        let now = now_ts();
        sqlx::query(
            "UPDATE conversations \
             SET message_count = message_count + 1, \
             updated_at = ? WHERE id = ?",
        )
        .bind(now)
        .bind(id.to_string())
        .execute(self.pool())
        .await?;
        Ok(())
    }

    async fn update_last_message_at(&self, id: Uuid) -> Result<()> {
        let now = now_ts();
        sqlx::query(
            "UPDATE conversations \
             SET last_message_at = ?, updated_at = ? \
             WHERE id = ?",
        )
        .bind(now)
        .bind(now)
        .bind(id.to_string())
        .execute(self.pool())
        .await?;
        Ok(())
    }

    async fn update_visibility(
        &self,
        id: Uuid,
        visibility: ConversationVisibility,
    ) -> Result<Conversation> {
        let now = now_ts();
        let vis = serialize_enum(&visibility);
        sqlx::query(
            "UPDATE conversations \
             SET visibility = ?, updated_at = ? \
             WHERE id = ?",
        )
        .bind(&vis)
        .bind(now)
        .bind(id.to_string())
        .execute(self.pool())
        .await?;

        ConversationRepository::find_by_id(self, id)
            .await?
            .context("conversation not found after visibility update")
    }

    async fn create_with_participants(
        &self,
        mut participants: Vec<String>,
        visibility: ConversationVisibility,
    ) -> Result<Conversation> {
        participants.sort();
        participants.dedup();
        let participants_json = serde_json::to_string(&participants)?;
        let vis = serialize_enum(&visibility);

        let id = Uuid::new_v4();
        let now = now_ts();
        sqlx::query(
            "INSERT INTO conversations \
             (id, participants, visibility, \
             message_count, created_at, updated_at) \
             VALUES (?, ?, ?, 0, ?, ?)",
        )
        .bind(id.to_string())
        .bind(&participants_json)
        .bind(&vis)
        .bind(now)
        .bind(now)
        .execute(self.pool())
        .await?;

        ConversationRepository::find_by_id(self, id)
            .await?
            .context("conversation not found after insert")
    }

    async fn add_participants(
        &self,
        id: Uuid,
        new_participants: Vec<String>,
    ) -> Result<Conversation> {
        let conv = ConversationRepository::find_by_id(self, id)
            .await?
            .context("conversation not found")?;

        let mut all_participants = conv.participants;
        for p in new_participants {
            if !all_participants.contains(&p) {
                all_participants.push(p);
            }
        }
        all_participants.sort();

        let participants_json = serde_json::to_string(&all_participants)?;
        let now = now_ts();

        sqlx::query(
            "UPDATE conversations \
             SET participants = ?, updated_at = ? \
             WHERE id = ?",
        )
        .bind(&participants_json)
        .bind(now)
        .bind(id.to_string())
        .execute(self.pool())
        .await?;

        ConversationRepository::find_by_id(self, id)
            .await?
            .context("conversation not found after participant update")
    }
}
