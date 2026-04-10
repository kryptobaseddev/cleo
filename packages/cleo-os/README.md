# CleoOS

> The batteries-included agentic development environment.
> One developer. Many agents. One operating system for the work.

CleoOS wraps [Pi](https://github.com/mariozechner/pi) — Mario Zechner's
open-source coding agent — with CLEO's governance layer: task memory,
lifecycle gates, multi-agent coordination, and the CANT DSL. Install once,
get both.

## Quick Start

```bash
npm install -g @cleocode/cleo-os
cleoos
```

That's it. CleoOS installs Pi automatically. The `cleoos` command launches
Pi with CleoOS extensions pre-loaded. The `cleo` CLI is also available for
task management, memory, and lifecycle operations.

## If You're...

| Goal | Start here |
|---|---|
| **New to AI coding agents** | [The Hearth](#the-hearth) — what you see when you run `cleoos` |
| **Already using Pi** | [What CleoOS Adds](#what-cleoos-adds-to-pi) — the extensions Pi doesn't have |
| **Comparing tools** | [Why CleoOS](#why-cleoos) — how it differs from Claude Code, Cursor, Copilot |

---

## Why CleoOS

AI coding agents can write code. What they cannot do is sustain a project across days, agents,
and context windows. Each session starts fresh, forgets last week's architectural decision,
and has no idea which tasks are blocked or why. The result: impressive demos, fragile projects.

CleoOS adds the missing layer. BRAIN persists memory across every session so agents never
rediscover the same facts twice. The CANT DSL defines agent roles, permissions, and mental models
in a checked-in file so governance is reproducible. The three-tier hierarchy gives leads the
authority to coordinate without giving them the power to cause chaos, and gives workers a
constrained domain where they can operate confidently.

The key differentiator is enforcement. Many tools describe role hierarchies. CleoOS enforces
them at the `tool_call` hook level inside Pi: lead agents literally cannot execute `Edit`,
`Write`, or `Bash`, and worker agents cannot write outside their declared file paths. There is
no workaround because the hook runs before Pi dispatches the tool call.

Pi provides excellent single-agent coding capability — a well-designed TUI, solid model
integration, and a stable extension API. CleoOS is not a competitor. It is the governance
shell that makes Pi production-ready for multi-agent workflows.

---

## The Five Named Powers

CleoOS is built on CLEO's five named powers. Each maps to a concrete runtime system:

| Power | What It Does |
|-------|-------------|
| **CLEO** | Governs continuity, routing, and system action across all sessions |
| **BRAIN** | Stores durable project knowledge — observations, decisions, patterns, learnings |
| **LOOM** | Enforces order of operations through the RCASD-IVTR+C lifecycle |
| **NEXUS** | Connects projects without merging them — cross-project registry |
| **LAFS** | Standardizes outputs for tools and agents — progressive disclosure protocol |

**CAAMP** is the provisioning ally: it equips the realm with provider configs, skills, and
injected instructions. See the [CLEO World Map](../../docs/concepts/CLEO-WORLD-MAP.md) for
the full narrative behind each power.

---

## The Hearth

The Hearth is what you see when you run `cleoos`. It is Pi's terminal UI with CleoOS
extensions loaded automatically:

- **CANT bridge** — reads `.cleo/cant/*.cant` files and injects agent personas, tool ACLs,
  and mental model preambles into the Pi session at startup. Compiles CANT DSL to system
  prompt injection transparently.
- **Chat room widget** — a below-editor panel that shows the last 15 inter-agent messages
  in real time. Messages arrive from other agents in the current worktree via `conduit.db`
  or `api.signaldock.io`. The chat room is a TUI view — it is not itself a messaging transport.
- **Status line** — shows the current agent tier, role name, and active task context pulled
  from BRAIN on spawn.

The Hearth is the operator surface. Conduit is the agent relay below it.

---

## The Three-Tier Hierarchy

The three-tier hierarchy is the headline feature of CleoOS. It brings structure to multi-agent
projects by giving each tier distinct powers and hard constraints enforced at runtime.

```
Orchestrator (you, or /cleo:auto <epicId>)
    │
    ├── Engineering Lead (thinker, NEVER executes)
    │   ├── backend-dev   (worker, writes code)
    │   ├── frontend-dev  (worker, writes code)
    │   └── qa-engineer   (worker, writes tests)
    │
    ├── Validation Lead
    │   ├── security-reviewer (worker, audits)
    │   └── doc-writer        (worker, writes docs)
    │
    └── Release Lead
        └── release-manager   (worker, ships)
```

### Tier Capabilities

| Tier | Role | Power | Hard Constraint |
|------|------|-------|-----------------|
| **Orchestrator** | Runs the Conductor Loop (`/cleo:auto <epicId>`) | Full system access | HITL boundary — user approves epic-level decisions |
| **Lead** | Coordinates a worker group, reviews output, delegates | Read + think + delegate | CANNOT execute `Edit`, `Write`, or `Bash` — no exceptions |
| **Worker** | Executes concrete code changes within a declared domain | Read + write within domain | Path ACL: `permissions.files: write[glob]` — cannot write outside glob |

### Enforcement (shipped in Wave 7b)

Enforcement runs at the Pi `tool_call` hook level. When a lead agent attempts to call
`Edit`, `Write`, or `Bash`, the hook intercepts the call before Pi dispatches it and
returns a rejection. When a worker agent attempts to write to a path outside its declared
glob pattern, the same hook rejects the call. There is no workaround at the agent level.

Teams are defined in `.cleo/teams.cant`:

```cant
team engineering-lead {
  role: lead
  workers: [backend-dev, frontend-dev, qa-engineer]
}

team backend-dev {
  role: worker
  permissions {
    files { write ["packages/core/**", "packages/contracts/**"] }
  }
}
```

### Wave Status

| Feature | Status |
|---|---|
| Lead tool blocking (`Edit`/`Write`/`Bash` rejected for `role: lead`) | Wave 7b shipped |
| Worker path ACL (`permissions.files: write[glob]` enforced) | T422-T426 shipped |
| `.cleo/teams.cant` definition format | Wave 0 shipped |
| Model tier routing (low/mid/high per tier) | Grammar shipped, router in progress |
| JIT agent composition (spawn team from task type) | Library exists, not wired to spawn path |

---

## Conduit — Agent Communication

Conduit is CLEO's agent-to-agent communication layer, structured in four concentric shells.
Each shell handles a different scope of agent communication.

### Shell 1 — Pi Native (free, built-in)

Orchestrator-to-lead-to-worker communication inside a single session. Pi handles
parent/child relay automatically via its JSONL subagent-link. No CLEO infrastructure
needed. Zero latency. Zero cost.

### Shell 2 — conduit.db (shipped v2026.4.12)

Per-project local messaging in SQLite at `.cleo/conduit.db`. Provides messages,
conversations, delivery queue, and dead-letter handling. Used when agents communicate
across sessions or hand off state between orchestrator runs on the same machine. Also
holds `project_agent_refs` — per-project agent visibility overrides that layer on top of
the global identity registry.

### Shell 3 — signaldock.io Cloud (shipped)

Cross-machine and cross-project agent coordination via the `signaldock-sdk` Rust crate
against `api.signaldock.io`. Four services: AgentService, MessageService,
ConversationService, DeliveryOrchestrator. TypeScript reaches the cloud tier via
`HttpTransport` (polling) or `SseTransport` (real-time EventSource). Used when a fleet
of agents spans multiple machines or CI environments.

### Shell 4 — Durable Broker (planned)

The CLEOOS-VISION message bus with Rust broker, TypeScript semantics, lease-based delivery,
and dead-letter queue. Deferred until cross-worktree durability is required by real workflows.

> **Note**: The Chat Room (`cleo-chatroom.ts`) is a TUI view under The Hearth, not a
> Conduit shell. It gives the operator visibility into inter-agent messages. Messages
> displayed in the chat room flow through `conduit.db` or `signaldock.io` — the chat room
> itself is only a renderer.

---

## What CleoOS Adds to Pi

| Capability | How | Source |
|---|---|---|
| **CANT bridge** | Injects agent personas from `.cleo/cant/*.cant` into Pi sessions at startup. Compiles CANT to system prompt injection. | `extensions/cleo-cant-bridge.ts` |
| **Lead tool blocking** | `tool_call` hook rejects `Edit`/`Write`/`Bash` for `role: lead` agents | Wave 7b |
| **Worker path ACL** | `tool_call` hook enforces `permissions.files: write[glob]` per worker | T422-T426 |
| **Mental model injection** | Fetches prior observations from BRAIN on spawn, injects validate-on-load preamble | Wave 8 |
| **Chat room TUI** | 4 inter-agent tools + below-editor widget showing last 15 messages | Wave 7 |
| **XDG-compliant paths** | All CleoOS state under `~/.local/share/cleo/` (Linux), `~/Library/Application Support/cleo/` (macOS) | `src/xdg.ts` |
| **Pi keystore redirect** | Pi credentials stored at `~/.config/cleo/auth/auth.json` instead of Pi's default | `src/keystore.ts` |
| **Postinstall scaffolding** | Creates XDG dirs, deploys extensions, scaffolds `model-routing.cant` stub, installs CLEO skills | `src/postinstall.ts` |

---

## Database Topology

CleoOS maintains five databases across two tiers per ADR-036 and ADR-037.

### Project Tier (`.cleo/`)

| Database | Purpose |
|---|---|
| `tasks.db` | Task hierarchy, sessions, audit log, lifecycle pipelines |
| `brain.db` | Observations, patterns, learnings, decisions (FTS5 searchable) |
| `conduit.db` | Agent messaging, delivery queue, `project_agent_refs` |

### Global Tier (`$XDG_DATA_HOME/cleo/`)

| Database | Purpose |
|---|---|
| `nexus.db` | Cross-project registry, federated queries |
| `signaldock.db` | Canonical agent identity, cloud-sync tables |

Plus: `global-salt` (32-byte machine-bound key for API key derivation), `machine-key`,
`extensions/`, and `cant/` directories for globally installed CANT files.

---

## Installation

```bash
# One command installs both CleoOS and Pi
npm install -g @cleocode/cleo-os

# Verify
cleoos --version
cleo version
```

### What Gets Installed

- `cleoos` binary — launches Pi with CleoOS extensions pre-loaded
- `cleo` binary — CLEO CLI (90+ commands across 10 canonical domains)
- `@mariozechner/pi-coding-agent` — Mario Zechner's open-source AI coding agent
- XDG directory structure at `~/.local/share/cleo/`
- Default CANT stubs and skill files

### Requirements

- Node.js >= 24.0.0
- An AI provider API key (set via `cleoos` on first run, stored in `~/.config/cleo/auth/auth.json`)

---

## Architecture

```
+-----------------------------------------------------------+
|                   @cleocode/cleo-os                       |
|  (CleoOS — batteries-included Pi wrapper)                 |
|                                                           |
|  +------------------------+  +------------------------+   |
|  | extensions/            |  | extensions/            |   |
|  | cleo-cant-bridge.ts    |  | cleo-chatroom.ts       |   |
|  | (CANT compile,         |  | (4 tools, TUI widget,  |   |
|  |  ACL enforcement,      |  |  JSONL relay,          |   |
|  |  mental model inject)  |  |  not a Conduit shell)  |   |
|  +------------------------+  +------------------------+   |
|  src/cli.ts         <- cleoos launcher                     |
|  src/postinstall.ts <- XDG scaffolding                     |
+-----------------------------------------------------------+
        |
        v (direct dependency)
+-----------------------------------------------------------+
|             @mariozechner/pi-coding-agent                 |
|  TUI, model providers, session management,                |
|  extension API, tool execution, subagent spawn            |
+-----------------------------------------------------------+
        |
        v
+-----------------------------------------------------------+
|                   @cleocode/cleo                          |
|  CLI (90+ commands), dispatch registry,                   |
|  LAFS envelopes, 10 canonical domains                     |
+-----------------------------------------------------------+
        |
        v
+-----------------------------------------------------------+
|                   @cleocode/core                          |
|  Tasks, sessions, memory, orchestration,                  |
|  lifecycle, validation, backup, conduit                   |
+-----------------------------------------------------------+
        |
        v
+-----------------------------------------------------------+
|             SQLite (node:sqlite via Drizzle ORM)          |
|  tasks.db   brain.db   conduit.db   nexus.db              |
|  signaldock.db                                            |
+-----------------------------------------------------------+
```

---

## Wave Roadmap

CleoOS ships in named waves. Each wave targets a vertical slice of the platform.

| Wave | Title | Status | Key Deliverable |
|------|-------|--------|-----------------|
| 0 | CANT Grammar | Shipped | `team`, `tool`, `mental_model` document kinds |
| 2 | CANT Bridge MVP | Shipped | `cleo-cant-bridge.ts` — compile + inject at session_start |
| 3 | Launcher + Install | Shipped | `cleoos` binary, postinstall, XDG hub |
| 7 | Chat Room + Hierarchy | Shipped | 4 inter-agent tools, TUI widget, 3-tier enforcement |
| 7b | Lead Tool Blocking | Shipped | `Edit`/`Write`/`Bash` blocked for `role: lead` |
| 8 | Mental Model Injection | Shipped | validate-on-load from BRAIN on agent spawn |
| ACL | Worker Path ACL | Shipped | `permissions.files: write[glob]` enforcement |
| 1 | Render Pipeline | Partial | Rust stubs exist, no `cant render` CLI verb yet |
| 4 | Lifecycle Codegen | Partial | `.cant` files exist, `stages.ts` connection missing |
| 5 | JIT Agent Composer | Partial | Library shipped, not wired to spawn path |
| 6 | Model Router | In progress | Rust classifier crate exists |
| 9 | Three-Tier CANT Resolution | Not started | Global/user/project `.cant` file hierarchy |

---

## References

- [CLEO World Map](../../docs/concepts/CLEO-WORLD-MAP.md) — the founding myth and system vocabulary
- [CleoOS Vision](../../docs/concepts/CLEOOS-VISION.md) — the long-term vision document
- [ADR-035](../../.cleo/adrs/ADR-035-pi-v2-v3-harness.md) — Pi as primary harness
- [ADR-036](../../.cleo/adrs/ADR-036-cleoos-database-topology.md) — database topology
- [ADR-037](../../.cleo/adrs/ADR-037-conduit-signaldock-separation.md) — conduit/signaldock split
- [Pi Coding Agent](https://github.com/mariozechner/pi) — the upstream agent CleoOS wraps

---

## License

MIT
