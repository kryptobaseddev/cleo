# Orchestrator Protocol Vision

**Version**: 1.0.0
**Status**: CANONICAL
**Author**: HITL Vision Document
**Created**: 2026-01-19

---

## The Core Problem

You are a solo developer working with Claude Code. You want to:

1. **Interact with ONE Claude Code session** across an entire project lifecycle
2. **Have that conversation last as long as possible** without context exhaustion
3. **Complete complex multi-phase work** without losing continuity between sessions
4. **Leverage AI for the ENTIRE lifecycle**: research, specification, implementation, testing, validation, documentation, release

**The fundamental tension**: Claude's context window is finite. Projects are not.

A typical feature epic involves thousands of lines of code changes, dozens of files, multiple test suites, documentation updates, and coordination across phases. If Claude tries to hold all of this in context, the conversation dies within hours.

---

## The Vision

**One orchestrator. Zero implementation. Infinite subagents.**

You speak to ONE Claude Code instance—the **orchestrator**. This orchestrator NEVER implements anything directly. Instead, it:

- **Plans** the work decomposition
- **Spawns** specialized subagents to execute each task
- **Reads** only compact summaries of their output
- **Coordinates** the handoff between agents
- **Maintains** the conversation with you indefinitely

The orchestrator is a **conductor**, not a musician. It coordinates the symphony but never plays an instrument.

---

## The Mantra

> **Stay high-level. Delegate everything. Read only manifests. Spawn in order.**

| Phrase | Meaning | Enforcement |
|--------|---------|-------------|
| **Stay high-level** | Orchestrator reasons about *what* to do, never *how* | ORC-001 |
| **Delegate everything** | Zero code, zero file reading, zero implementation | ORC-002 |
| **Read only manifests** | Subagents write 3-7 sentence summaries; orchestrator reads ONLY those | ORC-003 |
| **Spawn in order** | Respect CLEO dependency graph; wave-based execution | ORC-004 |

This mantra is not a guideline—it is an **immutable constraint**. Violation breaks the protocol.

---

## The Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                           YOU (HITL)                            │
│                     Single conversation                         │
│              "Build user authentication system"                 │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                        ORCHESTRATOR                             │
│                                                                 │
│  Context Budget: 10K tokens (HARD LIMIT)                        │
│                                                                 │
│  READS:                                                         │
│    • MANIFEST.jsonl key_findings (3-7 sentences per entry)      │
│    • CLEO task state (cleo show --brief)                        │
│    • Dependency graph (cleo deps, cleo analyze)                 │
│                                                                 │
│  DOES:                                                          │
│    Plan → Spawn → Wait → Read Summary → Update CLEO → Repeat    │
│                                                                 │
│  NEVER:                                                         │
│    • Reads full files (>100 lines)                              │
│    • Writes code                                                │
│    • Runs tests                                                 │
│    • Implements anything                                        │
└─────────────────────────────────────────────────────────────────┘
                              │
          ┌───────────────────┼───────────────────┐
          ▼                   ▼                   ▼
┌──────────────────┐ ┌──────────────────┐ ┌──────────────────┐
│ SUBAGENT (Wave 0)│ │ SUBAGENT (Wave 1)│ │ SUBAGENT (Wave N)│
│                  │ │                  │ │                  │
│ Fresh 200K ctx   │ │ Fresh 200K ctx   │ │ Fresh 200K ctx   │
│ Full file access │ │ Full file access │ │ Full file access │
│ Implements fully │ │ Implements fully │ │ Implements fully │
│                  │ │                  │ │                  │
│ Skills:          │ │ Skills:          │ │ Skills:          │
│ • epic-architect │ │ • task-executor  │ │ • validator      │
│ • spec-writer    │ │ • library-impl   │ │ • test-writer    │
│ • research-agent │ │ • research-agent │ │ • documentor     │
└────────┬─────────┘ └────────┬─────────┘ └────────┬─────────┘
         │                    │                    │
         ▼                    ▼                    ▼
┌─────────────────────────────────────────────────────────────────┐
│                       MANIFEST.jsonl                            │
│                                                                 │
│  Each subagent appends exactly ONE line:                        │
│  {                                                              │
│    "id": "auth-jwt-2026-01-19",                                 │
│    "key_findings": [                                            │
│      "JWT implementation uses RS256 with 15min expiry",         │
│      "Refresh tokens stored in HttpOnly cookies",               │
│      "Rate limiting: 5 attempts per minute per IP"              │
│    ],                                                           │
│    "needs_followup": ["T1234"],                                 │
│    "linked_tasks": ["T1230", "T1234"]                           │
│  }                                                              │
│                                                                 │
│  Orchestrator reads ONLY key_findings—never the full output     │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                      CLEO Task System                           │
│                                                                 │
│  Epic → Task → Subtask hierarchy                                │
│  Dependencies and blocking                                      │
│  Phase discipline (setup → core → testing → polish)             │
│  Verification gates (testsPassed, qaPassed, documented)         │
│  Session management and focus tracking                          │
│  Audit trail and state persistence                              │
└─────────────────────────────────────────────────────────────────┘
```

---

## The 5 Immutable Constraints

| ID | Constraint | Rationale |
|----|------------|-----------|
| **ORC-001** | MUST stay high-level; MUST NOT implement code | Context preservation; if orchestrator implements, context explodes |
| **ORC-002** | MUST delegate ALL work to subagents via Task tool | Each subagent gets fresh 200K context; separation of concerns |
| **ORC-003** | MUST NOT read full files (>100 lines) into context | Manifests are O(1) lookup; files are O(n) token consumption |
| **ORC-004** | MUST spawn agents in dependency order | Spawning T3 before T1 completes = wasted work and conflicts |
| **ORC-005** | MUST maintain context budget under 10K tokens | Leaves room for YOUR ongoing conversation with the orchestrator |

**These constraints are not suggestions.** They are the physics of the protocol. Breaking them breaks the system.

---

## The Complete Lifecycle

CLEO provides the structure. Skills provide the behavior. Orchestrator provides the coordination.

### Epic Types Supported

| Epic Type | Description | Typical Workflow |
|-----------|-------------|------------------|
| **Feature** | New capability | Research → Spec → Implement → Test → Document |
| **Bug Fix** | Defect correction | Reproduce → Diagnose → Fix → Verify → Document |
| **Research** | Investigation | Survey → Analyze → Synthesize → Report |
| **Refactor** | Code improvement | Analyze → Plan → Execute → Validate |
| **Migration** | System transition | Assess → Plan → Execute → Verify → Cutover |
| **Brownfield** | Existing codebase | Understand → Integrate → Adapt → Test |
| **Greenfield** | New project | Design → Bootstrap → Implement → Launch |

### Wave-Based Execution

```
EPIC CREATED (ct-epic-architect)
│
│  Decomposes into dependency waves
│
├── WAVE 0 (No dependencies)
│   ├── T1001: Research authentication patterns (ct-research-agent)
│   └── T1002: Write authentication spec (ct-spec-writer)
│
├── WAVE 1 (Depends on Wave 0)
│   ├── T1003: Implement JWT middleware (ct-task-executor)
│   ├── T1004: Implement refresh token logic (ct-task-executor)
│   └── T1005: Create auth utility library (ct-library-implementer-bash)
│
├── WAVE 2 (Depends on Wave 1)
│   ├── T1006: Write unit tests (ct-test-writer-bats)
│   ├── T1007: Write integration tests (ct-test-writer-bats)
│   └── T1008: Run compliance validation (ct-validator)
│
├── WAVE 3 (Depends on Wave 2)
│   ├── T1009: Write API documentation (ct-documentor)
│   └── T1010: Update README (ct-documentor)
│
└── VERIFICATION GATES
    ├── implemented ✓ (auto-set by cleo complete)
    ├── testsPassed ✓ (set by ct-validator)
    ├── qaPassed ✓ (set by orchestrator/HITL)
    ├── securityPassed ✓ (set by ct-validator)
    └── documented ✓ (set by ct-documentor)
    │
    └── EPIC AUTO-COMPLETES when all children verified
```

### Phase Discipline

| Phase | Purpose | Skills Used |
|-------|---------|-------------|
| **Setup** | Foundation and planning | ct-research-agent, ct-spec-writer, ct-epic-architect |
| **Core** | Main implementation | ct-task-executor, ct-library-implementer-bash |
| **Testing** | Validation and QA | ct-test-writer-bats, ct-validator |
| **Polish** | Refinement and docs | ct-documentor, ct-validator |
| **Maintenance** | Ongoing support | ct-task-executor, ct-research-agent |

---

## Why This Works

### Traditional Approach vs. Orchestrator Approach

| Traditional | Orchestrator |
|-------------|--------------|
| One agent does everything | Many agents, one coordinator |
| Context exhausted at ~50K tokens | Conversation runs for days/weeks |
| Lost state between Claude sessions | CLEO + MANIFEST = perfect continuity |
| Reactive: waits for your commands | Proactive: checks manifest, resumes work |
| Flat task list | Epic → Task → Subtask with dependencies |
| "Done" = code committed | "Done" = verified through gates |
| You re-explain context each session | Orchestrator reads manifest, picks up where left off |

### The Math

- Orchestrator context budget: **10K tokens**
- Each subagent context: **200K tokens**
- Manifest entry: **~200 tokens** (3-7 key_findings)
- 100 subagent completions = **20K tokens** in manifest summaries

With careful manifest management, you can coordinate **hundreds of subagent executions** while keeping the orchestrator conversation alive.

---

## The Subagent Contract

Every subagent MUST follow this protocol (RFC 2119):

```markdown
## OUTPUT REQUIREMENTS (MANDATORY)

1. MUST write findings to: claudedocs/research-outputs/YYYY-MM-DD_{topic-slug}.md
2. MUST append ONE line to: claudedocs/research-outputs/MANIFEST.jsonl
3. MUST return ONLY: "Task complete. See MANIFEST.jsonl for summary."
4. MUST NOT return detailed content in response.

## CLEO INTEGRATION (MANDATORY)

1. MUST read task details: cleo show <task-id>
2. MUST set focus: cleo focus set <task-id>
3. MUST complete task when done: cleo complete <task-id>
4. SHOULD link research: cleo research link <task-id> <research-id>
```

**Why the strict return message?**

If a subagent returns 5000 tokens of findings, the orchestrator's context budget is blown. By forcing subagents to write to files and return only a confirmation, we ensure the orchestrator stays lean.

---

## Session Continuity

### Starting a New Conversation

The orchestrator executes this startup protocol:

```bash
# 1. Check for pending work
cat claudedocs/research-outputs/MANIFEST.jsonl | \
  jq -s '[.[] | select(.needs_followup | length > 0)]'

# 2. Check active sessions
cleo session list --status active

# 3. Check current focus
cleo focus show

# 4. Review epic status
cleo dash --compact
```

### Decision Matrix

| Condition | Action |
|-----------|--------|
| Active session with focus | Resume; continue focused task |
| Active session, no focus | Query manifest `needs_followup`; spawn next |
| No session, manifest has followup | Create session; spawn for followup |
| No session, no followup | Ask HITL for direction |

**The orchestrator never starts from zero.** It always checks external state first.

---

## The Skill Ecosystem

Each skill is a specialized subagent prompt optimized for a task type:

| Skill | Purpose | Output |
|-------|---------|--------|
| `ct-epic-architect` | Decompose features into task waves | CLEO epic with dependencies |
| `ct-spec-writer` | Write technical specifications | Spec document + manifest entry |
| `ct-research-agent` | Investigate topics | Research document + manifest entry |
| `ct-task-executor` | Generic implementation work | Code changes + manifest entry |
| `ct-library-implementer-bash` | Create Bash libraries | lib/*.sh files + manifest entry |
| `ct-test-writer-bats` | Write BATS tests | tests/*.bats files + manifest entry |
| `ct-validator` | Run compliance checks | Validation report + manifest entry |
| `ct-documentor` | Write documentation | docs/*.md files + manifest entry |

Skills are invoked via token injection, ensuring consistent protocol compliance.

---

## The Core Reason

**You want to say "build this feature" once and have Claude Code coordinate the entire lifecycle—research, spec, implement, test, document, release—without you having to re-explain context every conversation.**

The orchestrator protocol makes this possible by:

1. **Preserving your context** — Orchestrator stays under 10K tokens
2. **Delegating actual work** — Subagents have full 200K context each
3. **Tracking state externally** — CLEO + MANIFEST = persistent memory across sessions
4. **Enforcing quality** — Verification gates prevent premature completion
5. **Supporting all epic types** — Feature, bug, research, migration, brownfield, greenfield
6. **Enabling indefinite sessions** — Your conversation with the orchestrator can last as long as the project

---

## Summary

The Orchestrator Protocol transforms Claude Code from a reactive assistant into a **project coordinator** that can manage complex, multi-phase work across unlimited time horizons.

**The orchestrator protects its context so it can protect your continuity.**

By enforcing strict delegation, manifest-based communication, and dependency-ordered execution, the protocol enables a single HITL conversation to span an entire project lifecycle—from initial research to final release.

> **Stay high-level. Delegate everything. Read only manifests. Spawn in order.**

---

## Related Documentation

- [Orchestrator Protocol Guide](guides/ORCHESTRATOR-PROTOCOL.md) — Operational procedures
- [Orchestrator Protocol Specification](specs/ORCHESTRATOR-PROTOCOL-SPEC.md) — RFC 2119 technical spec
- [Orchestrator Skill](../skills/ct-orchestrator/SKILL.md) — Skill definition
- [CLEO Task Management](~/.cleo/docs/TODO_Task_Management.md) — Task system reference

---

*This document is the canonical source for the orchestrator protocol philosophy and vision.*
