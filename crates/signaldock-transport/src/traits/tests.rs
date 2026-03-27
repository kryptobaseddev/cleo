use super::*;
use chrono::Utc;
use signaldock_protocol::message::ContentType;
use uuid::Uuid;

fn make_test_event() -> DeliveryEvent {
    DeliveryEvent {
        message_id: Uuid::new_v4(),
        conversation_id: Uuid::new_v4(),
        from_agent_id: "sender".into(),
        from_agent_name: "Sender Agent".into(),
        to_agent_id: "receiver".into(),
        content: "Test message".into(),
        content_type: ContentType::Text,
        created_at: Utc::now(),
        attachments: vec![],
    }
}

fn make_test_target() -> DeliveryTarget {
    DeliveryTarget {
        agent_id: "test".into(),
        endpoint: None,
        webhook_secret: None,
    }
}

#[test]
fn test_retry_policy_delays() {
    let policy = RetryPolicy::default();
    assert_eq!(policy.delay_for_attempt(1).as_millis(), 1_000);
    assert_eq!(policy.delay_for_attempt(2).as_millis(), 2_000);
    assert_eq!(policy.delay_for_attempt(3).as_millis(), 4_000);
    assert_eq!(policy.delay_for_attempt(4).as_millis(), 8_000);
    assert_eq!(policy.delay_for_attempt(5).as_millis(), 16_000);
    assert_eq!(policy.delay_for_attempt(6).as_millis(), 32_000);
}

#[test]
fn test_retry_policy_caps_at_max() {
    let policy = RetryPolicy::default();
    assert_eq!(policy.delay_for_attempt(7).as_millis(), 32_000);
}

#[test]
fn test_delivery_result_constructors() {
    let success = DeliveryResult::success("sse", Some(200), 5);
    assert!(success.success);
    assert_eq!(success.transport, "sse");
    assert_eq!(success.status_code, Some(200));
    assert!(!success.permanent_failure);

    let failure = DeliveryResult::failure("webhook", "timeout".into(), false);
    assert!(!failure.success);
    assert_eq!(failure.error, Some("timeout".into()));
    assert!(!failure.permanent_failure);

    let perm = DeliveryResult::failure("webhook", "bad request".into(), true);
    assert!(perm.permanent_failure);

    let not_conn = DeliveryResult::not_connected("sse");
    assert!(!not_conn.success);
    assert_eq!(not_conn.error, Some("agent not connected".into()));
}

/// Mock adapter for testing delivery chain behavior.
struct MockAdapter {
    adapter_name: &'static str,
    connected: bool,
    result: bool,
    permanent: bool,
}

#[async_trait::async_trait]
impl TransportAdapter for MockAdapter {
    fn name(&self) -> &'static str {
        self.adapter_name
    }
    fn supports_push(&self) -> bool {
        true
    }
    async fn is_connected(&self, _: &str) -> bool {
        self.connected
    }
    async fn deliver(
        &self,
        _: &DeliveryEvent,
        _: &DeliveryTarget,
    ) -> anyhow::Result<DeliveryResult> {
        if self.result {
            Ok(DeliveryResult::success(self.adapter_name, Some(200), 5))
        } else {
            Ok(DeliveryResult::failure(
                self.adapter_name,
                "mock error".into(),
                self.permanent,
            ))
        }
    }
}

fn mock(
    name: &'static str,
    connected: bool,
    result: bool,
    permanent: bool,
) -> Box<dyn TransportAdapter> {
    Box::new(MockAdapter {
        adapter_name: name,
        connected,
        result,
        permanent,
    })
}

#[tokio::test]
async fn test_chain_succeeds_on_first() {
    let chain = DeliveryChain::new(vec![
        mock("sse", true, true, false),
        mock("webhook", true, true, false),
    ]);
    let result = chain.deliver(&make_test_event(), &make_test_target()).await;
    assert!(result.success);
    assert_eq!(result.transport, "sse");
}

#[tokio::test]
async fn test_chain_falls_through_on_failure() {
    let chain = DeliveryChain::new(vec![
        mock("sse", true, false, false),
        mock("webhook", true, true, false),
    ]);
    let result = chain.deliver(&make_test_event(), &make_test_target()).await;
    assert!(result.success);
    assert_eq!(result.transport, "webhook");
}

#[tokio::test]
async fn test_chain_skips_disconnected() {
    let chain = DeliveryChain::new(vec![
        mock("sse", false, true, false),
        mock("webhook", true, true, false),
    ]);
    let result = chain.deliver(&make_test_event(), &make_test_target()).await;
    assert!(result.success);
    assert_eq!(result.transport, "webhook");
}

#[tokio::test]
async fn test_chain_stops_on_permanent_failure() {
    let chain = DeliveryChain::new(vec![
        mock("sse", true, false, true),
        mock("webhook", true, true, false),
    ]);
    let result = chain.deliver(&make_test_event(), &make_test_target()).await;
    assert!(!result.success);
    assert!(result.permanent_failure);
    assert_eq!(result.transport, "sse");
}

#[tokio::test]
async fn test_chain_no_adapters() {
    let chain = DeliveryChain::new(vec![]);
    let result = chain.deliver(&make_test_event(), &make_test_target()).await;
    assert!(!result.success);
    assert_eq!(result.transport, "none");
}

#[tokio::test]
async fn test_chain_is_connected() {
    let chain = DeliveryChain::new(vec![
        mock("sse", false, true, false),
        mock("webhook", true, true, false),
    ]);
    assert!(chain.is_connected("any").await);
}

#[tokio::test]
async fn test_chain_get_adapter() {
    let chain = DeliveryChain::new(vec![
        mock("sse", true, true, false),
        mock("webhook", true, true, false),
    ]);
    assert!(chain.get_adapter("sse").is_some());
    assert!(chain.get_adapter("webhook").is_some());
    assert!(chain.get_adapter("nonexistent").is_none());
}
