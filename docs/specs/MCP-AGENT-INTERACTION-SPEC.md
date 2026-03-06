---
title: "MCP-First Agent Interaction Specification"
version: "1.0.0"
status: "draft"
created: "2026-02-11"
updated: "2026-02-11"
authors: ["CLEO Development Team"]
task: "T4334"
---

# MCP-First Agent Interaction Specification

## 1. Purpose

This specification defines when and how AI agents should interact with CLEO through MCP tools (`query` / `mutate`) versus the CLI (`cleo` / `ct`), and establishes a progressive disclosure architecture for agent context injection.

CLEO's vision positions it as a vendor-neutral Brain and Memory system with interoperable interfaces (Pillar 3). The MCP gateway and CLI are both first-class interfaces, but they serve different consumers with different constraints. This document makes those boundaries explicit.

## 2. Scope

This specification covers:

- The MCP-first principle and rationale for agent consumers
- Progressive disclosure levels for agent context injection
- Entry point delineation between MCP and CLI
- Agent injection evolution plan (CLEO-INJECTION.md / AGENT-INJECTION.md)
- Token efficiency analysis

This specification does NOT cover:

- MCP server internals (see `docs/specs/MCP-SERVER-SPECIFICATION.md`)
- CLI command semantics (see `CLAUDE.md` and AGENT-INJECTION.md)
- Protocol stack or lifecycle gates (see `docs/specs/PROJECT-LIFECYCLE-SPEC.md`)

## 3. Definitions

| Term                       | Definition                                                                                |
| -------------------------- | ----------------------------------------------------------------------------------------- |
| **MCP Gateway**            | The two-tool CQRS surface: `query` (reads) and `mutate` (writes)                |
| **CLI**                    | The TypeScript command-line interface invoked via `cleo` or `ct` alias                    |
| **Native operation**       | An operation implemented in TypeScript that runs cross-platform without Bash              |
| **CLI-only operation**     | An operation that requires the CLI subprocess                                             |
| **Agent consumer**         | An LLM agent (Claude Code, Cursor, Windsurf, etc.) interacting with CLEO programmatically |
| **Human consumer**         | A developer interacting with CLEO directly via terminal                                   |
| **Progressive disclosure** | Layered context injection that reveals complexity only when needed                        |

## 4. MCP-First Principle

### 4.1 Statement

When an AI agent needs to interact with CLEO, it SHOULD prefer MCP tools (`query` / `mutate`) over CLI commands invoked through Bash.

### 4.2 Rationale

| Dimension               | MCP Gateway                         | CLI via Bash                                |
| ----------------------- | ----------------------------------- | ------------------------------------------- |
| **Structured I/O**      | JSON in, JSON out (guaranteed)      | Text parsing required, format varies        |
| **Error contract**      | Structured error objects with codes | Exit codes + stderr (requires parsing)      |
| **Token efficiency**    | Direct tool call, no shell overhead | Bash tool + command string + output parsing |
| **Cross-platform**      | Native operations work on any OS    | Requires Bash + Unix utilities              |
| **Tool discovery**      | 2 tools, 10 canonical domains, 247 operations              | 86 commands to learn                       |
| **Concurrency safety**  | Server-managed state                | Race conditions possible                    |
| **Provider neutrality** | Works with any MCP-compatible agent | Tied to agents with Bash tool access        |

### 4.3 When to Use MCP (Default)

Agents SHOULD use MCP tools for:

- All task CRUD operations (show, list, find, add, update, complete, delete)
- Session management (start, end, status, current)
- Schema validation
- System queries (version, config, health)
- Any operation where structured JSON response is sufficient

### 4.4 When to Use CLI (Fallback)

Agents MAY use CLI commands for:

- Operations not yet native in the MCP engine (see capability matrix below)
- Human-interactive debugging sessions
- Bash scripting contexts where MCP is unavailable
- Operations requiring rich terminal formatting (dash, tree)
- One-off administrative tasks (backup, restore, migrate)

### 4.5 Decision Flowchart

```
Agent needs to interact with CLEO
    │
    ├── Is MCP server available?
    │   ├── YES ─── Is operation native or hybrid?
    │   │           ├── YES ─── Use query / mutate
    │   │           └── NO ──── MCP routes to CLI automatically (transparent)
    │   └── NO ──── Use CLI directly via Bash tool
    │
    └── Is this a human debugging session?
        └── YES ─── Use CLI directly (richer output)
```

Key insight: even CLI-only operations can be invoked through MCP tools. The MCP server transparently routes to CLI when needed. Agents do not need to know whether an operation is native or CLI-backed.

## 5. Capability Matrix Summary

The MCP server implements exactly 247 operations across 10 canonical domains. Both MCP and CLI entry points route to the shared business logic layer.

### 5.1 Canonical Domains

- **tasks** (32 ops): Task hierarchy, CRUD, dependencies
- **session** (19 ops): Session lifecycle and context
- **memory** (25 ops): Cognitive memory and observations
- **check** (20 ops): Schema validation and test execution
- **pipeline** (40 ops): RCSD lifecycle and releases
- **orchestrate** (20 ops): Multi-agent coordination
- **tools** (32 ops): Skills, providers, and CAAMP catalog
- **admin** (43 ops): Configuration, backup, diagnostics
- **nexus** (31 ops): Cross-project coordination
- **sticky** (6 ops): Ephemeral project-wide capture

Total operations: 247.

### 5.2 Routing Transparency

From the agent\'s perspective, all 247 operations are invoked identically through `query` or `mutate`. The MCP server handles routing internally:

```
Agent calls: query { domain: "tasks", operation: "show", params: { id: "T1234" } }
    │
    └── Engine executes TypeScript directly

Agent calls: mutate { domain: "pipeline", operation: "release.prepare" }
    │
    └── Engine spawns fallback adapter if required
```

## 6. Progressive Disclosure Architecture

### 6.1 Problem

Current agent injection (CLEO-INJECTION.md) is ~600 lines and consumed entirely on every agent spawn. Most agents need only basic task operations, yet they receive the full protocol stack, lifecycle gates, and orchestration details.

### 6.2 Solution: Three-Tier Progressive Disclosure

Progressive disclosure delivers agent context in tiers, expanding only when the agent's task requires deeper knowledge. The 247 operations are organized into 3 tiers.

#### Tier 0: Core (Default)

**Token budget:** ~200 tokens
**Target:** All agents, always injected
**Operations:** 149 operations (tasks, session, check, pipeline, orchestrate, tools, admin, sticky)
**Content:**

```
CLEO provides two MCP tools:
- query(domain, operation, params) - Read operations (never modifies state)
- mutate(domain, operation, params) - Write operations (validated, logged, atomic)

Domains: tasks, session, memory, check, pipeline, orchestrate, tools, admin, nexus, sticky

Quick reference:
- Show task:    query { domain: "tasks", operation: "show", params: { id: "T1234" } }
- Add task:     mutate { domain: "tasks", operation: "add", params: { title: "..." } }
- Complete:     mutate { domain: "tasks", operation: "complete", params: { id: "T1234" } }
- Focus set:    mutate { domain: "tasks", operation: "start", params: { id: "T1234" } }
- Find tasks:   query { domain: "tasks", operation: "find", params: { query: "..." } }
- Session start: mutate { domain: "session", operation: "start", params: { scope: "epic:T001" } }
```

#### Tier 1: Extended (Domain Discovery)

**Token budget:** ~500 tokens
**Target:** Agents performing multi-step workflows, requiring cognitive memory or research access
**Operations:** 58 additional operations (memory + extended ops in pipeline, session, admin, tools)
**Trigger:** Agent escalates by querying `admin.help` with tier=1
**Content:** Adds available operations per domain with brief descriptions.

```
Tasks operations:
  Query: show, list, find, exists, tree, blockers, depends, analyze, next, plan, current...
  Mutate: add, update, complete, delete, archive, restore, start, stop...

Session operations:
  Query: status, list, show, history, context.drift...
  Mutate: start, end, resume, gc, record.decision...

Memory operations:
  Query: show, find, timeline, fetch...
  Mutate: observe, decision.store, pattern.store...

[... other domains ...]
```

#### Tier 2: Full System (Operation-Specific / Protocol-Aware)

**Token budget:** ~2-5K tokens
**Target:** Orchestrators, system administrators, and agents needing parameter schemas
**Operations:** 61 additional operations (nexus + advanced admin/tools)
**Trigger:** Agent escalates by querying `admin.help` with tier=2 or requests operation details
**Content:** Cross-project coordination (NEXUS), full protocol stack, lifecycle gates, and full parameter schemas.

```
## tasks.add

Parameters:
  title: string (required, 3-200 chars)
  description: string (optional, max 2000 chars)
  parent: string (optional, T### format, max depth 3)
  priority: "low" | "medium" | "high" | "critical" (optional)
  depends: string[] (optional, T### format)
  labels: string[] (optional)

Returns: { success: true, data: { id: "T####", ... } }

Errors:
  E_VALIDATION (6): Field validation failed
  E_PARENT_NOT_FOUND (10): Parent task does not exist
```

### 6.3 Tier Selection Matrix

| Agent Role             | Default Tier | May Escalate To     |
| ---------------------- | ------------- | ------------------- |
| Generic coding agent   | Tier 0       | Tier 1, Tier 2    |
| Task executor subagent | Tier 1       | Tier 2             |
| Orchestrator           | Tier 2       | N/A (already max)   |
| Human via CLI          | N/A           | N/A (uses CLI docs) |
| External MCP client    | Tier 0       | Tier 1             |

### 6.4 Escalation Mechanism

Agents can request higher disclosure tiers through MCP:

```json
// Discover available domains and operations (Tier 0)
query { domain: "admin", operation: "help" }

// Escalate to Tier 1 operations
query { domain: "admin", operation: "help", params: { tier: 1 } }

// Get operation-specific schema (returns full Tier 2 operation definition)
query { domain: "admin", operation: "help", params: { tier: 2, domain: "tasks", operation: "add" } }
```

This is self-service: agents discover what they need when they need it, rather than receiving everything upfront.

## 7. Entry Point Delineation

### 7.1 MCP Entry Point

**Surface:** Two tools registered with the MCP server
**Routing:** Domain + operation parameters route to business logic
**Advantages:** Minimal tool surface, structured contracts, cross-platform

```
┌─────────────────────────────────────────────────┐
│                  MCP Gateway                     │
│                                                  │
│  query(domain, operation, params)           │
│  mutate(domain, operation, params)          │
│                                                  │
│  ┌───────────────────────────────────────────┐  │
│  │          Domain Router                     │  │
│  │  tasks | session | memory | check |        │  │
│  │  pipeline | orchestrate | tools | admin |  │  │
│  │  nexus | sticky                            │  │
│  └─────────┬─────────────────┬───────────────┘  │
│            │                 │                    │
│    ┌───────▼──────┐  ┌──────▼───────┐           │
│    │ Native Engine│  │ CLI Adapter  │           │
│    │ (TypeScript) │  │ (Bash exec)  │           │
│    └──────────────┘  └──────────────┘           │
└─────────────────────────────────────────────────┘
```

### 7.2 CLI Entry Point

**Surface:** `cleo` / `ct` command with subcommands
**Routing:** Subcommand + flags parsed by Commander.js (TypeScript)
**Advantages:** Human ergonomics, rich formatting, scriptable

```
$ cleo show T1234
$ ct add "New task" --parent T001 --priority high
$ ct session start --scope epic:T001 --auto-focus
```

### 7.3 Shared Business Logic

Both entry points converge on the same business logic:

- Native operations share TypeScript engine code
- CLI-routed operations execute the same Bash scripts
- Validation rules, lifecycle gates, and audit logging are identical
- Data storage (`tasks.db` via SQLite/Drizzle ORM) is the single source of truth

### 7.4 Semantic Equivalence

Every MCP operation MUST have a CLI equivalent. Every CLI command SHOULD be accessible through MCP (modulo operations that are inherently interactive).

| MCP                                                                                     | CLI                                  |
| --------------------------------------------------------------------------------------- | ------------------------------------ |
| `query { domain: "tasks", operation: "show", params: { id: "T1234" } }`            | `ct show T1234`                      |
| `mutate { domain: "tasks", operation: "add", params: { title: "Fix bug" } }`       | `ct add "Fix bug"`                   |
| `mutate { domain: "tasks", operation: "complete", params: { id: "T42" } }`         | `ct complete T42`                    |
| `query { domain: "session", operation: "status" }`                                 | `ct session status`                  |
| `mutate { domain: "session", operation: "start", params: { scope: "epic:T001" } }` | `ct session start --scope epic:T001` |

## 8. Agent Injection Evolution Plan

### 8.1 Current State

Two injection files exist:

1. **`templates/CLEO-INJECTION.md`** (~600 lines): Global injection loaded via `~/.cleo/templates/CLEO-INJECTION.md`. CLI-first, covers full protocol stack.
2. **`.cleo/templates/AGENT-INJECTION.md`** (~167 lines): Project-level injection loaded into CLAUDE.md. CLI-first quick reference.

Both are CLI-first. Neither mentions MCP tools.

### 8.2 Target State

Both files evolve to MCP-first with CLI as documented fallback:

**AGENT-INJECTION.md** (project-level, ~200 lines):

- Section 1: MCP-first quick reference (Tier 0 + Tier 1 content)
- Section 2: CLI fallback reference (condensed)
- Section 3: Session protocol (MCP-first with CLI alternative)
- Section 4: Subagent architecture summary (unchanged)
- Section 5: Error handling (MCP error objects first, exit codes second)

**CLEO-INJECTION.md** (global, ~600 lines):

- Section 1: MCP-first entry (Tier 0)
- Section 2: Progressive disclosure guidance (how to escalate)
- Section 3: Full protocol stack (Tier 2, unchanged)
- Section 4: CLI reference (condensed, marked as fallback)

### 8.3 Migration Strategy

The migration is non-breaking:

1. **Phase 1:** Add MCP-first section to top of both files. Existing CLI content remains.
2. **Phase 2:** Reorder sections so MCP guidance appears before CLI in both files.
3. **Phase 3:** Condense CLI sections into a "CLI Fallback Reference" appendix.
4. **Phase 4:** Implement server-side progressive disclosure (Tier 0-2 dynamic loading).

Phase 1-3 are documentation changes. Phase 4 requires MCP server implementation.

## 9. Token Efficiency Analysis

### 9.1 Current Cost (CLI-First Injection)

| Component                          | Tokens (approx) |
| ---------------------------------- | --------------- |
| AGENT-INJECTION.md (always loaded) | ~1,200          |
| CLEO-INJECTION.md (subagent spawn) | ~4,500          |
| **Total per subagent**             | **~5,700**      |

### 9.2 Target Cost (MCP-First with Progressive Disclosure)

| Tier                         | Tokens (approx)          | Agents Using         |
| ---------------------------- | ------------------------ | -------------------- |
| Tier 0 (Core)                | ~200                     | All agents           |
| Tier 1 (Extended)            | ~500                     | Multi-step workflows |
| Tier 2 (Full System)         | ~2,000-5,000             | Orchestrators only   |

### 9.3 Savings

- **Generic agent:** 200 tokens vs 1,200 = **83% reduction**
- **Task executor:** 700 tokens vs 5,700 = **88% reduction**
- **Orchestrator:** ~5,000 tokens vs 5,700 = **12% reduction**
- **Weighted average (80% generic, 15% executor, 5% orchestrator):** ~**80% reduction**

### 9.4 Why This Matters

At scale (10+ subagent spawns per session), the current injection model consumes ~57,000 tokens in context injection alone. With progressive disclosure, the same session uses ~7,000-12,000 tokens, freeing 45,000+ tokens for actual work.

## 10. Error Handling Contract

### 10.1 MCP Error Response Format

All MCP operations return structured errors:

```json
{
  "success": false,
  "error": {
    "code": "E_NOT_FOUND",
    "exitCode": 4,
    "message": "Task T9999 not found",
    "fix": "query { domain: 'tasks', operation: 'find', params: { query: 'T9999' } }",
    "alternatives": [
      { "action": "Search by title", "operation": "tasks.find" },
      { "action": "List all tasks", "operation": "tasks.list" }
    ]
  }
}
```

### 10.2 Agent Error Handling Protocol

1. Check `success` field (boolean)
2. On failure, read `error.code` for programmatic branching
3. Use `error.fix` as a suggested recovery action
4. Use `error.alternatives` for fallback options
5. Retry on transient errors (codes: E_LOCK_TIMEOUT, E_FILE_BUSY)

### 10.3 CLI Error Mapping

Every MCP error code maps to a CLI exit code for equivalence:

| MCP Error Code         | CLI Exit Code | Description                       |
| ---------------------- | ------------- | --------------------------------- |
| E_NOT_FOUND            | 4             | Resource not found                |
| E_VALIDATION           | 6             | Validation failure                |
| E_PARENT_NOT_FOUND     | 10            | Parent task missing               |
| E_DEPTH_EXCEEDED       | 11            | Hierarchy too deep                |
| E_SIBLING_LIMIT        | 12            | Configured sibling limit exceeded |
| E_ACTIVE_TASK_REQUIRED | 38            | No start                          |
| E_PROTOCOL             | 60-67         | Protocol violations               |
| E_LIFECYCLE_GATE       | 75            | Lifecycle gate failed             |

## 11. Conformance Requirements

### 11.1 MUST (Required)

- Agent injection documents MUST present MCP tools before CLI commands.
- MCP operations MUST return structured JSON with `success` field.
- Error responses MUST include `code`, `message`, and `fix` fields.
- Native operations MUST NOT require Bash availability.
- Progressive disclosure Tier 0 MUST be under 250 tokens.

### 11.2 SHOULD (Recommended)

- Agents SHOULD prefer MCP tools over CLI for programmatic operations.
- Agent injection SHOULD include Tier 0 content by default.
- MCP error responses SHOULD include `alternatives` array.
- CLI fallback documentation SHOULD be clearly marked as secondary.

### 11.3 MAY (Optional)

- Agents MAY use CLI directly for debugging or human-interactive sessions.
- Progressive disclosure MAY be implemented server-side in a future phase.
- Operation schemas MAY be served dynamically via `admin.help`.

## 12. Implementation Tasks

The following tasks implement this specification:

1. **Update AGENT-INJECTION.md for MCP-first guidance** - Add MCP quick reference section, reorder content.
2. **Update CLEO-INJECTION.md for MCP-first guidance** - Add MCP entry section, condense CLI reference.
3. **Implement progressive disclosure in MCP server** - Add `admin.help` operation with level parameter.

## 13. References

- `docs/concepts/CLEO-VISION.md` - CLEO canonical vision
- `docs/specs/PORTABLE-BRAIN-SPEC.md` - Product contract
- `docs/specs/MCP-SERVER-SPECIFICATION.md` - MCP server internals
- `src/mcp/engine/capability-matrix.ts` - Native vs CLI routing
- `templates/CLEO-INJECTION.md` - Current global agent injection
- `.cleo/templates/AGENT-INJECTION.md` - Current project agent injection
- `docs/specs/PROJECT-LIFECYCLE-SPEC.md` - Lifecycle and protocol stack
