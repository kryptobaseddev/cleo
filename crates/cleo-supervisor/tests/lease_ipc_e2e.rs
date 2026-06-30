// SPDX-License-Identifier: MIT
// Copyright (c) 2026 kryptobaseddev
//
// This file is part of crates/cleo-supervisor in the CleoCode monorepo.

//! End-to-end `lease-ipc` v1.1 fast-path test (T11894 / ST-5).
//!
//! Proves the supervisor fast path over the REAL Unix-domain socket:
//!
//!   1. Bind the supervisor IPC `UnixListener` with a v1.1 [`LeaseArbiter`] wired
//!      into the accept-loop version router
//!      ([`cleo_supervisor::ipc_server::serve_with_lease`]).
//!   2. A v1.1 client sends `lease_acquire` and observes a `lease_granted`
//!      response, then `lease_release` and re-`lease_acquire` to prove the row
//!      was freed — all through the socket, against the SAME persisted
//!      `_writer_leases` row the Node engine arbitrates.
//!   3. **In the SAME accept loop**, a v1.0 client sends a `Health` request and
//!      observes the unchanged `Health` response — proving the version router
//!      leaves v1.0 clients completely unaffected (the freeze invariant).
//!   4. A `rate_check` v1.1 request returns the deferred `E_LEASE_UNIMPLEMENTED`
//!      error.
//!
//! The whole flow runs over a real Unix socket — no in-memory shim — so a green
//! run is direct evidence the version-routing accept loop + lease claim path is
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
    DbScope, LeaseAcquireReq, LeaseEnvelope, LeaseLane, LeasePayload, LeaseReleaseReq, LeaseRequest,
    LeaseResponse, LEASE_IPC_PROTOCOL_VERSION,
};
use cleo_supervisor::supervisor::ChildRegistry;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::UnixStream;
use tokio::sync::mpsc::unbounded_channel;

/// Bootstrap DDL byte-equivalent to the Node `COLD_OPEN_LEASE_BOOTSTRAP_DDL` so
/// the supervisor claims against the SAME schema the Node engine creates.
const BOOTSTRAP_DDL: &str = "\
    CREATE TABLE IF NOT EXISTS _writer_leases (\
      id INTEGER PRIMARY KEY, scope TEXT NOT NULL, lane TEXT NOT NULL, \
      holder_id TEXT NOT NULL, holder_pid INTEGER NOT NULL, epoch INTEGER NOT NULL, \
      acquired_at INTEGER NOT NULL, heartbeat_at INTEGER NOT NULL, ttl_ms INTEGER NOT NULL, \
      reentrancy_depth INTEGER NOT NULL DEFAULT 1, active INTEGER NOT NULL DEFAULT 1);\
    CREATE UNIQUE INDEX IF NOT EXISTS ux_writer_leases_active ON _writer_leases (scope, lane) WHERE active = 1;\
    CREATE TABLE IF NOT EXISTS _writer_queue (\
      ticket INTEGER PRIMARY KEY AUTOINCREMENT, scope TEXT NOT NULL, lane TEXT NOT NULL, \
      holder_id TEXT NOT NULL, priority INTEGER NOT NULL DEFAULT 100, \
      enqueued_at INTEGER NOT NULL, deadline_at INTEGER NOT NULL);\
    CREATE INDEX IF NOT EXISTS ix_writer_queue_order ON _writer_queue (scope, lane, priority ASC, ticket ASC);";

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

/// AC1+AC2+AC5+T15: bind with a lease arbiter, prove v1.1 acquire/release works
/// over the socket, v1.0 Health is unaffected, and `rate_check` is unimplemented.
#[tokio::test]
async fn v1_1_acquire_release_over_socket_v1_0_unaffected() {
    // ── Isolated fixture cleo.db with the lease tables bootstrapped ──────────
    let dir = tempfile::tempdir().expect("tempdir");
    let db_path = dir.path().join("cleo.db");
    {
        let conn = rusqlite::Connection::open(&db_path).expect("open");
        conn.execute_batch(BOOTSTRAP_DDL).expect("bootstrap lease tables");
    }
    let resolved = db_path.clone();
    let resolver: ScopeDbResolver = Arc::new(move |_scope| Ok(resolved.clone()));
    let arbiter = LeaseArbiter::new(resolver);

    let socket_path = dir.path().join("cleo-supervisor.sock");

    // ── Stand up the supervisor IPC accept loop WITH the lease arbiter ───────
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

    // ── v1.1 client: acquire → granted ──────────────────────────────────────
    let stream = UnixStream::connect(&socket_path).await.expect("v1.1 connect");
    let (read, mut write) = stream.into_split();
    let mut lines = BufReader::new(read).lines();

    let acquire = LeaseEnvelope::request(
        "lease-acq-1",
        LeaseRequest::LeaseAcquire(LeaseAcquireReq {
            scope: DbScope::Project,
            lane: LeaseLane::Tasks,
            holder_id: "pid-1:tasks".into(),
            priority: 0,
            ttl_ms: 60_000,
            reentrant: true,
        }),
    );
    write_line(&mut write, &acquire.to_ndjson().expect("ser acquire")).await;

    let granted_line = read_line(&mut lines).await;
    let granted = LeaseEnvelope::from_ndjson(&granted_line).expect("parse granted envelope");
    assert_eq!(
        granted.protocol_version, LEASE_IPC_PROTOCOL_VERSION,
        "v1.x response framing"
    );
    assert_eq!(granted.id, "lease-acq-1", "correlation id echoed");
    let granted_epoch = match granted.payload {
        LeasePayload::Response {
            response: LeaseResponse::LeaseGranted(g),
        } => {
            assert_eq!(g.holder_id, "pid-1:tasks");
            assert_eq!(g.ttl_ms, 60_000);
            g.epoch
        }
        other => panic!("expected lease_granted, got {other:?}"),
    };

    // ── v1.0 client (DIFFERENT connection, SAME accept loop): Health unaffected ─
    let v10_stream = UnixStream::connect(&socket_path).await.expect("v1.0 connect");
    let (v10_read, mut v10_write) = v10_stream.into_split();
    let mut v10_lines = BufReader::new(v10_read).lines();
    let health = IpcEnvelope::request("health-1", IpcRequest::Health(cleo_supervisor::ipc::HealthRequest {}));
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

    // ── v1.1 client: a SECOND holder is queued while the first holds it ──────
    let acquire2 = LeaseEnvelope::request(
        "lease-acq-2",
        LeaseRequest::LeaseAcquire(LeaseAcquireReq {
            scope: DbScope::Project,
            lane: LeaseLane::Tasks,
            holder_id: "pid-2:tasks".into(),
            priority: 0,
            ttl_ms: 60_000,
            reentrant: true,
        }),
    );
    write_line(&mut write, &acquire2.to_ndjson().expect("ser acquire2")).await;
    let queued_line = read_line(&mut lines).await;
    let queued = LeaseEnvelope::from_ndjson(&queued_line).expect("parse queued envelope");
    match queued.payload {
        LeasePayload::Response {
            response: LeaseResponse::LeaseQueued(q),
        } => assert_eq!(q.ahead, 0, "second holder is queued behind the live first holder"),
        other => panic!("expected lease_queued, got {other:?}"),
    }

    // ── v1.1 client: release the first grant → the row is freed ──────────────
    let release = LeaseEnvelope::request(
        "lease-rel-1",
        LeaseRequest::LeaseRelease(LeaseReleaseReq {
            scope: DbScope::Project,
            lane: LeaseLane::Tasks,
            holder_id: "pid-1:tasks".into(),
            epoch: granted_epoch,
        }),
    );
    write_line(&mut write, &release.to_ndjson().expect("ser release")).await;
    let released_line = read_line(&mut lines).await;
    let released = LeaseEnvelope::from_ndjson(&released_line).expect("parse release envelope");
    assert!(matches!(
        released.payload,
        LeasePayload::Response {
            response: LeaseResponse::LeaseGranted(_)
        }
    ));

    // ── v1.1 client: re-acquire by a new holder now grants (row was freed) ───
    let reacquire = LeaseEnvelope::request(
        "lease-acq-3",
        LeaseRequest::LeaseAcquire(LeaseAcquireReq {
            scope: DbScope::Project,
            lane: LeaseLane::Tasks,
            holder_id: "pid-3:tasks".into(),
            priority: 0,
            ttl_ms: 60_000,
            reentrant: true,
        }),
    );
    write_line(&mut write, &reacquire.to_ndjson().expect("ser reacquire")).await;
    let regrant_line = read_line(&mut lines).await;
    let regrant = LeaseEnvelope::from_ndjson(&regrant_line).expect("parse regrant envelope");
    match regrant.payload {
        LeasePayload::Response {
            response: LeaseResponse::LeaseGranted(g),
        } => assert!(g.epoch > granted_epoch, "a fresh grant bumps the epoch"),
        other => panic!("expected lease_granted after release, got {other:?}"),
    }

    // ── v1.1 client: rate_check is the deferred E_LEASE_UNIMPLEMENTED ─────────
    let rate = LeaseEnvelope::request(
        "rate-1",
        LeaseRequest::RateCheck(cleo_supervisor::lease_ipc::RateCheckReq {
            scope: DbScope::Global,
            lane: LeaseLane::Bulk,
            est_bytes: 1024,
        }),
    );
    write_line(&mut write, &rate.to_ndjson().expect("ser rate")).await;
    let rate_line = read_line(&mut lines).await;
    let rate_env = LeaseEnvelope::from_ndjson(&rate_line).expect("parse rate envelope");
    match rate_env.payload {
        LeasePayload::Response {
            response: LeaseResponse::Error(e),
        } => assert_eq!(e.code, "E_LEASE_UNIMPLEMENTED"),
        other => panic!("expected E_LEASE_UNIMPLEMENTED, got {other:?}"),
    }

    server.abort();
}

/// A v1.1 frame on a loop with NO lease arbiter wired (the default `serve`)
/// returns `E_LEASE_UNAVAILABLE` — never a silent drop, and v1.0 stays frozen.
#[tokio::test]
async fn v1_1_without_arbiter_returns_unavailable() {
    let dir = tempfile::tempdir().expect("tempdir");
    let socket_path = dir.path().join("cleo-supervisor.sock");
    let (event_tx, event_rx) = unbounded_channel();
    let registry = ChildRegistry::new(event_tx);
    let serve_socket = socket_path.clone();
    let server = tokio::spawn(async move {
        // Plain `serve` — no lease arbiter (the production-default v1.0-only loop).
        let _ = ipc_server::serve(&serve_socket, registry, event_rx).await;
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
    let acquire = LeaseEnvelope::request(
        "no-arb-1",
        LeaseRequest::LeaseAcquire(LeaseAcquireReq {
            scope: DbScope::Project,
            lane: LeaseLane::Tasks,
            holder_id: "pid-9:tasks".into(),
            priority: 0,
            ttl_ms: 30_000,
            reentrant: true,
        }),
    );
    write_line(&mut write, &acquire.to_ndjson().expect("ser acquire")).await;
    let line = read_line(&mut lines).await;
    let env = LeaseEnvelope::from_ndjson(&line).expect("parse envelope");
    match env.payload {
        LeasePayload::Response {
            response: LeaseResponse::Error(e),
        } => assert_eq!(e.code, "E_LEASE_UNAVAILABLE"),
        other => panic!("expected E_LEASE_UNAVAILABLE, got {other:?}"),
    }

    server.abort();
}
