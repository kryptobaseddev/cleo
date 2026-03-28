//! [`ConversationRepository`] implementation for [`DieselStore`].
//!
//! Participants are stored as a sorted JSON string array, matching
//! the sqlx adapter's convention. LIKE queries on the JSON string
//! enable agent-scoped listing without a join table.

use anyhow::{Context, Result};
use async_trait::async_trait;
use diesel::prelude::*;
use diesel_async::{AsyncConnection, RunQueryDsl};
use uuid::Uuid;

use signaldock_protocol::conversation::{Conversation, ConversationVisibility};

use super::diesel_helpers::*;
use super::diesel_store::DieselStore;
use crate::models::*;
use crate::schema::*;
use crate::traits::ConversationRepository;
use crate::types::{ConversationQuery, Page};

#[async_trait]
impl<C> ConversationRepository for DieselStore<C>
where
    C: AsyncConnection + 'static,
    C: diesel_async::AsyncConnection<Backend = diesel::sqlite::Sqlite>,
    C: diesel_async::pooled_connection::PoolableConnection,
{
    async fn find_or_create(
        &self,
        participant_a: &str,
        participant_b: &str,
    ) -> Result<Conversation> {
        let mut parts = vec![participant_a.to_string(), participant_b.to_string()];
        parts.sort();
        let participants_json = serde_json::to_string(&parts)?;

        let mut conn = self.pool.get().await.map_err(pool_err)?;

        // Look for an existing conversation with this exact participant pair.
        let existing: Option<ConversationRow> = conversations::table
            .filter(conversations::participants.eq(&participants_json))
            .first(&mut conn)
            .await
            .optional()
            .map_err(diesel_err)?;

        if let Some(row) = existing {
            return Ok(conversation_from_row(row));
        }

        // Create a new private conversation.
        let id = Uuid::new_v4();
        let now = now_ts();
        let new_row = NewConversationRow {
            id: id.to_string(),
            participants: participants_json,
            visibility: "private".to_string(),
            message_count: 0,
            last_message_at: None,
            created_at: now,
            updated_at: now,
        };

        diesel::insert_into(conversations::table)
            .values(&new_row)
            .execute(&mut conn)
            .await
            .map_err(diesel_err)?;

        self.find_by_id(id)
            .await?
            .context("conversation not found after insert")
    }

    async fn find_by_id(&self, id: Uuid) -> Result<Option<Conversation>> {
        let mut conn = self.pool.get().await.map_err(pool_err)?;
        let row: Option<ConversationRow> = conversations::table
            .find(id.to_string())
            .first(&mut conn)
            .await
            .optional()
            .map_err(diesel_err)?;
        Ok(row.map(conversation_from_row))
    }

    async fn list_for_agent(&self, query: ConversationQuery) -> Result<Page<Conversation>> {
        let agent_id = query
            .participant_agent_id
            .as_deref()
            .context("participant_agent_id required")?;

        // Match the JSON-encoded participant string with a LIKE pattern.
        let pattern = format!("%\"{agent_id}\"%");

        let mut conn = self.pool.get().await.map_err(pool_err)?;

        let total: i64 = conversations::table
            .filter(conversations::participants.like(&pattern))
            .count()
            .get_result(&mut conn)
            .await
            .map_err(diesel_err)?;

        let offset = if query.page == 0 {
            0
        } else {
            (query.page.saturating_sub(1)) * query.limit
        };

        let rows: Vec<ConversationRow> = conversations::table
            .filter(conversations::participants.like(&pattern))
            .order(conversations::updated_at.desc())
            .limit(query.limit as i64)
            .offset(offset as i64)
            .load(&mut conn)
            .await
            .map_err(diesel_err)?;

        let convs = rows.into_iter().map(conversation_from_row).collect();
        Ok(Page::new(convs, total as u64, query.page, query.limit))
    }

    async fn increment_message_count(&self, id: Uuid) -> Result<()> {
        let now = now_ts();
        let mut conn = self.pool.get().await.map_err(pool_err)?;
        diesel::update(conversations::table.find(id.to_string()))
            .set((
                conversations::message_count.eq(conversations::message_count + 1),
                conversations::updated_at.eq(now),
            ))
            .execute(&mut conn)
            .await
            .map_err(diesel_err)?;
        Ok(())
    }

    async fn update_last_message_at(&self, id: Uuid) -> Result<()> {
        let now = now_ts();
        let mut conn = self.pool.get().await.map_err(pool_err)?;
        diesel::update(conversations::table.find(id.to_string()))
            .set((
                conversations::last_message_at.eq(Some(now)),
                conversations::updated_at.eq(now),
            ))
            .execute(&mut conn)
            .await
            .map_err(diesel_err)?;
        Ok(())
    }

    async fn update_visibility(
        &self,
        id: Uuid,
        visibility: ConversationVisibility,
    ) -> Result<Conversation> {
        let now = now_ts();
        let vis = serialize_enum(&visibility);
        let mut conn = self.pool.get().await.map_err(pool_err)?;
        diesel::update(conversations::table.find(id.to_string()))
            .set((
                conversations::visibility.eq(&vis),
                conversations::updated_at.eq(now),
            ))
            .execute(&mut conn)
            .await
            .map_err(diesel_err)?;

        self.find_by_id(id)
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
        let new_row = NewConversationRow {
            id: id.to_string(),
            participants: participants_json,
            visibility: vis,
            message_count: 0,
            last_message_at: None,
            created_at: now,
            updated_at: now,
        };

        let mut conn = self.pool.get().await.map_err(pool_err)?;
        diesel::insert_into(conversations::table)
            .values(&new_row)
            .execute(&mut conn)
            .await
            .map_err(diesel_err)?;

        self.find_by_id(id)
            .await?
            .context("conversation not found after insert")
    }

    async fn add_participants(
        &self,
        id: Uuid,
        new_participants: Vec<String>,
    ) -> Result<Conversation> {
        let conv = self
            .find_by_id(id)
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

        let mut conn = self.pool.get().await.map_err(pool_err)?;
        diesel::update(conversations::table.find(id.to_string()))
            .set((
                conversations::participants.eq(&participants_json),
                conversations::updated_at.eq(now),
            ))
            .execute(&mut conn)
            .await
            .map_err(diesel_err)?;

        self.find_by_id(id)
            .await?
            .context("conversation not found after participant update")
    }
}
