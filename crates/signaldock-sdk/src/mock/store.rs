use std::collections::HashMap;
use std::sync::{Mutex, MutexGuard};

use anyhow::{Result, anyhow};
use async_trait::async_trait;
use chrono::Utc;
use uuid::Uuid;

use signaldock_protocol::{
    agent::{Agent, AgentStats, AgentStatus, AgentUpdate, NewAgent},
    claim::ClaimCode,
    conversation::Conversation,
    message::Message,
};
use signaldock_storage::{
    traits::{AgentRepository, ClaimRepository},
    types::{AgentQuery, Page, StatsDelta},
};

/// In-memory mock implementation of storage traits for testing.
pub struct MockStore {
    pub(crate) agents: Mutex<HashMap<Uuid, Agent>>,
    pub(crate) claims: Mutex<HashMap<String, ClaimCode>>,
    pub(crate) conversations: Mutex<HashMap<Uuid, Conversation>>,
    pub(crate) messages: Mutex<HashMap<Uuid, Message>>,
}

pub(crate) fn lock<T>(m: &Mutex<T>) -> Result<MutexGuard<'_, T>> {
    m.lock().map_err(|e| anyhow!("lock poisoned: {e}"))
}

impl Default for MockStore {
    fn default() -> Self {
        Self {
            agents: Mutex::new(HashMap::new()),
            claims: Mutex::new(HashMap::new()),
            conversations: Mutex::new(HashMap::new()),
            messages: Mutex::new(HashMap::new()),
        }
    }
}

impl MockStore {
    /// Creates a new empty mock store.
    pub fn new() -> Self {
        Self::default()
    }
}

#[async_trait]
impl AgentRepository for MockStore {
    async fn find_by_agent_id(&self, agent_id: &str) -> Result<Option<Agent>> {
        let map = lock(&self.agents)?;
        Ok(map.values().find(|a| a.agent_id == agent_id).cloned())
    }

    async fn find_by_id(&self, id: Uuid) -> Result<Option<Agent>> {
        Ok(lock(&self.agents)?.get(&id).cloned())
    }

    async fn create(&self, agent: NewAgent) -> Result<Agent> {
        let now = Utc::now();
        let id = Uuid::new_v4();
        let a = Agent {
            id,
            agent_id: agent.agent_id,
            name: agent.name,
            description: agent.description,
            class: agent.class,
            privacy_tier: agent.privacy_tier,
            owner_id: None,
            endpoint: agent.endpoint,
            webhook_secret: agent.webhook_secret,
            capabilities: agent.capabilities,
            skills: agent.skills,
            avatar: agent.avatar,
            stats: AgentStats::default(),
            status: AgentStatus::Online,
            is_claimed: false,
            last_seen: now,
            created_at: now,
            updated_at: now,
            payment_config: agent.payment_config,
            api_key_hash: None,
            organization_id: None,
        };
        lock(&self.agents)?.insert(id, a.clone());
        Ok(a)
    }

    async fn update(&self, id: Uuid, upd: AgentUpdate) -> Result<Agent> {
        let mut map = lock(&self.agents)?;
        let a = map.get_mut(&id).ok_or_else(|| anyhow!("not found"))?;
        if let Some(v) = upd.name {
            a.name = v;
        }
        if let Some(v) = upd.description {
            a.description = Some(v);
        }
        if let Some(v) = upd.class {
            a.class = v;
        }
        if let Some(v) = upd.privacy_tier {
            a.privacy_tier = v;
        }
        if let Some(v) = upd.endpoint {
            a.endpoint = Some(v);
        }
        if let Some(v) = upd.capabilities {
            a.capabilities = v;
        }
        if let Some(v) = upd.skills {
            a.skills = v;
        }
        if let Some(v) = upd.avatar {
            a.avatar = Some(v);
        }
        if let Some(v) = upd.status {
            a.status = v;
        }
        if let Some(v) = upd.payment_config {
            a.payment_config = Some(v);
        }
        if let Some(v) = upd.webhook_secret {
            a.webhook_secret = Some(v);
        }
        if let Some(v) = upd.api_key_hash {
            a.api_key_hash = Some(v);
        }
        a.updated_at = Utc::now();
        Ok(a.clone())
    }

    async fn delete(&self, id: Uuid) -> Result<()> {
        lock(&self.agents)?.remove(&id);
        Ok(())
    }

    async fn list(&self, query: AgentQuery) -> Result<Page<Agent>> {
        let map = lock(&self.agents)?;
        let mut items: Vec<Agent> = map.values().cloned().collect();
        if let Some(ref s) = query.search {
            items.retain(|a| a.name.contains(s.as_str()) || a.agent_id.contains(s.as_str()));
        }
        let total = items.len() as u64;
        let off = query.offset() as usize;
        let items = items
            .into_iter()
            .skip(off)
            .take(query.limit as usize)
            .collect();
        Ok(Page::new(items, total, query.page, query.limit))
    }

    async fn increment_stats(&self, id: Uuid, delta: StatsDelta) -> Result<()> {
        let mut map = lock(&self.agents)?;
        let a = map.get_mut(&id).ok_or_else(|| anyhow!("not found"))?;
        a.stats.messages_sent += delta.messages_sent;
        a.stats.messages_received += delta.messages_received;
        a.stats.conversation_count += delta.conversation_count;
        a.stats.friend_count += delta.friend_count;
        Ok(())
    }

    async fn set_owner(&self, id: Uuid, owner_id: Uuid) -> Result<Agent> {
        let mut map = lock(&self.agents)?;
        let a = map.get_mut(&id).ok_or_else(|| anyhow!("not found"))?;
        a.owner_id = Some(owner_id);
        a.is_claimed = true;
        a.updated_at = Utc::now();
        Ok(a.clone())
    }

    async fn update_last_seen(&self, id: Uuid) -> Result<()> {
        let mut map = lock(&self.agents)?;
        let a = map.get_mut(&id).ok_or_else(|| anyhow!("not found"))?;
        a.last_seen = Utc::now();
        Ok(())
    }
}

#[async_trait]
impl ClaimRepository for MockStore {
    async fn create_code(
        &self,
        agent_id: Uuid,
        code: &str,
        expires_at: chrono::DateTime<chrono::Utc>,
    ) -> Result<ClaimCode> {
        let claim = ClaimCode {
            id: Uuid::new_v4(),
            agent_id,
            code: code.to_string(),
            expires_at,
            used_at: None,
            used_by: None,
            created_at: Utc::now(),
        };
        lock(&self.claims)?.insert(code.to_string(), claim.clone());
        Ok(claim)
    }

    async fn find_code(&self, code: &str) -> Result<Option<ClaimCode>> {
        Ok(lock(&self.claims)?.get(code).cloned())
    }

    async fn redeem_code(&self, code: &str, user_id: Uuid) -> Result<ClaimCode> {
        let mut map = lock(&self.claims)?;
        let c = map.get_mut(code).ok_or_else(|| anyhow!("not found"))?;
        c.used_at = Some(Utc::now());
        c.used_by = Some(user_id);
        Ok(c.clone())
    }

    async fn invalidate_expired(&self) -> Result<u64> {
        let mut map = lock(&self.claims)?;
        let now = Utc::now();
        let before = map.len();
        map.retain(|_, c| c.expires_at >= now || c.used_at.is_some());
        Ok((before - map.len()) as u64)
    }
}
