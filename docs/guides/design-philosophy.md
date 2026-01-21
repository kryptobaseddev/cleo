# Design Philosophy: Why CLEO Works This Way

> **For solo developers building with AI coding agents**

---

## The Vision

CLEO isn't just another task tracker. It's the **contract between you and your AI coding agent**—a structured protocol that prevents hallucination, maintains context across sessions, and turns chaotic AI-assisted development into a reliable workflow.

**One developer. One AI agent. One source of truth.**

---

## Core Insight: Agents Are Not Humans

Traditional task management assumes human users. But when your primary "user" is an LLM agent like Claude Code, everything changes:

| Dimension | Human User | LLM Agent |
|-----------|------------|-----------|
| **Input preference** | Natural language, flexibility | Structured data, constraints |
| **Error handling** | Reads error messages | Branches on exit codes |
| **Validation** | Trusts own judgment | Needs external ground truth |
| **Context** | Maintains mental model | Loses context between sessions |
| **Completion** | Knows when "done" | Needs explicit success criteria |

**CLEO is built for agents first, with human accessibility second.**

---

## The Five Design Decisions

### 1. Flat Sequential IDs (`T001`, `T042`, `T999`)

**Why not hierarchical IDs like `T001.2.3`?**

| Aspect | Hierarchical (`T001.2.3`) | Flat (`T042`) |
|--------|---------------------------|---------------|
| **Stability** | Breaks on restructure | Never changes |
| **Git references** | `"Fixes T001.2.3"` → orphaned | `"Fixes T042"` → eternal |
| **LLM reasoning** | Unbounded pattern space | Bounded, predictable |
| **Multi-agent** | ID collision on parallel create | Single counter, no collision |

**The guarantee**: Any `T{NNN}` ID will **forever** reference the same task, regardless of hierarchy changes, archiving, or project restructuring.

```bash
# Hierarchy is stored separately, not encoded in ID
{
  "id": "T042",        # Never changes
  "parentId": "T001",  # Can be updated
  "type": "task"       # Classification
}
```

**Key insight: Hierarchy is a relationship, not identity.**

The `parentId` field describes *where* a task sits in the hierarchy. The `id` field describes *which* task it is. Reparenting changes the relationship without changing the identity.

**Industry precedent**: Linear beat Jira with flat IDs. GitHub uses `#123`. Git uses flat SHAs. Flat wins.

---

### 2. JSON Output by Default (Non-TTY)

**Why JSON instead of pretty text?**

When Claude Code runs `cleo list`, it's piping output—not displaying in a terminal. The agent needs machine-parseable data, not ANSI colors.

```bash
# Terminal (TTY detected) → human-readable
$ cleo list
T001 [active] high - Implement auth

# Piped/scripted (non-TTY) → JSON automatically
$ cleo list | jq '.tasks[0].id'
"T001"

# Force human output when needed
$ cleo list --human
```

**The `--human` flag** is for you, the developer, when you want to see what Claude sees. The default serves the agent.

---

### 3. Exit Codes Over Error Messages

**Why numeric codes instead of descriptive errors?**

Agents branch on numbers, not prose:

```bash
# Agent workflow
cleo exists T042 --quiet
case $? in
  0)  cleo update T042 --notes "Found" ;;
  1)  echo "Not found" >&2; exit 1 ;;  # Fail fast
  2)  echo "Invalid ID" >&2; exit 2 ;;
esac
```

**17 documented exit codes**, not arbitrary numbers:

| Range | Purpose |
|-------|---------|
| `0` | Success |
| `1-9` | General errors (not found, invalid input, file error) |
| `10-19` | Hierarchy errors (parent not found, depth exceeded) |
| `20-29` | Concurrency errors (checksum mismatch, ID collision) |
| `100+` | Special conditions (no data, already exists, no change) |

Every exit code is a **named constant** in `lib/exit-codes.sh`—no magic numbers.

---

### 4. Validation-First, Not Trust-First

**Why validate before every operation?**

LLMs hallucinate. They'll reference task `T999` that doesn't exist, create duplicate IDs, or claim completion without actually finishing. CLEO validates **before** executing:

```bash
# Anti-hallucination layers
1. JSON Schema     → Structure validation
2. Semantic checks → ID uniqueness, timestamp sanity
3. Cross-file      → Referential integrity
4. State machine   → Valid status transitions only
```

**The `exists` command** is the foundation:

```bash
# ALWAYS verify before operating
if cleo exists T042 --quiet; then
  cleo complete T042
else
  echo "ERROR: Task T042 not found" >&2
  exit 1
fi
```

This isn't paranoia—it's **the only way to build reliable AI workflows**.

---

### 5. No Time Estimates. Ever.

**Why scope-based sizing instead of hours/days?**

Time estimates are:
- **Unpredictable** for humans
- **Meaningless** for agents
- **Actively harmful** for planning

CLEO uses **scope dimensions** instead:

| Size | File Scope | Complexity | Context Risk |
|------|------------|------------|--------------|
| **Small** | 1-2 files | Straightforward | Minimal |
| **Medium** | 3-7 files | Moderate decisions | Contained |
| **Large** | 8+ files | Architectural | **Must decompose** |

A "large" task **forces decomposition**—it's a signal to break down, not a calendar prediction.

```bash
cleo add "Auth system" --size large
# WARNING: Large scope detected
# Action: Decompose into medium/small tasks
```

---

## The Hierarchy Model

### Three Levels Only

```
Epic (strategic initiative)
  └── Task (primary work unit)
        └── Subtask (atomic operation)
```

**Why not deeper?** Research shows 3 levels is optimal for navigation. Deeper nesting increases cognitive overhead for both humans and agents.

### Configurable Limits

| Constraint | Default | Purpose |
|------------|---------|---------|
| Max depth | 3 | Prevents over-nesting |
| Max siblings | 20 | LLM-first (not human 7±2 limit) |
| Max active siblings | 8 | Focuses current work |

**Key insight**: The 7-sibling limit was based on human short-term memory (Miller's 7±2). LLMs have 200K+ token context windows—they don't need the same constraints. We limit for **organization**, not cognitive load.

---

## The Session Protocol

### Why Sessions Matter

Agents lose context between invocations. Sessions provide **checkpoints**:

```bash
# Start of work
cleo session start
cleo focus set T042

# During work
cleo focus note "JWT middleware implemented"
cleo update T042 --notes "Tests passing"

# End of work
cleo complete T042
cleo session end
```

**Session data persists** in `todo-log.json`—enabling context recovery across sessions, agent handoffs, and debugging.

### Single Active Task

Only **ONE task** can have `status: "active"` at a time. This prevents:
- Context confusion
- Parallel task interference
- Scope creep within sessions

```bash
cleo focus set T042  # Marks T042 active, others pending
```

---

## Anti-Hallucination Checklist

Before any operation, CLEO validates:

| Check | Purpose |
|-------|---------|
| ID exists | Prevent hallucinated references |
| ID unique | Prevent duplicate creation |
| Status valid | Only enum values allowed |
| Timestamps sane | Not in future, completedAt > createdAt |
| Dependencies acyclic | No circular references |
| Parent exists | Hierarchy integrity |
| Depth ≤ 3 | Structural constraint |

**If validation fails, the operation is rejected.** No partial states, no corruption.

---

## The Contract

When you use CLEO with Claude Code, you're establishing a **formal contract**:

1. **Tasks are identified by stable IDs** (`T001`) that never change
2. **All output is machine-parseable** by default (JSON)
3. **All errors have numeric exit codes** for programmatic handling
4. **All operations validate first**, fail fast on invalid input
5. **All state is persisted** in `todo.json` as single source of truth
6. **All changes are logged** in immutable audit trail
7. **All writes are atomic** with automatic backup and rollback

This contract enables **reliable, repeatable AI-assisted development**.

---

## For the Solo Developer

You're building something. You have Claude Code as your pair programmer. But without structure:

- Claude forgets what you did yesterday
- You lose track of which tasks are actually done
- Hallucinated references break your workflow
- Context degrades over long sessions

**CLEO solves this** by giving both you and Claude a shared, validated, persistent view of your project's tasks.

```bash
# Your morning routine
cleo session start
cleo dash              # See where you are
cleo focus show        # What was I working on?
cleo next --explain    # What should I do next?

# Claude's understanding
cleo list --format json | jq '.tasks[] | select(.status == "pending")'
```

**One developer. One agent. One truth.**

---

## Quick Reference

| Principle | Implementation |
|-----------|----------------|
| **Agents first** | JSON default, `--human` for you |
| **Flat IDs** | `T001` not `T001.2.3` |
| **Exit codes** | 17 documented constants |
| **Validation first** | `exists`, schema, semantic checks |
| **No time estimates** | Scope-based sizing only |
| **Single active task** | `focus set` enforces discipline |
| **Session checkpoints** | `session start/end` for context |
| **Atomic operations** | Write → validate → backup → rename |
| **Immutable history** | Append-only `todo-log.json` |

---

## Further Reading

| Document | Purpose |
|----------|---------|
| [LLM-TASK-ID-SYSTEM-DESIGN-SPEC.md](../specs/LLM-TASK-ID-SYSTEM-DESIGN-SPEC.md) | Complete ID system specification |
| [TASK-HIERARCHY-SPEC.md](../specs/TASK-HIERARCHY-SPEC.md) | Hierarchy features specification |
| [LLM-AGENT-FIRST-SPEC.md](../specs/LLM-AGENT-FIRST-SPEC.md) | CLI design principles |
| [LLM-AGENT-FIRST-DESIGN.md](../../claudedocs/research/LLM-AGENT-FIRST-DESIGN.md) | Research and rationale |
| [TASK-COMPLETION-PHILOSOPHY.md](../../claudedocs/research/TASK-COMPLETION-PHILOSOPHY.md) | "Always Be Shipping" principles |

---

*CLEO: The contract between you and your AI coding agent.*
