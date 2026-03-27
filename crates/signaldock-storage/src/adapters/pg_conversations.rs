use anyhow::{Context, Result};
use async_trait::async_trait;
use sqlx::Row;
use uuid::Uuid;

use signaldock_protocol::conversation::{Conversation, ConversationVisibility};

use super::pg_helpers::*;
use super::postgres::PostgresStore;
use crate::traits::ConversationRepository;
use crate::types::{ConversationQuery, Page};

#[async_trait]
impl ConversationRepository for PostgresStore {
    async fn find_or_create(
        &self,
        participant_a: &str,
        participant_b: &str,
    ) -> Result<Conversation> {
        let mut parts = vec![participant_a.to_string(), participant_b.to_string()];
        parts.sort();
        let pjson = serde_json::to_value(&parts)?;
        let new_id = Uuid::new_v4();

        let row = sqlx::query(
            "WITH ins AS ( \
               INSERT INTO conversations \
               (id, participants, visibility, \
                created_at, updated_at) \
               VALUES ($1, $2, 'private', NOW(), NOW()) \
               ON CONFLICT DO NOTHING \
               RETURNING * \
             ) \
             SELECT * FROM ins \
             UNION ALL \
             SELECT * FROM conversations \
             WHERE participants = $2 \
             LIMIT 1",
        )
        .bind(new_id)
        .bind(&pjson)
        .fetch_one(&self.pool)
        .await?;

        conversation_from_row(&row)
    }

    async fn find_by_id(&self, id: Uuid) -> Result<Option<Conversation>> {
        let row = sqlx::query("SELECT * FROM conversations WHERE id = $1")
            .bind(id)
            .fetch_optional(&self.pool)
            .await?;
        row.as_ref().map(conversation_from_row).transpose()
    }

    async fn list_for_agent(&self, q: ConversationQuery) -> Result<Page<Conversation>> {
        let aid = q
            .participant_agent_id
            .as_deref()
            .context("participant_agent_id required")?;
        let offset = if q.page == 0 {
            0
        } else {
            (q.page.saturating_sub(1)) * q.limit
        };
        let aj = serde_json::to_value([aid])?;

        let total: i64 = sqlx::query(
            "SELECT COUNT(*) as total \
             FROM conversations \
             WHERE participants @> $1::jsonb",
        )
        .bind(&aj)
        .fetch_one(&self.pool)
        .await?
        .try_get("total")?;

        let rows = sqlx::query(
            "SELECT * FROM conversations \
             WHERE participants @> $1::jsonb \
             ORDER BY COALESCE( \
               last_message_at, created_at) DESC \
             LIMIT $2 OFFSET $3",
        )
        .bind(&aj)
        .bind(q.limit as i64)
        .bind(offset as i64)
        .fetch_all(&self.pool)
        .await?;

        let items: Vec<Conversation> = rows
            .iter()
            .map(conversation_from_row)
            .collect::<Result<_>>()?;
        Ok(Page::new(items, total as u64, q.page, q.limit))
    }

    async fn increment_message_count(&self, id: Uuid) -> Result<()> {
        sqlx::query(
            "UPDATE conversations SET \
             message_count = message_count + 1, \
             updated_at = NOW() WHERE id = $1",
        )
        .bind(id)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    async fn update_last_message_at(&self, id: Uuid) -> Result<()> {
        sqlx::query(
            "UPDATE conversations SET \
             last_message_at = NOW(), \
             updated_at = NOW() WHERE id = $1",
        )
        .bind(id)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    async fn update_visibility(
        &self,
        id: Uuid,
        visibility: ConversationVisibility,
    ) -> Result<Conversation> {
        let vis = serde_json::to_string(&visibility)
            .unwrap_or_default()
            .trim_matches('"')
            .to_string();
        sqlx::query(
            "UPDATE conversations SET \
             visibility = $1, updated_at = NOW() \
             WHERE id = $2",
        )
        .bind(&vis)
        .bind(id)
        .execute(&self.pool)
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
        let pjson = serde_json::to_value(&participants)?;
        let vis = serde_json::to_string(&visibility)
            .unwrap_or_default()
            .trim_matches('"')
            .to_string();
        let id = Uuid::new_v4();

        sqlx::query(
            "INSERT INTO conversations \
             (id, participants, visibility, \
              created_at, updated_at) \
             VALUES ($1, $2, $3, NOW(), NOW())",
        )
        .bind(id)
        .bind(&pjson)
        .bind(&vis)
        .execute(&self.pool)
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

        let pjson = serde_json::to_value(&all_participants)?;
        sqlx::query(
            "UPDATE conversations SET \
             participants = $1, updated_at = NOW() \
             WHERE id = $2",
        )
        .bind(&pjson)
        .bind(id)
        .execute(&self.pool)
        .await?;

        ConversationRepository::find_by_id(self, id)
            .await?
            .context("conversation not found after participant update")
    }
}
