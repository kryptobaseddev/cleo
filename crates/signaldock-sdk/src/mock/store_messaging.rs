use anyhow::{Result, anyhow};
use async_trait::async_trait;
use chrono::Utc;
use uuid::Uuid;

use signaldock_protocol::{
    conversation::{Conversation, ConversationVisibility},
    message::{Message, MessageStatus, NewMessage},
};
use signaldock_storage::{
    traits::{ConversationRepository, MessageRepository},
    types::{ActionItem, ConversationQuery, MessageQuery, Page, UnreadConversation},
};

use super::MockStore;
use super::store::lock;

#[async_trait]
impl ConversationRepository for MockStore {
    async fn find_or_create(&self, pa: &str, pb: &str) -> Result<Conversation> {
        let mut map = lock(&self.conversations)?;
        let mut sorted = vec![pa.to_string(), pb.to_string()];
        sorted.sort();
        if let Some(c) = map.values().find(|c| {
            let mut cp = c.participants.clone();
            cp.sort();
            cp == sorted
        }) {
            return Ok(c.clone());
        }
        let now = Utc::now();
        let conv = Conversation {
            id: Uuid::new_v4(),
            participants: sorted,
            visibility: ConversationVisibility::Private,
            message_count: 0,
            last_message_at: None,
            created_at: now,
            updated_at: now,
        };
        map.insert(conv.id, conv.clone());
        Ok(conv)
    }

    async fn find_by_id(&self, id: Uuid) -> Result<Option<Conversation>> {
        Ok(lock(&self.conversations)?.get(&id).cloned())
    }

    async fn list_for_agent(&self, q: ConversationQuery) -> Result<Page<Conversation>> {
        let map = lock(&self.conversations)?;
        let mut items: Vec<Conversation> = map.values().cloned().collect();
        if let Some(ref aid) = q.participant_agent_id {
            items.retain(|c| c.participants.contains(aid));
        }
        let total = items.len() as u64;
        Ok(Page::new(items, total, q.page, q.limit))
    }

    async fn increment_message_count(&self, id: Uuid) -> Result<()> {
        let mut map = lock(&self.conversations)?;
        let c = map.get_mut(&id).ok_or_else(|| anyhow!("not found"))?;
        c.message_count += 1;
        c.last_message_at = Some(Utc::now());
        Ok(())
    }

    async fn update_last_message_at(&self, id: Uuid) -> Result<()> {
        let mut map = lock(&self.conversations)?;
        let c = map.get_mut(&id).ok_or_else(|| anyhow!("not found"))?;
        c.last_message_at = Some(Utc::now());
        Ok(())
    }

    async fn update_visibility(
        &self,
        id: Uuid,
        visibility: ConversationVisibility,
    ) -> Result<Conversation> {
        let mut map = lock(&self.conversations)?;
        let c = map.get_mut(&id).ok_or_else(|| anyhow!("not found"))?;
        c.visibility = visibility;
        c.updated_at = Utc::now();
        Ok(c.clone())
    }

    async fn create_with_participants(
        &self,
        mut participants: Vec<String>,
        visibility: ConversationVisibility,
    ) -> Result<Conversation> {
        participants.sort();
        participants.dedup();
        let now = Utc::now();
        let conv = Conversation {
            id: Uuid::new_v4(),
            participants,
            visibility,
            message_count: 0,
            last_message_at: None,
            created_at: now,
            updated_at: now,
        };
        lock(&self.conversations)?.insert(conv.id, conv.clone());
        Ok(conv)
    }

    async fn add_participants(
        &self,
        id: Uuid,
        new_participants: Vec<String>,
    ) -> Result<Conversation> {
        let mut map = lock(&self.conversations)?;
        let c = map.get_mut(&id).ok_or_else(|| anyhow!("not found"))?;
        for p in new_participants {
            if !c.participants.contains(&p) {
                c.participants.push(p);
            }
        }
        c.participants.sort();
        c.updated_at = Utc::now();
        Ok(c.clone())
    }
}

#[async_trait]
impl MessageRepository for MockStore {
    async fn create(&self, msg: NewMessage) -> Result<Message> {
        let now = Utc::now();
        let m = Message {
            id: Uuid::new_v4(),
            conversation_id: msg.conversation_id,
            from_agent_id: msg.from_agent_id,
            to_agent_id: msg.to_agent_id,
            content: msg.content,
            content_type: msg.content_type,
            status: MessageStatus::Pending,
            created_at: now,
            delivered_at: None,
            read_at: None,
            attachments: msg.attachments,
            group_id: msg.group_id,
            metadata: msg.metadata,
            reply_to: msg.reply_to,
        };
        lock(&self.messages)?.insert(m.id, m.clone());
        Ok(m)
    }

    async fn find_by_id(&self, id: Uuid) -> Result<Option<Message>> {
        Ok(lock(&self.messages)?.get(&id).cloned())
    }

    async fn list_for_conversation(&self, q: MessageQuery) -> Result<Page<Message>> {
        let map = lock(&self.messages)?;
        let mut items: Vec<Message> = map.values().cloned().collect();
        if let Some(cid) = q.conversation_id {
            items.retain(|m| m.conversation_id == cid);
        }
        // Dedup fan-out copies: keep only the first message per group_id.
        let mut seen_groups = std::collections::HashSet::new();
        items.sort_by_key(|m| m.created_at);
        items.retain(|m| {
            if let Some(gid) = m.group_id {
                seen_groups.insert(gid)
            } else {
                true
            }
        });
        let total = items.len() as u64;
        Ok(Page::new(items, total, q.page, q.limit))
    }

    async fn poll_new(&self, agent_id: &str, since_id: Option<Uuid>) -> Result<Vec<Message>> {
        let map = lock(&self.messages)?;
        let mut items: Vec<Message> = map
            .values()
            .filter(|m| m.to_agent_id == agent_id)
            .cloned()
            .collect();
        if let Some(since) = since_id
            && let Some(since_msg) = map.get(&since)
        {
            let t = since_msg.created_at;
            items.retain(|m| m.created_at > t);
        }
        items.sort_by_key(|m| m.created_at);
        Ok(items)
    }

    async fn mark_delivered(&self, id: Uuid) -> Result<()> {
        let mut map = lock(&self.messages)?;
        let m = map.get_mut(&id).ok_or_else(|| anyhow!("not found"))?;
        m.status = MessageStatus::Delivered;
        m.delivered_at = Some(Utc::now());
        Ok(())
    }

    async fn mark_read(&self, id: Uuid) -> Result<()> {
        let mut map = lock(&self.messages)?;
        let m = map.get_mut(&id).ok_or_else(|| anyhow!("not found"))?;
        m.status = MessageStatus::Read;
        m.read_at = Some(Utc::now());
        Ok(())
    }

    async fn search(
        &self,
        query: &str,
        conversation_id: Option<Uuid>,
        limit: u32,
    ) -> Result<Vec<Message>> {
        let map = lock(&self.messages)?;
        let q_lower = query.to_lowercase();
        let mut results: Vec<Message> = map
            .values()
            .filter(|m| {
                m.content.to_lowercase().contains(&q_lower)
                    && conversation_id.map_or(true, |cid| m.conversation_id == cid)
            })
            .cloned()
            .collect();
        results.sort_by(|a, b| b.created_at.cmp(&a.created_at));
        results.truncate(limit as usize);
        Ok(results)
    }

    async fn count_unread(&self, agent_id: &str) -> Result<i64> {
        let map = lock(&self.messages)?;
        let count = map
            .values()
            .filter(|m| {
                m.to_agent_id == agent_id
                    && matches!(m.status, MessageStatus::Pending | MessageStatus::Delivered)
            })
            .count();
        Ok(count as i64)
    }

    async fn unread_by_conversation(&self, agent_id: &str) -> Result<Vec<UnreadConversation>> {
        let map = lock(&self.messages)?;
        let mut by_conv: std::collections::HashMap<Uuid, (i64, i64)> =
            std::collections::HashMap::new();
        for m in map.values().filter(|m| {
            m.to_agent_id == agent_id
                && matches!(m.status, MessageStatus::Pending | MessageStatus::Delivered)
        }) {
            let entry = by_conv.entry(m.conversation_id).or_insert((0, 0));
            entry.0 += 1;
            let ts = m.created_at.timestamp();
            if ts > entry.1 {
                entry.1 = ts;
            }
        }
        let mut results: Vec<UnreadConversation> = by_conv
            .into_iter()
            .map(|(cid, (count, last))| UnreadConversation {
                conversation_id: cid.to_string(),
                unread: count,
                last_at: last,
            })
            .collect();
        results.sort_by(|a, b| b.last_at.cmp(&a.last_at));
        Ok(results)
    }

    async fn action_items(&self, agent_id: &str, limit: i64) -> Result<Vec<ActionItem>> {
        let map = lock(&self.messages)?;
        let mut items: Vec<ActionItem> = map
            .values()
            .filter(|m| {
                m.to_agent_id == agent_id
                    && matches!(m.status, MessageStatus::Pending | MessageStatus::Delivered)
                    && m.metadata.is_some()
            })
            .map(|m| {
                let preview = if m.content.len() > 200 {
                    m.content[..200].to_string()
                } else {
                    m.content.clone()
                };
                ActionItem {
                    id: m.id.to_string(),
                    from_agent_id: m.from_agent_id.clone(),
                    conversation_id: m.conversation_id.to_string(),
                    preview,
                    metadata: m
                        .metadata
                        .as_ref()
                        .map(|md| serde_json::to_string(md).unwrap_or_default())
                        .unwrap_or_default(),
                    created_at: m.created_at.timestamp(),
                }
            })
            .collect();
        items.sort_by(|a, b| b.created_at.cmp(&a.created_at));
        items.truncate(limit as usize);
        Ok(items)
    }
}
