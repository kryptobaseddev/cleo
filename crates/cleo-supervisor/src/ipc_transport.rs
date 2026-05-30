// SPDX-License-Identifier: MIT
// Copyright (c) 2026 kryptobaseddev
//
// This file is part of crates/cleo-supervisor in the CleoCode monorepo.

//! IPC fan-out transport for the supervisor (T11339 AC3).
//!
//! The supervisor broadcasts [`crate::ipc::IpcEnvelope`] NDJSON lines to every
//! connected client and reads requests back. The transport is platform-split:
//!
//!   * Unix — a `tokio::net::UnixListener` bound to a socket under the CLEO
//!     home; clients connect with a `UnixStream`. A socketpair is used for the
//!     in-process round-trip test so the same codec is exercised without a
//!     filesystem socket.
//!   * Windows — a named pipe (`\\.\pipe\cleo-supervisor.<pid>`). The pipe
//!     server is created lazily on first listen.
//!
//! This module owns only the byte transport + a [`Fanout`] registry that holds
//! per-client write halves and broadcasts an envelope to all of them. Message
//! semantics live in [`crate::ipc`].

use std::sync::Arc;

use tokio::io::AsyncWriteExt;
use tokio::sync::Mutex;

use crate::ipc::IpcEnvelope;

/// A registry of connected client write-halves to which the supervisor
/// broadcasts NDJSON envelopes.
///
/// Generic over the write half so the same fan-out logic serves Unix sockets,
/// Windows named pipes, and in-memory duplex streams used in tests.
#[derive(Default)]
pub struct Fanout<W> {
    clients: Arc<Mutex<Vec<W>>>,
}

impl<W> Clone for Fanout<W> {
    fn clone(&self) -> Self {
        Self {
            clients: Arc::clone(&self.clients),
        }
    }
}

impl<W> Fanout<W>
where
    W: AsyncWriteExt + Unpin + Send,
{
    /// Create an empty fan-out registry.
    #[must_use]
    pub fn new() -> Self {
        Self {
            clients: Arc::new(Mutex::new(Vec::new())),
        }
    }

    /// Register a new client write half.
    pub async fn add_client(&self, writer: W) {
        self.clients.lock().await.push(writer);
    }

    /// Number of currently-registered clients.
    pub async fn client_count(&self) -> usize {
        self.clients.lock().await.len()
    }

    /// Broadcast one envelope as an NDJSON line to every connected client.
    ///
    /// Clients whose write fails (disconnected) are dropped from the registry.
    /// Returns the number of clients the line was successfully delivered to.
    ///
    /// # Errors
    ///
    /// Returns a `serde_json` error if the envelope cannot be serialized.
    pub async fn broadcast(&self, envelope: &IpcEnvelope) -> Result<usize, serde_json::Error> {
        let mut line = envelope.to_ndjson()?;
        line.push('\n');
        let bytes = line.into_bytes();

        let mut guard = self.clients.lock().await;
        let mut delivered = 0usize;
        let mut alive: Vec<W> = Vec::with_capacity(guard.len());
        for mut client in guard.drain(..) {
            match client.write_all(&bytes).await {
                Ok(()) => {
                    let _ = client.flush().await;
                    delivered += 1;
                    alive.push(client);
                }
                Err(_) => {
                    // Drop disconnected clients silently.
                }
            }
        }
        *guard = alive;
        Ok(delivered)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ipc::{HealthResult, IpcResponse, IPC_PROTOCOL_VERSION};
    use tokio::io::{AsyncBufReadExt, BufReader};

    /// Round-trip an envelope through the fan-out using an in-memory duplex
    /// stream, then parse it back — exercising the exact codec the Unix socket /
    /// Windows pipe transport uses (AC3 "Rust→shape→Rust").
    #[tokio::test]
    async fn fanout_broadcasts_parseable_ndjson() {
        let (server_side, client_side) = tokio::io::duplex(4096);
        let fanout: Fanout<tokio::io::WriteHalf<tokio::io::DuplexStream>> = Fanout::new();
        let (read_half, write_half) = tokio::io::split(server_side);
        // The read half is unused on the server side here; keep it alive so the
        // duplex stream is not half-closed.
        let _server_read = read_half;
        fanout.add_client(write_half).await;
        assert_eq!(fanout.client_count().await, 1);

        let env = IpcEnvelope::response(
            "req-9",
            IpcResponse::Health(HealthResult {
                pid: 7,
                child_count: 0,
                uptime_secs: 1,
                protocol_version: IPC_PROTOCOL_VERSION.into(),
            }),
        );
        let delivered = fanout.broadcast(&env).await.expect("broadcast");
        assert_eq!(delivered, 1);

        // Read the line back from the client end and parse it.
        let mut reader = BufReader::new(client_side);
        let mut line = String::new();
        reader.read_line(&mut line).await.expect("read line");
        let back = IpcEnvelope::from_ndjson(&line).expect("parse");
        assert_eq!(back, env);
    }
}
