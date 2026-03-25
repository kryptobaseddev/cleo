//! WASM bindings for lafs-core
//!
//! Provides JavaScript/TypeScript access to LAFS envelope types

use crate::*;
use wasm_bindgen::prelude::*;

// Re-export core types with WASM bindings

/// The transport mechanism used to deliver a LAFS envelope.
#[wasm_bindgen]
#[derive(Clone, Copy)]
pub struct WasmLafsTransport {
    inner: LafsTransport,
}

#[wasm_bindgen]
impl WasmLafsTransport {
    /// Create a CLI transport variant.
    #[wasm_bindgen(js_name = Cli)]
    pub fn cli() -> Self {
        Self {
            inner: LafsTransport::Cli,
        }
    }

    /// Create an HTTP transport variant.
    #[wasm_bindgen(js_name = Http)]
    pub fn http() -> Self {
        Self {
            inner: LafsTransport::Http,
        }
    }

    /// Create a gRPC transport variant.
    #[wasm_bindgen(js_name = Grpc)]
    pub fn grpc() -> Self {
        Self {
            inner: LafsTransport::Grpc,
        }
    }

    /// Create an SDK transport variant.
    #[wasm_bindgen(js_name = Sdk)]
    pub fn sdk() -> Self {
        Self {
            inner: LafsTransport::Sdk,
        }
    }

    /// Get the transport as a string.
    #[wasm_bindgen(getter)]
    pub fn as_string(&self) -> String {
        match self.inner {
            LafsTransport::Cli => "cli".to_string(),
            LafsTransport::Http => "http".to_string(),
            LafsTransport::Grpc => "grpc".to_string(),
            LafsTransport::Sdk => "sdk".to_string(),
        }
    }
}

/// LAFS metadata for envelope.
#[wasm_bindgen]
pub struct WasmLafsMeta {
    inner: LafsMeta,
}

#[wasm_bindgen]
impl WasmLafsMeta {
    /// Create new LAFS metadata.
    ///
    /// # Arguments
    /// * `operation` - The operation name (e.g., "tasks.list")
    /// * `transport` - Transport type string ("cli", "http", "grpc", "sdk")
    #[wasm_bindgen(constructor)]
    pub fn new(operation: String, transport: String) -> Self {
        let transport = match transport.as_str() {
            "http" => LafsTransport::Http,
            "grpc" => LafsTransport::Grpc,
            "sdk" => LafsTransport::Sdk,
            _ => LafsTransport::Cli,
        };

        Self {
            inner: LafsMeta::new(&operation, transport),
        }
    }

    /// Get the LAFS spec version.
    #[wasm_bindgen(getter)]
    pub fn spec_version(&self) -> String {
        self.inner.spec_version.clone()
    }

    /// Get the schema version.
    #[wasm_bindgen(getter)]
    pub fn schema_version(&self) -> String {
        self.inner.schema_version.clone()
    }

    /// Get the operation name.
    #[wasm_bindgen(getter)]
    pub fn operation(&self) -> String {
        self.inner.operation.clone()
    }

    /// Get the transport type as a string.
    #[wasm_bindgen(getter)]
    pub fn transport(&self) -> String {
        match self.inner.transport {
            LafsTransport::Cli => "cli".to_string(),
            LafsTransport::Http => "http".to_string(),
            LafsTransport::Grpc => "grpc".to_string(),
            LafsTransport::Sdk => "sdk".to_string(),
        }
    }
}

impl From<WasmLafsMeta> for LafsMeta {
    fn from(wasm: WasmLafsMeta) -> Self {
        wasm.inner
    }
}

/// LAFS envelope - the main response type.
#[wasm_bindgen]
pub struct WasmLafsEnvelope {
    inner: LafsEnvelope,
}

#[wasm_bindgen]
impl WasmLafsEnvelope {
    /// Create a success envelope.
    ///
    /// # Arguments
    /// * `data` - JSON string of the result data
    /// * `meta` - LAFS metadata
    #[wasm_bindgen(js_name = createSuccess)]
    pub fn create_success(data: String, meta: WasmLafsMeta) -> Self {
        let json_data: serde_json::Value = serde_json::from_str(&data).unwrap_or_default();
        Self {
            inner: LafsEnvelope::success(json_data, meta.into()),
        }
    }

    /// Create an error envelope.
    ///
    /// # Arguments
    /// * `code` - Error code string
    /// * `message` - Error message
    /// * `meta` - LAFS metadata
    #[wasm_bindgen(js_name = createError)]
    pub fn create_error(code: String, message: String, meta: WasmLafsMeta) -> Self {
        let error = LafsError {
            code,
            message,
            category: LafsErrorCategory::Internal,
            retryable: false,
            retry_after_ms: None,
            details: serde_json::Value::Null,
            agent_action: None,
            escalation_required: None,
            suggested_action: None,
            doc_url: None,
        };
        Self {
            inner: LafsEnvelope::error(error, meta.into()),
        }
    }

    /// Check if the envelope represents success.
    #[wasm_bindgen(getter)]
    pub fn success(&self) -> bool {
        self.inner.success
    }

    /// Get the result as a JSON string.
    #[wasm_bindgen(getter)]
    pub fn result_json(&self) -> String {
        self.inner
            .result
            .as_ref()
            .map(|v| v.to_string())
            .unwrap_or_default()
    }

    /// Get the error as a JSON string.
    #[wasm_bindgen(getter)]
    pub fn error_json(&self) -> String {
        self.inner
            .error
            .as_ref()
            .map(|e| serde_json::to_string(e).unwrap_or_default())
            .unwrap_or_default()
    }

    /// Get the metadata as a JSON string.
    #[wasm_bindgen(getter)]
    pub fn meta_json(&self) -> String {
        serde_json::to_string(&self.inner.meta).unwrap_or_default()
    }
}

impl From<WasmLafsEnvelope> for LafsEnvelope {
    fn from(wasm: WasmLafsEnvelope) -> Self {
        wasm.inner
    }
}

/// Helper function to create a transport enum.
///
/// # Arguments
/// * `transport` - Transport type string ("cli", "http", "grpc", "sdk")
#[wasm_bindgen]
pub fn create_transport(transport: String) -> WasmLafsTransport {
    match transport.as_str() {
        "http" => WasmLafsTransport::http(),
        "grpc" => WasmLafsTransport::grpc(),
        "sdk" => WasmLafsTransport::sdk(),
        _ => WasmLafsTransport::cli(),
    }
}
