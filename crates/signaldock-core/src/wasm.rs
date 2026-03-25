//! WASM bindings for signaldock-core
//!
//! Provides `JavaScript`/`TypeScript` access to `SignalDock` domain types
//! Used by `CleoOS` for local `SignalDock` operation

use crate::*;
use wasm_bindgen::prelude::*;

/// Agent class/persona classification.
#[wasm_bindgen]
#[derive(Clone)]
pub struct WasmAgentClass {
    inner: agent::AgentClass,
}

#[wasm_bindgen]
impl WasmAgentClass {
    /// Personal assistant.
    #[wasm_bindgen(js_name = PersonalAssistant)]
    pub fn personal_assistant() -> Self {
        Self {
            inner: agent::AgentClass::PersonalAssistant,
        }
    }

    /// Code development agent.
    #[wasm_bindgen(js_name = CodeDev)]
    pub fn code_dev() -> Self {
        Self {
            inner: agent::AgentClass::CodeDev,
        }
    }

    /// Research agent.
    #[wasm_bindgen(js_name = Research)]
    pub fn research() -> Self {
        Self {
            inner: agent::AgentClass::Research,
        }
    }

    /// Orchestrator agent.
    #[wasm_bindgen(js_name = Orchestrator)]
    pub fn orchestrator() -> Self {
        Self {
            inner: agent::AgentClass::Orchestrator,
        }
    }

    /// Security agent.
    #[wasm_bindgen(js_name = Security)]
    pub fn security() -> Self {
        Self {
            inner: agent::AgentClass::Security,
        }
    }

    /// DevOps agent.
    #[wasm_bindgen(js_name = Devops)]
    pub fn devops() -> Self {
        Self {
            inner: agent::AgentClass::Devops,
        }
    }

    /// Get class as string.
    #[wasm_bindgen(getter)]
    pub fn as_string(&self) -> String {
        format!("{:?}", self.inner).to_lowercase()
    }
}

/// Privacy tier for agent visibility.
#[wasm_bindgen]
#[derive(Clone)]
pub struct WasmPrivacyTier {
    inner: agent::PrivacyTier,
}

#[wasm_bindgen]
impl WasmPrivacyTier {
    /// Public - visible to all.
    #[wasm_bindgen(js_name = Public)]
    pub fn public() -> Self {
        Self {
            inner: agent::PrivacyTier::Public,
        }
    }

    /// Discoverable - searchable but not listed.
    #[wasm_bindgen(js_name = Discoverable)]
    pub fn discoverable() -> Self {
        Self {
            inner: agent::PrivacyTier::Discoverable,
        }
    }

    /// Private - invite only.
    #[wasm_bindgen(js_name = Private)]
    pub fn private() -> Self {
        Self {
            inner: agent::PrivacyTier::Private,
        }
    }

    /// Get tier as string.
    #[wasm_bindgen(getter)]
    pub fn as_string(&self) -> String {
        format!("{:?}", self.inner).to_lowercase()
    }
}

/// Agent status.
#[wasm_bindgen]
#[derive(Clone)]
pub struct WasmAgentStatus {
    inner: agent::AgentStatus,
}

#[wasm_bindgen]
impl WasmAgentStatus {
    /// Online and available.
    #[wasm_bindgen(js_name = Online)]
    pub fn online() -> Self {
        Self {
            inner: agent::AgentStatus::Online,
        }
    }

    /// Online but busy.
    #[wasm_bindgen(js_name = Busy)]
    pub fn busy() -> Self {
        Self {
            inner: agent::AgentStatus::Busy,
        }
    }

    /// Offline.
    #[wasm_bindgen(js_name = Offline)]
    pub fn offline() -> Self {
        Self {
            inner: agent::AgentStatus::Offline,
        }
    }

    /// Get status as string.
    #[wasm_bindgen(getter)]
    pub fn as_string(&self) -> String {
        format!("{:?}", self.inner).to_lowercase()
    }
}

/// Conversation visibility.
#[wasm_bindgen]
#[derive(Clone)]
pub struct WasmConversationVisibility {
    inner: ConversationVisibility,
}

#[wasm_bindgen]
impl WasmConversationVisibility {
    /// Public conversation.
    #[wasm_bindgen(js_name = Public)]
    pub fn public() -> Self {
        Self {
            inner: ConversationVisibility::Public,
        }
    }

    /// Private conversation.
    #[wasm_bindgen(js_name = Private)]
    pub fn private() -> Self {
        Self {
            inner: ConversationVisibility::Private,
        }
    }

    /// Get visibility as string.
    #[wasm_bindgen(getter)]
    pub fn as_string(&self) -> String {
        format!("{:?}", self.inner).to_lowercase()
    }
}

/// Helper to create agent class from string.
///
/// # Arguments
/// * `class` - The agent class string (`"code_dev"`, `"research"`, `"orchestrator"`, etc.)
#[wasm_bindgen]
pub fn create_agent_class(class: String) -> WasmAgentClass {
    match class.as_str() {
        "code_dev" | "code-dev" => WasmAgentClass::code_dev(),
        "research" => WasmAgentClass::research(),
        "orchestrator" => WasmAgentClass::orchestrator(),
        "security" => WasmAgentClass::security(),
        "devops" => WasmAgentClass::devops(),
        _ => WasmAgentClass::personal_assistant(),
    }
}

/// Helper to create privacy tier from string.
#[wasm_bindgen]
pub fn create_privacy_tier(tier: String) -> WasmPrivacyTier {
    match tier.as_str() {
        "discoverable" => WasmPrivacyTier::discoverable(),
        "private" => WasmPrivacyTier::private(),
        _ => WasmPrivacyTier::public(),
    }
}
