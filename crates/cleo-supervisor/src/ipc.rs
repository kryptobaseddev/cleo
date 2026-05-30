// SPDX-License-Identifier: MIT
// Copyright (c) 2026 kryptobaseddev
//
// This file is part of crates/cleo-supervisor in the CleoCode monorepo.

//! `supervisor-ipc` v1.0 — Rust side of the FROZEN IPC contract (T11339).
//!
//! These serde types are the byte-for-byte mirror of the Zod schemas in
//! `packages/contracts/src/supervisor-ipc/`. The wire format is newline-delimited
//! JSON (NDJSON): one [`IpcEnvelope`] per line. R2 (T11253) consumes this exact
//! shape, so the v1.0 message set is **frozen** — see [`IPC_PROTOCOL_VERSION`].
//!
//! Fan-out transport:
//!   * Unix — a `UnixStream` socketpair (one end handed to each client).
//!   * Windows — a named pipe (`\\.\pipe\cleo-supervisor.<pid>`).
//!
//! The transport is intentionally decoupled from the message types: the same
//! [`IpcEnvelope`] (de)serialization is used regardless of which OS channel
//! carries it, which is what the round-trip test in this module exercises.

use serde::{Deserialize, Serialize};

/// FROZEN protocol version for the supervisor IPC contract.
///
/// MUST equal the `SUPERVISOR_IPC_PROTOCOL_VERSION` const in the TS contract
/// (`packages/contracts/src/supervisor-ipc/version.ts`). The schema-drift guard
/// test (`tests/ipc_freeze.rs`) and the TS drift test both pin this value; bump
/// only via a new major contract revision, never in place.
pub const IPC_PROTOCOL_VERSION: &str = "1.0.0";

/// Default base name for the Windows named pipe / Unix socket path.
pub const IPC_CHANNEL_BASENAME: &str = "cleo-supervisor";

/// A request from a client to the supervisor.
///
/// Tagged by `kind` so the JSON shape matches the Zod discriminated union
/// (`{ "kind": "spawn", ... }`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum IpcRequest {
    /// Ask the supervisor to spawn a new child worker.
    Spawn(SpawnRequest),
    /// Ask the supervisor to restart an existing child by id.
    Restart(RestartRequest),
    /// Ask the supervisor for the status of one or all children.
    Monitor(MonitorRequest),
    /// Ask the supervisor for its own health.
    Health(HealthRequest),
}

/// A response or unsolicited event emitted by the supervisor.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum IpcResponse {
    /// Result of a [`SpawnRequest`].
    Spawned(SpawnResult),
    /// Result of a [`RestartRequest`].
    Restarted(RestartResult),
    /// A monitor snapshot for one or more children.
    Monitor(MonitorResult),
    /// A health snapshot for the supervisor itself.
    Health(HealthResult),
    /// An unsolicited lifecycle event (child exited / restarted).
    Event(LifecycleEvent),
    /// An error response correlated to a request id.
    Error(ErrorResult),
}

/// Top-level IPC envelope: a versioned, correlated wrapper carrying either a
/// request or a response. One envelope per NDJSON line.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct IpcEnvelope {
    /// Protocol version. MUST be [`IPC_PROTOCOL_VERSION`] for v1.0 peers.
    pub protocol_version: String,
    /// Correlation id echoed between a request and its response.
    pub id: String,
    /// The payload — a request from a client or a response from the supervisor.
    #[serde(flatten)]
    pub payload: IpcPayload,
}

/// Discriminates whether the envelope carries a request or a response.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "direction", rename_all = "snake_case")]
pub enum IpcPayload {
    /// A client → supervisor request.
    Request {
        /// The request body.
        request: IpcRequest,
    },
    /// A supervisor → client response or event.
    Response {
        /// The response body.
        response: IpcResponse,
    },
}

impl IpcEnvelope {
    /// Build a request envelope stamped with the frozen protocol version.
    #[must_use]
    pub fn request(id: impl Into<String>, request: IpcRequest) -> Self {
        Self {
            protocol_version: IPC_PROTOCOL_VERSION.to_string(),
            id: id.into(),
            payload: IpcPayload::Request { request },
        }
    }

    /// Build a response envelope stamped with the frozen protocol version.
    #[must_use]
    pub fn response(id: impl Into<String>, response: IpcResponse) -> Self {
        Self {
            protocol_version: IPC_PROTOCOL_VERSION.to_string(),
            id: id.into(),
            payload: IpcPayload::Response { response },
        }
    }

    /// Serialize this envelope to a single NDJSON line (no trailing newline).
    ///
    /// # Errors
    ///
    /// Returns a `serde_json` error if serialization fails.
    pub fn to_ndjson(&self) -> Result<String, serde_json::Error> {
        serde_json::to_string(self)
    }

    /// Parse one NDJSON line into an envelope.
    ///
    /// # Errors
    ///
    /// Returns a `serde_json` error if the line is not a valid envelope.
    pub fn from_ndjson(line: &str) -> Result<Self, serde_json::Error> {
        serde_json::from_str(line.trim())
    }
}

/// Request to spawn a child worker.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SpawnRequest {
    /// Caller-chosen logical id for the child (stable across restarts).
    pub child_id: String,
    /// Absolute path to the program to execute.
    pub program: String,
    /// Arguments passed to the program.
    #[serde(default)]
    pub args: Vec<String>,
    /// Environment overrides applied on top of the supervisor's environment.
    #[serde(default)]
    pub env: Vec<EnvPair>,
    /// Optional working directory for the child.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
}

/// A single environment key/value override.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EnvPair {
    /// Environment variable name.
    pub key: String,
    /// Environment variable value.
    pub value: String,
}

/// Result of a spawn request.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SpawnResult {
    /// Logical id of the spawned child.
    pub child_id: String,
    /// OS pid assigned to the spawned child.
    pub pid: u32,
}

/// Request to restart a child worker.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RestartRequest {
    /// Logical id of the child to restart.
    pub child_id: String,
}

/// Result of a restart request.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RestartResult {
    /// Logical id of the restarted child.
    pub child_id: String,
    /// New OS pid after the restart.
    pub pid: u32,
    /// Number of times this child has been restarted in total.
    pub restart_count: u32,
}

/// Request a monitor snapshot for one (or all) children.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MonitorRequest {
    /// Specific child id to monitor; `None` requests all children.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub child_id: Option<String>,
}

/// Monitor snapshot for one or more children.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MonitorResult {
    /// One row per monitored child.
    pub children: Vec<ChildStatus>,
}

/// Liveness state of a supervised child.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ChildState {
    /// Child process is running.
    Running,
    /// Child exited and a backoff-delayed restart is pending.
    Restarting,
    /// Child exited and will not be restarted (supervisor stopping).
    Stopped,
}

/// A single child's status row.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChildStatus {
    /// Logical id of the child.
    pub child_id: String,
    /// Current OS pid (0 when not currently running).
    pub pid: u32,
    /// Current liveness state.
    pub state: ChildState,
    /// Total restarts observed for this child.
    pub restart_count: u32,
}

/// Request the supervisor's own health.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HealthRequest {}

/// Supervisor health snapshot.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HealthResult {
    /// Supervisor process pid.
    pub pid: u32,
    /// Number of children currently tracked.
    pub child_count: u32,
    /// Seconds the supervisor has been running.
    pub uptime_secs: u64,
    /// Frozen protocol version the supervisor speaks.
    pub protocol_version: String,
}

/// Lifecycle event kind for [`LifecycleEvent`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LifecycleEventKind {
    /// A child process exited.
    ChildExited,
    /// A child process was restarted after a crash.
    ChildRestarted,
}

/// An unsolicited lifecycle event broadcast to all connected clients.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LifecycleEvent {
    /// What happened.
    pub event: LifecycleEventKind,
    /// Logical id of the affected child.
    pub child_id: String,
    /// Exit code, when the OS reported one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i32>,
    /// Terminating signal name, when the child was signalled (Unix).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub signal: Option<String>,
    /// Backoff delay (ms) before the pending restart, when applicable.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub restart_delay_ms: Option<u64>,
}

/// An error response correlated to a request.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ErrorResult {
    /// Machine-readable error code (e.g. `E_UNKNOWN_CHILD`).
    pub code: String,
    /// Human-readable error message.
    pub message: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    /// AC3: Rust → wire (TS-shaped JSON) → Rust round-trips losslessly for
    /// every variant of the v1.0 message set.
    #[test]
    fn round_trips_all_request_variants() {
        let cases = [
            IpcRequest::Spawn(SpawnRequest {
                child_id: "studio".into(),
                program: "/usr/bin/node".into(),
                args: vec!["build/index.js".into()],
                env: vec![EnvPair {
                    key: "PORT".into(),
                    value: "3456".into(),
                }],
                cwd: Some("/srv/studio".into()),
            }),
            IpcRequest::Restart(RestartRequest {
                child_id: "studio".into(),
            }),
            IpcRequest::Monitor(MonitorRequest {
                child_id: Some("studio".into()),
            }),
            IpcRequest::Health(HealthRequest {}),
        ];
        for req in cases {
            let env = IpcEnvelope::request("req-1", req.clone());
            let line = env.to_ndjson().expect("serialize");
            assert!(!line.contains('\n'), "NDJSON line must be single-line");
            let back = IpcEnvelope::from_ndjson(&line).expect("deserialize");
            assert_eq!(env, back);
        }
    }

    #[test]
    fn round_trips_all_response_variants() {
        let cases = [
            IpcResponse::Spawned(SpawnResult {
                child_id: "studio".into(),
                pid: 4242,
            }),
            IpcResponse::Restarted(RestartResult {
                child_id: "studio".into(),
                pid: 4243,
                restart_count: 1,
            }),
            IpcResponse::Monitor(MonitorResult {
                children: vec![ChildStatus {
                    child_id: "studio".into(),
                    pid: 4243,
                    state: ChildState::Running,
                    restart_count: 1,
                }],
            }),
            IpcResponse::Health(HealthResult {
                pid: 100,
                child_count: 1,
                uptime_secs: 60,
                protocol_version: IPC_PROTOCOL_VERSION.into(),
            }),
            IpcResponse::Event(LifecycleEvent {
                event: LifecycleEventKind::ChildRestarted,
                child_id: "studio".into(),
                exit_code: Some(1),
                signal: None,
                restart_delay_ms: Some(2000),
            }),
            IpcResponse::Error(ErrorResult {
                code: "E_UNKNOWN_CHILD".into(),
                message: "no such child".into(),
            }),
        ];
        for resp in cases {
            let env = IpcEnvelope::response("req-1", resp.clone());
            let line = env.to_ndjson().expect("serialize");
            let back = IpcEnvelope::from_ndjson(&line).expect("deserialize");
            assert_eq!(env, back);
        }
    }

    #[test]
    fn envelope_carries_frozen_protocol_version() {
        let env = IpcEnvelope::request("x", IpcRequest::Health(HealthRequest {}));
        assert_eq!(env.protocol_version, IPC_PROTOCOL_VERSION);
    }

    /// Confirms the JSON shape a TS Zod peer expects: a discriminated union on
    /// `kind`, wrapped by `direction` + `protocol_version` + `id`.
    #[test]
    fn json_shape_matches_ts_contract() {
        let env = IpcEnvelope::request(
            "abc",
            IpcRequest::Spawn(SpawnRequest {
                child_id: "w1".into(),
                program: "/bin/true".into(),
                args: vec![],
                env: vec![],
                cwd: None,
            }),
        );
        let value: serde_json::Value =
            serde_json::from_str(&env.to_ndjson().expect("ser")).expect("json");
        // We use snake_case keys, so a camelCase `protocolVersion` must be absent.
        assert!(!value["protocolVersion"].is_string());
        assert_eq!(value["protocol_version"], IPC_PROTOCOL_VERSION);
        assert_eq!(value["id"], "abc");
        assert_eq!(value["direction"], "request");
        assert_eq!(value["request"]["kind"], "spawn");
        assert_eq!(value["request"]["child_id"], "w1");
    }
}
