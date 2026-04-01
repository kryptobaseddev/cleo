//! Agent lifecycle service.
//!
//! Provides registration, lookup, update, deletion, heartbeat,
//! claim-code workflows, and API key management for agents.
//! Generic over any repository that implements `AgentRepository`
//! and `ClaimRepository`.

use std::sync::Arc;

use anyhow::{Context, Result};
use chrono::Utc;
use sha2::{Digest, Sha256};
use uuid::Uuid;

use signaldock_protocol::{
    agent::{Agent, AgentStatus, AgentUpdate, NewAgent},
    claim::ClaimCode,
};
use signaldock_storage::{
    traits::{AgentRepository, ClaimRepository},
    types::{AgentQuery, Page},
};

/// Result of an API key generation or reset operation.
///
/// Contains the plaintext key (shown once to the caller) and
/// the SHA-256 hash that was persisted in the database.
#[derive(Debug, Clone)]
pub struct ApiKeyResult {
    /// The agent this key belongs to.
    pub agent_id: String,
    /// Plaintext API key (`sk_live_` prefix). Shown once, never stored.
    pub api_key: String,
    /// SHA-256 hex digest of the key, persisted in the agent record.
    pub api_key_hash: String,
}

/// Generates a new `sk_live_` API key and its SHA-256 hash.
///
/// Returns `(plaintext_key, hex_hash)`. The plaintext key is
/// 72 characters: 8-char prefix + 64 hex chars from 32 random bytes.
pub fn generate_api_key_pair() -> (String, String) {
    let key_bytes: [u8; 32] = rand::random();
    let key_hex = hex::encode(key_bytes);
    let api_key = format!("sk_live_{key_hex}");
    let hash = hex::encode(Sha256::digest(api_key.as_bytes()));
    (api_key, hash)
}

/// Computes the SHA-256 hex digest of a plaintext API key.
///
/// Used by auth middleware to verify bearer tokens against stored hashes.
pub fn hash_api_key(api_key: &str) -> String {
    hex::encode(Sha256::digest(api_key.as_bytes()))
}

/// Service for agent registration, discovery, and ownership.
///
/// `R` must implement both `AgentRepository` and
/// `ClaimRepository` to support the full agent lifecycle
/// including claim-code generation and redemption.
pub struct AgentService<R> {
    repo: Arc<R>,
}

impl<R: AgentRepository + ClaimRepository + Send + Sync> AgentService<R> {
    /// Creates a new [`AgentService`] backed by the given
    /// repository.
    pub fn new(repo: Arc<R>) -> Self {
        Self { repo }
    }

    /// Registers a new agent in the system.
    ///
    /// # Errors
    ///
    /// Returns an error if the underlying repository rejects
    /// the creation (e.g. duplicate `agent_id`).
    pub async fn register(&self, new_agent: NewAgent) -> Result<Agent> {
        self.repo
            .create(new_agent)
            .await
            .context("failed to register agent")
    }

    /// Looks up an agent by its human-readable slug.
    ///
    /// # Errors
    ///
    /// Returns an error if the agent does not exist or the
    /// repository query fails.
    pub async fn get_by_agent_id(&self, agent_id: &str) -> Result<Agent> {
        self.repo
            .find_by_agent_id(agent_id)
            .await?
            .ok_or_else(|| anyhow::anyhow!("agent not found: {agent_id}"))
    }

    /// Looks up an agent by its internal UUID.
    ///
    /// # Errors
    ///
    /// Returns an error if the agent does not exist or the
    /// repository query fails.
    pub async fn get_by_id(&self, id: Uuid) -> Result<Agent> {
        self.repo
            .find_by_id(id)
            .await?
            .ok_or_else(|| anyhow::anyhow!("agent not found: {id}"))
    }

    /// Applies a partial update to an existing agent.
    ///
    /// # Errors
    ///
    /// Returns an error if the agent does not exist or the
    /// update payload is invalid.
    pub async fn update(&self, id: Uuid, update: AgentUpdate) -> Result<Agent> {
        self.repo
            .update(id, update)
            .await
            .context("failed to update agent")
    }

    /// Permanently deletes an agent by internal UUID.
    ///
    /// # Errors
    ///
    /// Returns an error if the agent does not exist or the
    /// repository operation fails.
    pub async fn delete(&self, id: Uuid) -> Result<()> {
        self.repo.delete(id).await
    }

    /// Searches for agents matching the given query criteria.
    ///
    /// # Errors
    ///
    /// Returns an error if the repository query fails.
    pub async fn search(&self, query: AgentQuery) -> Result<Page<Agent>> {
        self.repo.list(query).await
    }

    /// Records a heartbeat for the given agent, updating its
    /// `last_seen` timestamp and setting status to
    /// [`AgentStatus::Online`].
    ///
    /// # Errors
    ///
    /// Returns an error if the agent is not found or the
    /// repository operations fail.
    pub async fn heartbeat(&self, agent_id: &str) -> Result<()> {
        let agent = self.get_by_agent_id(agent_id).await?;
        self.repo.update_last_seen(agent.id).await?;
        let update = AgentUpdate {
            status: Some(AgentStatus::Online),
            ..Default::default()
        };
        self.repo.update(agent.id, update).await?;
        Ok(())
    }

    // ── API Key Management ──────────────────────────────────────

    /// Generates an API key for an agent that does not yet have one.
    ///
    /// Returns the plaintext key (shown once) and persists only
    /// the SHA-256 hash. Fails if the agent already has a key —
    /// use [`rotate_api_key`] to replace an existing key.
    ///
    /// # Errors
    ///
    /// Returns an error if the agent already has a key or is not found.
    pub async fn generate_api_key(&self, agent_id: &str) -> Result<ApiKeyResult> {
        let agent = self.get_by_agent_id(agent_id).await?;
        if agent.api_key_hash.is_some() {
            anyhow::bail!(
                "Agent already has an API key. Use rotate_api_key to replace it."
            );
        }
        let (api_key, hash) = generate_api_key_pair();
        let update = AgentUpdate {
            api_key_hash: Some(hash.clone()),
            ..Default::default()
        };
        self.repo.update(agent.id, update).await?;
        Ok(ApiKeyResult {
            agent_id: agent_id.to_string(),
            api_key,
            api_key_hash: hash,
        })
    }

    /// Replaces an existing agent API key with a new one.
    ///
    /// The old key is immediately invalidated. Returns the new
    /// plaintext key (shown once).
    ///
    /// # Errors
    ///
    /// Returns an error if the agent is not found.
    pub async fn rotate_api_key(&self, agent_id: &str) -> Result<ApiKeyResult> {
        let agent = self.get_by_agent_id(agent_id).await?;
        let (api_key, hash) = generate_api_key_pair();
        let update = AgentUpdate {
            api_key_hash: Some(hash.clone()),
            ..Default::default()
        };
        self.repo.update(agent.id, update).await?;
        Ok(ApiKeyResult {
            agent_id: agent_id.to_string(),
            api_key,
            api_key_hash: hash,
        })
    }

    /// Force-resets an agent's API key regardless of current state.
    ///
    /// Intended for superadmin/DBA use when an agent has lost its
    /// key or the key hash is unknown. Replaces any existing key
    /// (or creates one if none exists). No agent-side auth needed.
    ///
    /// # Errors
    ///
    /// Returns an error if the agent is not found.
    pub async fn admin_reset_api_key(&self, agent_id: &str) -> Result<ApiKeyResult> {
        let agent = self.get_by_agent_id(agent_id).await?;
        let (api_key, hash) = generate_api_key_pair();
        let update = AgentUpdate {
            api_key_hash: Some(hash.clone()),
            ..Default::default()
        };
        self.repo
            .update(agent.id, update)
            .await
            .context("failed to reset API key")?;
        Ok(ApiKeyResult {
            agent_id: agent_id.to_string(),
            api_key,
            api_key_hash: hash,
        })
    }

    // ── Claim Code Management ──────────────────────────────────

    /// Generates a one-time claim code for the specified agent.
    ///
    /// The code expires after 15 minutes and consists of 6
    /// alphanumeric characters (ambiguous characters excluded).
    ///
    /// # Errors
    ///
    /// Returns an error if the agent is not found or claim-code
    /// creation fails.
    pub async fn generate_claim_code(&self, agent_id: &str) -> Result<ClaimCode> {
        let agent = self.get_by_agent_id(agent_id).await?;
        let code = generate_claim_code_str();
        let expires_at = Utc::now() + chrono::Duration::minutes(15);
        self.repo.create_code(agent.id, &code, expires_at).await
    }

    /// Redeems a claim code, transferring agent ownership to
    /// the specified user.
    ///
    /// Validates that the code has not already been used and
    /// has not expired before assigning the `owner_id`.
    ///
    /// # Errors
    ///
    /// Returns an error if the code is not found, already used,
    /// expired, or if the repository operations fail.
    pub async fn redeem_claim_code(&self, code: &str, user_id: Uuid) -> Result<Agent> {
        let claim = self
            .repo
            .find_code(code)
            .await?
            .ok_or_else(|| anyhow::anyhow!("claim code not found"))?;

        if claim.used_at.is_some() {
            anyhow::bail!("claim code already used");
        }
        if claim.expires_at < Utc::now() {
            anyhow::bail!("claim code expired");
        }

        self.repo.redeem_code(code, user_id).await?;
        self.repo.set_owner(claim.agent_id, user_id).await
    }
}

fn generate_claim_code_str() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .subsec_nanos();
    let chars: Vec<char> = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789".chars().collect();
    // Generate 8-character code in XXXX-XXXX format to match frontend expectation
    let mut parts = String::with_capacity(8);
    let mut val = ts;
    for _ in 0..8 {
        parts.push(chars[(val as usize) % chars.len()]);
        val = val.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
    }
    format!("{}-{}", &parts[..4], &parts[4..])
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mock::MockStore;

    #[tokio::test]
    async fn test_register_and_get() {
        let store = Arc::new(MockStore::new());
        let svc = AgentService::new(store);

        let new_agent = NewAgent {
            agent_id: "test-agent".into(),
            name: "Test Agent".into(),
            description: None,
            class: signaldock_protocol::agent::AgentClass::Custom,
            privacy_tier: signaldock_protocol::agent::PrivacyTier::Public,
            endpoint: None,
            capabilities: vec![],
            skills: vec![],
            avatar: None,
            payment_config: None,
            webhook_secret: None,
        };

        let agent = svc.register(new_agent).await.unwrap();
        assert_eq!(agent.agent_id, "test-agent");

        let fetched = svc.get_by_agent_id("test-agent").await.unwrap();
        assert_eq!(fetched.id, agent.id);

        let fetched_by_id = svc.get_by_id(agent.id).await.unwrap();
        assert_eq!(fetched_by_id.agent_id, "test-agent");
    }

    #[tokio::test]
    async fn test_get_not_found() {
        let store = Arc::new(MockStore::new());
        let svc = AgentService::new(store);

        let result = svc.get_by_agent_id("nonexistent").await;
        assert!(result.is_err());
        assert!(result.unwrap_err().to_string().contains("agent not found"));
    }

    #[tokio::test]
    async fn test_heartbeat() {
        let store = Arc::new(MockStore::new());
        let svc = AgentService::new(store);

        let new_agent = NewAgent {
            agent_id: "heartbeat-agent".into(),
            name: "Heartbeat".into(),
            description: None,
            class: signaldock_protocol::agent::AgentClass::Custom,
            privacy_tier: signaldock_protocol::agent::PrivacyTier::Public,
            endpoint: None,
            capabilities: vec![],
            skills: vec![],
            avatar: None,
            payment_config: None,
            webhook_secret: None,
        };

        svc.register(new_agent).await.unwrap();
        svc.heartbeat("heartbeat-agent").await.unwrap();

        let agent = svc.get_by_agent_id("heartbeat-agent").await.unwrap();
        assert_eq!(agent.status, AgentStatus::Online);
    }

    #[tokio::test]
    async fn test_claim_code_flow() {
        let store = Arc::new(MockStore::new());
        let svc = AgentService::new(store);

        let new_agent = NewAgent {
            agent_id: "claim-agent".into(),
            name: "Claimable".into(),
            description: None,
            class: signaldock_protocol::agent::AgentClass::Custom,
            privacy_tier: signaldock_protocol::agent::PrivacyTier::Public,
            endpoint: None,
            capabilities: vec![],
            skills: vec![],
            avatar: None,
            payment_config: None,
            webhook_secret: None,
        };

        svc.register(new_agent).await.unwrap();

        let claim = svc.generate_claim_code("claim-agent").await.unwrap();
        assert_eq!(claim.code.len(), 9); // XXXX-XXXX format

        let user_id = Uuid::new_v4();
        let claimed = svc.redeem_claim_code(&claim.code, user_id).await.unwrap();
        assert_eq!(claimed.owner_id, Some(user_id));
        assert!(claimed.is_claimed);
    }

    #[tokio::test]
    async fn test_delete() {
        let store = Arc::new(MockStore::new());
        let svc = AgentService::new(store);

        let new_agent = NewAgent {
            agent_id: "delete-me".into(),
            name: "Delete Me".into(),
            description: None,
            class: signaldock_protocol::agent::AgentClass::Custom,
            privacy_tier: signaldock_protocol::agent::PrivacyTier::Public,
            endpoint: None,
            capabilities: vec![],
            skills: vec![],
            avatar: None,
            payment_config: None,
            webhook_secret: None,
        };

        let agent = svc.register(new_agent).await.unwrap();
        svc.delete(agent.id).await.unwrap();
        assert!(svc.get_by_id(agent.id).await.is_err());
    }

    fn test_agent(id: &str) -> NewAgent {
        NewAgent {
            agent_id: id.into(),
            name: id.into(),
            description: None,
            class: signaldock_protocol::agent::AgentClass::Custom,
            privacy_tier: signaldock_protocol::agent::PrivacyTier::Public,
            endpoint: None,
            capabilities: vec![],
            skills: vec![],
            avatar: None,
            payment_config: None,
            webhook_secret: None,
        }
    }

    #[tokio::test]
    async fn test_generate_api_key() {
        let store = Arc::new(MockStore::new());
        let svc = AgentService::new(store);
        svc.register(test_agent("key-agent")).await.unwrap();

        let result = svc.generate_api_key("key-agent").await.unwrap();
        assert!(result.api_key.starts_with("sk_live_"));
        assert_eq!(result.api_key.len(), 72); // 8 prefix + 64 hex
        assert_eq!(result.api_key_hash, hash_api_key(&result.api_key));

        // Second call should fail — key already exists
        let err = svc.generate_api_key("key-agent").await.unwrap_err();
        assert!(err.to_string().contains("already has an API key"));
    }

    #[tokio::test]
    async fn test_rotate_api_key() {
        let store = Arc::new(MockStore::new());
        let svc = AgentService::new(store);
        svc.register(test_agent("rotate-agent")).await.unwrap();

        let first = svc.generate_api_key("rotate-agent").await.unwrap();
        let second = svc.rotate_api_key("rotate-agent").await.unwrap();

        assert_ne!(first.api_key, second.api_key);
        assert_ne!(first.api_key_hash, second.api_key_hash);

        let agent = svc.get_by_agent_id("rotate-agent").await.unwrap();
        assert_eq!(agent.api_key_hash, Some(second.api_key_hash));
    }

    #[tokio::test]
    async fn test_admin_reset_api_key() {
        let store = Arc::new(MockStore::new());
        let svc = AgentService::new(store);
        svc.register(test_agent("admin-reset")).await.unwrap();

        // Works even when agent has no key
        let result = svc.admin_reset_api_key("admin-reset").await.unwrap();
        assert!(result.api_key.starts_with("sk_live_"));

        // Works when agent already has a key (force-replace)
        let second = svc.admin_reset_api_key("admin-reset").await.unwrap();
        assert_ne!(result.api_key, second.api_key);

        let agent = svc.get_by_agent_id("admin-reset").await.unwrap();
        assert_eq!(agent.api_key_hash, Some(second.api_key_hash));
    }

    #[test]
    fn test_generate_api_key_pair_format() {
        let (key, hash) = generate_api_key_pair();
        assert!(key.starts_with("sk_live_"));
        assert_eq!(key.len(), 72);
        assert_eq!(hash.len(), 64); // SHA-256 hex digest
        assert_eq!(hash, hash_api_key(&key));
    }
}
