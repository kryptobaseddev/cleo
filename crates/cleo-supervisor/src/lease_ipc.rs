// SPDX-License-Identifier: MIT
// Copyright (c) 2026 kryptobaseddev
//
// This file is part of crates/cleo-supervisor in the CleoCode monorepo.

//! `lease-ipc` v1.1 — Rust side of the PARALLEL `DbWriterLease` IPC contract (T11627 ST-1).
//!
//! This module ships a **v1.1 union that runs in parallel** to the byte-frozen
//! v1.0 [`crate::ipc`] contract. The v1.0 module is NOT edited — its
//! `IPC_PROTOCOL_VERSION = "1.0.0"`, its `IpcRequest`/`IpcResponse` "10-tuple",
//! and its freeze `mod tests` all stay green. The two protocols are
//! distinguished on the wire purely by the [`LeaseEnvelope::protocol_version`]
//! string ([`LEASE_IPC_PROTOCOL_VERSION`] = `"1.1.0"`), so a single accept loop
//! can route `"1.0.0"` → [`crate::ipc::IpcRequest`] and `"1.1.0"` →
//! [`LeaseRequest`] (the version router lands with the T11626 listener / ST-5).
//!
//! These serde types are the byte-for-byte mirror of the Zod schemas in
//! `packages/contracts/src/lease-ipc/`. The wire format is newline-delimited
//! JSON (NDJSON): one [`LeaseEnvelope`] per line — identical framing to v1.0,
//! only the version string and the inner union differ.
//!
//! ## Staged delivery
//!
//! Per the ratified spec (§1.2 graft 4) the union *declares* every kind so the
//! protocol freeze is stable, but only `lease_acquire` / `lease_release` /
//! `lease_renew` are wired in the first cut. The speculative `rate_check` /
//! `tool_grant` request kinds are declared so the protocol never needs a second
//! version bump; their handlers are deferred and return `E_LEASE_UNIMPLEMENTED`
//! until a follow-up task. This module (ST-1) ships the **protocol surface with
//! no consumer** — zero behavior change.

use serde::{Deserialize, Serialize};

/// PARALLEL protocol version for the `DbWriterLease` IPC contract.
///
/// MUST equal the `LEASE_IPC_PROTOCOL_VERSION` const in the TS contract
/// (`packages/contracts/src/lease-ipc/version.ts`). The schema-drift guard test
/// (`lease_ipc::tests`) and the TS drift test both pin this value; bump only via
/// a coordinated dual (Rust + TS) edit, never in place. It is intentionally a
/// *different string* from [`crate::ipc::IPC_PROTOCOL_VERSION`] so a shared
/// accept loop can route the two contracts apart on the wire.
pub const LEASE_IPC_PROTOCOL_VERSION: &str = "1.1.0";

/// The cleo.db scope a lease is arbitrated within. Mirrors `LeaseScope` in TS.
///
/// Under the dual-cleo.db split, a `Project` lease lives inside the project's
/// `cleo.db` and a `Global` lease inside the global `cleo.db` — different files,
/// so they never serialize against each other (AC2).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DbScope {
    /// The project-local cleo.db scope.
    Project,
    /// The global (user-home) cleo.db scope.
    Global,
}

/// The write lane a lease arbitrates within a single scope file. Mirrors
/// `LeaseLane` in TS.
///
/// Lanes let the brain writer (AC4) and bulk bypass writers hold leases
/// independently of the `tasks` chokepoint within one scope file.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LeaseLane {
    /// The primary task-chokepoint write lane.
    Tasks,
    /// The BRAIN memory write lane (gated separately — AC4).
    Brain,
    /// The bulk / bypass-writer lane (conduit, telemetry, nexus graph, …).
    Bulk,
}

/// A client → arbiter lease request.
///
/// Tagged by `kind` so the JSON shape matches the Zod discriminated union
/// (`{ "kind": "lease_acquire", ... }`), mirroring serde
/// `#[serde(tag = "kind")]`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum LeaseRequest {
    /// Acquire (or re-enter) the writer lease for a (scope, lane). `[v1 core]`
    LeaseAcquire(LeaseAcquireReq),
    /// Release the held writer lease. `[v1 core]`
    LeaseRelease(LeaseReleaseReq),
    /// Heartbeat / renew the held lease's TTL. `[v1 core]`
    LeaseRenew(LeaseRenewReq),
    /// Check the per-scope write rate budget. `[declared; handler deferred]`
    RateCheck(RateCheckReq),
    /// Request a tool-use grant. `[declared; handler deferred]`
    ToolGrant(ToolGrantReq),
    /// Admit (or defer) an outbound LLM call through the priority scheduler +
    /// per-provider rate governor (T11630 · AC1-AC4). `[wired]`
    QueueAdmit(QueueAdmitReq),
}

/// An arbiter → client lease response or unsolicited event.
///
/// Tagged by `kind`, mirroring serde `#[serde(tag = "kind")]` on the TS union.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum LeaseResponse {
    /// The lease was granted to the caller.
    LeaseGranted(LeaseGranted),
    /// The caller was placed in the per-scope FIFO+priority queue.
    LeaseQueued(LeaseQueued),
    /// The acquire was denied (e.g. `require` mode with no arbiter).
    LeaseDenied(LeaseDenied),
    /// Reply to a deferred `rate_check` (handler returns `E_LEASE_UNIMPLEMENTED`).
    RateResult(RateResult),
    /// Reply to a deferred `tool_grant` (handler returns `E_LEASE_UNIMPLEMENTED`).
    ToolGranted(ToolGranted),
    /// Unsolicited event: a held lease was revoked (Fanout broadcast, fresh id).
    LeaseRevoked(LeaseRevoked),
    /// Unsolicited event: a lease holder was killed for being unresponsive.
    ChildKilledUnresponsive(ChildKilled),
    /// Reply to a `queue_admit`: the LLM call was admitted or deferred (T11630).
    QueueAdmitResult(QueueAdmitResult),
    /// An error response correlated to a request id. Reuses the v1.0
    /// [`crate::ipc::ErrorResult`] shape so error framing is shared across both
    /// protocol versions.
    Error(crate::ipc::ErrorResult),
}

/// Top-level lease IPC envelope: a versioned, correlated wrapper carrying either
/// a request or a response. One envelope per NDJSON line.
///
/// This is a sibling of [`crate::ipc::IpcEnvelope`] with the identical
/// `protocol_version` / `id` / `direction`-flatten shape — keeping the v1.0
/// envelope literally frozen while reusing its exact wire framing. Only the
/// version string and inner union differ.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LeaseEnvelope {
    /// Protocol version. MUST be [`LEASE_IPC_PROTOCOL_VERSION`] for v1.1 peers.
    pub protocol_version: String,
    /// Correlation id echoed between a request and its response.
    pub id: String,
    /// The payload — a request from a client or a response from the arbiter.
    #[serde(flatten)]
    pub payload: LeasePayload,
}

/// Discriminates whether the lease envelope carries a request or a response.
///
/// Mirrors [`crate::ipc::IpcPayload`] (`#[serde(tag = "direction")]`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "direction", rename_all = "snake_case")]
pub enum LeasePayload {
    /// A client → arbiter request.
    Request {
        /// The request body.
        request: LeaseRequest,
    },
    /// An arbiter → client response or event.
    Response {
        /// The response body.
        response: LeaseResponse,
    },
}

impl LeaseEnvelope {
    /// Build a request envelope stamped with the parallel protocol version.
    #[must_use]
    pub fn request(id: impl Into<String>, request: LeaseRequest) -> Self {
        Self {
            protocol_version: LEASE_IPC_PROTOCOL_VERSION.to_string(),
            id: id.into(),
            payload: LeasePayload::Request { request },
        }
    }

    /// Build a response envelope stamped with the parallel protocol version.
    #[must_use]
    pub fn response(id: impl Into<String>, response: LeaseResponse) -> Self {
        Self {
            protocol_version: LEASE_IPC_PROTOCOL_VERSION.to_string(),
            id: id.into(),
            payload: LeasePayload::Response { response },
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

    /// Parse one NDJSON line into a lease envelope.
    ///
    /// # Errors
    ///
    /// Returns a `serde_json` error if the line is not a valid envelope.
    pub fn from_ndjson(line: &str) -> Result<Self, serde_json::Error> {
        serde_json::from_str(line.trim())
    }
}

// ─── Request payloads ───────────────────────────────────────────────────────

/// Acquire (or re-enter) the writer lease for a (scope, lane). Mirrors
/// `LeaseAcquireReq`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LeaseAcquireReq {
    /// The cleo.db scope being arbitrated.
    pub scope: DbScope,
    /// The write lane within the scope.
    pub lane: LeaseLane,
    /// Process+lane holder identity.
    pub holder_id: String,
    /// Advisory priority — lower acquires sooner. `0` = highest.
    pub priority: u8,
    /// Lease time-to-live in milliseconds.
    pub ttl_ms: u64,
    /// When true, a same-holder acquire re-enters (refcount++) rather than
    /// queuing.
    pub reentrant: bool,
}

/// Release the held writer lease. Mirrors `LeaseReleaseReq`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LeaseReleaseReq {
    /// The cleo.db scope being arbitrated.
    pub scope: DbScope,
    /// The write lane within the scope.
    pub lane: LeaseLane,
    /// Process+lane holder identity.
    pub holder_id: String,
    /// The epoch fence the holder acquired — a stale epoch no-ops (the lease was
    /// already reclaimed).
    pub epoch: u64,
}

/// Heartbeat / renew the held lease's TTL. Mirrors `LeaseRenewReq`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LeaseRenewReq {
    /// The cleo.db scope being arbitrated.
    pub scope: DbScope,
    /// The write lane within the scope.
    pub lane: LeaseLane,
    /// Process+lane holder identity.
    pub holder_id: String,
    /// The epoch fence the holder acquired (epoch-guarded renew).
    pub epoch: u64,
}

/// Check the per-scope write rate budget. Mirrors `RateCheckReq`.
/// Handler deferred — returns `E_LEASE_UNIMPLEMENTED` until a follow-up task.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RateCheckReq {
    /// The cleo.db scope being checked.
    pub scope: DbScope,
    /// The write lane within the scope.
    pub lane: LeaseLane,
    /// Estimated bytes the caller intends to write.
    pub est_bytes: u64,
}

/// Request a tool-use grant. Mirrors `ToolGrantReq`.
/// Handler deferred — returns `E_LEASE_UNIMPLEMENTED` until a follow-up task.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ToolGrantReq {
    /// The tool name being requested.
    pub tool: String,
    /// The requesting holder identity.
    pub holder_id: String,
}

/// The priority class of a `queue_admit` request.
///
/// Mirrors the TS `QueuePriorityClass` enum and
/// `cleo_supervisor::llm_queue::PriorityClass`. `lead > worker > background` — a
/// lead is never starved by background work.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum QueuePriorityClass {
    /// A lead/orchestrator agent — highest priority.
    Lead,
    /// A worker agent — normal priority.
    Worker,
    /// Background consolidation / dreaming — lowest priority.
    Background,
}

/// Admit (or defer) an outbound LLM call through the priority scheduler +
/// per-provider rate governor (T11630 · AC1-AC4). Mirrors `QueueAdmitReq`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct QueueAdmitReq {
    /// The LLM provider id the call targets (rate budget is per-provider).
    pub provider: String,
    /// The caller's priority class (lead > worker > background).
    pub priority_class: QueuePriorityClass,
    /// The caller's estimate of the request's token cost (debited on admit).
    pub est_tokens: u64,
    /// The child the call belongs to (in-flight tracking — the watchdog seam).
    pub child_id: String,
}

// ─── Response payloads ──────────────────────────────────────────────────────

/// The lease was granted to the caller. Mirrors `LeaseGranted`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LeaseGranted {
    /// The granted cleo.db scope.
    pub scope: DbScope,
    /// The granted write lane.
    pub lane: LeaseLane,
    /// The holder the lease was granted to.
    pub holder_id: String,
    /// The monotonic epoch fence assigned to this grant.
    pub epoch: u64,
    /// The lease TTL in milliseconds.
    pub ttl_ms: u64,
    /// Absolute expiry timestamp (epoch ms) for this grant.
    pub expires_at_ms: u64,
}

/// The caller was placed in the per-scope FIFO+priority queue. Mirrors
/// `LeaseQueued`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LeaseQueued {
    /// The queued cleo.db scope.
    pub scope: DbScope,
    /// The queued write lane.
    pub lane: LeaseLane,
    /// The monotonic ticket assigned for FIFO tiebreak.
    pub ticket: i64,
    /// Number of waiters ahead of this one.
    pub ahead: u32,
}

/// The acquire was denied. Mirrors `LeaseDenied`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LeaseDenied {
    /// The denied cleo.db scope.
    pub scope: DbScope,
    /// Machine-readable denial code (e.g. `E_LEASE_UNAVAILABLE`).
    pub code: String,
    /// Human-readable denial message.
    pub message: String,
}

/// Reply to a deferred `rate_check`. Mirrors `RateResult`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RateResult {
    /// The checked cleo.db scope.
    pub scope: DbScope,
    /// Whether the write is within budget.
    pub ok: bool,
    /// Suggested back-off in milliseconds when `ok` is false.
    pub retry_after_ms: u64,
    /// Remaining token budget for the scope.
    pub tokens_remaining: u64,
}

/// Reply to a deferred `tool_grant`. Mirrors `ToolGranted`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ToolGranted {
    /// The granted tool name.
    pub tool: String,
    /// The holder the tool grant was issued to.
    pub holder_id: String,
}

/// The disposition of a `queue_admit` request (T11630).
///
/// Mirrors `QueueAdmitDisposition` in TS — `admitted` (execute now) or
/// `deferred` (back off `retry_after_ms` and re-request; AC4 — never a silent
/// drop).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum QueueAdmitDisposition {
    /// The call is admitted — execute it now.
    Admitted,
    /// The call is deferred — wait `retry_after_ms` and re-request.
    Deferred,
}

/// Reply to a `queue_admit`. Mirrors `QueueAdmitResult` (T11630).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct QueueAdmitResult {
    /// Whether the LLM call was admitted or deferred.
    pub disposition: QueueAdmitDisposition,
    /// Back-off in ms before re-requesting (0 when admitted).
    pub retry_after_ms: u64,
    /// Remaining provider token budget after this decision.
    pub tokens_remaining: u64,
    /// Number of higher/equal-priority waiters ahead (0 when admitted).
    pub queue_position: u32,
}

/// Unsolicited event: a held lease was revoked. Mirrors `LeaseRevoked`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LeaseRevoked {
    /// The revoked cleo.db scope.
    pub scope: DbScope,
    /// The revoked write lane.
    pub lane: LeaseLane,
    /// The holder whose lease was revoked.
    pub holder_id: String,
    /// Human-readable reason for the revocation.
    pub reason: String,
}

/// Unsolicited event: a lease holder was killed for being unresponsive. Mirrors
/// `ChildKilled`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChildKilled {
    /// Logical id of the killed child.
    pub child_id: String,
    /// The holder identity the killed child held the lease as.
    pub holder_id: String,
    /// The cleo.db scope the killed child held the lease in.
    pub scope: DbScope,
    /// Human-readable reason for the kill.
    pub reason: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The FROZEN v1.1 request `kind` values, in declaration order. The
    /// schema-drift guard pins this tuple; any addition/removal is a
    /// contract-breaking change requiring a coordinated dual edit.
    const LEASE_REQUEST_KINDS: [&str; 6] = [
        "lease_acquire",
        "lease_release",
        "lease_renew",
        "rate_check",
        "tool_grant",
        "queue_admit",
    ];

    /// The FROZEN v1.1 response `kind` values, in declaration order.
    const LEASE_RESPONSE_KINDS: [&str; 9] = [
        "lease_granted",
        "lease_queued",
        "lease_denied",
        "rate_result",
        "tool_granted",
        "lease_revoked",
        "child_killed_unresponsive",
        "queue_admit_result",
        "error",
    ];

    fn sample_requests() -> Vec<LeaseRequest> {
        vec![
            LeaseRequest::LeaseAcquire(LeaseAcquireReq {
                scope: DbScope::Project,
                lane: LeaseLane::Tasks,
                holder_id: "pid-42:tasks".into(),
                priority: 0,
                ttl_ms: 30_000,
                reentrant: true,
            }),
            LeaseRequest::LeaseRelease(LeaseReleaseReq {
                scope: DbScope::Project,
                lane: LeaseLane::Tasks,
                holder_id: "pid-42:tasks".into(),
                epoch: 7,
            }),
            LeaseRequest::LeaseRenew(LeaseRenewReq {
                scope: DbScope::Global,
                lane: LeaseLane::Brain,
                holder_id: "pid-42:brain".into(),
                epoch: 7,
            }),
            LeaseRequest::RateCheck(RateCheckReq {
                scope: DbScope::Global,
                lane: LeaseLane::Bulk,
                est_bytes: 4096,
            }),
            LeaseRequest::ToolGrant(ToolGrantReq {
                tool: "browser".into(),
                holder_id: "pid-42:tasks".into(),
            }),
            LeaseRequest::QueueAdmit(QueueAdmitReq {
                provider: "anthropic".into(),
                priority_class: QueuePriorityClass::Lead,
                est_tokens: 1024,
                child_id: "worker-1".into(),
            }),
        ]
    }

    fn sample_responses() -> Vec<LeaseResponse> {
        vec![
            LeaseResponse::LeaseGranted(LeaseGranted {
                scope: DbScope::Project,
                lane: LeaseLane::Tasks,
                holder_id: "pid-42:tasks".into(),
                epoch: 7,
                ttl_ms: 30_000,
                expires_at_ms: 1_000_030_000,
            }),
            LeaseResponse::LeaseQueued(LeaseQueued {
                scope: DbScope::Project,
                lane: LeaseLane::Tasks,
                ticket: 3,
                ahead: 2,
            }),
            LeaseResponse::LeaseDenied(LeaseDenied {
                scope: DbScope::Global,
                code: "E_LEASE_UNAVAILABLE".into(),
                message: "no arbiter in require mode".into(),
            }),
            LeaseResponse::RateResult(RateResult {
                scope: DbScope::Global,
                ok: false,
                retry_after_ms: 250,
                tokens_remaining: 0,
            }),
            LeaseResponse::ToolGranted(ToolGranted {
                tool: "browser".into(),
                holder_id: "pid-42:tasks".into(),
            }),
            LeaseResponse::LeaseRevoked(LeaseRevoked {
                scope: DbScope::Project,
                lane: LeaseLane::Tasks,
                holder_id: "pid-42:tasks".into(),
                reason: "ttl expired".into(),
            }),
            LeaseResponse::ChildKilledUnresponsive(ChildKilled {
                child_id: "worker-1".into(),
                holder_id: "pid-42:tasks".into(),
                scope: DbScope::Project,
                reason: "unresponsive past ttl".into(),
            }),
            LeaseResponse::QueueAdmitResult(QueueAdmitResult {
                disposition: QueueAdmitDisposition::Deferred,
                retry_after_ms: 250,
                tokens_remaining: 0,
                queue_position: 2,
            }),
            LeaseResponse::Error(crate::ipc::ErrorResult {
                code: "E_LEASE_BAD_VERSION".into(),
                message: "unsupported protocol".into(),
            }),
        ]
    }

    /// The serde `kind` tag emitted for a request variant.
    fn request_kind(req: &LeaseRequest) -> String {
        let v: serde_json::Value = serde_json::to_value(req).expect("to_value");
        v["kind"].as_str().expect("kind").to_string()
    }

    /// The serde `kind` tag emitted for a response variant.
    fn response_kind(resp: &LeaseResponse) -> String {
        let v: serde_json::Value = serde_json::to_value(resp).expect("to_value");
        v["kind"].as_str().expect("kind").to_string()
    }

    #[test]
    fn pins_the_parallel_protocol_version() {
        assert_eq!(LEASE_IPC_PROTOCOL_VERSION, "1.1.0");
        // It MUST differ from the byte-frozen v1.0 contract so the accept loop
        // can route the two apart on the wire.
        assert_ne!(LEASE_IPC_PROTOCOL_VERSION, crate::ipc::IPC_PROTOCOL_VERSION);
    }

    #[test]
    fn pins_the_exact_request_kind_tuple() {
        let kinds: Vec<String> = sample_requests().iter().map(request_kind).collect();
        assert_eq!(kinds, LEASE_REQUEST_KINDS);
    }

    #[test]
    fn pins_the_exact_response_kind_tuple() {
        let kinds: Vec<String> = sample_responses().iter().map(response_kind).collect();
        assert_eq!(kinds, LEASE_RESPONSE_KINDS);
    }

    /// Rust → wire (TS-shaped JSON) → Rust round-trips losslessly for every
    /// request variant.
    #[test]
    fn round_trips_all_request_variants() {
        for req in sample_requests() {
            let env = LeaseEnvelope::request("req-1", req.clone());
            let line = env.to_ndjson().expect("serialize");
            assert!(!line.contains('\n'), "NDJSON line must be single-line");
            let back = LeaseEnvelope::from_ndjson(&line).expect("deserialize");
            assert_eq!(env, back);
        }
    }

    /// Rust → wire → Rust round-trips losslessly for every response variant.
    #[test]
    fn round_trips_all_response_variants() {
        for resp in sample_responses() {
            let env = LeaseEnvelope::response("req-1", resp.clone());
            let line = env.to_ndjson().expect("serialize");
            let back = LeaseEnvelope::from_ndjson(&line).expect("deserialize");
            assert_eq!(env, back);
        }
    }

    #[test]
    fn envelope_carries_parallel_protocol_version() {
        let env = LeaseEnvelope::request(
            "x",
            LeaseRequest::LeaseRenew(LeaseRenewReq {
                scope: DbScope::Project,
                lane: LeaseLane::Tasks,
                holder_id: "h".into(),
                epoch: 1,
            }),
        );
        assert_eq!(env.protocol_version, LEASE_IPC_PROTOCOL_VERSION);
    }

    /// Confirms the JSON shape a TS Zod peer expects: a discriminated union on
    /// `kind`, wrapped by `direction` + `protocol_version` + `id`, with
    /// snake_case enum payloads.
    #[test]
    fn json_shape_matches_ts_contract() {
        let env = LeaseEnvelope::request(
            "abc",
            LeaseRequest::LeaseAcquire(LeaseAcquireReq {
                scope: DbScope::Project,
                lane: LeaseLane::Tasks,
                holder_id: "h1".into(),
                priority: 0,
                ttl_ms: 30_000,
                reentrant: true,
            }),
        );
        let value: serde_json::Value =
            serde_json::from_str(&env.to_ndjson().expect("ser")).expect("json");
        // snake_case keys — a camelCase `protocolVersion` must be absent.
        assert!(!value["protocolVersion"].is_string());
        assert_eq!(value["protocol_version"], LEASE_IPC_PROTOCOL_VERSION);
        assert_eq!(value["id"], "abc");
        assert_eq!(value["direction"], "request");
        assert_eq!(value["request"]["kind"], "lease_acquire");
        assert_eq!(value["request"]["scope"], "project");
        assert_eq!(value["request"]["lane"], "tasks");
        assert_eq!(value["request"]["holder_id"], "h1");
        assert_eq!(value["request"]["reentrant"], true);
    }

    /// The reused v1.0 [`crate::ipc::ErrorResult`] shape carries unchanged inside
    /// a v1.1 response envelope — error framing is shared across versions.
    #[test]
    fn reuses_v1_error_result_shape() {
        let env = LeaseEnvelope::response(
            "e",
            LeaseResponse::Error(crate::ipc::ErrorResult {
                code: "E_LEASE_UNIMPLEMENTED".into(),
                message: "deferred handler".into(),
            }),
        );
        let value: serde_json::Value =
            serde_json::from_str(&env.to_ndjson().expect("ser")).expect("json");
        assert_eq!(value["response"]["kind"], "error");
        assert_eq!(value["response"]["code"], "E_LEASE_UNIMPLEMENTED");
    }
}
