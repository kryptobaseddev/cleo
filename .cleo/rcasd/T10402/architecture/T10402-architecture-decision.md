---
epic: T10402
stage: architecture_decision
task: T10402
related:
  - type: saga
    id: T10402
  - type: research
    path: ../research/T10402-research.md
  - type: consensus
    path: ../consensus/T10402-consensus.md
  - type: adr
    id: ADR-089
created: 2026-05-27
updated: 2026-05-27
---

# Architecture Decision (T10402) — SG-COCKPIT-HARNESS

## Component Architecture

```
crates/cockpit/
├── Cargo.toml                    # Workspace member, deps: ratatui, crossterm, tokio, zmq, lafs-core, cleo-conduit-core
├── src/
│   ├── main.rs                   # Binary entrypoint: tokio runtime, app init, event loop
│   ├── app.rs                    # App state machine, panel registry, global keybindings
│   ├── ipc/
│   │   ├── mod.rs                # IPC module
│   │   ├── client.rs             # ZeroMQ connection manager (PUB/SUB + REQ/REP sockets)
│   │   ├── heartbeat.rs          # Heartbeat monitor: detect missed beats, trigger ConnectionLost
│   │   ├── transport.rs          # LAFS envelope send/recv, serde_json framing over ZMQ
│   │   └── operations.rs         # Typed wrappers for daemon operations (orchestrate.*, tasks.*, etc.)
│   ├── ui/
│   │   ├── mod.rs                # UI module
│   │   ├── layout.rs             # 4-quadrant layout engine, resize handling, Constraint::Ratio
│   │   ├── theme.rs              # Color palette, style constants, Dream State palette shift
│   │   ├── keybindings.rs        # Global + per-panel keybinding registry
│   │   ├── panels/
│   │   │   ├── mod.rs
│   │   │   ├── hud.rs            # Left sidebar: daemon health, brain visualization stubs
│   │   │   ├── pipeline.rs       # Right sidebar: Saga/Epic tree, LOOM phase tags
│   │   │   ├── orchestrator.rs   # Center top: Prime chat + Conduit feed
│   │   │   └── isolation.rs      # Center bottom: PTY pane grid (rmux or hand-rolled)
│   │   └── widgets/
│   │       ├── mod.rs
│   │       ├── tree.rs           # Collapsible tree widget (Saga/Epic hierarchy)
│   │       ├── gauge.rs          # Health gauge (CPU, memory, worker count)
│   │       ├── log_stream.rs     # Scrolling log viewer (worker stdout/stderr)
│   │       └── status_badge.rs   # Color-coded status indicator
│   └── model/
│       ├── mod.rs                # Data model
│       ├── daemon_state.rs       # DaemonStatus, DispatchStatus, worker roster
│       ├── saga_tree.rs          # Saga → Epic → Task → Subtask tree structure
│       ├── chat.rs               # ChatMessage, ConduitMessage, agent identity
│       └── pty.rs                # PtySession, PtyGrid, worker→PTY mapping
```

## Data Flow

```
┌─────────────────────────────────────────────────────────┐
│                    Cockpit TUI (Rust)                    │
│                                                         │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌────────┐ │
│  │ HUD      │  │ Pipeline │  │Orchestr. │  │Isolat. │ │
│  │ (daemon  │  │ (saga    │  │ (chat +  │  │(PTY    │ │
│  │  health  │  │  tree)   │  │ conduit) │  │ grid)  │ │
│  │ + brain) │  │          │  │          │  │        │ │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └───┬────┘ │
│       │              │              │            │      │
│       └──────────────┴──────────────┴────────────┘      │
│                        │                                 │
│              ┌─────────┴─────────┐                      │
│              │   IPC Layer        │                      │
│              │ ┌───────────────┐  │                      │
│              │ │ ZMQ PUB/SUB   │  │  ←─ daemon firehose  │
│              │ │ (data plane)  │  │  (worker stdout,     │
│              │ │               │  │   brain pulses,      │
│              │ │               │  │   heartbeats,        │
│              │ │               │  │   state changes)     │
│              │ └───────────────┘  │                      │
│              │ ┌───────────────┐  │                      │
│              │ │ HTTP/Unix     │  │  ←→ daemon control   │
│              │ │ (control      │  │  (orchestrate.spawn, │
│              │ │  plane)       │  │   tasks.claim,       │
│              │ │               │  │   daemon.status)     │
│              │ └───────────────┘  │                      │
│              └────────────────────┘                      │
└─────────────────────────────────────────────────────────┘
         │                              ▲
         │  ZeroMQ PUB/SUB              │  HTTP REQ/RESP
         ▼                              │  (via T10409 gateway)
┌─────────────────────┐     ┌──────────────────────┐
│   cleo daemon serve │     │  crates/cleo-gateway │
│   (T10401)          │────▶│  (T10409)            │
│   TypeScript        │     │  axum + hyper        │
└─────────────────────┘     └──────────────────────┘
```

## Event Loop Design

```
tokio::select! {
    // Terminal events (keyboard, resize, mouse)
    event = crossterm_event_stream.next() => {
        match event {
            Key(key) => app.handle_key(key),
            Resize(w, h) => app.handle_resize(w, h),
            Mouse(m) => app.handle_mouse(m),
        }
    }
    // ZeroMQ PUB/SUB messages (daemon firehose)
    msg = zmq_sub_socket.recv() => {
        let envelope: LafsEnvelope = serde_json::from_slice(&msg)?;
        app.handle_daemon_event(envelope);
    }
    // Render tick (60fps for streaming PTY output)
    _ = tokio::time::interval(Duration::from_millis(16)).tick() => {
        app.render_frame()?;
    }
    // Heartbeat check (every 1s)
    _ = tokio::time::interval(Duration::from_secs(1)).tick() => {
        app.check_heartbeat();
    }
}
```

## Render Pipeline

1. App collects latest state from IPC buffers (lock-free or Arc<Mutex<>>)
2. Build ratatui `Frame` with 4-quadrant layout constraints
3. Each panel renders from its local state cache
4. PTY grid renders worker stdout from ring buffers
5. Frame is double-buffered to terminal via crossterm backend
6. On `Resize` event, layout constraints are recalculated

## LAFS Envelope Operations (Cockpit Consumer)

The Cockpit consumes these operations from the daemon's SDK API:

| Operation | Direction | Transport | Purpose |
|-----------|-----------|-----------|---------|
| `daemon.status` | REQ→REP | HTTP | Get daemon health, active runs, queue depth |
| `orchestrate.status` | REQ→REP | HTTP | Get saga execution status |
| `orchestrate.ready` | REQ→REP | HTTP | List tasks ready for dispatch |
| `runs.history` | REQ→REP | HTTP | Get task run history |
| `tasks.list` | REQ→REP | HTTP | List tasks with status/parent |
| `tasks.show` | REQ→REP | HTTP | Get task details |
| (worker stdout) | PUB→SUB | ZeroMQ | Streaming PTY output from worker processes |
| (brain pulses) | PUB→SUB | ZeroMQ | Brain activity events for visualization |
| (heartbeats) | PUB→SUB | ZeroMQ | Daemon liveness pings (1Hz) |
| (state changes) | PUB→SUB | ZeroMQ | Task state transitions, worker lifecycle |

The Cockpit also SENDS these commands:
| Operation | Direction | Transport | Purpose |
|-----------|-----------|-----------|---------|
| `orchestrate.spawn` | REQ→REP | HTTP | User requests worker spawn for a task |
| `tasks.claim` | REQ→REP | HTTP | User claims a task for manual work |
| `daemon.start` | REQ→REP | HTTP | Start daemon dispatch loop |
| `daemon.stop` | REQ→REP | HTTP | Stop daemon dispatch loop |
