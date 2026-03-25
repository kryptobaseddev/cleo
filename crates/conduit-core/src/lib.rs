//! Canonical Conduit wire types for the CLEO ecosystem.
//!
//! Provides the primary definitions for the Conduit protocol message
//! envelopes, connection state, configuration, and CANT metadata types.
//! These serve as the Single Source of Truth for Conduit message structure
//! in Rust, mirroring the canonical TypeScript types from
//! `@cleocode/contracts/conduit.ts`.
//!
//! # Overview
//!
//! The Conduit protocol enables agent-to-agent communication within the
//! CLEO ecosystem. This crate defines:
//!
//! - [`ConduitMessage`] — a message received through the Conduit
//! - [`ConduitSendOptions`] — options for sending a message
//! - [`ConduitSendResult`] — result of sending a message
//! - [`ConduitState`] — connection state enumeration
//! - [`ConduitStateChange`] — connection state change event
//! - [`ConduitConfig`] — factory configuration for creating a Conduit instance
//! - [`CantMetadata`] — CANT parsing result embedded in message metadata
//! - [`CantOperation`] — a parsed CANT operation (gateway + domain + operation)

use serde::{Deserialize, Serialize};

// ============================================================================
// Message types
// ============================================================================

/// A message received through the Conduit.
///
/// Represents a single message in the agent-to-agent communication protocol.
/// Messages may optionally include tags for classification, thread/group IDs
/// for conversation context, and arbitrary structured metadata.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ConduitMessage {
    /// Unique message ID.
    pub id: String,

    /// Sender agent ID.
    pub from: String,

    /// Message content (text).
    pub content: String,

    /// Optional tags for message classification (e.g. #status, #decision).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tags: Option<Vec<String>>,

    /// Thread ID for conversation threading.
    #[serde(rename = "threadId", skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<String>,

    /// Group ID if sent to a group conversation.
    #[serde(rename = "groupId", skip_serializing_if = "Option::is_none")]
    pub group_id: Option<String>,

    /// ISO 8601 timestamp.
    pub timestamp: String,

    /// Optional structured metadata.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<serde_json::Value>,
}

impl ConduitMessage {
    /// Extract CANT metadata from this message's metadata field.
    ///
    /// Looks for a `"cant"` key in the message metadata and attempts
    /// to deserialize it as [`CantMetadata`]. Returns `None` if no
    /// metadata is present, no `"cant"` key exists, or deserialization fails.
    pub fn extract_cant_metadata(&self) -> Option<CantMetadata> {
        let metadata = self.metadata.as_ref()?;
        let cant_value = metadata.get("cant")?;
        serde_json::from_value(cant_value.clone()).ok()
    }

    /// Inject CANT metadata into this message's metadata field.
    ///
    /// Sets the `"cant"` key in the message metadata to the serialized
    /// form of the provided [`CantMetadata`]. If the metadata field is
    /// `None`, a new object is created. If serialization of the CANT
    /// metadata fails, the message is returned unchanged.
    #[must_use]
    pub fn with_cant_metadata(mut self, cant: CantMetadata) -> Self {
        let cant_value = match serde_json::to_value(&cant) {
            Ok(v) => v,
            Err(_) => return self,
        };

        let map = match self.metadata.take() {
            Some(serde_json::Value::Object(m)) => m,
            Some(_) | None => serde_json::Map::new(),
        };

        let mut map = map;
        map.insert("cant".to_string(), cant_value);
        self.metadata = Some(serde_json::Value::Object(map));
        self
    }
}

/// Options for sending a message through the Conduit.
///
/// All fields are optional and allow the caller to attach tags,
/// specify threading/group context, and include arbitrary metadata.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct ConduitSendOptions {
    /// Tags to attach to the message.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tags: Option<Vec<String>>,

    /// Thread ID for threading.
    #[serde(rename = "threadId", skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<String>,

    /// Group ID to send to a group.
    #[serde(rename = "groupId", skip_serializing_if = "Option::is_none")]
    pub group_id: Option<String>,

    /// Arbitrary metadata.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<serde_json::Value>,
}

/// Result of sending a message through the Conduit.
///
/// Contains the assigned message ID and the delivery timestamp.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ConduitSendResult {
    /// The assigned message ID.
    #[serde(rename = "messageId")]
    pub message_id: String,

    /// ISO 8601 timestamp of delivery.
    #[serde(rename = "deliveredAt")]
    pub delivered_at: String,
}

// ============================================================================
// Connection state
// ============================================================================

/// Conduit connection states.
///
/// Represents the lifecycle of a Conduit connection, from initial
/// disconnection through connection establishment and potential
/// error/reconnection states.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ConduitState {
    /// Not connected to the messaging backend.
    Disconnected,
    /// Currently establishing a connection.
    Connecting,
    /// Successfully connected and ready to send/receive.
    Connected,
    /// Connection was lost; attempting to reconnect.
    Reconnecting,
    /// An error occurred during connection.
    Error,
}

/// Connection state change event.
///
/// Emitted when the Conduit connection transitions between states.
/// Includes the previous and new states, a timestamp, and an optional
/// error message when transitioning to the [`ConduitState::Error`] state.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ConduitStateChange {
    /// Previous state.
    pub from: ConduitState,

    /// New state.
    pub to: ConduitState,

    /// ISO 8601 timestamp.
    pub timestamp: String,

    /// Error details if state is `error`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

// ============================================================================
// Factory configuration
// ============================================================================

/// Configuration for creating a Conduit instance.
///
/// Provides the necessary parameters for connecting to the messaging
/// backend, including authentication credentials and connection details.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ConduitConfig {
    /// Agent ID to connect as.
    #[serde(rename = "agentId")]
    pub agent_id: String,

    /// API base URL (for cloud implementations).
    #[serde(rename = "apiBaseUrl", skip_serializing_if = "Option::is_none")]
    pub api_base_url: Option<String>,

    /// API key for authentication.
    #[serde(rename = "apiKey", skip_serializing_if = "Option::is_none")]
    pub api_key: Option<String>,

    /// Poll interval in milliseconds (for polling implementations). Default: 5000.
    #[serde(rename = "pollIntervalMs", skip_serializing_if = "Option::is_none")]
    pub poll_interval_ms: Option<u64>,

    /// WebSocket URL (for local `SignalDock` implementations).
    #[serde(rename = "wsUrl", skip_serializing_if = "Option::is_none")]
    pub ws_url: Option<String>,
}

// ============================================================================
// CANT metadata types
// ============================================================================

/// CANT parsing result embedded in Conduit message metadata.
///
/// When a Conduit message contains CANT-formatted content, the parsed
/// result is stored in the message metadata under the `"cant"` key.
/// This struct captures the directive, addressing, task references,
/// tags, and optional operation extracted from the CANT syntax.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CantMetadata {
    /// The directive text extracted from the message, if any.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub directive: Option<String>,

    /// The type of directive: `"actionable"`, `"routing"`, or `"informational"`.
    #[serde(rename = "directiveType")]
    pub directive_type: String,

    /// Agent addresses extracted from the message (e.g. `@agent-id`).
    pub addresses: Vec<String>,

    /// Task references extracted from the message (e.g. `T1234`).
    #[serde(rename = "taskRefs")]
    pub task_refs: Vec<String>,

    /// Tags extracted from the message (e.g. `#status`).
    pub tags: Vec<String>,

    /// Parsed CLEO operation, if the message contains one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub operation: Option<CantOperation>,
}

/// A parsed CANT operation representing a CLEO gateway call.
///
/// Encodes the gateway (mutate/query), domain, operation name, and
/// optional parameters extracted from CANT syntax within a message.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CantOperation {
    /// The gateway type: `"mutate"` or `"query"`.
    pub gateway: String,

    /// The CLEO domain (e.g. `"tasks"`, `"session"`).
    pub domain: String,

    /// The operation name (e.g. `"find"`, `"show"`).
    pub operation: String,

    /// Optional parameters for the operation.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub params: Option<serde_json::Value>,
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    /// Helper to create a minimal [`ConduitMessage`] for testing.
    fn make_message() -> ConduitMessage {
        ConduitMessage {
            id: "msg-001".to_string(),
            from: "agent-a".to_string(),
            content: "Hello from agent A".to_string(),
            tags: None,
            thread_id: None,
            group_id: None,
            timestamp: "2026-03-24T12:00:00Z".to_string(),
            metadata: None,
        }
    }

    /// Helper to create a sample [`CantMetadata`] for testing.
    fn make_cant_metadata() -> CantMetadata {
        CantMetadata {
            directive: Some("please review T5678".to_string()),
            directive_type: "actionable".to_string(),
            addresses: vec!["@cleo-core".to_string()],
            task_refs: vec!["T5678".to_string()],
            tags: vec!["#review".to_string()],
            operation: Some(CantOperation {
                gateway: "query".to_string(),
                domain: "tasks".to_string(),
                operation: "show".to_string(),
                params: Some(serde_json::json!({"id": "T5678"})),
            }),
        }
    }

    #[test]
    fn serialize_conduit_message_minimal() {
        let msg = make_message();
        let json = serde_json::to_value(&msg);
        assert!(json.is_ok());
        let json = match json {
            Ok(v) => v,
            Err(_) => return,
        };

        assert_eq!(json["id"], "msg-001");
        assert_eq!(json["from"], "agent-a");
        assert_eq!(json["content"], "Hello from agent A");
        assert_eq!(json["timestamp"], "2026-03-24T12:00:00Z");

        // Optional fields should be absent
        assert!(json.get("tags").is_none());
        assert!(json.get("threadId").is_none());
        assert!(json.get("groupId").is_none());
        assert!(json.get("metadata").is_none());
    }

    #[test]
    fn serialize_conduit_message_full() {
        let msg = ConduitMessage {
            id: "msg-002".to_string(),
            from: "agent-b".to_string(),
            content: "Full message".to_string(),
            tags: Some(vec!["#status".to_string(), "#decision".to_string()]),
            thread_id: Some("thread-abc".to_string()),
            group_id: Some("group-xyz".to_string()),
            timestamp: "2026-03-24T13:00:00Z".to_string(),
            metadata: Some(serde_json::json!({"key": "value"})),
        };

        let json = serde_json::to_value(&msg);
        assert!(json.is_ok());
        let json = match json {
            Ok(v) => v,
            Err(_) => return,
        };

        // Verify camelCase field names
        assert_eq!(json["threadId"], "thread-abc");
        assert_eq!(json["groupId"], "group-xyz");
        assert_eq!(json["tags"][0], "#status");
        assert_eq!(json["tags"][1], "#decision");
        assert_eq!(json["metadata"]["key"], "value");

        // Verify snake_case names do NOT appear
        assert!(json.get("thread_id").is_none());
        assert!(json.get("group_id").is_none());
    }

    #[test]
    fn deserialize_conduit_message_from_camel_case_json() {
        let json_str = r#"{
            "id": "msg-003",
            "from": "agent-c",
            "content": "deserialized",
            "threadId": "t-100",
            "groupId": "g-200",
            "timestamp": "2026-03-24T14:00:00Z"
        }"#;

        let msg: Result<ConduitMessage, _> = serde_json::from_str(json_str);
        assert!(msg.is_ok());
        let msg = match msg {
            Ok(v) => v,
            Err(_) => return,
        };

        assert_eq!(msg.thread_id.as_deref(), Some("t-100"));
        assert_eq!(msg.group_id.as_deref(), Some("g-200"));
        assert!(msg.tags.is_none());
        assert!(msg.metadata.is_none());
    }

    #[test]
    fn conduit_message_roundtrip() {
        let msg = ConduitMessage {
            id: "msg-rt".to_string(),
            from: "agent-rt".to_string(),
            content: "round trip".to_string(),
            tags: Some(vec!["#test".to_string()]),
            thread_id: Some("thread-rt".to_string()),
            group_id: None,
            timestamp: "2026-03-24T15:00:00Z".to_string(),
            metadata: Some(serde_json::json!({"nested": {"a": 1}})),
        };

        let serialized = serde_json::to_string(&msg);
        assert!(serialized.is_ok());
        let serialized = match serialized {
            Ok(v) => v,
            Err(_) => return,
        };

        let deserialized: Result<ConduitMessage, _> = serde_json::from_str(&serialized);
        assert!(deserialized.is_ok());
        let deserialized = match deserialized {
            Ok(v) => v,
            Err(_) => return,
        };

        assert_eq!(msg, deserialized);
    }

    #[test]
    fn serialize_conduit_state_variants() {
        // Each variant should serialize to lowercase string
        let cases = [
            (ConduitState::Disconnected, "\"disconnected\""),
            (ConduitState::Connecting, "\"connecting\""),
            (ConduitState::Connected, "\"connected\""),
            (ConduitState::Reconnecting, "\"reconnecting\""),
            (ConduitState::Error, "\"error\""),
        ];

        for (state, expected) in &cases {
            let serialized = serde_json::to_string(state);
            assert!(serialized.is_ok());
            let serialized = match serialized {
                Ok(v) => v,
                Err(_) => continue,
            };
            assert_eq!(&serialized, expected, "ConduitState::{state:?} mismatch");
        }
    }

    #[test]
    fn deserialize_conduit_state_variants() {
        let cases = [
            ("\"disconnected\"", ConduitState::Disconnected),
            ("\"connecting\"", ConduitState::Connecting),
            ("\"connected\"", ConduitState::Connected),
            ("\"reconnecting\"", ConduitState::Reconnecting),
            ("\"error\"", ConduitState::Error),
        ];

        for (json_str, expected) in &cases {
            let state: Result<ConduitState, _> = serde_json::from_str(json_str);
            assert!(state.is_ok());
            let state = match state {
                Ok(v) => v,
                Err(_) => continue,
            };
            assert_eq!(&state, expected);
        }
    }

    #[test]
    fn serialize_conduit_state_change() {
        let change = ConduitStateChange {
            from: ConduitState::Connected,
            to: ConduitState::Error,
            timestamp: "2026-03-24T16:00:00Z".to_string(),
            error: Some("connection reset".to_string()),
        };

        let json = serde_json::to_value(&change);
        assert!(json.is_ok());
        let json = match json {
            Ok(v) => v,
            Err(_) => return,
        };

        assert_eq!(json["from"], "connected");
        assert_eq!(json["to"], "error");
        assert_eq!(json["timestamp"], "2026-03-24T16:00:00Z");
        assert_eq!(json["error"], "connection reset");
    }

    #[test]
    fn serialize_conduit_state_change_without_error() {
        let change = ConduitStateChange {
            from: ConduitState::Disconnected,
            to: ConduitState::Connecting,
            timestamp: "2026-03-24T16:30:00Z".to_string(),
            error: None,
        };

        let json = serde_json::to_value(&change);
        assert!(json.is_ok());
        let json = match json {
            Ok(v) => v,
            Err(_) => return,
        };

        assert!(json.get("error").is_none());
    }

    #[test]
    fn conduit_state_change_roundtrip() {
        let change = ConduitStateChange {
            from: ConduitState::Reconnecting,
            to: ConduitState::Connected,
            timestamp: "2026-03-24T17:00:00Z".to_string(),
            error: None,
        };

        let serialized = serde_json::to_string(&change);
        assert!(serialized.is_ok());
        let serialized = match serialized {
            Ok(v) => v,
            Err(_) => return,
        };

        let deserialized: Result<ConduitStateChange, _> = serde_json::from_str(&serialized);
        assert!(deserialized.is_ok());
        let deserialized = match deserialized {
            Ok(v) => v,
            Err(_) => return,
        };

        assert_eq!(change, deserialized);
    }

    #[test]
    fn serialize_conduit_send_options_camel_case() {
        let opts = ConduitSendOptions {
            tags: Some(vec!["#urgent".to_string()]),
            thread_id: Some("t-send".to_string()),
            group_id: Some("g-send".to_string()),
            metadata: None,
        };

        let json = serde_json::to_value(&opts);
        assert!(json.is_ok());
        let json = match json {
            Ok(v) => v,
            Err(_) => return,
        };

        assert_eq!(json["threadId"], "t-send");
        assert_eq!(json["groupId"], "g-send");
        assert!(json.get("thread_id").is_none());
        assert!(json.get("group_id").is_none());
    }

    #[test]
    fn serialize_conduit_send_result_camel_case() {
        let result = ConduitSendResult {
            message_id: "msg-sent-001".to_string(),
            delivered_at: "2026-03-24T18:00:00Z".to_string(),
        };

        let json = serde_json::to_value(&result);
        assert!(json.is_ok());
        let json = match json {
            Ok(v) => v,
            Err(_) => return,
        };

        assert_eq!(json["messageId"], "msg-sent-001");
        assert_eq!(json["deliveredAt"], "2026-03-24T18:00:00Z");
        assert!(json.get("message_id").is_none());
        assert!(json.get("delivered_at").is_none());
    }

    #[test]
    fn serialize_conduit_config_camel_case() {
        let config = ConduitConfig {
            agent_id: "cleo-core".to_string(),
            api_base_url: Some("https://api.example.com".to_string()),
            api_key: Some("secret-key".to_string()),
            poll_interval_ms: Some(3000),
            ws_url: None,
        };

        let json = serde_json::to_value(&config);
        assert!(json.is_ok());
        let json = match json {
            Ok(v) => v,
            Err(_) => return,
        };

        assert_eq!(json["agentId"], "cleo-core");
        assert_eq!(json["apiBaseUrl"], "https://api.example.com");
        assert_eq!(json["apiKey"], "secret-key");
        assert_eq!(json["pollIntervalMs"], 3000);
        assert!(json.get("wsUrl").is_none());

        // Verify snake_case names do NOT appear
        assert!(json.get("agent_id").is_none());
        assert!(json.get("api_base_url").is_none());
        assert!(json.get("api_key").is_none());
        assert!(json.get("poll_interval_ms").is_none());
        assert!(json.get("ws_url").is_none());
    }

    #[test]
    fn cant_metadata_roundtrip() {
        let cant = make_cant_metadata();

        let serialized = serde_json::to_string(&cant);
        assert!(serialized.is_ok());
        let serialized = match serialized {
            Ok(v) => v,
            Err(_) => return,
        };

        let deserialized: Result<CantMetadata, _> = serde_json::from_str(&serialized);
        assert!(deserialized.is_ok());
        let deserialized = match deserialized {
            Ok(v) => v,
            Err(_) => return,
        };

        assert_eq!(cant, deserialized);
    }

    #[test]
    fn cant_metadata_camel_case_fields() {
        let cant = CantMetadata {
            directive: None,
            directive_type: "informational".to_string(),
            addresses: vec![],
            task_refs: vec!["T100".to_string()],
            tags: vec![],
            operation: None,
        };

        let json = serde_json::to_value(&cant);
        assert!(json.is_ok());
        let json = match json {
            Ok(v) => v,
            Err(_) => return,
        };

        assert_eq!(json["directiveType"], "informational");
        assert_eq!(json["taskRefs"][0], "T100");

        // Snake_case names must not appear
        assert!(json.get("directive_type").is_none());
        assert!(json.get("task_refs").is_none());

        // Optional directive should be absent
        assert!(json.get("directive").is_none());
        // Optional operation should be absent
        assert!(json.get("operation").is_none());
    }

    #[test]
    fn cant_operation_serialization() {
        let op = CantOperation {
            gateway: "mutate".to_string(),
            domain: "tasks".to_string(),
            operation: "complete".to_string(),
            params: Some(serde_json::json!({"id": "T999"})),
        };

        let json = serde_json::to_value(&op);
        assert!(json.is_ok());
        let json = match json {
            Ok(v) => v,
            Err(_) => return,
        };

        assert_eq!(json["gateway"], "mutate");
        assert_eq!(json["domain"], "tasks");
        assert_eq!(json["operation"], "complete");
        assert_eq!(json["params"]["id"], "T999");
    }

    #[test]
    fn cant_operation_without_params() {
        let op = CantOperation {
            gateway: "query".to_string(),
            domain: "session".to_string(),
            operation: "status".to_string(),
            params: None,
        };

        let json = serde_json::to_value(&op);
        assert!(json.is_ok());
        let json = match json {
            Ok(v) => v,
            Err(_) => return,
        };

        assert!(json.get("params").is_none());
    }

    #[test]
    fn extract_cant_metadata_from_message() {
        let cant = make_cant_metadata();
        let msg = make_message().with_cant_metadata(cant.clone());

        let extracted = msg.extract_cant_metadata();
        assert!(extracted.is_some());
        let extracted = match extracted {
            Some(v) => v,
            None => return,
        };

        assert_eq!(extracted, cant);
    }

    #[test]
    fn extract_cant_metadata_returns_none_when_missing() {
        let msg = make_message();
        assert!(msg.extract_cant_metadata().is_none());
    }

    #[test]
    fn extract_cant_metadata_returns_none_for_invalid_cant() {
        let msg = ConduitMessage {
            metadata: Some(serde_json::json!({"cant": "not-an-object"})),
            ..make_message()
        };
        assert!(msg.extract_cant_metadata().is_none());
    }

    #[test]
    fn with_cant_metadata_creates_metadata_when_none() {
        let msg = make_message();
        assert!(msg.metadata.is_none());

        let cant = make_cant_metadata();
        let msg = msg.with_cant_metadata(cant);

        assert!(msg.metadata.is_some());
        assert!(msg.extract_cant_metadata().is_some());
    }

    #[test]
    fn with_cant_metadata_preserves_existing_metadata() {
        let msg = ConduitMessage {
            metadata: Some(serde_json::json!({"existing": "value"})),
            ..make_message()
        };

        let cant = CantMetadata {
            directive: None,
            directive_type: "routing".to_string(),
            addresses: vec!["@target".to_string()],
            task_refs: vec![],
            tags: vec![],
            operation: None,
        };

        let msg = msg.with_cant_metadata(cant);

        let meta = match &msg.metadata {
            Some(v) => v,
            None => return,
        };

        // Existing metadata preserved
        assert_eq!(meta["existing"], "value");
        // CANT metadata injected
        assert!(meta.get("cant").is_some());
    }

    #[test]
    fn conduit_send_options_default_is_empty() {
        let opts = ConduitSendOptions::default();
        assert!(opts.tags.is_none());
        assert!(opts.thread_id.is_none());
        assert!(opts.group_id.is_none());
        assert!(opts.metadata.is_none());

        // Default serializes to empty object
        let json = serde_json::to_value(&opts);
        assert!(json.is_ok());
        let json = match json {
            Ok(v) => v,
            Err(_) => return,
        };
        assert_eq!(json, serde_json::json!({}));
    }

    #[test]
    fn conduit_config_minimal() {
        let json_str = r#"{"agentId": "test-agent"}"#;
        let config: Result<ConduitConfig, _> = serde_json::from_str(json_str);
        assert!(config.is_ok());
        let config = match config {
            Ok(v) => v,
            Err(_) => return,
        };

        assert_eq!(config.agent_id, "test-agent");
        assert!(config.api_base_url.is_none());
        assert!(config.api_key.is_none());
        assert!(config.poll_interval_ms.is_none());
        assert!(config.ws_url.is_none());
    }
}
