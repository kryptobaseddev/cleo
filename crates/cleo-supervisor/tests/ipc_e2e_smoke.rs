// SPDX-License-Identifier: MIT
// Copyright (c) 2026 kryptobaseddev
//
// This file is part of crates/cleo-supervisor in the CleoCode monorepo.

//! End-to-end IPC smoke test (T11626 AC4 / R2).
//!
//! Proves the R1-deferred R2 loop is finished by exercising the real transport
//! end to end on Unix:
//!
//!   1. Bind the supervisor IPC `UnixListener` at a temp socket path and run the
//!      accept loop ([`cleo_supervisor::ipc_server::serve`]).
//!   2. Connect a client `UnixStream`.
//!   3. Send a `Spawn` request for a trivial child (`true`) as one NDJSON
//!      [`IpcEnvelope`] line.
//!   4. Observe the correlated `Spawned` response AND the unsolicited
//!      `child_exited` [`LifecycleEvent`] broadcast over the same channel.
//!
//! The whole flow runs over a real Unix-domain socket — no in-memory shim — so a
//! green run is direct evidence the bind + accept + dispatch + fan-out path is
//! wired. Windows uses a named-pipe transport not yet implemented in this crate,
//! so the test is `cfg(unix)`-gated.

#![cfg(unix)]
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::time::Duration;

use cleo_supervisor::ipc::{
    IpcEnvelope, IpcPayload, IpcRequest, IpcResponse, LifecycleEventKind, SpawnRequest,
};
use cleo_supervisor::ipc_server;
use cleo_supervisor::supervisor::ChildRegistry;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::UnixStream;
use tokio::sync::mpsc::unbounded_channel;

/// Path to the always-available `true` binary on the host. macOS ships it at
/// `/usr/bin/true` (no `/bin/true`), Linux at `/bin/true`; probe the canonical
/// macOS path first and fall back to the Linux path.
fn true_cmd() -> &'static str {
    if std::path::Path::new("/usr/bin/true").exists() {
        "/usr/bin/true"
    } else {
        "/bin/true"
    }
}

/// A trivial, always-available child that exits immediately so the smoke test
/// observes a `child_exited` event deterministically and fast.
fn trivial_spawn(child_id: &str) -> SpawnRequest {
    SpawnRequest {
        child_id: child_id.into(),
        program: true_cmd().into(),
        args: vec![],
        env: vec![],
        cwd: None,
    }
}

/// Read the next response-direction envelope from the client connection,
/// failing the test if the stream closes or stalls.
async fn read_response<R>(lines: &mut tokio::io::Lines<BufReader<R>>) -> IpcEnvelope
where
    R: tokio::io::AsyncRead + Unpin,
{
    let next = tokio::time::timeout(Duration::from_secs(5), lines.next_line())
        .await
        .expect("timed out waiting for an IPC line")
        .expect("read error on client stream")
        .expect("server closed the connection before responding");
    IpcEnvelope::from_ndjson(&next).expect("server sent an unparseable envelope")
}

/// AC4: bind the socket, accept a client, Spawn a child, observe its
/// [`LifecycleEvent`](cleo_supervisor::ipc::LifecycleEvent).
#[tokio::test]
async fn bind_accept_spawn_observe_lifecycle_event() {
    let dir = tempfile::tempdir().expect("tempdir");
    let socket_path = dir.path().join("cleo-supervisor.sock");

    // ── Stand up the supervisor IPC accept loop ─────────────────────────────
    let (event_tx, event_rx) = unbounded_channel();
    let registry = ChildRegistry::new(event_tx);
    let serve_socket = socket_path.clone();
    let server = tokio::spawn(async move {
        // The accept loop runs until the test drops everything; an early error
        // would surface here. We ignore the Result because the test tears the
        // task down with `abort()` rather than a clean shutdown signal.
        let _ = ipc_server::serve(&serve_socket, registry, event_rx).await;
    });

    // Wait for the socket file to appear (bind completed) before connecting.
    let mut bound = false;
    for _ in 0..200 {
        if socket_path.exists() {
            bound = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert!(bound, "supervisor never bound the IPC socket");

    // ── Connect a client and split into reader + writer ─────────────────────
    let stream = UnixStream::connect(&socket_path)
        .await
        .expect("client connect");
    let (read, mut write) = stream.into_split();
    let mut lines = BufReader::new(read).lines();

    // ── Send a Spawn request for the trivial `true` child ───────────────────
    let request = IpcEnvelope::request(
        "req-spawn-1",
        IpcRequest::Spawn(trivial_spawn("smoke-child")),
    );
    let mut line = request.to_ndjson().expect("serialize request");
    line.push('\n');
    write
        .write_all(line.as_bytes())
        .await
        .expect("write spawn request");
    write.flush().await.expect("flush");

    // ── Observe the Spawned response AND the child_exited LifecycleEvent ─────
    let mut saw_spawned = false;
    let mut saw_exit_event = false;
    let mut observed_pid = 0u32;

    // The two messages can arrive in either order (the broadcast event races the
    // direct response), so drain a few envelopes until both are seen.
    for _ in 0..6 {
        if saw_spawned && saw_exit_event {
            break;
        }
        let env = read_response(&mut lines).await;
        let IpcPayload::Response { response } = env.payload else {
            panic!("expected a response-direction envelope, got a request");
        };
        match response {
            IpcResponse::Spawned(result) => {
                assert_eq!(result.child_id, "smoke-child");
                assert!(result.pid > 0, "spawned child must report a real pid");
                observed_pid = result.pid;
                saw_spawned = true;
            }
            IpcResponse::Event(event) => {
                assert_eq!(event.event, LifecycleEventKind::ChildExited);
                assert_eq!(event.child_id, "smoke-child");
                saw_exit_event = true;
            }
            other => panic!("unexpected response while draining: {other:?}"),
        }
    }

    assert!(saw_spawned, "never received the Spawned response");
    assert!(
        saw_exit_event,
        "never received the child_exited LifecycleEvent broadcast"
    );
    assert!(observed_pid > 0, "spawn must have yielded a pid");

    // ── Tear down ───────────────────────────────────────────────────────────
    server.abort();
}
