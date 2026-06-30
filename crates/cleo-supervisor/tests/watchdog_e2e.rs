// SPDX-License-Identifier: MIT
// Copyright (c) 2026 kryptobaseddev
//
// This file is part of crates/cleo-supervisor in the CleoCode monorepo.

//! End-to-end watchdog heartbeat test over the REAL Unix-domain socket (T11628).
//!
//! Proves the v1.1 `worker_heartbeat` verb works through the supervisor accept
//! loop with a watchdog-backed lease arbiter:
//!
//!   1. Bind the supervisor IPC `UnixListener` with a [`LeaseArbiter`] whose
//!      shared heartbeat sink IS the [`Watchdog`]'s ledger
//!      ([`cleo_supervisor::ipc_server::serve_with_lease`]).
//!   2. A v1.1 client sends `worker_heartbeat` and observes a `heartbeat_ack`
//!      response — and the beat is visible in the watchdog's ledger (the child
//!      is no longer a stale candidate even past a tiny deadline).
//!   3. **In the SAME accept loop**, a v1.0 client sends a `Health` request and
//!      observes the unchanged `Health` response — proving the new verb leaves
//!      v1.0 clients completely unaffected (the freeze invariant).
//!
//! The whole flow runs over a real Unix socket — no in-memory shim — so a green
//! run is direct evidence the `worker_heartbeat` path is wired without disturbing
//! the frozen v1.0 contract. Windows uses a named-pipe transport not yet
//! implemented in this crate, so the test is `cfg(unix)`-gated.

#![cfg(unix)]
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::sync::Arc;
use std::time::Duration;

use cleo_supervisor::ipc::{IpcEnvelope, IpcPayload, IpcRequest, IpcResponse};
use cleo_supervisor::ipc_server;
use cleo_supervisor::lease_handler::{LeaseArbiter, ScopeDbResolver};
use cleo_supervisor::lease_ipc::{
    LeaseEnvelope, LeasePayload, LeaseRequest, LeaseResponse, WorkerHeartbeatReq,
    LEASE_IPC_PROTOCOL_VERSION,
};
use cleo_supervisor::llm_queue::LlmQueue;
use cleo_supervisor::supervisor::ChildRegistry;
use cleo_supervisor::watchdog::Watchdog;
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

/// AC1: a `worker_heartbeat` over the socket is acked, recorded in the shared
/// watchdog ledger, AND a v1.0 `Health` on the same accept loop is unaffected.
#[tokio::test]
async fn worker_heartbeat_over_socket_acks_and_v1_0_unaffected() {
    let dir = tempfile::tempdir().expect("tempdir");
    let socket_path = dir.path().join("cleo-supervisor.sock");

    // The watchdog's ledger IS the arbiter's heartbeat sink — a beat received
    // over the socket lands where the sweep reads it.
    let watchdog = Watchdog::with_deadlines(
        LlmQueue::new(),
        Duration::from_millis(1),
        Duration::from_secs(600),
    );
    let sink = watchdog.sink();
    // The arbiter needs a scope resolver, but the heartbeat path never opens a DB.
    let resolver: ScopeDbResolver = Arc::new(|_scope| Ok(std::path::PathBuf::from("/dev/null")));
    let arbiter = LeaseArbiter::new(resolver).with_heartbeat_sink(sink);

    let (event_tx, event_rx) = unbounded_channel();
    let registry = ChildRegistry::new(event_tx);
    let serve_socket = socket_path.clone();
    let server = tokio::spawn(async move {
        let _ = ipc_server::serve_with_lease(&serve_socket, registry, event_rx, Some(arbiter)).await;
    });

    // Wait for the socket to appear (bind completed).
    let mut bound = false;
    for _ in 0..200 {
        if socket_path.exists() {
            bound = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert!(bound, "supervisor never bound the IPC socket");

    // ── v1.1 client: worker_heartbeat → heartbeat_ack ────────────────────────
    let stream = UnixStream::connect(&socket_path).await.expect("v1.1 connect");
    let (read, mut write) = stream.into_split();
    let mut lines = BufReader::new(read).lines();

    let hb = LeaseEnvelope::request(
        "hb-1",
        LeaseRequest::WorkerHeartbeat(WorkerHeartbeatReq {
            child_id: "worker-7".into(),
            in_flight_llm: false,
        }),
    );
    write_line(&mut write, &hb.to_ndjson().expect("ser heartbeat")).await;

    let ack_line = read_line(&mut lines).await;
    let ack = LeaseEnvelope::from_ndjson(&ack_line).expect("parse ack envelope");
    assert_eq!(
        ack.protocol_version, LEASE_IPC_PROTOCOL_VERSION,
        "v1.x response framing"
    );
    assert_eq!(ack.id, "hb-1", "correlation id echoed");
    assert!(
        matches!(
            ack.payload,
            LeasePayload::Response {
                response: LeaseResponse::HeartbeatAck(_)
            }
        ),
        "a worker_heartbeat is acknowledged with heartbeat_ack",
    );

    // The beat is recorded in the shared ledger: even past the 1ms deadline the
    // child is NOT a stale candidate immediately after the beat.
    assert!(
        watchdog
            .stale_candidates(&["worker-7".to_string()])
            .is_empty(),
        "the heartbeat reset the child's deadline clock in the shared ledger"
    );

    // ── v1.0 client (DIFFERENT connection, SAME accept loop): Health unaffected ─
    let v10_stream = UnixStream::connect(&socket_path).await.expect("v1.0 connect");
    let (v10_read, mut v10_write) = v10_stream.into_split();
    let mut v10_lines = BufReader::new(v10_read).lines();
    let health = IpcEnvelope::request(
        "health-1",
        IpcRequest::Health(cleo_supervisor::ipc::HealthRequest {}),
    );
    write_line(&mut v10_write, &health.to_ndjson().expect("ser health")).await;
    let health_line = read_line(&mut v10_lines).await;
    let health_env = IpcEnvelope::from_ndjson(&health_line).expect("parse v1.0 health envelope");
    assert_eq!(health_env.protocol_version, "1.0.0", "v1.0 framing untouched");
    match health_env.payload {
        IpcPayload::Response {
            response: IpcResponse::Health(h),
        } => {
            assert_eq!(h.protocol_version, "1.0.0");
            assert!(h.pid > 0);
        }
        other => panic!("expected v1.0 Health response, got {other:?}"),
    }

    server.abort();
}

/// A `worker_heartbeat` to an accept loop with NO watchdog sink wired still acks
/// (the worker degrades gracefully) — it just records nothing.
#[tokio::test]
async fn worker_heartbeat_without_watchdog_sink_still_acks() {
    let dir = tempfile::tempdir().expect("tempdir");
    let socket_path = dir.path().join("cleo-supervisor.sock");

    // Arbiter with NO heartbeat sink (watchdog not enabled).
    let resolver: ScopeDbResolver = Arc::new(|_scope| Ok(std::path::PathBuf::from("/dev/null")));
    let arbiter = LeaseArbiter::new(resolver);

    let (event_tx, event_rx) = unbounded_channel();
    let registry = ChildRegistry::new(event_tx);
    let serve_socket = socket_path.clone();
    let server = tokio::spawn(async move {
        let _ = ipc_server::serve_with_lease(&serve_socket, registry, event_rx, Some(arbiter)).await;
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

    let stream = UnixStream::connect(&socket_path).await.expect("connect");
    let (read, mut write) = stream.into_split();
    let mut lines = BufReader::new(read).lines();
    let hb = LeaseEnvelope::request(
        "hb-noop",
        LeaseRequest::WorkerHeartbeat(WorkerHeartbeatReq {
            child_id: "w".into(),
            in_flight_llm: true,
        }),
    );
    write_line(&mut write, &hb.to_ndjson().expect("ser")).await;
    let line = read_line(&mut lines).await;
    let env = LeaseEnvelope::from_ndjson(&line).expect("parse");
    assert!(
        matches!(
            env.payload,
            LeasePayload::Response {
                response: LeaseResponse::HeartbeatAck(_)
            }
        ),
        "a heartbeat still acks even without a watchdog sink wired",
    );

    server.abort();
}
