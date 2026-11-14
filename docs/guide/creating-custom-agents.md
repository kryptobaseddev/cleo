# Creating Custom Agents

**Version**: 2.0.0
**Status**: ACTIVE
**Task**: T440 (WS-3 Documentation Lead)

A practical guide for creating custom CLEO subagents from `.cant` (Collaborative Agent Notation Tongue) definition files: write the file, install it with `cleo agent install`, and let `cleo orchestrate spawn` resolve it.

> **ADR-098 status.** Earlier versions of this guide loaded agents through the Pi `cleo-cant-bridge` extension of CleoOS. That harness is deprecated and retires under ADR-098. Agents are installed into the agent registry and resolved by the spawn pipeline, which works in every harness.

---

## Prerequisites

- The `cleo` CLI (it bundles `@cleocode/cant` for parsing and validation)
- Familiarity with the CLEO task system (`cleo show`, `cleo start`, `cleo complete`)
- Understanding of the base subagent protocol (`packages/agents/cleo-subagent.cant`)

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
| `lead` | No (by protocol; see the note below) | Yes (via `delegate` tool) | N/A |
| `developer` | Yes | No | Optional |
| `orchestrator` | Yes | Yes (via spawn/fanout) | Optional |

The lead tool block and the worker path ACL were enforced at runtime only by the Pi `cleo-cant-bridge` extension, which retires under ADR-098. In other harnesses they are declarations the spawn prompt carries, not a sandbox.

---

## Step 2: Validate the `.cant` File

```bash
cleo cant validate backend-dev.cant   # the 42-rule validator from cant-core
cleo cant list backend-dev.cant       # agents, workflows and pipelines it declares
```

### Common Validation Errors

| Error | Cause | Fix |
|-------|-------|-----|
| Missing frontmatter | No `---` block at top of file | Add `kind: agent` and `version: 1` frontmatter |
| Parse failure | Invalid CANT syntax | Check indentation and property format |
| S01 rule violation | Missing required field | Add the required field (usually `model` or `prompt`) |

To start from a scaffold instead of a blank file, `cleo agent create --name backend-dev --role worker` writes an agent package (`persona.cant` plus `manifest.json`); `cleo agent pack <dir>` turns a package into a `.cantz` archive.

---

## Step 3: Install the Agent

`cleo agent install` accepts a `.cant` file, a `.cantz` archive or an agent package directory (`core/src/agents/install-pipeline.ts`). It copies the `.cant` into a tier directory and records the agent in the global agent registry (`agent_registry_agents`):

```bash
cleo agent install backend-dev.cant            # project tier: <project>/.cleo/cant/agents/backend-dev.cant
cleo agent install backend-dev.cant --global   # global tier: ~/.local/share/cleo/cant/agents/
cleo agent install ./backend-dev.cantz --global --attach   # install globally, attach to this project
```

`--force` overwrites an existing row or file, `--resync` reinstalls the registry row from the `.cant` on disk, and `--strict` fails on warnings such as unknown skill slugs.

A `.cant` file copied into a directory by hand is not installed: the registry row is what the spawn pipeline reads. `cleo agent doctor` reports drift between the `.cant` files on disk and the registry, and `cleo agent list` shows what is registered.

### Resolution Precedence

At spawn time `resolveAgent` (`core/src/store/agent-resolver.ts`) picks the first match:

| Order | Tier | Source |
|-------|------|--------|
| 1 | `project` | Registry row installed from `<project>/.cleo/cant/agents/` |
| 2 | `global` | Registry row installed from `~/.local/share/cleo/cant/agents/` |
| 3 | `packaged` | Registry row installed from the bundled `@cleocode/agents/templates/` |
| 4 | `fallback` | No row; the bundled `templates/<id>.cant` file, if present |
| 5 | `universal` | The universal base `@cleocode/agents/cleo-subagent.cant` |

A row whose `.cant` file is gone is skipped and resolution falls through to the next tier.

### Bundled Agents (reference)

`packages/agents/` ships reference definitions you can copy and customize:
- `templates/project-orchestrator.cant`, `project-dev-lead.cant`, `project-code-worker.cant`, `project-docs-worker.cant`, `project-security-worker.cant` -- the packaged per-role templates
- `definitions/cleo-lead.cant`, `definitions/cleo-worker.cant` -- lead and worker definitions
- `meta/agent-architect.cant`, `meta/playbook-architect.cant` -- meta-agents (`cleo agent mint` uses agent-architect)
- `cleo-subagent.cant` -- the universal base protocol

---

## Step 4: Assign the Agent to a Team

Teams are defined in `.cant` files using the `team` syntax. Keep team definitions next to your agents (for example in `.cleo/cant/`) and validate them with `cleo cant validate`:

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

When the orchestrator receives a task, it uses `cleo orchestrate classify` to route the request to the best-matching team based on the `consult-when` hint. The classifier performs substring matching against the request text.

To verify team routing:

```bash
cleo orchestrate classify "build a new API endpoint for user profiles"
```

This returns the matched team, suggested protocol, and confidence score.

---

## Step 5: Spawn the Agent

Agents are spawned through `cleo orchestrate`. There are three spawn paths:

### Single Spawn

The orchestrator spawns a single agent for a specific task:

```bash
cleo orchestrate spawn T1234 --protocol implementation
```

This validates spawn readiness, prepares the spawn context with token resolution, and returns the spawn prompt. To execute the actual spawn:

```bash
cleo orchestrate spawn-execute T1234
```

### Fanout (Parallel Spawn)

Spawn several tasks of an epic concurrently:

```bash
cleo orchestrate fanout T1200 --tasks T1234,T1235,T1236
```

### Handoff (Session End + Spawn)

Composite operation that ends the current session and spawns a successor:

```bash
cleo orchestrate handoff T1234 --protocol implementation
```

### Spawn Lifecycle

Once spawned, the subagent follows the 4-phase lifecycle defined in `packages/agents/cleo-subagent.cant`:

1. **Initialize**: Worktree guard check, then `cleo show` and `cleo start`
2. **Execute**: Follow the injected skill protocol
3. **Output**: Write output file, append manifest entry, `cleo complete`
4. **Return**: Return one-line summary only

---

## File Permissions (Path ACL)

Workers declare the paths they may write with `permissions.files.write` globs. Only the Pi `cleo-cant-bridge.ts` extension enforced these at runtime (its `tool_call` hook), and it retires under ADR-098; elsewhere the globs are a declaration in the spawn prompt, not a sandbox.

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

Under the Pi bridge, a write outside the declared paths was rejected with:

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
| Agent not resolved at spawn | Run `cleo agent doctor` and `cleo agent list` | Install it with `cleo agent install` (a hand-copied file is not registered) |
| Parse errors | Run `cleo cant validate <file>` | Fix CANT syntax (indentation, missing colons) |
| Spawn fails with E_SPAWN_NO_ADAPTER | No Claude CLI installed | Install `claude` CLI and ensure it is in PATH |
| Worker writes blocked unexpectedly | Check `permissions.files.write` | Expand glob patterns or remove write ACL for unrestricted access |
| Mental model not injecting | Agent has no prior observations | Run `cleo memory observe "..."` with the agent name to seed observations |
| Token resolution failure | Required tokens unresolved | Ensure task has proper fields (title, labels, parentId) |

---

## Key File Reference

| File | Purpose |
|------|---------|
| `packages/agents/cleo-subagent.cant` | Universal base protocol every subagent inherits |
| `packages/agents/templates/*.cant` | Packaged per-role agent templates |
| `packages/core/src/agents/install-pipeline.ts` | `cleo agent install` input handling (`.cant`, `.cantz`, directory) |
| `packages/core/src/store/agent-install.ts` | `installAgentFromCant()`: tier directories and the registry row |
| `packages/core/src/store/agent-resolver.ts` | 5-tier spawn-time resolution |
| `packages/cant/src/bundle.ts` | `compileBundle()` implementation |
| `packages/cleo-os/extensions/cleo-cant-bridge.ts` | Deprecated Pi extension (ADR-098) that compiled `.cant` files into the Pi prompt |
| [`docs/reference/cant.md`](../reference/cant.md) | CANT overview |
| [`docs/spec/cant-dsl.md`](../spec/cant-dsl.md) | Full CANT syntax specification |
