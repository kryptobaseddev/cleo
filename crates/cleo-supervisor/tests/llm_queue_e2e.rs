// SPDX-License-Identifier: MIT
// Copyright (c) 2026 kryptobaseddev
//
// This file is part of crates/cleo-supervisor in the CleoCode monorepo.

//! End-to-end `queue_admit` v1.1 fast-path test (T11630).
//!
//! Proves the LLM-queue admission path over the REAL Unix-domain socket:
//!
//!   1. Bind the supervisor IPC `UnixListener` with a v1.1 [`LeaseArbiter`] whose
//!      [`LlmQueue`] has a tiny provider budget configured.
//!   2. A v1.1 client sends `queue_admit` and observes a `queue_admit_result`:
//!      the first call is `admitted`, a budget-exhausting second is `deferred`
//!      with a `retry_after_ms` back-off — AC4, never a silent drop.
//!   3. **In the SAME accept loop**, a v1.0 `Health` client observes the
//!      unchanged `Health` response — the version router leaves v1.0 untouched
//!      (the freeze invariant).
//!
//! The whole flow runs over a real Unix socket — no in-memory shim — so a green
//! run is direct evidence the version-routing accept loop + queue-admit path is
//! wired without disturbing the frozen v1.0 contract. Windows uses a named-pipe
//! transport not yet implemented in this crate, so the test is `cfg(unix)`-gated.

#![cfg(unix)]
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::sync::Arc;
use std::time::Duration;

use cleo_supervisor::ipc::{IpcEnvelope, IpcPayload, IpcRequest, IpcResponse};
use cleo_supervisor::ipc_server;
use cleo_supervisor::lease_handler::{LeaseArbiter, ScopeDbResolver};
use cleo_supervisor::lease_ipc::{
    LeaseEnvelope, LeasePayload, LeaseRequest, LeaseResponse, QueueAdmitDisposition, QueueAdmitReq,
    QueuePriorityClass, LEASE_IPC_PROTOCOL_VERSION,
};
use cleo_supervisor::llm_queue::LlmQueue;
use cleo_supervisor::supervisor::ChildRegistry;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::UnixStream;
use tokio::sync::mpsc::unbounded_channel;

/// Read the next NDJSON line from the client connection, failing the test if the
/// stream closes or stalls.
async fn read_line<R>(lines: &mut tokio::io::Lines<BufReader<R>>) -> String
where
    R: tokio::io::AsyncRead + Unpin,
{
    tokio::time::timeout(Duration::from_secs(5), lines.next_line())
        .await
        .expect("timed out waiting for an IPC line")
        .expect("read error on client stream")
        .expect("server closed the connection before responding")
}

/// Write one NDJSON line + flush to the client write half.
async fn write_line(write: &mut tokio::net::unix::OwnedWriteHalf, line: &str) {
    let mut buf = line.to_string();
    buf.push('\n');
    write.write_all(buf.as_bytes()).await.expect("write line");
    write.flush().await.expect("flush");
}

/// AC1+AC2+AC4+freeze: bind with a lease arbiter whose LLM queue has a tiny
/// budget; prove `queue_admit` admits then defers over the socket, and a v1.0
/// `Health` client in the SAME loop is unaffected.
#[tokio::test]
async fn queue_admit_over_socket_admits_then_defers_v1_0_unaffected() {
    let dir = tempfile::tempdir().expect("tempdir");
    // The arbiter needs SOME resolver, but queue_admit never touches the DB; a
    // resolver that yields a temp path is sufficient (and never opened here).
    let db_path = dir.path().join("cleo.db");
    let resolved = db_path.clone();
    let resolver: ScopeDbResolver = Arc::new(move |_scope| Ok(resolved.clone()));

    // Seed a tiny anthropic budget so the SECOND admit is forced to defer.
    let queue = LlmQueue::new();
    queue.configure_provider("anthropic", 100, 10, 60_000);
    let arbiter = LeaseArbiter::with_llm_queue(resolver, queue);

    let socket_path = dir.path().join("cleo-supervisor.sock");
    let (event_tx, event_rx) = unbounded_channel();
    let registry = ChildRegistry::new(event_tx);
    let serve_socket = socket_path.clone();
    let server = tokio::spawn(async move {
        let _ =
            ipc_server::serve_with_lease(&serve_socket, registry, event_rx, Some(arbiter)).await;
    });

    let mut bound = false;
    for _ in 0..200 {
        if socket_path.exists() {
            bound = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert!(bound, "supervisor never bound the IPC socket");

    // ── v1.1 client: first queue_admit (lead, 80 tokens) → admitted ──────────
    let stream = UnixStream::connect(&socket_path)
        .await
        .expect("v1.1 connect");
    let (read, mut write) = stream.into_split();
    let mut lines = BufReader::new(read).lines();

    let admit1 = LeaseEnvelope::request(
        "qadmit-1",
        LeaseRequest::QueueAdmit(QueueAdmitReq {
            provider: "anthropic".into(),
            priority_class: QueuePriorityClass::Lead,
            est_tokens: 80,
            child_id: "lead-1".into(),
        }),
    );
    write_line(&mut write, &admit1.to_ndjson().expect("ser admit1")).await;
    let line1 = read_line(&mut lines).await;
    let env1 = LeaseEnvelope::from_ndjson(&line1).expect("parse admit1 result");
    assert_eq!(
        env1.protocol_version, LEASE_IPC_PROTOCOL_VERSION,
        "v1.x response framing"
    );
    assert_eq!(env1.id, "qadmit-1", "correlation id echoed");
    match env1.payload {
        LeasePayload::Response {
            response: LeaseResponse::QueueAdmitResult(r),
        } => {
            assert_eq!(r.disposition, QueueAdmitDisposition::Admitted);
            assert_eq!(r.retry_after_ms, 0);
            assert_eq!(r.tokens_remaining, 20, "80 of 100 tokens debited");
        }
        other => panic!("expected admitted queue_admit_result, got {other:?}"),
    }

    // ── v1.0 client (DIFFERENT connection, SAME accept loop): Health unaffected ─
    let v10_stream = UnixStream::connect(&socket_path)
        .await
        .expect("v1.0 connect");
    let (v10_read, mut v10_write) = v10_stream.into_split();
    let mut v10_lines = BufReader::new(v10_read).lines();
    let health = IpcEnvelope::request(
        "health-1",
        IpcRequest::Health(cleo_supervisor::ipc::HealthRequest {}),
    );
    write_line(&mut v10_write, &health.to_ndjson().expect("ser health")).await;
    let health_line = read_line(&mut v10_lines).await;
    let health_env = IpcEnvelope::from_ndjson(&health_line).expect("parse v1.0 health envelope");
    assert_eq!(
        health_env.protocol_version, "1.0.0",
        "v1.0 framing untouched"
    );
    match health_env.payload {
        IpcPayload::Response {
            response: IpcResponse::Health(h),
        } => {
            assert_eq!(h.protocol_version, "1.0.0");
            assert!(h.pid > 0);
        }
        other => panic!("expected v1.0 Health response, got {other:?}"),
    }

    // ── v1.1 client: second queue_admit (worker, 50 tokens) → DEFERRED ───────
    let admit2 = LeaseEnvelope::request(
        "qadmit-2",
        LeaseRequest::QueueAdmit(QueueAdmitReq {
            provider: "anthropic".into(),
            priority_class: QueuePriorityClass::Worker,
            est_tokens: 50,
            child_id: "worker-1".into(),
        }),
    );
    write_line(&mut write, &admit2.to_ndjson().expect("ser admit2")).await;
    let line2 = read_line(&mut lines).await;
    let env2 = LeaseEnvelope::from_ndjson(&line2).expect("parse admit2 result");
    match env2.payload {
        LeasePayload::Response {
            response: LeaseResponse::QueueAdmitResult(r),
        } => {
            assert_eq!(
                r.disposition,
                QueueAdmitDisposition::Deferred,
                "over-budget admit is deferred (AC4)"
            );
            assert!(
                r.retry_after_ms >= 1,
                "a deferral carries a positive back-off"
            );
        }
        other => panic!("expected deferred queue_admit_result, got {other:?}"),
    }

    server.abort();
}
