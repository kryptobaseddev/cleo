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

This specification defines when and how AI agents should interact with CLEO through MCP tools (`cleo_query` / `cleo_mutate`) versus the CLI (`cleo` / `ct`), and establishes a progressive disclosure architecture for agent context injection.

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
| **MCP Gateway**            | The two-tool CQRS surface: `cleo_query` (reads) and `cleo_mutate` (writes)                |
| **CLI**                    | The TypeScript command-line interface invoked via `cleo` or `ct` alias                    |
| **Native operation**       | An operation implemented in TypeScript that runs cross-platform without Bash              |
| **CLI-only operation**     | An operation that requires the CLI subprocess                                             |
| **Agent consumer**         | An LLM agent (Claude Code, Cursor, Windsurf, etc.) interacting with CLEO programmatically |
| **Human consumer**         | A developer interacting with CLEO directly via terminal                                   |
| **Progressive disclosure** | Layered context injection that reveals complexity only when needed                        |

## 4. MCP-First Principle

### 4.1 Statement

When an AI agent needs to interact with CLEO, it SHOULD prefer MCP tools (`cleo_query` / `cleo_mutate`) over CLI commands invoked through Bash.

### 4.2 Rationale

| Dimension               | MCP Gateway                         | CLI via Bash                                |
| ----------------------- | ----------------------------------- | ------------------------------------------- |
| **Structured I/O**      | JSON in, JSON out (guaranteed)      | Text parsing required, format varies        |
| **Error contract**      | Structured error objects with codes | Exit codes + stderr (requires parsing)      |
| **Token efficiency**    | Direct tool call, no shell overhead | Bash tool + command string + output parsing |
| **Cross-platform**      | Native operations work on any OS    | Requires Bash + Unix utilities              |
| **Tool discovery**      | 2 tools, domain-routed              | 65+ commands to learn                       |
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
    │   │           ├── YES ─── Use cleo_query / cleo_mutate
    │   │           └── NO ──── MCP routes to CLI automatically (transparent)
    │   └── NO ──── Use CLI directly via Bash tool
    │
    └── Is this a human debugging session?
        └── YES ─── Use CLI directly (richer output)
```

Key insight: even CLI-only operations can be invoked through MCP tools. The MCP server transparently routes to CLI when needed. Agents do not need to know whether an operation is native or CLI-backed.

## 5. Capability Matrix Summary

The MCP server maintains a capability matrix (`src/mcp/engine/capability-matrix.ts`) that defines which operations run natively versus requiring CLI. As of v0.91.0:

### 5.1 Native Operations (Cross-Platform, No Bash)

**Tasks domain (queries):** show, list, find, exists, manifest, current
**Tasks domain (mutations):** add, update, complete, delete, archive, start, stop

**Session domain (queries):** status, list, show
**Tasks domain (focus queries):** current

**System domain:** version, config, config.get, config.set, init
**Validate domain:** schema

**Total native:** 29 operations

### 5.2 CLI-Only Operations

**Tasks:** next, depends, stats, export, history, lint, batch-validate, tree, blockers, analyze, relates, restore, import, reorder, reparent, promote, reopen, relates.add

**Session:** history, stats, resume, switch, archive, suspend, gc

**Orchestrate (all):** status, next, ready, analyze, context, waves, skill.list, start, spawn, validate, parallel.start, parallel.end, skill.inject

**Research (all):** show, list, find, pending, stats, manifest.read, inject, link, manifest.append, manifest.archive, compact, validate

**Lifecycle (all):** validate, status, history, gates, prerequisites, record, skip, reset, gate.pass, gate.fail

**Release (all):** prepare, changelog, commit, tag, push, gates.run, rollback

### 5.3 Routing Transparency

From the agent's perspective, all operations are invoked identically through `cleo_query` or `cleo_mutate`. The MCP server handles routing internally:

```
Agent calls: cleo_query { domain: "tasks", operation: "show", params: { id: "T1234" } }
    │
    ├── Capability matrix says: native
    └── Engine executes TypeScript directly

Agent calls: cleo_query { domain: "orchestrate", operation: "waves", params: { epic: "T001" } }
    │
    ├── Capability matrix says: cli
    └── Engine spawns: cleo orchestrator waves --epic T001
```

## 6. Progressive Disclosure Architecture

### 6.1 Problem

Current agent injection (CLEO-INJECTION.md) is ~600 lines and consumed entirely on every agent spawn. Most agents need only basic task operations, yet they receive the full protocol stack, lifecycle gates, and orchestration details.

### 6.2 Solution: Four Disclosure Levels

Progressive disclosure delivers agent context in layers, expanding only when the agent's task requires deeper knowledge.

#### Level 0: Minimal Entry (Default)

**Token budget:** ~200 tokens
**Target:** All agents, always injected
**Content:**

```
CLEO provides two MCP tools:
- cleo_query(domain, operation, params) - Read operations (never modifies state)
- cleo_mutate(domain, operation, params) - Write operations (validated, logged, atomic)

Domains: tasks, session, system, validate, orchestrate, research, lifecycle, release, issues, skills, providers

Quick reference:
- Show task:    cleo_query { domain: "tasks", operation: "show", params: { id: "T1234" } }
- Add task:     cleo_mutate { domain: "tasks", operation: "add", params: { title: "..." } }
- Complete:     cleo_mutate { domain: "tasks", operation: "complete", params: { id: "T1234" } }
- Focus set:    cleo_mutate { domain: "tasks", operation: "start", params: { id: "T1234" } }
- Find tasks:   cleo_query { domain: "tasks", operation: "find", params: { query: "..." } }
- Session start: cleo_mutate { domain: "session", operation: "start", params: { scope: "epic:T001" } }
```

#### Level 1: Domain Discovery

**Token budget:** ~500 tokens
**Target:** Agents performing multi-step workflows
**Trigger:** Agent invokes operations across 2+ domains, or requests help
**Content:** Adds available operations per domain with brief descriptions.

```
Tasks operations:
  Query: show, list, find, exists, next, depends, stats, manifest, tree, blockers, current
  Mutate: add, update, complete, delete, archive, restore, reparent, promote, start, stop

Session operations:
  Query: status, list, show
  Mutate: start, end, resume

System operations:
  Query: version, health, config.get, dash
  Mutate: init, config.set, backup

[... other domains ...]
```

#### Level 2: Operation-Specific

**Token budget:** ~2-5K tokens (loaded per-operation)
**Target:** Agents needing parameter schemas and error contracts
**Trigger:** Agent encounters error, or requests operation details
**Content:** Full parameter schemas, return types, error codes, and examples for specific operations.

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
  E_DEPTH_EXCEEDED (11): Max depth 3 (epic > task > subtask)
  E_SIBLING_LIMIT (12): Configured sibling limit exceeded (`hierarchy.maxSiblings`, default: unlimited)

Example:
  cleo_mutate { domain: "tasks", operation: "add", params: {
    title: "Implement auth flow",
    description: "Add JWT-based authentication",
    parent: "T001",
    priority: "high"
  }}
```

#### Level 3: Protocol-Aware

**Token budget:** ~5-15K tokens
**Target:** Orchestrators and protocol-compliant subagents
**Trigger:** Orchestrator spawn or lifecycle-gated operations
**Content:** Full protocol stack injection including lifecycle gates, validation rules, manifest requirements, and RCSD pipeline. This is the current CLEO-INJECTION.md content.

### 6.3 Level Selection Matrix

| Agent Role             | Default Level | May Escalate To     |
| ---------------------- | ------------- | ------------------- |
| Generic coding agent   | Level 0       | Level 1, Level 2    |
| Task executor subagent | Level 1       | Level 2             |
| Orchestrator           | Level 3       | N/A (already max)   |
| Human via CLI          | N/A           | N/A (uses CLI docs) |
| External MCP client    | Level 0       | Level 1             |

### 6.4 Escalation Mechanism

Agents can request higher disclosure levels through MCP:

```json
// Discover available domains and operations
cleo_query { domain: "system", operation: "help", params: { level: 1 } }

// Get operation-specific schema
cleo_query { domain: "system", operation: "help", params: { level: 2, domain: "tasks", operation: "add" } }
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
│  cleo_query(domain, operation, params)           │
│  cleo_mutate(domain, operation, params)          │
│                                                  │
│  ┌───────────────────────────────────────────┐  │
│  │          Domain Router                     │  │
│  │  tasks | session | system | validate |     │  │
│  │  orchestrate | research | lifecycle |      │  │
│  │  release | issues | skills | providers     │  │
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
| `cleo_query { domain: "tasks", operation: "show", params: { id: "T1234" } }`            | `ct show T1234`                      |
| `cleo_mutate { domain: "tasks", operation: "add", params: { title: "Fix bug" } }`       | `ct add "Fix bug"`                   |
| `cleo_mutate { domain: "tasks", operation: "complete", params: { id: "T42" } }`         | `ct complete T42`                    |
| `cleo_query { domain: "session", operation: "status" }`                                 | `ct session status`                  |
| `cleo_mutate { domain: "session", operation: "start", params: { scope: "epic:T001" } }` | `ct session start --scope epic:T001` |

## 8. Agent Injection Evolution Plan

### 8.1 Current State

Two injection files exist:

1. **`templates/CLEO-INJECTION.md`** (~600 lines): Global injection loaded via `~/.cleo/templates/CLEO-INJECTION.md`. CLI-first, covers full protocol stack.
2. **`.cleo/templates/AGENT-INJECTION.md`** (~167 lines): Project-level injection loaded into CLAUDE.md. CLI-first quick reference.

Both are CLI-first. Neither mentions MCP tools.

### 8.2 Target State

Both files evolve to MCP-first with CLI as documented fallback:

**AGENT-INJECTION.md** (project-level, ~200 lines):

- Section 1: MCP-first quick reference (Level 0 + Level 1 content)
- Section 2: CLI fallback reference (condensed)
- Section 3: Session protocol (MCP-first with CLI alternative)
- Section 4: Subagent architecture summary (unchanged)
- Section 5: Error handling (MCP error objects first, exit codes second)

**CLEO-INJECTION.md** (global, ~600 lines):

- Section 1: MCP-first entry (Level 0)
- Section 2: Progressive disclosure guidance (how to escalate)
- Section 3: Full protocol stack (Level 3, unchanged)
- Section 4: CLI reference (condensed, marked as fallback)

### 8.3 Migration Strategy

The migration is non-breaking:

1. **Phase 1:** Add MCP-first section to top of both files. Existing CLI content remains.
2. **Phase 2:** Reorder sections so MCP guidance appears before CLI in both files.
3. **Phase 3:** Condense CLI sections into a "CLI Fallback Reference" appendix.
4. **Phase 4:** Implement server-side progressive disclosure (Level 0-3 dynamic loading).

Phase 1-3 are documentation changes. Phase 4 requires MCP server implementation.

## 9. Token Efficiency Analysis

### 9.1 Current Cost (CLI-First Injection)

| Component                          | Tokens (approx) |
| ---------------------------------- | --------------- |
| AGENT-INJECTION.md (always loaded) | ~1,200          |
| CLEO-INJECTION.md (subagent spawn) | ~4,500          |
| **Total per subagent**             | **~5,700**      |

### 9.2 Target Cost (MCP-First with Progressive Disclosure)

| Level                        | Tokens (approx)          | Agents Using         |
| ---------------------------- | ------------------------ | -------------------- |
| Level 0 (minimal)            | ~200                     | All agents           |
| Level 1 (domain discovery)   | ~500                     | Multi-step workflows |
| Level 2 (operation-specific) | ~500-2,000 per operation | On-demand            |
| Level 3 (full protocol)      | ~4,500                   | Orchestrators only   |

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
    "fix": "cleo_query { domain: 'tasks', operation: 'find', params: { query: 'T9999' } }",
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
- Progressive disclosure Level 0 MUST be under 250 tokens.

### 11.2 SHOULD (Recommended)

- Agents SHOULD prefer MCP tools over CLI for programmatic operations.
- Agent injection SHOULD include Level 0 content by default.
- MCP error responses SHOULD include `alternatives` array.
- CLI fallback documentation SHOULD be clearly marked as secondary.

### 11.3 MAY (Optional)

- Agents MAY use CLI directly for debugging or human-interactive sessions.
- Progressive disclosure MAY be implemented server-side in a future phase.
- Operation schemas MAY be served dynamically via `system.help`.

## 12. Implementation Tasks

The following tasks implement this specification:

1. **Update AGENT-INJECTION.md for MCP-first guidance** - Add MCP quick reference section, reorder content.
2. **Update CLEO-INJECTION.md for MCP-first guidance** - Add MCP entry section, condense CLI reference.
3. **Implement progressive disclosure in MCP server** - Add `system.help` operation with level parameter.

## 13. References

- `docs/concepts/vision.md` - CLEO canonical vision
- `docs/specs/PORTABLE-BRAIN-SPEC.md` - Product contract
- `docs/specs/MCP-SERVER-SPECIFICATION.md` - MCP server internals
- `src/mcp/engine/capability-matrix.ts` - Native vs CLI routing
- `templates/CLEO-INJECTION.md` - Current global agent injection
- `.cleo/templates/AGENT-INJECTION.md` - Current project agent injection
- `docs/specs/PROJECT-LIFECYCLE-SPEC.md` - Lifecycle and protocol stack
