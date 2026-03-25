//! WASM bindings for conduit-core
//!
//! Provides JavaScript/TypeScript access to Conduit wire types

use crate::*;
use wasm_bindgen::prelude::*;

/// Conduit message for agent-to-agent communication.
#[wasm_bindgen]
pub struct WasmConduitMessage {
    inner: ConduitMessage,
}

#[wasm_bindgen]
impl WasmConduitMessage {
    /// Create a new Conduit message.
    ///
    /// # Arguments
    /// * `id` - Unique message ID
    /// * `from` - Sender agent ID
    /// * `content` - Message content
    /// * `timestamp` - ISO 8601 timestamp
    #[wasm_bindgen(constructor)]
    pub fn new(id: String, from: String, content: String, timestamp: String) -> Self {
        Self {
            inner: ConduitMessage {
                id,
                from,
                content,
                tags: None,
                thread_id: None,
                group_id: None,
                timestamp,
                metadata: None,
            },
        }
    }

    /// Get the message ID.
    #[wasm_bindgen(getter)]
    pub fn id(&self) -> String {
        self.inner.id.clone()
    }

    /// Get the sender agent ID.
    #[wasm_bindgen(getter)]
    pub fn from(&self) -> String {
        self.inner.from.clone()
    }

    /// Get the message content.
    #[wasm_bindgen(getter)]
    pub fn content(&self) -> String {
        self.inner.content.clone()
    }

    /// Get the timestamp.
    #[wasm_bindgen(getter)]
    pub fn timestamp(&self) -> String {
        self.inner.timestamp.clone()
    }

    /// Get tags as JSON string.
    #[wasm_bindgen(getter)]
    pub fn tags_json(&self) -> String {
        self.inner
            .tags
            .as_ref()
            .map(|t| serde_json::to_string(t).unwrap_or_default())
            .unwrap_or_default()
    }

    /// Get metadata as JSON string.
    #[wasm_bindgen(getter)]
    pub fn metadata_json(&self) -> String {
        self.inner
            .metadata
            .as_ref()
            .map(|m| m.to_string())
            .unwrap_or_default()
    }

    /// Convert to JSON string.
    #[wasm_bindgen(js_name = toJson)]
    pub fn to_json(&self) -> String {
        serde_json::to_string(&self.inner).unwrap_or_default()
    }

    /// Parse from JSON string.
    #[wasm_bindgen(js_name = fromJson)]
    pub fn from_json(json: String) -> Option<WasmConduitMessage> {
        serde_json::from_str(&json).ok().map(|inner| Self { inner })
    }
}

impl From<WasmConduitMessage> for ConduitMessage {
    fn from(wasm: WasmConduitMessage) -> Self {
        wasm.inner
    }
}

/// Conduit connection state.
#[wasm_bindgen]
#[derive(Clone, Copy)]
pub struct WasmConduitState {
    inner: ConduitState,
}

#[wasm_bindgen]
impl WasmConduitState {
    /// Create disconnected state.
    #[wasm_bindgen(js_name = Disconnected)]
    pub fn disconnected() -> Self {
        Self {
            inner: ConduitState::Disconnected,
        }
    }

    /// Create connecting state.
    #[wasm_bindgen(js_name = Connecting)]
    pub fn connecting() -> Self {
        Self {
            inner: ConduitState::Connecting,
        }
    }

    /// Create connected state.
    #[wasm_bindgen(js_name = Connected)]
    pub fn connected() -> Self {
        Self {
            inner: ConduitState::Connected,
        }
    }

    /// Create reconnecting state.
    #[wasm_bindgen(js_name = Reconnecting)]
    pub fn reconnecting() -> Self {
        Self {
            inner: ConduitState::Reconnecting,
        }
    }

    /// Create error state.
    #[wasm_bindgen(js_name = Error)]
    pub fn error() -> Self {
        Self {
            inner: ConduitState::Error,
        }
    }

    /// Get state as string.
    #[wasm_bindgen(getter)]
    pub fn as_string(&self) -> String {
        match self.inner {
            ConduitState::Disconnected => "disconnected".to_string(),
            ConduitState::Connecting => "connecting".to_string(),
            ConduitState::Connected => "connected".to_string(),
            ConduitState::Reconnecting => "reconnecting".to_string(),
            ConduitState::Error => "error".to_string(),
        }
    }
}

/// CANT metadata from parsed message.
#[wasm_bindgen]
pub struct WasmCantMetadata {
    inner: CantMetadata,
}

#[wasm_bindgen]
impl WasmCantMetadata {
    /// Create new CANT metadata.
    ///
    /// # Arguments
    /// * `directive_type` - "actionable", "routing", or "informational"
    /// * `addresses` - JSON array of addresses
    /// * `task_refs` - JSON array of task refs
    /// * `tags` - JSON array of tags
    #[wasm_bindgen(constructor)]
    pub fn new(directive_type: String, addresses: String, task_refs: String, tags: String) -> Self {
        let addresses: Vec<String> = serde_json::from_str(&addresses).unwrap_or_default();
        let task_refs: Vec<String> = serde_json::from_str(&task_refs).unwrap_or_default();
        let tags: Vec<String> = serde_json::from_str(&tags).unwrap_or_default();

        Self {
            inner: CantMetadata {
                directive: None,
                directive_type,
                addresses,
                task_refs,
                tags,
                operation: None,
            },
        }
    }

    /// Get the directive type.
    #[wasm_bindgen(getter)]
    pub fn directive_type(&self) -> String {
        self.inner.directive_type.clone()
    }

    /// Get addresses as JSON string.
    #[wasm_bindgen(getter)]
    pub fn addresses_json(&self) -> String {
        serde_json::to_string(&self.inner.addresses).unwrap_or_default()
    }

    /// Get task refs as JSON string.
    #[wasm_bindgen(getter)]
    pub fn task_refs_json(&self) -> String {
        serde_json::to_string(&self.inner.task_refs).unwrap_or_default()
    }

    /// Get tags as JSON string.
    #[wasm_bindgen(getter)]
    pub fn tags_json(&self) -> String {
        serde_json::to_string(&self.inner.tags).unwrap_or_default()
    }

    /// Convert to JSON string.
    #[wasm_bindgen(js_name = toJson)]
    pub fn to_json(&self) -> String {
        serde_json::to_string(&self.inner).unwrap_or_default()
    }
}

/// Helper function to parse a Conduit message from JSON.
///
/// # Arguments
/// * `json` - JSON string representing a ConduitMessage
#[wasm_bindgen]
pub fn parse_conduit_message(json: String) -> Option<WasmConduitMessage> {
    WasmConduitMessage::from_json(json)
}

/// Helper function to create a Conduit state from string.
///
/// # Arguments
/// * `state` - State string ("disconnected", "connecting", "connected", "reconnecting", "error")
#[wasm_bindgen]
pub fn create_conduit_state(state: String) -> WasmConduitState {
    match state.as_str() {
        "connecting" => WasmConduitState::connecting(),
        "connected" => WasmConduitState::connected(),
        "reconnecting" => WasmConduitState::reconnecting(),
        "error" => WasmConduitState::error(),
        _ => WasmConduitState::disconnected(),
    }
}
