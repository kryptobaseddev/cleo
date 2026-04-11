# Creating Custom Agents

**Version**: 1.0.0
**Status**: ACTIVE
**Task**: T440 (WS-3 Documentation Lead)

A practical guide for creating custom subagents in the CleoOS Agent Platform using `.cant` (Collaborative Agent Notation Tongue) definition files.

---

## Prerequisites

- A working CleoOS installation with `@cleocode/cant` installed
- Familiarity with the CLEO task system (`cleo show`, `cleo start`, `cleo complete`)
- Understanding of the base subagent protocol (see `packages/agents/cleo-subagent/AGENT.md`)

---

## Step 1: Write a `.cant` File

Every agent starts with a `.cant` file that declares its persona, role, capabilities, and behavioral constraints.

### Minimal Example

```cant
---
kind: agent
version: 1
---

agent my-worker:
  model: sonnet
  description: "A focused worker agent for backend tasks."
  prompt: "You are my-worker -- a backend development agent. You write clean, tested TypeScript code. You follow SOLID principles and existing patterns."
  role: worker
  parent: orchestrator
  tier: 0
  skills: ["ct-cleo", "ct-task-executor"]

  tools:
    core: [Read, Write, Edit, Bash, Glob, Grep]

  permissions:
    tasks: read, write
    session: read, write
    memory: read, write
    pipeline: read, write
    check: read, execute
    tools: read
```

### Full Example (ULTRAPLAN section 9.3 canonical pattern)

```cant
---
kind: agent
version: 1
---

agent backend-dev:
  model: sonnet
  persist: session
  description: "Backend development agent specializing in TypeScript packages and API work."
  prompt: "You are backend-dev -- a specialized backend developer. You build TypeScript packages, write API endpoints, create database migrations, and ensure test coverage. You follow the project's ESM conventions, use Vitest for testing, and always run quality gates before completing work."
  role: worker
  parent: cleo-core
  tier: 0

  skills: ["ct-cleo", "ct-task-executor", "ct-dev-workflow"]

  tools:
    core: [Read, Write, Edit, Bash, Glob, Grep]

  domains:
    tasks: "Task hierarchy, CRUD, work tracking"
    session: "Session lifecycle, decisions, context"
    memory: "Cognitive memory: observations, decisions, patterns, learnings"
    pipeline: "RCASD-IVTR+C lifecycle, manifest ledger"
    check: "Schema validation, compliance, testing"
    tools: "Skills, providers"

  permissions:
    tasks: read, write
    session: read, write
    memory: read, write
    pipeline: read, write
    check: read, execute
    tools: read
    admin: read
    files:
      write: ["packages/api/**", "packages/core/**", "crates/**"]
      read: ["**/*"]

  tokens:
    required:
      TASK_ID: pattern("^T[0-9]+$")
      DATE: date
      TOPIC_SLUG: pattern("^[a-z0-9-]+$")
    optional:
      EPIC_ID: pattern("^T[0-9]+$") = ""
      OUTPUT_DIR: path = ".cleo/agent-outputs"

  constraints [lifecycle]:
    BASE-001: MUST append ONE entry to pipeline manifest before returning
    BASE-003: MUST complete task via tasks.complete
    BASE-005: MUST start task before beginning work
    BASE-008: MUST check success field on every LAFS response

  constraints [behavior]:
    BASE-002: MUST NOT return content in response
    BASE-006: MUST NOT fabricate information

  context:
    active-tasks
    memory-bridge

  on SessionStart:
    session "Load task context and begin protocol"
      context: [active-tasks]
```

### Key Fields

| Field | Required | Description |
|-------|----------|-------------|
| `model` | Yes | Model tier: `haiku`, `sonnet`, `opus` |
| `description` | Yes | One-line summary of the agent's purpose |
| `prompt` | Yes | System prompt injected at spawn time |
| `role` | Yes | Role type: `worker`, `lead`, `developer`, `project-lead`, `orchestrator` |
| `parent` | No | Parent agent in the hierarchy |
| `tier` | No | Agent tier: `0` (default), `1`, `2` |
| `skills` | No | Array of skill names to load at spawn |
| `tools` | No | Grouped tool access declarations |
| `permissions` | No | Domain and file access controls |
| `tokens` | No | Token replacement definitions |
| `constraints` | No | Behavioral constraints (RFC 2119 language) |
| `context` | No | Context sources to load at spawn time |
| `on <Event>` | No | Event hooks (SessionStart, TaskCompleted, PostToolUse, etc.) |

### Roles and Their Implications

| Role | Can Edit/Write/Bash? | Can Delegate? | Path ACL? |
|------|---------------------|---------------|-----------|
| `worker` | Yes (within declared paths) | No | Yes, via `permissions.files.write` |
| `lead` | No (blocked by `tool_call` hook) | Yes (via `delegate` tool) | N/A |
| `developer` | Yes | No | Optional |
| `orchestrator` | Yes | Yes (via spawn/fanout) | Optional |

---

## Step 2: Place the `.cant` File

### Project Tier (recommended for project-specific agents)

Place your `.cant` file in the project's `.cleo/cant/` directory:

```
<project-root>/
  .cleo/
    cant/
      backend-dev.cant      <-- your agent definition
      frontend-dev.cant
      db-specialist.cant
```

The cleo-cant-bridge Pi extension scans this directory recursively at session start. Subdirectories are supported:

```
.cleo/
  cant/
    teams/
      platform-team.cant
    agents/
      backend-dev.cant
      frontend-dev.cant
```

### Global and User Tiers (implemented in T438)

For agents shared across all projects, place them in the global or user tier:

| Tier | Path | Precedence |
|------|------|------------|
| Global | `$XDG_DATA_HOME/cleo/cant/` (`~/.local/share/cleo/cant/`) | Lowest |
| User | `$XDG_CONFIG_HOME/cleo/cant/` (`~/.config/cleo/cant/`) | Middle |
| Project | `<project>/.cleo/cant/` | Highest |

Files in higher-precedence tiers override files in lower-precedence tiers that share the same basename. For example, a project-tier `backend-dev.cant` overrides a global-tier `backend-dev.cant`.

### Seed Agents (reference)

The project ships seed agent definitions at `packages/agents/seed-agents/`:
- `cleo-dev.cant` -- General-purpose development agent
- `cleo-rust-lead.cant` -- Rust crate architecture lead
- `cleo-historian.cant` -- Canon/documentation guardian
- `cleo-db-lead.cant` -- Database domain lead
- `cleo-prime.cant` -- Primary orchestrator
- `cleoos-opus-orchestrator.cant` -- Legacy orchestrator

These serve as reference examples but are not automatically loaded. Copy and customize them into your `.cleo/cant/` directory if needed.

---

## Step 3: Verify the Agent Definition

### Option A: Check via Pi session

Start a Pi session and verify the bridge loaded your agent:

```bash
# Start Pi and look for the CANT bridge status message
# The bridge will report: "CANT: N agent(s), M file(s)"

# Use the introspection command
/cant:bundle-info
```

The `/cant:bundle-info` command reports:
- Number of files compiled
- Number of agents, teams, and tools found
- Whether the bundle is valid
- Count of errors and warnings

### Option B: Check the rendered system prompt

The compiled bundle is appended to the Pi system prompt. You can verify your agent appears by checking the prompt includes:

```markdown
## CANT Bundle -- Loaded Declarations

### Agents

- **backend-dev** (role: worker, tier: 0)
  You are backend-dev -- a specialized backend developer...
```

### Common Validation Errors

| Error | Cause | Fix |
|-------|-------|-----|
| Missing frontmatter | No `---` block at top of file | Add `kind: agent` and `version: 1` frontmatter |
| Parse failure | Invalid CANT syntax | Check indentation and property format |
| S01 rule violation | Missing required field | Add the required field (usually `model` or `prompt`) |

---

## Step 4: Assign the Agent to a Team

Teams are defined in `.cant` files using the `team` syntax. Place a team definition file in `.cleo/cant/` or `.cleo/workflows/`:

```cant
---
kind: workflow
version: 1
---

team platform-team:
  description: "Platform development team for backend services"
  orchestrator: cleo-prime
  consult-when: "backend API database migration service infrastructure"
  stages: [implementation, testing, review]

  members:
    - backend-dev
    - db-specialist

  lead: backend-dev
```

### Team Routing

When the orchestrator receives a task, it uses `orchestrate.classify` to route the request to the best-matching team based on the `consult-when` hint. The classifier performs substring matching against the request text.

To verify team routing:

```
query orchestrate.classify { request: "build a new API endpoint for user profiles" }
```

This returns the matched team, suggested protocol, and confidence score.

---

## Step 5: Spawn the Agent

Agents are spawned through the orchestrate dispatch domain. There are three spawn paths:

### Single Spawn

The orchestrator spawns a single agent for a specific task:

```
mutate orchestrate.spawn { taskId: "T1234", protocolType: "implementation" }
```

This validates spawn readiness, prepares the spawn context with token resolution, and returns the spawn prompt. To execute the actual spawn:

```
mutate orchestrate.spawn.execute { taskId: "T1234" }
```

### Fanout (Parallel Spawn)

Spawn multiple agents concurrently:

```
mutate orchestrate.fanout {
  items: [
    { team: "platform-team", taskId: "T1234" },
    { team: "platform-team", taskId: "T1235" },
    { team: "frontend-team", taskId: "T1236" }
  ]
}
```

Each item is dispatched concurrently via `Promise.allSettled`. Results include per-item status:

```json
{
  "manifestEntryId": "fanout-1712678400000-abc123",
  "results": [
    { "taskId": "T1234", "status": "spawned", "instanceId": "claude-..." },
    { "taskId": "T1235", "status": "spawned", "instanceId": "claude-..." },
    { "taskId": "T1236", "status": "failed", "error": "No adapter available" }
  ]
}
```

### Handoff (Session End + Spawn)

Composite operation that ends the current session and spawns a successor:

```
mutate orchestrate.handoff {
  taskId: "T1234",
  protocolType: "implementation",
  note: "Handing off to implementation agent"
}
```

### Spawn Lifecycle

Once spawned, the subagent follows the 4-phase lifecycle defined in `AGENT.md`:

1. **Initialize**: Worktree guard check, then `cleo show` and `cleo start`
2. **Execute**: Follow the injected skill protocol
3. **Output**: Write output file, append manifest entry, `cleo complete`
4. **Return**: Return one-line summary only

---

## File Permissions (Path ACL)

Workers with declared `permissions.files.write` globs are restricted to those paths at runtime. The `tool_call` hook in `cleo-cant-bridge.ts` enforces this.

```cant
agent backend-dev:
  permissions:
    files:
      write: ["packages/api/**", "packages/core/**"]
      read: ["**/*"]
      delete: ["packages/api/**"]
```

### ACL Behavior

| `write` value | Effect |
|---------------|--------|
| `undefined` (not declared) | No write ACL -- unrestricted |
| `[]` (empty array) | Read-only agent -- all writes blocked |
| `["packages/api/**"]` | Writes allowed only within matching paths |

If a worker attempts to write outside its declared paths, it receives:

```json
{
  "rejected": true,
  "error": {
    "code": 71,
    "codeName": "E_WORKER_PATH_ACL_VIOLATION",
    "message": "Worker backend-dev is not allowed to write to docs/README.md",
    "fix": "This worker can only write inside: packages/api/**, packages/core/**"
  }
}
```

---

## Troubleshooting

| Problem | Diagnostic | Solution |
|---------|-----------|----------|
| Agent not appearing in bundle | Run `/cant:bundle-info` | Check file is in `.cleo/cant/` and has `.cant` extension |
| Parse errors | Check diagnostics in bundle info | Fix CANT syntax (indentation, missing colons) |
| Spawn fails with E_SPAWN_NO_ADAPTER | No Claude CLI installed | Install `claude` CLI and ensure it is in PATH |
| Worker writes blocked unexpectedly | Check `permissions.files.write` | Expand glob patterns or remove write ACL for unrestricted access |
| Mental model not injecting | Agent has no prior observations | Run `cleo observe "..."` with the agent name to seed observations |
| Token resolution failure | Required tokens unresolved | Ensure task has proper fields (title, labels, parentId) |

---

## Key File Reference

| File | Purpose |
|------|---------|
| `packages/agents/cleo-subagent/AGENT.md` | Base protocol every subagent inherits |
| `packages/agents/cleo-subagent/cleo-subagent.cant` | CANT version of the base protocol |
| `packages/agents/seed-agents/*.cant` | Reference agent definitions |
| `packages/cant/src/bundle.ts` | `compileBundle()` implementation |
| `packages/cleo-os/extensions/cleo-cant-bridge.ts` | Pi extension that discovers and compiles `.cant` files |
| `docs/guides/CANT-REFERENCE.md` | Full CANT syntax reference |
| `docs/guides/SUBAGENT-INJECTION-PIPELINE.md` | End-to-end injection pipeline documentation |
