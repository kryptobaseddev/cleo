use anyhow::Result;

use signaldock_protocol::agent::{AgentClass, AgentUpdate, NewAgent, PrivacyTier};
use signaldock_protocol::connection::{ConnectionStatus, NewConnection};
use signaldock_protocol::message::{ContentType, MessageStatus, NewMessage};

use super::sqlite::SqliteStore;
use crate::traits::{
    AgentRepository, ClaimRepository, ConnectionRepository, ConversationRepository,
    MessageRepository, UserRepository,
};
use crate::types::StatsDelta;

async fn test_store() -> Result<SqliteStore> {
    SqliteStore::new("sqlite::memory:").await
}

fn new_agent(slug: &str, name: &str) -> NewAgent {
    NewAgent {
        agent_id: slug.into(),
        name: name.into(),
        description: None,
        class: AgentClass::Custom,
        privacy_tier: PrivacyTier::Public,
        endpoint: None,
        capabilities: vec![],
        skills: vec![],
        avatar: None,
        payment_config: None,
        webhook_secret: None,
    }
}

#[tokio::test]
async fn test_agent_create_and_find() -> Result<()> {
    let store = test_store().await?;
    let agent = AgentRepository::create(
        &store,
        NewAgent {
            capabilities: vec!["chat".into()],
            description: Some("A test agent".into()),
            ..new_agent("test-agent", "Test Agent")
        },
    )
    .await?;

    assert_eq!(agent.agent_id, "test-agent");
    assert!(!agent.is_claimed);
    assert_eq!(agent.stats.messages_sent, 0);

    let found = AgentRepository::find_by_agent_id(&store, "test-agent")
        .await?
        .expect("agent not found");
    assert_eq!(found.id, agent.id);

    let by_id = AgentRepository::find_by_id(&store, agent.id)
        .await?
        .expect("agent not found");
    assert_eq!(by_id.agent_id, "test-agent");
    Ok(())
}

#[tokio::test]
async fn test_agent_update() -> Result<()> {
    let store = test_store().await?;
    let agent = AgentRepository::create(&store, new_agent("update-me", "Before")).await?;

    let updated = AgentRepository::update(
        &store,
        agent.id,
        AgentUpdate {
            name: Some("After".into()),
            ..Default::default()
        },
    )
    .await?;

    assert_eq!(updated.name, "After");
    Ok(())
}

#[tokio::test]
async fn test_agent_increment_stats() -> Result<()> {
    let store = test_store().await?;
    let agent = AgentRepository::create(&store, new_agent("stats-agent", "Stats")).await?;

    AgentRepository::increment_stats(&store, agent.id, StatsDelta::sent()).await?;
    AgentRepository::increment_stats(&store, agent.id, StatsDelta::sent()).await?;

    let found = AgentRepository::find_by_id(&store, agent.id)
        .await?
        .expect("not found");
    assert_eq!(found.stats.messages_sent, 2);
    Ok(())
}

#[tokio::test]
async fn test_conversation_find_or_create() -> Result<()> {
    let store = test_store().await?;
    let c1 = ConversationRepository::find_or_create(&store, "agent-a", "agent-b").await?;
    let c2 = ConversationRepository::find_or_create(&store, "agent-b", "agent-a").await?;

    assert_eq!(c1.id, c2.id);
    assert_eq!(c1.participants, vec!["agent-a", "agent-b"]);
    Ok(())
}

#[tokio::test]
async fn test_message_create_and_poll() -> Result<()> {
    let store = test_store().await?;
    let conv = ConversationRepository::find_or_create(&store, "sender", "receiver").await?;

    let msg = MessageRepository::create(
        &store,
        NewMessage {
            conversation_id: conv.id,
            from_agent_id: "sender".into(),
            to_agent_id: "receiver".into(),
            content: "Hello!".into(),
            content_type: ContentType::Text,
            attachments: vec![],
            group_id: None,
            metadata: None,
            reply_to: None,
        },
    )
    .await?;

    assert_eq!(msg.content, "Hello!");
    assert_eq!(msg.status, MessageStatus::Pending);

    let polled = MessageRepository::poll_new(&store, "receiver", None).await?;
    assert_eq!(polled.len(), 1);
    assert_eq!(polled[0].id, msg.id);
    Ok(())
}

#[tokio::test]
async fn test_message_mark_delivered_and_read() -> Result<()> {
    let store = test_store().await?;
    let conv = ConversationRepository::find_or_create(&store, "a", "b").await?;

    let msg = MessageRepository::create(
        &store,
        NewMessage {
            conversation_id: conv.id,
            from_agent_id: "a".into(),
            to_agent_id: "b".into(),
            content: "test".into(),
            content_type: ContentType::Text,
            attachments: vec![],
            group_id: None,
            metadata: None,
            reply_to: None,
        },
    )
    .await?;

    MessageRepository::mark_delivered(&store, msg.id).await?;
    let found = MessageRepository::find_by_id(&store, msg.id)
        .await?
        .expect("not found");
    assert_eq!(found.status, MessageStatus::Delivered);
    assert!(found.delivered_at.is_some());

    MessageRepository::mark_read(&store, msg.id).await?;
    let found = MessageRepository::find_by_id(&store, msg.id)
        .await?
        .expect("not found");
    assert_eq!(found.status, MessageStatus::Read);
    assert!(found.read_at.is_some());
    Ok(())
}

#[tokio::test]
async fn test_user_create_and_find() -> Result<()> {
    let store = test_store().await?;
    let user =
        UserRepository::create(&store, "test@example.com", "hashed", Some("Test User")).await?;

    assert_eq!(user.email, "test@example.com");
    assert_eq!(user.name.as_deref(), Some("Test User"));

    let by_email = UserRepository::find_by_email(&store, "test@example.com")
        .await?
        .expect("not found");
    assert_eq!(by_email.id, user.id);
    Ok(())
}

#[tokio::test]
async fn test_claim_code_lifecycle() -> Result<()> {
    let store = test_store().await?;
    let agent = AgentRepository::create(&store, new_agent("claim-agent", "Claim")).await?;

    let user = UserRepository::create(&store, "claimer@example.com", "hashed", None).await?;

    let expires = chrono::Utc::now() + chrono::Duration::hours(1);
    let claim = ClaimRepository::create_code(&store, agent.id, "CODE123", expires).await?;

    assert_eq!(claim.code, "CODE123");
    assert!(claim.used_at.is_none());

    let redeemed = ClaimRepository::redeem_code(&store, "CODE123", user.id).await?;
    assert!(redeemed.used_at.is_some());
    assert_eq!(redeemed.used_by, Some(user.id));
    Ok(())
}

#[tokio::test]
async fn test_connection_create_and_find() -> Result<()> {
    let store = test_store().await?;
    let a = AgentRepository::create(&store, new_agent("conn-a", "A")).await?;
    let b = AgentRepository::create(&store, new_agent("conn-b", "B")).await?;

    let conn = ConnectionRepository::create(
        &store,
        NewConnection {
            agent_a: a.id,
            agent_b: b.id,
            initiated_by: "conn-a".into(),
        },
    )
    .await?;
    assert_eq!(conn.status, ConnectionStatus::Pending);

    let found = ConnectionRepository::find_by_agents(&store, a.id, b.id)
        .await?
        .expect("not found");
    assert_eq!(found.id, conn.id);

    let rev = ConnectionRepository::find_by_agents(&store, b.id, a.id)
        .await?
        .expect("not found");
    assert_eq!(rev.id, conn.id);

    let updated =
        ConnectionRepository::update_status(&store, conn.id, ConnectionStatus::Accepted).await?;
    assert_eq!(updated.status, ConnectionStatus::Accepted);

    let list = ConnectionRepository::list_for_agent(&store, a.id).await?;
    assert_eq!(list.len(), 1);
    Ok(())
}
