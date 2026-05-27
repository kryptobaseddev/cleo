---
epic: T10401
stage: research
task: T10401
related:
  - type: task
    id: T10401
created: 2026-05-27
updated: 2026-05-27
---
# T10401 Research: Harness Daemon IPC

## Research Summary

### 1. ADR-089 Analysis

ADR-089 (Cleo Daemon — Native Autonomous Dispatch for Saga Lifecycles, dated 2026-05-26) is the authoritative design document for T10401. Key findings:

**Architecture:**
- Single TypeScript long-running process (`cleo daemon serve`)
- Absorbs the existing sentient daemon (T1737 legacy) into one unified daemon
- Components: DispatchEngine, ClaimManager, SpawnManager, MonitorEngine, VerificationEngine, NotificationEngine
- Multiple internal tick loops (dispatch 30s, monitor 10s, GC 5min, sentient 5min, cron 1min)

**Database schema additions (5 new tables):**
1. `agent_profiles` — agent configurations (provider, model, skills, capacities)
2. `task_runs` — append-only worker spawn history (pid, status, heartbeat, evidence)
3. `task_events` — audit log (claimed, reclaimed, promoted, completed, etc.)
4. `task_skills` — task-to-skill mapping for worker context injection
5. Alterations: `tasks.claimed_at`, `tasks.intended_profile`

**CORE API surface:**
- `daemon.start/stop/status` — lifecycle management
- `tasks.claim/release` — atomic claim operations
- `runs.history` — run history queries
- `events.audit` — event audit log queries

### 2. Current Daemon Architecture

**Existing code (packages/core/src/sentient/):**
- `daemon.ts` (1318 lines) — Current sentient daemon with cron-based ticks (every 5min), kill-switch, advisory locking, Studio supervision, curator integration
- `daemon-api.ts` (400 lines) — Public SDK daemon control API wrapping sentient + GC daemons
- `daemon-entry.ts` — Entry point for detached process spawning
- `tick.ts` — Tier-1 execution via `cleo orchestrate spawn`

**Existing CLI (packages/cleo/src/cli/commands/daemon.ts):**
- Current commands: `cleo daemon start/stop/status/install/uninstall`
- Start has `--foreground` flag for systemd/launchd
- Manages GC sidecar daemon and sentient loop
- No dispatch-loop / saga-focused operations yet

**GC Daemon (packages/core/src/gc/):**
- Separate sidecar for transcript cleanup
- Will be absorbed into the unified daemon per ADR-089

### 3. IPC Protocol Needs

T10401 title specifies three IPC transports: HTTP, Unix-socket, ZeroMQ.

**Use cases:**
- **HTTP (REST)**: Primary SDK API surface. Cockpit TUI (T10402) connects to daemon over envelope-IPC. External integrations (CI/CD, webhooks) use HTTP.
- **Unix-socket**: Local-only, low-latency IPC for CLI tools and co-located processes. Lower overhead than TCP. Preferred for `cleo` CLI ↔ daemon communication.
- **ZeroMQ**: High-performance message passing for internal components (heartbeats, event streaming, pub/sub). Used for NotificationEngine → Conduit bridge and VCM mutex coordination.

**Key IPC patterns:**
- Request-response: CLI commands, SDK API queries
- Pub-sub: Event notifications, heartbeat broadcasts, Conduit integration
- Streaming: Worker output, log streaming
- Mutex/locking: VCM (Versioned Concurrency Mutex) for task claim coordination

**Protocol considerations:**
- All IPC channels must carry LAFS envelopes (consistent with T10343 SG-ENVELOPE-FIRST)
- Types must be shared via `@cleocode/contracts` (consistent with T10400 SDK API)
- The daemon hosts `crates/cleo-gateway` (vendored from onecli per T10409) as an in-process Rust sidecar via napi-rs

### 4. SDK API Surface (T10400) Exposure

The daemon is the primary hosting environment for the T10400 SDK API. It must expose:

**Gateway operations:**
- `cleo daemon serve` starts the gateway hosting the SDK API
- The gateway is a vendored Rust binary (`crates/cleo-gateway`) providing HTTPS MITM, vault integration, JWT auth
- Daemon wraps the gateway and adds the dispatch loop, monitoring, and notification layers

**SDK API domains hosted by daemon:**
- `daemon.*` — start/stop/status
- `tasks.*` — claim/release (extends existing CRUD)
- `orchestrate.*` — ready/spawn/status/context/validate (existing, consumed by daemon)
- `runs.*` — history queries
- `events.*` — audit log queries
- `profiles.*` — agent profile CRUD

### 5. Existing T10401 Children (10 tasks)

The 10 existing children predate ADR-089 and are harness-architecture focused:
- T1738: Design CleoOS harness architecture
- T1750: CleoNativeHarnessAdapter
- T1751: Branch-lock worktree spawning
- T1752: Health monitoring and self-healing
- T1753: Deprecate external binary harnesses
- T1783: Gateway session + cron job schemas
- T1792: Gateway Runner infrastructure
- T1802: Cron Scheduler Engine
- T1808: Gateway-specific hooks
- T1811: Health monitoring diagnostics

These 10 tasks are blocked on various dependencies (T1741, T1742, T1745, T1785-T1800, etc.) in other sagas.

### 6. Sequencing Dependencies

Per North Star §4:
1. T10400 SG-CLEO-SDK-API must ship BEFORE T10401 implementation
2. T10409 SG-VAULT-CORE must ship BEFORE daemon production use
3. T10401 + T10403 can run in parallel

### 7. IPC Server Implementation Strategy

The IPC server should be a modular subsystem:

- **Transport layer**: Pluggable backends (HTTP via express/fastify, Unix-socket via node:net, ZeroMQ via zeromq.js)
- **Routing layer**: Maps operations (daemon.start, tasks.claim, etc.) to handlers
- **Envelope layer**: Wraps all responses in LAFS envelopes (T10343 compliance)
- **Auth layer**: JWT validation against vault (T10409), session management
- **Mutex layer**: VCM for task claim atomicity using SQLite BEGIN IMMEDIATE

### 8. Key Risks Identified

1. **Multi-daemon safety**: SQLite advisory locking + daemon.pid prevents dual-process
2. **HITL gates**: Daemon pauses on blocked, human approves via CLI/Cockpit
3. **Gateway vendoring**: crates/cleo-gateway from onecli must integrate cleanly
4. **Migration risk**: Existing sentient daemon must be absorbed without breaking Studio supervision or GC sidecar
5. **Performance**: Poll loop at 30s with 3 concurrent workers must not overload SQLite
