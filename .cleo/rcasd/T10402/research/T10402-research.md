---
epic: T10402
stage: research
task: T10402
related:
  - type: saga
    id: T10402
  - type: saga
    id: T10401
  - type: saga
    id: T10400
  - type: epic
    id: T10420
created: 2026-05-27
updated: 2026-05-27
---

# Research (T10402) — SG-COCKPIT-HARNESS

## 1. Daemon IPC Contract (T10401 dependency)

T10402 consumes the T10401 daemon via three IPC channels:

### 1.1 HTTPS Control Plane (Primary — T10409 Gateway)
- Hosted by `crates/cleo-gateway` (axum + hyper + tokio-rustls + rcgen MITM CA)
- SDK API endpoints via LAFS envelope request/response
- Auth: JWT Proxy-Authorization header per T10409 AC7
- Unix socket fallback at `~/.local/share/cleo/daemon.sock` for local high-trust ops

### 1.2 ZeroMQ Data Plane (Streaming)
- **PUB/SUB**: Daemon → Cockpit. High-volume firehose for:
  - Worker stdout/stderr streaming
  - Brain pulses (1Hz)
  - State change events
  - Heartbeat pings (1Hz per daemon instance)
- **REQ/REP**: Cockpit → Daemon. Command channel for:
  - User input forwarding (`orchestrate.spawn`, `tasks.claim`)
  - Query operations (`daemon.status`, `runs.history`)
  - All wrapped in LAFS envelopes

### 1.3 LAFS Envelope Contract
All IPC payloads are `LafsEnvelope` structs (defined in `crates/lafs-core`):
- `$schema`, `_meta` (spec_version, timestamp, operation, request_id, transport, mvi, context_version), `success`, `result`/`error`, `page`
- Cockpit consumes these operations (from ADR-089 + T10400 SDK API):
  - **orchestrate**: `ready`, `spawn`, `status`, `waves`, `context`, `validate`
  - **tasks**: `list`, `show`, `claim`, `release`, `verify`, `complete`
  - **daemon**: `start`, `stop`, `status`
  - **runs**: `history`, `status`, `reclaim`
  - **brain** (future): pulse events, dream state transitions
- Transport enum: `Cli` | `Http` | `Grpc` | `Sdk` — Cockpit uses `Http` for control plane, custom `Zmq` extension for data plane

## 2. Existing TUI/Monitoring Surfaces

### 2.1 In-Project
- **NO existing Rust TUI**: No ratatui or crossterm crates in workspace (Cargo.toml has workspace deps but no TUI crates)
- **NO existing cockpit crate**: The `crates/cockpit/` directory does not exist
- **Existing Rust crates**: cant-core, cant-lsp, cant-napi, cant-router, cant-runtime, cleo-conduit-core, lafs-core, lafs-napi, worktree-napi, worktrunk-core, integration-tests
- **CLI surface** (`packages/cleo/src/cli/commands/daemon.ts`): Text-based daemon commands only — `cleo daemon start/stop/status`
- **Web UI stub** (T1806, `packages/cleo-os/src/web/`): Exists but currently under T10402; may move to T10401 or T10419
- **Conduit message types** (`crates/cleo-conduit-core`): Rust types for agent-to-agent messaging; reusable for Cockpit chat pane

### 2.2 Competitive Landscape (T10420 Survey Targets)
- **RMUX** (`github.com/helvesec/rmux`): Native ratatui PTY multiplexer — ADOPT as Cockpit multiplexer infra per SG-WORKTRUNK-OWN vendor pattern
- **OpenCode**: 3-facet evaluation (harness arch → T10401, Webapp GUI → T1806/T10419, chat history → T10405/T10402)
- Category A (TUI inspirations): Lazygit, Helix, Zed, k9s, jj, btop, charmbracelet Crush
- Category B (Agent harnesses): Claude Code, Aider, Cursor, Cline, Roo Code, Continue.dev, Goose, Codex CLI, Gemini CLI
- Category C (Memory platforms): Letta, Honcho, Mem0 V3, Graphiti, Hindsight, Mastra, LangMem
- Category D (Orchestration): LangGraph, CrewAI, DSPy, Pydantic AI, AutoGen, Vercel AI SDK

## 3. Ratatui Capability Assessment

### 3.1 Core Capabilities
- **Layout engine**: Constraint-based layout (Percentage, Length, Min, Max, Ratio) — sufficient for 4-quadrant Cockpit
- **Rendering**: Double-buffered terminal rendering via crossterm backend
- **Event handling**: crossterm `EventStream` for keyboard, mouse, resize
- **Widgets**: Block, Paragraph, List, Table, Tabs, Gauge, Sparkline, Chart, Scrollbar, Clear
- **Styling**: Modifier (BOLD, ITALIC, REVERSED), Color (ANSI + TrueColor), Style

### 3.2 Key Gaps Cockpit Must Solve
- **Dynamic PTY panes**: ratatui has no native PTY support. RMUX fills this gap (PTY spawning, I/O streaming, pane management)
- **Real-time streaming**: ratatui renders on event loop tick (keypress, resize, timer). Need tokio interval for 60fps streaming updates from ZeroMQ PUB/SUB
- **Braille Canvas**: ratatui supports Unicode braille characters but requires custom rendering logic for the Living Brain macro-topology
- **Collapsible tree**: No native tree widget. Must hand-roll or use `tui-tree`/`tui-widgets` extensions
- **Keybinding layer**: crossterm raw mode + custom keybinding registry (chord-style shortcuts per competitive intel)

### 3.3 Dependency Plan
```toml
[dependencies]
ratatui = "0.29"           # Terminal UI framework
crossterm = "0.28"         # Terminal backend (event handling, raw mode)
tokio = { version = "1", features = ["full"] }  # Async runtime
zmq = "0.10"               # ZeroMQ bindings (PUB/SUB + REQ/REP)
serde = { version = "1", features = ["derive"] }
serde_json = "1"
lafs-core = { path = "../lafs-core" }           # LAFS envelope types
cleo-conduit-core = { path = "../cleo-conduit-core" }  # Conduit message types
# rmux = { git = "..." }   # IF council approves T10420 D8
```

## 4. Cockpit TUI Layout Research

From Harness Architecture §6 (canonical layout):

### 4.1 Left Sidebar (HUD Panel)
- Daemon health: PID, uptime, memory usage, active workers count, queue depth
- Connection status: green/yellow/red indicator + "Connection Lost" overlay on 3 missed heartbeats
- Living Brain visualization:
  - **Braille Canvas**: Sub-character resolution macro-topology showing neural "pulses" and connection activity
  - **Semantic Ledger**: Table showing exact contextual memory retrievals
  - **Dream State**: Palette shift (blue→purple) when system is in consolidation mode

### 4.2 Right Sidebar (Pipeline Panel)
- Collapsible Saga/Epic tree
- Color-coded LOOM phase tags: RCASD phases (blue) vs IVTR phases (green)
- Task status indicators: pending (gray), claimed (yellow), running (cyan), completed (green), failed (red), blocked (orange)
- Click/keyboard navigation to expand/collapse and select tasks

### 4.3 Center Top (Orchestrator Panel)
- Prime Orchestrator chat: messages from the Cleo persona
- Conduit agent-debate feed: inter-agent messages from `cleo-conduit-core`
- Rolling feed with timestamps, agent-identity tags
- Message composition input at bottom of panel

### 4.4 Center Bottom (Isolation Zone)
- Dynamic grid of PTY panes for ephemeral workers
- Each pane: worker ID, task ID, iteration count, status badge
- Real-time stdout/stderr streaming via ZeroMQ PUB/SUB
- Crash-safe: pane collapses without taking down TUI
- Keyboard: Ctrl+W close pane, Ctrl+Tab cycle panes, Ctrl+Shift+Arrow resize

## 5. Architecture Constraints

### 5.1 Envelope-First Doctrine (T10343)
- ALL IPC payloads MUST be LAFS Envelopes
- Cockpit is a SEPARATE PROCESS from the daemon (not in-process)
- Language choice (Rust) is implementation detail, not architecture

### 5.2 Boundary Registry (T10176)
- `crates/cockpit/` requires a `BoundaryEntry` in `packages/contracts/src/boundary.ts`
- LAFS transport enum should be extended with `Zmq` variant

### 5.3 Sequencing
- Cockpit MUST NOT ship before T10400 (SDK API) + T10401 (Daemon IPC)
- T10420 competitive intel IS pre-work (Wave 0) — informs but does not block scaffold
- T10345 architecture decision IS part of this decomposition
- T1806 Web UI may move; Cockpit should not depend on it

## 6. Key Risks (from Harness Arch §8)

| Risk | Mitigation |
|------|-----------|
| **D. ZeroMQ zombie sockets / TUI disconnects** | Heartbeat protocol on PUB/SUB. Miss 3 heartbeats → "Connection Lost" overlay, auto-reconnect with exponential backoff |
| **E. Worker containment** | PTY isolation handled by daemon; Cockpit only renders streams, never executes |
| **Context window exhaustion** | Not Cockpit's concern — handled by Genkit middleware (T10403) |
| **SQLite write contention (Brain)** | WAL mode — Cockpit reads are read-only and non-blocking |
| **Ratatui PTY gap** | RMUX fills this; fallback to hand-rolled if council rejects |

## 7. Research Verdict

T10402 is **ready for decomposition**. The IPC contract is well-defined (ADR-089 + T10400 SDK API spec), the layout is specified (Harness Arch §6), the tech stack is chosen (ratatui + crossterm + tokio + ZeroMQ), and the competitive intel survey (T10420) runs in parallel. Decomposition into 10 concrete implementation tasks follows below.
