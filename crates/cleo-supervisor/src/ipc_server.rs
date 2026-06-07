// SPDX-License-Identifier: MIT
// Copyright (c) 2026 kryptobaseddev
//
// This file is part of crates/cleo-supervisor in the CleoCode monorepo.

//! IPC accept loop + request dispatch for the supervisor (T11253 / R2).
//!
//! This module finishes the R1-deferred IPC loop: it binds the platform
//! transport (a Unix-domain `UnixListener` on Unix; a named-pipe stub on
//! Windows — see [`bind_listener`]), accepts clients, and wires each one to a
//! shared [`ChildRegistry`].
//!
//! Three concurrent roles run over one [`tokio`] reactor:
//!
//!   * **accept loop** — [`serve`] accepts client connections; for each it
//!     splits the stream into a read half (request parser) and a write half
//!     (registered into the broadcast [`Fanout`] and used for direct request
//!     responses).
//!   * **per-client reader** — parses one [`IpcEnvelope`] request per NDJSON
//!     line, dispatches it onto the registry, and writes the correlated
//!     [`IpcResponse`] back to that client.
//!   * **event pump** — drains the registry's [`LifecycleEvent`] channel and
//!     broadcasts each event to *every* connected client via the same
//!     [`Fanout`] codec, with NO edit to the frozen `ipc.rs` v1.0 message set.
//!
//! The wire codec is the exact NDJSON [`IpcEnvelope`] (de)serialization owned by
//! [`crate::ipc`]; this module adds only transport + dispatch glue.

use std::sync::Arc;

use tokio::io::{AsyncBufReadExt, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::sync::Mutex;
use tokio::sync::mpsc::UnboundedReceiver;

use crate::ipc::{
    IpcEnvelope, IpcPayload, IpcRequest, IpcResponse, HealthResult, LifecycleEvent,
    IPC_PROTOCOL_VERSION,
};
use crate::ipc_transport::Fanout;
use crate::process;
use crate::supervisor::{ChildRegistry, RegistryError};

/// A write half shared between the per-client responder and the broadcast
/// [`Fanout`].
///
/// Each accepted client's write half is wrapped in an `Arc<Mutex<W>>`; one clone
/// is registered into the `Fanout` (for unsolicited lifecycle-event broadcasts)
/// and another is held by the per-client reader (for correlated request
/// responses). [`SharedWriter`] implements [`AsyncWrite`] by locking the inner
/// writer per poll, so the existing generic `Fanout<W>` serves it unchanged.
pub struct SharedWriter<W> {
    inner: Arc<Mutex<W>>,
}

impl<W> Clone for SharedWriter<W> {
    fn clone(&self) -> Self {
        Self {
            inner: Arc::clone(&self.inner),
        }
    }
}

impl<W> SharedWriter<W> {
    /// Wrap a write half so it can be shared between direct responses and
    /// broadcasts.
    #[must_use]
    pub fn new(writer: W) -> Self {
        Self {
            inner: Arc::new(Mutex::new(writer)),
        }
    }
}

impl<W> AsyncWrite for SharedWriter<W>
where
    W: AsyncWrite + Unpin + Send,
{
    fn poll_write(
        self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
        buf: &[u8],
    ) -> std::task::Poll<std::io::Result<usize>> {
        // Acquire the lock without blocking the reactor: if it is momentarily
        // held by the other clone, register the waker and retry.
        let mut guard = match self.inner.try_lock() {
            Ok(g) => g,
            Err(_) => {
                cx.waker().wake_by_ref();
                return std::task::Poll::Pending;
            }
        };
        std::pin::Pin::new(&mut *guard).poll_write(cx, buf)
    }

    fn poll_flush(
        self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        let mut guard = match self.inner.try_lock() {
            Ok(g) => g,
            Err(_) => {
                cx.waker().wake_by_ref();
                return std::task::Poll::Pending;
            }
        };
        std::pin::Pin::new(&mut *guard).poll_flush(cx)
    }

    fn poll_shutdown(
        self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        let mut guard = match self.inner.try_lock() {
            Ok(g) => g,
            Err(_) => {
                cx.waker().wake_by_ref();
                return std::task::Poll::Pending;
            }
        };
        std::pin::Pin::new(&mut *guard).poll_shutdown(cx)
    }
}

/// Dispatch a single parsed [`IpcRequest`] onto the registry, returning the
/// correlated [`IpcResponse`] to send back to the requesting client.
///
/// `Spawn`/`Restart`/`Monitor` map onto the matching [`ChildRegistry`]
/// operations; `Health` synthesizes a [`HealthResult`] from registry state. Any
/// [`RegistryError`] is lowered into an [`IpcResponse::Error`] carrying the
/// stable error code — no request ever panics the dispatcher.
pub async fn dispatch(registry: &ChildRegistry, request: IpcRequest) -> IpcResponse {
    match request {
        IpcRequest::Spawn(req) => match registry.spawn(&req).await {
            Ok(result) => IpcResponse::Spawned(result),
            Err(e) => error_response(&e),
        },
        IpcRequest::Restart(req) => match registry.restart(&req.child_id).await {
            Ok(result) => IpcResponse::Restarted(result),
            Err(e) => error_response(&e),
        },
        IpcRequest::Monitor(req) => match registry.monitor(req.child_id.as_deref()).await {
            Ok(result) => IpcResponse::Monitor(result),
            Err(e) => error_response(&e),
        },
        IpcRequest::Health(_) => IpcResponse::Health(HealthResult {
            pid: process::current_pid(),
            child_count: registry.child_count().await,
            uptime_secs: registry.uptime_secs(),
            protocol_version: IPC_PROTOCOL_VERSION.to_string(),
        }),
    }
}

/// Lower a [`RegistryError`] into the wire [`IpcResponse::Error`].
fn error_response(err: &RegistryError) -> IpcResponse {
    IpcResponse::Error(crate::ipc::ErrorResult {
        code: err.code().to_string(),
        message: err.to_string(),
    })
}

/// Drive the per-client read loop: parse one [`IpcEnvelope`] request per NDJSON
/// line, dispatch it, and write the correlated response back over `writer`.
///
/// Returns when the client closes its end (EOF) or sends an unparseable line
/// that is not recoverable. Parse errors on a single line are answered with an
/// `IpcResponse::Error` and the loop continues, so one malformed line does not
/// drop an otherwise-healthy client.
async fn client_read_loop<R, W>(read: R, writer: SharedWriter<W>, registry: ChildRegistry)
where
    R: tokio::io::AsyncRead + Unpin + Send,
    W: AsyncWrite + Unpin + Send,
{
    let mut lines = BufReader::new(read).lines();
    let mut writer = writer;
    loop {
        let line = match lines.next_line().await {
            Ok(Some(line)) => line,
            Ok(None) => break, // clean EOF
            Err(e) => {
                tracing::debug!(error = %e, "client read error; dropping connection");
                break;
            }
        };
        if line.trim().is_empty() {
            continue;
        }
        match IpcEnvelope::from_ndjson(&line) {
            Ok(env) => match env.payload {
                IpcPayload::Request { request } => {
                    let response = dispatch(&registry, request).await;
                    let reply = IpcEnvelope::response(env.id, response);
                    if let Err(e) = write_envelope(&mut writer, &reply).await {
                        tracing::debug!(error = %e, "failed to write response; dropping client");
                        break;
                    }
                }
                IpcPayload::Response { .. } => {
                    // Clients do not send responses; ignore defensively.
                    tracing::debug!("ignoring unexpected response-direction envelope from client");
                }
            },
            Err(e) => {
                let reply = IpcEnvelope::response(
                    "unparseable",
                    IpcResponse::Error(crate::ipc::ErrorResult {
                        code: "E_BAD_REQUEST".to_string(),
                        message: format!("could not parse IPC envelope: {e}"),
                    }),
                );
                if write_envelope(&mut writer, &reply).await.is_err() {
                    break;
                }
            }
        }
    }
}

/// Serialize and write one envelope as an NDJSON line + flush.
async fn write_envelope<W>(
    writer: &mut SharedWriter<W>,
    envelope: &IpcEnvelope,
) -> std::io::Result<()>
where
    W: AsyncWrite + Unpin + Send,
{
    let mut line = envelope
        .to_ndjson()
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
    line.push('\n');
    writer.write_all(line.as_bytes()).await?;
    writer.flush().await
}

/// Drain the registry's [`LifecycleEvent`] channel, broadcasting each event to
/// every connected client via the shared [`Fanout`] codec.
///
/// Runs until the event sender (held by the [`ChildRegistry`]) is dropped, at
/// which point the channel closes and the pump exits.
async fn event_pump<W>(mut events: UnboundedReceiver<LifecycleEvent>, fanout: Fanout<W>)
where
    W: AsyncWriteExt + Unpin + Send,
{
    while let Some(event) = events.recv().await {
        let envelope = IpcEnvelope::response(
            format!("event-{}", event.child_id),
            IpcResponse::Event(event),
        );
        match fanout.broadcast(&envelope).await {
            Ok(delivered) => {
                tracing::trace!(delivered, "broadcast lifecycle event");
            }
            Err(e) => {
                tracing::debug!(error = %e, "failed to serialize lifecycle event");
            }
        }
    }
}

#[cfg(unix)]
mod unix_serve {
    use super::*;
    use tokio::net::UnixListener;

    /// Accept loop body for a Unix-domain listener.
    ///
    /// Spawns the event pump once, then accepts clients forever; per connection
    /// it registers the write half into the broadcast [`Fanout`] and spawns the
    /// per-client read loop. Returns only on an unrecoverable accept error.
    pub async fn run(
        listener: UnixListener,
        registry: ChildRegistry,
        events: UnboundedReceiver<LifecycleEvent>,
    ) -> std::io::Result<()> {
        let fanout: Fanout<SharedWriter<tokio::net::unix::OwnedWriteHalf>> = Fanout::new();
        tokio::spawn(event_pump(events, fanout.clone()));

        loop {
            let (stream, _addr) = listener.accept().await?;
            let (read, write) = stream.into_split();
            let shared = SharedWriter::new(write);
            fanout.add_client(shared.clone()).await;
            tokio::spawn(client_read_loop(read, shared, registry.clone()));
        }
    }
}

/// Bind the supervisor IPC listener and run the accept loop until it errors.
///
/// On Unix this binds a `UnixListener` at `socket_path`, removing any stale
/// socket file left by a prior crash first (an existing socket file would make
/// `bind` fail with `EADDRINUSE`). On Windows the named-pipe transport is not
/// yet implemented in this crate; [`serve`] returns an error so the caller can
/// degrade gracefully rather than silently no-op (the named-pipe server lands
/// with the Windows IPC epic).
///
/// # Errors
///
/// Returns an I/O error if the socket cannot be bound or the accept loop fails.
#[cfg(unix)]
pub async fn serve(
    socket_path: &std::path::Path,
    registry: ChildRegistry,
    events: UnboundedReceiver<LifecycleEvent>,
) -> std::io::Result<()> {
    use tokio::net::UnixListener;

    if let Some(parent) = socket_path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    // Remove a stale socket file from a prior unclean shutdown; bind fails with
    // EADDRINUSE otherwise. A live peer would already hold the pidfile, so the
    // double-launch guard upstream prevents stomping an active supervisor.
    match std::fs::remove_file(socket_path) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(e),
    }
    let listener = UnixListener::bind(socket_path)?;
    tracing::info!(socket = %socket_path.display(), "supervisor IPC listening");
    unix_serve::run(listener, registry, events).await
}

/// Windows IPC is not yet implemented in this crate (named-pipe server lands
/// with the Windows IPC epic); calling [`serve`] returns an error so the binary
/// can degrade gracefully without a silent no-op.
///
/// # Errors
///
/// Always returns `ErrorKind::Unsupported` on Windows.
#[cfg(not(unix))]
pub async fn serve(
    _socket_path: &std::path::Path,
    _registry: ChildRegistry,
    _events: UnboundedReceiver<LifecycleEvent>,
) -> std::io::Result<()> {
    Err(std::io::Error::new(
        std::io::ErrorKind::Unsupported,
        "named-pipe IPC transport is not yet implemented for Windows in cleo-supervisor",
    ))
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use crate::ipc::{IpcResponse, MonitorRequest, SpawnRequest};
    use tokio::sync::mpsc::unbounded_channel;

    fn true_spawn(child_id: &str) -> SpawnRequest {
        SpawnRequest {
            child_id: child_id.into(),
            program: "/bin/true".into(),
            args: vec![],
            env: vec![],
            cwd: None,
        }
    }

    /// `dispatch` of a Health request reports the live supervisor pid + the
    /// frozen protocol version, independent of any clients.
    #[tokio::test]
    async fn dispatch_health_reports_protocol_version() {
        let (tx, _rx) = unbounded_channel();
        let registry = ChildRegistry::new(tx);
        let resp = dispatch(&registry, IpcRequest::Health(crate::ipc::HealthRequest {})).await;
        match resp {
            IpcResponse::Health(h) => {
                assert_eq!(h.protocol_version, IPC_PROTOCOL_VERSION);
                assert_eq!(h.pid, process::current_pid());
                assert_eq!(h.child_count, 0);
            }
            other => panic!("expected Health, got {other:?}"),
        }
    }

    /// `dispatch` of a Restart for an unknown child lowers the registry error
    /// into a wire `IpcResponse::Error` with the stable code.
    #[tokio::test]
    async fn dispatch_restart_unknown_child_is_error() {
        let (tx, _rx) = unbounded_channel();
        let registry = ChildRegistry::new(tx);
        let resp = dispatch(
            &registry,
            IpcRequest::Restart(crate::ipc::RestartRequest {
                child_id: "ghost".into(),
            }),
        )
        .await;
        match resp {
            IpcResponse::Error(e) => assert_eq!(e.code, "E_UNKNOWN_CHILD"),
            other => panic!("expected Error, got {other:?}"),
        }
    }

    /// `dispatch` of a Spawn registers the child and a subsequent Monitor lists
    /// it.
    #[tokio::test]
    async fn dispatch_spawn_then_monitor_lists_child() {
        let (tx, _rx) = unbounded_channel();
        let registry = ChildRegistry::new(tx);
        let spawned = dispatch(&registry, IpcRequest::Spawn(true_spawn("w1"))).await;
        match spawned {
            IpcResponse::Spawned(r) => assert_eq!(r.child_id, "w1"),
            other => panic!("expected Spawned, got {other:?}"),
        }
        let mon = dispatch(
            &registry,
            IpcRequest::Monitor(MonitorRequest { child_id: None }),
        )
        .await;
        match mon {
            IpcResponse::Monitor(m) => {
                assert_eq!(m.children.len(), 1);
                assert_eq!(m.children[0].child_id, "w1");
            }
            other => panic!("expected Monitor, got {other:?}"),
        }
    }
}
