---
epic: T10402
stage: decomposition
task: T10402
related:
  - type: saga
    id: T10402
  - type: research
    path: ../research/T10402-research.md
  - type: consensus
    path: ../consensus/T10402-consensus.md
  - type: adr
    path: ../architecture/T10402-architecture-decision.md
  - type: spec
    path: ../specification/T10402-specification.md
created: 2026-05-27
updated: 2026-05-27
---

# Decomposition (T10402) — SG-COCKPIT-HARNESS

## Summary

T10402 decomposes into **10 concrete implementation tasks**, grouped into 4 implementation waves. Waves 1-3 deliver the functional Cockpit TUI. Wave 4 (follow-up) delivers Living Brain visualization. All tasks are self-contained, testable independently, and sequenced by dependency.

## Current Children (pre-existing)

| ID | Title | Type | Status |
|----|-------|------|--------|
| T10420 | EP-COCKPIT-COMPETITIVE-INTEL — Wave 0 survey (4 categories, steal-decisions, council review) | epic | pending |
| T10345 | EP-COCKPIT-TUI — Wave 0 architecture decision + Wave 1+ implementation | task | pending |
| T1806 | Build Web UI for daemon management in CleoOS | task | pending |
| T1812 | Performance optimization and stress testing for CleoOS | task | pending |

## New Decomposition (10 tasks)

### Wave 1: Foundation (3 tasks — can run in parallel)

#### Task 1: COCKPIT-SCAFFOLD — Rust Crate + TUI Bootstrap
**Size**: Small (2-4h)  
**Depends on**: None  
**Priority**: High  

Create `crates/cockpit/` as a Rust binary crate in the Cargo workspace:
- `Cargo.toml` with deps: ratatui 0.29, crossterm 0.28, tokio 1 (full), serde/serde_json, lafs-core (path), cleo-conduit-core (path)
- `src/main.rs`: tokio runtime bootstrap, crossterm terminal init (raw mode, alternate screen, panic hook restore), ratatui `Terminal` creation
- Minimal render loop: clears screen, draws "CLEO Cockpit — Waiting for daemon..." placeholder
- Workspace membership in root `Cargo.toml` (members + default-members)
- `cargo build` and `cargo run` both succeed
- `cargo clippy` passes with project workspace lints (no unwrap, no expect, missing_docs warn)

**Acceptance**:
- `crates/cockpit/` directory exists with Cargo.toml and src/main.rs
- `cargo build -p cockpit` succeeds from workspace root
- Binary launches, renders placeholder, exits cleanly on Ctrl+C
- Crossterm terminal is properly restored on exit (no garbled terminal)

#### Task 2: IPC-LAYER — ZeroMQ Transport + LAFS Envelopes + Heartbeat
**Size**: Medium (6-10h)  
**Depends on**: Task 1 (COCKPIT-SCAFFOLD)  
**Priority**: High  

Build the IPC client layer in `crates/cockpit/src/ipc/`:
- `client.rs`: ZeroMQ context management, PUB/SUB socket connect (daemon firehose), REQ/REP socket connect (control plane), graceful disconnect
- `transport.rs`: Serialize/deserialize `LafsEnvelope` over ZMQ multipart messages; handle framing (JSON body as message part); validate incoming envelopes against `lafs-core` schema
- `heartbeat.rs`: Track heartbeat pings from daemon PUB/SUB; detect 3 consecutive misses (3s window); emit `ConnectionState::Lost` event; exponential backoff reconnect (1s, 2s, 4s, 8s, max 30s)
- `operations.rs`: Typed request builders for `daemon.status`, `orchestrate.status`, `tasks.list`, `runs.history` — produce properly-formed `LafsEnvelope` with correct `operation`, `request_id`, `transport: Zmq`
- Daemon connection config from env vars: `CLEO_DAEMON_ZMQ_PUB` (default `tcp://127.0.0.1:5555`), `CLEO_DAEMON_ZMQ_REQ` (default `tcp://127.0.0.1:5556`), `CLEO_DAEMON_UNIX_SOCK` (default `~/.local/share/cleo/daemon.sock`)
- Error handling: all ZMQ errors map to `ConnectionState::Error(String)`; schema validation failures log warning but don't crash

**Acceptance**:
- Unit tests: envelope serialize/deserialize round-trip
- Unit tests: heartbeat state machine (connected → degraded → lost → reconnecting → connected)
- Unit tests: operation builder produces valid envelope with correct operation field
- Integration test (manual): `cargo test` passes all tests
- IPC module compiles and links into Cockpit binary

#### Task 3: LAYOUT-FRAMEWORK — 4-Quadrant ratatui Layout + Theme + Keybindings
**Size**: Medium (6-10h)  
**Depends on**: Task 1 (COCKPIT-SCAFFOLD)  
**Priority**: High  

Build the TUI shell in `crates/cockpit/src/ui/`:
- `layout.rs`: 4-panel layout using ratatui `Layout` with `Constraint::Ratio`. Left sidebar (20%), Right sidebar (25%), Center top (60%), Center bottom (40%). Resize handling recalculates constraints. Minimum terminal size enforcement (120×40).
- `theme.rs`: Color palette constants: `BG`, `FG`, `ACCENT`, `SUCCESS` (green), `WARNING` (yellow), `ERROR` (red), `INFO` (cyan), `MUTED` (gray). Dream state palette: `BG_DREAM` (dark purple), `FG_DREAM` (light lavender). ratatui `Style` helpers for common patterns.
- `keybindings.rs`: Global keybinding registry: `q`/`Ctrl+C` = quit, `1-4` = focus panel, `F5` = refresh, `?` = help overlay. Per-panel keybinding contexts (delegate to focused panel). crossterm `KeyEvent` → `Action` enum mapping.
- `app.rs`: App state machine: `AppState { connection: ConnectionState, focused_panel: PanelId, daemon: Option<DaemonState>, sagas: SagaTree, chat: Vec<ChatMessage>, workers: Vec<WorkerState> }`. Event loop with `tokio::select!` over crossterm events, ZMQ messages, render ticks, heartbeat ticks.
- `widgets/status_badge.rs`: Color-coded status indicator widget (pending/claimed/running/completed/failed/blocked)

**Acceptance**:
- Cockpit launches with 4 empty placeholder panels in correct layout
- Resize terminal window: layout recalculates correctly
- Press `1`/`2`/`3`/`4`: focused panel border changes to accent color
- Press `?`: help overlay appears with all keybindings listed
- Press `q`: graceful exit, terminal restored

---

### Wave 2: Panels (4 tasks — can run in parallel after Wave 1)

#### Task 4: HUD-PANEL — Left Sidebar (Daemon Health + Brain Stubs)
**Size**: Medium (6-10h)  
**Depends on**: Task 2 (IPC-LAYER), Task 3 (LAYOUT-FRAMEWORK)  
**Priority**: High  

Build the HUD panel in `crates/cockpit/src/ui/panels/hud.rs`:
- Daemon health section:
  - PID (from `daemon.status`), uptime in HH:MM:SS, memory usage in MB (if available)
  - Active worker count, queued task count, completed task count
  - Connection status dot: 🟢 connected, 🟡 degraded (1-2 missed heartbeats), 🔴 lost (3+ missed)
  - "Connection Lost" overlay with reconnect countdown when state = Lost
- Health gauges using `widgets/gauge.rs`:
  - Worker capacity gauge: running / max_concurrent (filled: cyan, empty: gray)
  - Queue depth gauge: ready tasks count (filled: yellow, empty: gray)
- Living Brain stubs (Wave 2 placeholders):
  - "Braille Canvas — Wave 2" placeholder panel with dashed border
  - "Semantic Ledger — Wave 2" placeholder panel with dashed border
  - Dream State indicator: reads `brain.dream_state` from daemon state; applies dream palette when active

**Acceptance**:
- Panel renders daemon health when connected to daemon
- Connection status dot changes correctly based on heartbeat state
- "Connection Lost" overlay appears after 3 missed heartbeats
- Gauges update in real-time as daemon state changes
- Brain stubs render as labeled placeholders
- Panel gracefully handles no-daemon state (shows "Disconnected — waiting for daemon...")

#### Task 5: PIPELINE-PANEL — Right Sidebar (Saga Tree + LOOM Tags)
**Size**: Large (10-16h)  
**Depends on**: Task 2 (IPC-LAYER), Task 3 (LAYOUT-FRAMEWORK)  
**Priority**: High  

Build the Pipeline panel in `crates/cockpit/src/ui/panels/pipeline.rs`:
- `widgets/tree.rs`: Collapsible tree widget — recursive node rendering with indentation, expand/collapse toggles (`▶`/`▼`), keyboard navigation (j/k up/down, Enter expand/collapse, Space select)
- Saga tree data model in `model/saga_tree.rs`:
  - `SagaNode { id, title, status, phase, children: Vec<EpicNode> }`
  - `EpicNode { id, title, status, phase, children: Vec<TaskNode> }`
  - `TaskNode { id, title, status, phase, assignee, children: Vec<SubtaskNode> }`
  - `SubtaskNode { id, title, status, phase }`
- LOOM phase tag rendering: RCASD phases (Research/Consensus/Architecture/Specification/Decomposition) render with blue tag; IVTR phases (Implementation/Validation/Testing/Release) render with green tag
- Task status color coding per spec F3
- Filter by status: `/` opens filter input; type `running` to show only running tasks; Escape clears filter
- Click to expand/collapse/select (crossterm mouse events)
- Scroll: j/k for line-by-line, PageUp/PageDown for page scroll

**Acceptance**:
- Panel renders saga hierarchy when daemon provides `tasks.list` data
- Expand/collapse works with keyboard (Enter) and mouse (click)
- LOOM tags show correct color for RCASD vs IVTR phases
- Task status colors match specification
- Filter by status works (e.g., show only "running" tasks)
- Scrollable when tree exceeds panel height
- Empty state: "No sagas loaded — start daemon dispatch to populate"

#### Task 6: ORCHESTRATOR-PANEL — Center Top (Chat + Conduit Feed)
**Size**: Medium (8-12h)  
**Depends on**: Task 2 (IPC-LAYER), Task 3 (LAYOUT-FRAMEWORK)  
**Priority**: Medium  

Build the Orchestrator panel in `crates/cockpit/src/ui/panels/orchestrator.rs`:
- `model/chat.rs`: `ChatMessage { id, from: AgentIdentity, content, timestamp, tags }`, `AgentIdentity { name, role: Prime | Lead(String) | Worker(String), color }`, `ConduitMessage` from `cleo-conduit-core`
- Chat feed rendering:
  - Prime Orchestrator messages: left-aligned, Cleo identity badge (magenta), full-width content
  - Conduit agent messages: right-aligned, agent-specific color badge, indented content
  - Conduit debate messages: centered, muted style, smaller text
  - Timestamps in HH:MM:SS format, dimmed
- `widgets/log_stream.rs`: Scrolling message buffer with ring buffer (max 1000 messages), PageUp/PageDown scroll, Home/End, auto-scroll-to-bottom on new message
- Message input line: `>` prompt at panel bottom, Enter to submit, Esc to clear, supports Unicode
- Commands: messages starting with `/` are treated as commands (`/status`, `/spawn <taskId>`, `/claim <taskId>`)

**Acceptance**:
- Panel renders chat messages from Prime and conduit agents
- Agent identity badges show correct colors
- Auto-scrolls to bottom on new message
- PageUp/PageDown scroll through history
- `/status` command dispatches `daemon.status` and displays response
- Empty state: "Orchestrator — no messages yet. Type to begin."

#### Task 7: ISOLATION-ZONE — Center Bottom (PTY Grid + Worker Streaming)
**Size**: Large (12-20h)  
**Depends on**: Task 2 (IPC-LAYER), Task 3 (LAYOUT-FRAMEWORK)  
**Priority**: High  

Build the PTY Isolation Zone in `crates/cockpit/src/ui/panels/isolation.rs`:
- `model/pty.rs`: `PtySession { worker_id, task_id, iteration, status, stdout_buffer: RingBuffer<String> }`, `PtyGrid { sessions: Vec<PtySession>, layout: GridLayout }`
- PTY pane grid:
  - Dynamic layout: 1 pane → full width; 2 panes → 1×2; 3-4 panes → 2×2; 5-6 → 3×2; 7-9 → 3×3; etc.
  - Each pane renders: worker ID badge (top-left), task ID (top-right), iteration count, status indicator
  - Stdout/stderr text area: preserves ANSI escape codes via `ansi-to-tui` crate or manual ANSI parsing
- ZeroMQ PUB/SUB worker stream handling:
  - Subscribe to `worker.{worker_id}.stdout` topics
  - Append to ring buffer (max 10,000 lines per worker)
  - Scroll: Shift+PageUp/PageDown per pane
- Crash-safe pane collapse:
  - When daemon reports worker status = `crashed` or `timed_out`:
    - Pane shrinks to a single-line summary (worker ID + status + exit code)
    - After 5 seconds, pane is removed from grid
- Keyboard controls:
  - Ctrl+Tab: cycle focused pane
  - Ctrl+W: close focused pane (sends terminate command to daemon)
  - Ctrl+Shift+Arrow: resize focused pane
  - Ctrl+[ / Ctrl+]: cycle between PTY panes (forward/backward)

**Multiplexer Strategy**:
- **If rmux approved by T10420 council (D8)**: Vendor `rmux` into `crates/cockpit/Cargo.toml`, create thin adapter at `src/multiplexer/rmux_adapter.rs`
- **If rmux rejected**: Hand-rolled PTY via `portable-pty` crate + ratatui pane grid

**Acceptance**:
- Empty state: "Isolation Zone — no active workers"
- When daemon reports a worker spawned: new pane appears with worker badge
- Stdout lines from daemon ZMQ PUB stream appear in correct pane
- Multiple workers render in correct grid layout
- Ctrl+Tab cycles between panes; focused pane has accent border
- Worker crash: pane collapses to summary line, then disappears
- Closing all panes: returns to empty state

---

### Wave 3: Integration (1 task)

#### Task 8: IPC-INTEGRATION — Wire All Panels to Live Daemon Data
**Size**: Large (10-16h)  
**Depends on**: Tasks 4, 5, 6, 7  
**Priority**: High  

Integrate all panels with real daemon IPC data:
- `app.rs` state management:
  - On ZMQ PUB message: parse `LafsEnvelope`, inspect `_meta.operation`, dispatch to correct panel state
  - On heartbeat ping: update `connection.last_heartbeat`, reset miss counter
  - On heartbeat miss (1s tick with no ping): increment miss counter; at 3 → set ConnectionState::Lost, show overlay
  - On reconnect: re-subscribe to all ZMQ topics, re-query `daemon.status`
- Panel data flow:
  - HUD panel subscribes to: `daemon.status` (health), `daemon.heartbeat` (liveness), `brain.pulse` (dream state)
  - Pipeline panel subscribes to: `tasks.list` (hierarchy), `tasks.status_change` (status updates), `orchestrate.status` (execution state)
  - Orchestrator panel subscribes to: `conduit.message` (agent chat), `orchestrator.message` (prime chat)
  - Isolation panel subscribes to: `worker.{id}.stdout` (per-worker streams), `worker.{id}.state` (lifecycle)
- Command dispatch:
  - On `/status`: send `daemon.status` REQ, await REP, update HUD
  - On `/spawn <taskId>`: send `orchestrate.spawn` REQ, await REP, flash confirmation in orchestrator
  - On `/claim <taskId>`: send `tasks.claim` REQ, await REP, update pipeline
  - On Ctrl+W (close pane): send `worker.terminate { worker_id }` REQ
  - On `s`/`x`: send `daemon.start` / `daemon.stop` REQ
- Periodic polling (every 30s): `daemon.status` + `tasks.list` + `orchestrate.status` for full state refresh (covers dropped ZMQ messages)

**Acceptance**:
- Cockpit connects to real `cleo daemon serve` and displays live data in all 4 panels
- Heartbeat detection works: "Connection Lost" appears when daemon stops; auto-recovers when daemon restarts
- `/spawn <taskId>` command triggers worker spawn in daemon; new PTY pane appears
- Worker stdout streams in real-time to correct PTY pane
- Task status changes in Pipeline panel reflect daemon state
- Conduit messages from agent communication appear in Orchestrator panel
- All commands (`/status`, `/spawn`, `/claim`) produce correct daemon IPC calls
- Cockpit exits cleanly: closes ZMQ sockets, restores terminal, leaves daemon running

---

### Wave 4: Hardening (2 tasks)

#### Task 9: E2E-INTEGRATION — Integration Tests + Stress Testing
**Size**: Medium (8-12h)  
**Depends on**: Task 8 (IPC-INTEGRATION)  
**Priority**: Medium  

End-to-end integration tests and stress testing:
- Integration test harness:
  - Script to start `cleo daemon serve` in background before test
  - Script to spawn mock workers that produce stdout traffic
  - Test: Cockpit connects, displays 4 panels with live data, disconnects cleanly
  - Test: Connection Lost + auto-reconnect cycle (kill daemon, restart, Cockpit recovers)
- Stress tests:
  - 10 concurrent worker PTY streams: no frame drops below 30fps
  - 100+ tasks in pipeline tree: tree renders without lag
  - 10,000 chat messages in orchestrator scrollback: scrolling is responsive
  - Daemon flapping (rapid connect/disconnect): Cockpit doesn't crash
- Crash resilience:
  - Kill Cockpit process (SIGKILL): daemon continues running, PTY workers unaffected
  - Kill daemon process: Cockpit shows Connection Lost, reconnects on daemon restart
  - Worker process crash: PTY pane collapses, other panes unaffected
- Performance benchmarks:
  - Startup time <500ms
  - Memory usage <200MB with 10 active PTY sessions
  - 60fps render during normal operation
  - ZMQ SUB handles 1MB/s aggregate worker output without frame drops

**Acceptance**:
- Integration test script passes: connect → display → disconnect
- Connection Lost + recovery test passes
- 10-worker stress test: no crashes, responsive UI
- 100-task tree renders without noticeable lag
- Performance metrics within spec (startup <500ms, memory <200MB, 60fps)

#### Task 10: BOUNDARY-LAFS-EXT — Extend LAFS Transport + Register Boundary
**Size**: Small (1-3h)  
**Depends on**: Task 1 (COCKPIT-SCAFFOLD)  
**Priority**: Medium  

Cross-cutting changes to integrate Cockpit into CLEO's architecture governance:
- Extend `LafsTransport` enum in `crates/lafs-core/src/lib.rs`:
  - Add `Zmq` variant (serializes as `"zmq"`)
  - Bump `spec_version` if schema changes required
  - Update `LafsMeta::new()` if needed (no changes expected)
- Register `BoundaryEntry` in `packages/contracts/src/boundary.ts`:
  - Entry for `crates/cockpit/`: Rust binary, consumer of `lafs-core` + `cleo-conduit-core`, IPC-only (no NAPI bridge)
  - Cross-reference to T10402 + T10401 + T10400
- Update `crates/lafs-core/schemas/v1/envelope.schema.json`:
  - Add `"zmq"` to transport enum values
  - Run `scripts/lint-lafs-schema-parity.mjs` to verify parity with TypeScript SSoT
- Run `cargo test -p lafs-core` to verify transport extension doesn't break existing tests
- Run `cargo clippy --workspace` to verify no new lint violations

**Acceptance**:
- `LafsTransport::Zmq` compiles and serializes to lowercase `"zmq"`
- Existing lafs-core tests pass (backward compatible)
- Boundary registry entry exists for `crates/cockpit/`
- `lint-lafs-schema-parity.mjs` passes
- `cargo clippy --workspace` passes

---

## Task Summary

| # | Task | Size | Wave | Dependencies |
|---|------|------|------|-------------|
| 1 | COCKPIT-SCAFFOLD: Rust crate + TUI bootstrap | Small | 1 | None |
| 2 | IPC-LAYER: ZeroMQ transport + LAFS envelopes + heartbeat | Medium | 1 | Task 1 |
| 3 | LAYOUT-FRAMEWORK: 4-quadrant layout + theme + keybindings | Medium | 1 | Task 1 |
| 4 | HUD-PANEL: Left sidebar (daemon health + brain stubs) | Medium | 2 | Tasks 2, 3 |
| 5 | PIPELINE-PANEL: Right sidebar (saga tree + LOOM tags) | Large | 2 | Tasks 2, 3 |
| 6 | ORCHESTRATOR-PANEL: Center top (chat + conduit feed) | Medium | 2 | Tasks 2, 3 |
| 7 | ISOLATION-ZONE: Center bottom (PTY grid + worker streaming) | Large | 2 | Tasks 2, 3 |
| 8 | IPC-INTEGRATION: Wire all panels to live daemon data | Large | 3 | Tasks 4-7 |
| 9 | E2E-INTEGRATION: Integration tests + stress testing | Medium | 4 | Task 8 |
| 10 | BOUNDARY-LAFS-EXT: Extend LAFS transport + boundary registry | Small | 1 | Task 1 |

## Estimated Total Effort

- **Small tasks (2)**: ~6h
- **Medium tasks (5)**: ~50h
- **Large tasks (3)**: ~42h
- **Total**: ~98h (~2.5 weeks for 1 FTE, ~1.5 weeks for 2 FTE)

## Parallelization

```
Wave 1 (parallel):  Task 1 ──┬── Task 2
                             └── Task 3 ── Task 10

Wave 2 (parallel):  Task 2 ──┬── Task 4
                    Task 3 ──├── Task 5
                             ├── Task 6
                             └── Task 7

Wave 3 (sequential): Tasks 4-7 ── Task 8

Wave 4 (parallel):   Task 8 ──┬── Task 9
                              └── (none)
```

Wave 1 and Wave 2(partial) can overlap: Task 10 can start as soon as Task 1 completes. Tasks 2 and 3 can run in parallel once Task 1 is done. All 4 panel tasks can run in parallel once Tasks 2 and 3 are done.

## Relationship to Pre-Existing Children

| Child | Relationship |
|-------|-------------|
| T10420 | Pre-work (Wave 0). Runs in parallel with Wave 1 scaffold. RMUX decision (D8) gates Task 7's multiplexer strategy. OpenCode findings inform Task 6 (chat UX). Does NOT block Tasks 1-3. |
| T10345 | Architecture decision document. Produced from this decomposition's consensus + architecture artifacts. Consider folding into T10402 consensus directly. |
| T1806 | Web UI for daemon management. Currently under T10402; may move to T10401 or T10419 per D10. Cockpit does NOT depend on T1806. |
| T1812 | Performance optimization and stress testing. Task 9 (E2E-INTEGRATION) provides the baseline; T1812 extends for production hardening. |

## Gating Dependencies (External Sagas)

| Saga | What T10402 Needs | Status |
|------|------------------|--------|
| T10400 | SDK API spec (OpenAPI 3.2) — defines operation schemas Cockpit consumes | pending |
| T10401 | Daemon IPC server — the runtime Cockpit connects to | pending (depends on T10400 + T10409) |
| T10409 | Gateway (HTTPS control plane) — hosts the IPC surface | pending |

**Note**: Cockpit Wave 1-2 tasks can be developed and tested against a mock daemon (returns canned LAFS envelopes). Wave 3-4 integration requires a real T10401 daemon. Per North Star §4 sequencing, T10401 ships before T10402.
