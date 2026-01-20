# CLEO System Architecture: The Complete Vision

**Version**: 1.0.0
**Status**: CANONICAL
**Created**: 2026-01-20
**Purpose**: Complete connective tissue for CLEO + Orchestrator Protocol + Claude Code integration

---

## The Core Problem

**You want AI to manage entire projects—not just answer questions.**

Traditional AI coding assistants:
- Lose context after ~50K tokens
- Forget what they were working on between sessions
- Can't coordinate multi-phase work (research → spec → implement → test → document)
- Require constant re-explanation of project state

**CLEO + Orchestrator Protocol solves this.**

---

## The Solution: Three-Layer Architecture

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                                                                                 │
│                              YOU (HITL)                                         │
│                    ┌─────────────────────────────┐                              │
│                    │  Single conversation that   │                              │
│                    │  can last days/weeks        │                              │
│                    └─────────────┬───────────────┘                              │
│                                  │                                              │
│ ════════════════════════════════════════════════════════════════════════════   │
│                         LAYER 1: ORCHESTRATOR                                   │
│ ════════════════════════════════════════════════════════════════════════════   │
│                                  │                                              │
│  ┌───────────────────────────────▼───────────────────────────────────────┐     │
│  │                      ORCHESTRATOR AGENT                                │     │
│  │                                                                        │     │
│  │   Context Budget: 10K tokens (HARD LIMIT)                             │     │
│  │                                                                        │     │
│  │   READS:                                                               │     │
│  │   ├── MANIFEST.jsonl key_findings (~200 tokens/entry)                 │     │
│  │   ├── CLEO task state (cleo show --brief)                             │     │
│  │   └── Dependency graph (cleo deps, cleo analyze)                      │     │
│  │                                                                        │     │
│  │   DOES:                                                                │     │
│  │   Plan → Spawn → Wait → Read Summary → Update CLEO → Repeat           │     │
│  │                                                                        │     │
│  │   NEVER:                                                               │     │
│  │   ├── Reads full files (>100 lines)                                   │     │
│  │   ├── Writes code                                                      │     │
│  │   ├── Runs tests                                                       │     │
│  │   └── Implements anything                                              │     │
│  └───────────────────────────────┬───────────────────────────────────────┘     │
│                                  │                                              │
│ ════════════════════════════════════════════════════════════════════════════   │
│                         LAYER 2: SUBAGENTS                                      │
│ ════════════════════════════════════════════════════════════════════════════   │
│                                  │                                              │
│      ┌───────────────────────────┼───────────────────────────┐                 │
│      │                           │                           │                 │
│      ▼                           ▼                           ▼                 │
│  ┌────────────┐           ┌────────────┐           ┌────────────┐             │
│  │  SUBAGENT  │           │  SUBAGENT  │           │  SUBAGENT  │             │
│  │  (Wave 0)  │           │  (Wave 1)  │           │  (Wave N)  │             │
│  │            │           │            │           │            │             │
│  │ Fresh 200K │           │ Fresh 200K │           │ Fresh 200K │             │
│  │ Full files │           │ Full files │           │ Full files │             │
│  │ Implements │           │ Implements │           │ Implements │             │
│  └─────┬──────┘           └─────┬──────┘           └─────┬──────┘             │
│        │                        │                        │                     │
│        │  Writes output         │  Writes output         │  Writes output     │
│        │  + manifest entry      │  + manifest entry      │  + manifest entry  │
│        │                        │                        │                     │
│ ════════════════════════════════════════════════════════════════════════════   │
│                         LAYER 3: PERSISTENCE                                    │
│ ════════════════════════════════════════════════════════════════════════════   │
│        │                        │                        │                     │
│        ▼                        ▼                        ▼                     │
│  ┌─────────────────────────────────────────────────────────────────────────┐  │
│  │                        MANIFEST.jsonl                                    │  │
│  │  • Each subagent appends ONE line (~200 tokens)                         │  │
│  │  • key_findings: 3-7 sentences (summary for orchestrator)               │  │
│  │  • needs_followup: handoff to next agent                                │  │
│  │  • linked_tasks: bidirectional CLEO task links                          │  │
│  └─────────────────────────────────────────────────────────────────────────┘  │
│                                  │                                              │
│                                  │ Queries                                      │
│                                  ▼                                              │
│  ┌─────────────────────────────────────────────────────────────────────────┐  │
│  │                      CLEO TASK SYSTEM                                    │  │
│  │                                                                          │  │
│  │  Epic → Task → Subtask hierarchy                                        │  │
│  │  Dependencies and wave-based execution                                   │  │
│  │  Phase discipline (setup → core → testing → polish → maintenance)       │  │
│  │  Verification gates (implemented, testsPassed, qaPassed, documented)    │  │
│  │  Multi-session management with scoped isolation                          │  │
│  │  Persistent state across Claude conversations                            │  │
│  └─────────────────────────────────────────────────────────────────────────┘  │
│                                                                                 │
└─────────────────────────────────────────────────────────────────────────────────┘
```

---

## Layer 1: The Orchestrator

### The Mantra

> **Stay high-level. Delegate everything. Read only manifests. Spawn in order.**

### The 5 Immutable Constraints (ORC)

| ID | Constraint | Why | Enforcement |
|----|------------|-----|-------------|
| **ORC-001** | Stay high-level; NO implementation | If orchestrator implements, context explodes | Behavioral protocol |
| **ORC-002** | Delegate ALL work via Task tool | Each subagent gets fresh 200K context | Tool restriction |
| **ORC-003** | No full file reads (>100 lines) | Manifests are O(1); files are O(n) | Reading constraints |
| **ORC-004** | Spawn in dependency order | Out-of-order = wasted work | CLEO deps check |
| **ORC-005** | Context budget: 10K tokens | Leaves room for YOUR conversation | Context monitoring |

### Context Budget Allocation

```
┌─────────────────────────────────────────────────────────────────┐
│               ORCHESTRATOR CONTEXT BUDGET                        │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  Total Budget: 10,000 tokens                                     │
│                                                                  │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │ Permitted Allocations                                     │   │
│  ├──────────────────────────────────────────────────────────┤   │
│  │ Manifest summaries (50 entries × 200 tokens)    = 10,000 │   │
│  │                          OR                               │   │
│  │ Conversation with user                          = ~5,000  │   │
│  │ Task state queries (cleo show --brief)          = ~2,000  │   │
│  │ Dependency analysis                             = ~1,500  │   │
│  │ Planning/reasoning                              = ~1,500  │   │
│  └──────────────────────────────────────────────────────────┘   │
│                                                                  │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │ PROHIBITED (Would exceed budget instantly)                │   │
│  ├──────────────────────────────────────────────────────────┤   │
│  │ Full research file (1 file)                     = ~5,000  │   │
│  │ Full source file (1 file)                       = ~3,000  │   │
│  │ Test results (1 run)                            = ~2,000  │   │
│  └──────────────────────────────────────────────────────────┘   │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### Context Monitoring System

| Exit Code | Status | Usage | Action |
|-----------|--------|-------|--------|
| 0 | OK | <70% | Continue normally |
| 50 | Warning | 70-84% | Consider wrapping up |
| 51 | Caution | 85-89% | Start graceful shutdown |
| 52 | Critical | 90-94% | Immediate safe stop |
| 53 | Emergency | 95%+ | Emergency shutdown |

```bash
# Check context before major operations
cleo context check
case $? in
  0)  echo "OK" ;;
  50) echo "Warning - consider completion" ;;
  52) echo "Critical - must stop" ;;
esac
```

---

## Layer 2: Subagents (Skills)

### The Subagent Contract (RFC 2119)

Every subagent MUST follow this protocol:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         SUBAGENT EXECUTION FLOW                              │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  1. RECEIVE TASK                                                             │
│     ├── Read task:     cleo show {{TASK_ID}}                                │
│     └── Set focus:     cleo focus set {{TASK_ID}}                           │
│                                                                              │
│  2. EXECUTE WORK                                                             │
│     └── [Skill-specific implementation - FULL 200K context available]       │
│                                                                              │
│  3. PERSIST OUTPUT                                                           │
│     ├── Write file:    {{OUTPUT_DIR}}/{{DATE}}_{{TOPIC_SLUG}}.md            │
│     │                  └── Full research/implementation (~5000+ tokens)     │
│     │                                                                        │
│     └── Append manifest: {{MANIFEST_PATH}}                                  │
│                  └── Single JSON line (~200 tokens)                         │
│                      • key_findings: 3-7 sentences                          │
│                      • needs_followup: next task IDs                        │
│                      • linked_tasks: CLEO task references                   │
│                                                                              │
│  4. COMPLETE TASK                                                            │
│     ├── Mark done:     cleo complete {{TASK_ID}}                            │
│     └── Link research: cleo research link {{TASK_ID}} {{RESEARCH_ID}}       │
│                                                                              │
│  5. RETURN MESSAGE                                                           │
│     └── ONLY: "Research complete. See MANIFEST.jsonl for summary."          │
│               ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^         │
│               THIS IS THE ONLY ACCEPTABLE RETURN MESSAGE                     │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### The 14 Skills

| Skill | Purpose | Triggers |
|-------|---------|----------|
| **ct-epic-architect** | Epic creation, task decomposition, wave planning | "create epic", "plan tasks", "break down" |
| **ct-spec-writer** | RFC 2119 specifications | "write spec", "define protocol" |
| **ct-research-agent** | Multi-source investigation | "research", "investigate", "look up" |
| **ct-task-executor** | Generic implementation (fallback) | "implement", "execute task" |
| **ct-library-implementer-bash** | Bash library creation | "create library", "lib/*.sh" |
| **ct-test-writer-bats** | BATS integration tests | "write tests", "BATS tests" |
| **ct-validator** | Compliance validation | "validate", "verify", "audit" |
| **ct-documentor** | Documentation orchestration | "write docs", "document" |
| **ct-docs-lookup** | Library docs via Context7 | "how do I configure", "API reference" |
| **ct-docs-write** | Documentation creation | "create documentation" |
| **ct-docs-review** | Style guide compliance | "review docs", "style check" |
| **ct-skill-lookup** | Skill discovery | "find a skill", "install skill" |
| **ct-skill-creator** | Skill creation guide | "create new skill" |
| **ct-orchestrator** | Multi-agent coordination | "orchestrate", "coordinate agents" |

### Skill Selection Algorithm

```
TASK INPUT (cleo show T1234)
        │
        ▼
┌───────────────────────────────────────────────────────────────┐
│                    SKILL DISPATCH                              │
├───────────────────────────────────────────────────────────────┤
│                                                                │
│  Priority 1: LABEL MATCH                                       │
│    task.labels ∩ skill.tags → first match wins                │
│    Example: labels=["spec"] → ct-spec-writer                  │
│                                                                │
│  Priority 2: TYPE MATCH                                        │
│    task.type → skill.dispatch_triggers.types[]                │
│    Example: type="epic" → ct-epic-architect                   │
│                                                                │
│  Priority 3: KEYWORD MATCH                                     │
│    (title + description) ∩ skill.keywords[]                   │
│    Example: "write integration tests" → ct-test-writer-bats   │
│                                                                │
│  Fallback: ct-task-executor                                    │
│    Catches all unmatched tasks                                 │
│                                                                │
└───────────────────────────────────────────────────────────────┘
```

### Token Injection System

```bash
source lib/token-inject.sh

# 1. Set required context
ti_set_context "T1234" "2026-01-20" "auth-implementation" "T1000"

# 2. Apply CLEO defaults
ti_set_defaults

# 3. Validate tokens
ti_validate_required || exit $?

# 4. Load skill with tokens injected
prompt=$(ti_load_template "skills/ct-task-executor/SKILL.md")

# 5. Spawn subagent with injected prompt
# Task tool call with prompt...
```

**Token Reference**:

| Token | Example | Purpose |
|-------|---------|---------|
| `{{TASK_ID}}` | T1234 | Current task |
| `{{DATE}}` | 2026-01-20 | ISO date |
| `{{TOPIC_SLUG}}` | auth-implementation | URL-safe topic |
| `{{OUTPUT_DIR}}` | claudedocs/research-outputs | Output path |
| `{{MANIFEST_PATH}}` | {{OUTPUT_DIR}}/MANIFEST.jsonl | Manifest path |
| `{{TASK_SHOW_CMD}}` | cleo show | Task detail command |
| `{{TASK_FOCUS_CMD}}` | cleo focus set | Focus command |
| `{{TASK_COMPLETE_CMD}}` | cleo complete | Completion command |

---

## Layer 3: CLEO Task System

### The Hierarchy

```
LEVEL 0: EPIC (Strategic initiative)
    │
    │    type: "epic"
    │    parentId: null
    │    Example: T001 "User Authentication System"
    │
    ├── LEVEL 1: TASK (Primary work unit)
    │       │
    │       │    type: "task"
    │       │    parentId: "T001"
    │       │    Example: T002 "JWT middleware"
    │       │
    │       └── LEVEL 2: SUBTASK (Atomic operation)
    │               │
    │               │    type: "subtask"
    │               │    parentId: "T002"
    │               │    Example: T005 "Add token validation"
    │               │
    │               └── (MAX DEPTH - cannot have children)
    │
    ├── T003 "Password hashing" (task)
    │
    └── T004 "Session management" (task)
```

**Constraints**:
- Maximum depth: 3 levels (Epic → Task → Subtask)
- Subtasks cannot have children
- Default max siblings: Unlimited (LLM-agent-first design)

### Wave-Based Execution

Dependencies organize tasks into parallel execution waves:

```
EPIC T001: Authentication System
│
├── WAVE 0 (No dependencies - execute first)
│   ├── T1001: Research auth patterns (ct-research-agent)
│   └── T1002: Write auth spec (ct-spec-writer)
│
├── WAVE 1 (Depends on Wave 0)
│   ├── T1003: Implement JWT middleware (ct-task-executor)
│   ├── T1004: Implement refresh tokens (ct-task-executor)
│   └── T1005: Create auth utilities (ct-library-implementer-bash)
│
├── WAVE 2 (Depends on Wave 1)
│   ├── T1006: Write unit tests (ct-test-writer-bats)
│   ├── T1007: Write integration tests (ct-test-writer-bats)
│   └── T1008: Security validation (ct-validator)
│
├── WAVE 3 (Depends on Wave 2)
│   ├── T1009: API documentation (ct-documentor)
│   └── T1010: README updates (ct-documentor)
│
└── COMPLETION
    └── All children verified → Epic auto-completes
```

**Wave Computation**:
```
Wave(task) = 0                           if task.depends == []
Wave(task) = max(Wave(d) for d in deps) + 1  otherwise
```

### Phase Discipline

```
PROJECT LIFECYCLE
═════════════════

    setup ──→ core ──→ testing ──→ polish ──→ maintenance
      │         │          │          │            │
      ▼         ▼          ▼          ▼            ▼
┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐
│ SETUP   │ │  CORE   │ │ TESTING │ │ POLISH  │ │  MAINT  │
│         │ │         │ │         │ │         │ │         │
│ Research│ │ Implement│ │ Test    │ │ Refine  │ │ Bug fix │
│ Spec    │ │ Build   │ │ Validate│ │ Document│ │ Support │
│ Plan    │ │ Create  │ │ QA      │ │ Polish  │ │ Extend  │
└─────────┘ └─────────┘ └─────────┘ └─────────┘ └─────────┘

SKILLS BY PHASE:
• setup:       ct-research-agent, ct-spec-writer, ct-epic-architect
• core:        ct-task-executor, ct-library-implementer-bash
• testing:     ct-test-writer-bats, ct-validator
• polish:      ct-documentor, ct-validator
• maintenance: ct-task-executor, ct-research-agent
```

### Verification Gates

Before an epic can auto-complete, all children must pass verification:

```
TASK COMPLETION FLOW
════════════════════

cleo complete T1003
        │
        ▼
┌───────────────────────────────────────┐
│ Auto-set: verification.gates.implemented = true │
└───────────────────────────────────────┘
        │
        ▼
┌───────────────────────────────────────┐
│ Manual gates (subagent-set):          │
│   testsPassed      (ct-validator)     │
│   qaPassed         (orchestrator/HITL)│
│   securityPassed   (ct-validator)     │
│   documented       (ct-documentor)    │
└───────────────────────────────────────┘
        │
        ▼
┌───────────────────────────────────────┐
│ When ALL gates pass:                  │
│   verification.passed = true          │
└───────────────────────────────────────┘
        │
        ▼
┌───────────────────────────────────────┐
│ When ALL children verified:           │
│   Parent epic auto-completes          │
└───────────────────────────────────────┘
```

**Gate Commands**:
```bash
cleo verify T1003 --gate testsPassed      # Set individual gate
cleo verify T1003 --all                   # Set all gates
cleo verify T1003                         # Show verification status
cleo list --verification-status pending   # Find unverified tasks
```

---

## The Manifest System

### Structure

```jsonl
{"id":"auth-research-2026-01-20","file":"2026-01-20_auth-research.md","title":"Authentication Research","date":"2026-01-20","status":"complete","topics":["auth","security"],"key_findings":["OAuth 2.1 with PKCE recommended","JWT RS256 with 15min expiry","Refresh tokens in HttpOnly cookies"],"actionable":true,"needs_followup":["T1003","T1004"],"linked_tasks":["T1001","T1002"]}
```

### Token Economics

| Approach | Per Entry | 10 Entries | 100 Entries |
|----------|-----------|------------|-------------|
| **Full file read** | ~5,000 | ~50,000 | ~500,000 |
| **Manifest entry** | ~200 | ~2,000 | ~20,000 |
| **Savings** | **96%** | **96%** | **96%** |

**Why JSONL?**
- O(1) append (no read-modify-write)
- Atomic writes (POSIX guarantee)
- Single-line corruption isolation
- Concurrent subagent safety

### Query Patterns

```bash
# Get latest entry
tail -1 MANIFEST.jsonl | jq '{id, key_findings}'

# Find pending followups (session startup)
jq -s '[.[] | select(.needs_followup | length > 0)]' MANIFEST.jsonl

# Filter by topic
jq -s '[.[] | select(.topics | contains(["auth"]))]' MANIFEST.jsonl

# Get findings for epic
jq -s '[.[] | select(.linked_tasks | contains(["T001"])) | .key_findings] | flatten' MANIFEST.jsonl

# CLI equivalents (preferred)
cleo research list --status complete --limit 10
cleo research pending
cleo research show <id>
```

---

## Session Management

### Multi-Session Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                        MULTI-SESSION COORDINATION                            │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  CONCURRENT SESSIONS (Different Scopes)                                      │
│                                                                              │
│  ┌──────────────────────┐  ┌──────────────────────┐  ┌──────────────────────┐
│  │  Session A           │  │  Session B           │  │  Session C           │
│  │  Scope: epic:T001    │  │  Scope: epic:T050    │  │  Scope: epicPhase    │
│  │  Agent: opus-1       │  │  Agent: sonnet-1     │  │         T001:testing │
│  │  Focus: T003         │  │  Focus: T051         │  │  Focus: T007         │
│  └──────────────────────┘  └──────────────────────┘  └──────────────────────┘
│           │                         │                         │              │
│           │                         │                         │              │
│           └─────────────────────────┼─────────────────────────┘              │
│                                     │                                        │
│                                     ▼                                        │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │                         CLEO TASK SYSTEM                             │    │
│  │                                                                      │    │
│  │  • Sessions CANNOT claim same task as currentTask                   │    │
│  │  • Scopes MAY overlap if configured (allowScopeOverlap)             │    │
│  │  • Focus isolation per session                                       │    │
│  │  • Session binding via .current-session file                         │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Session State Machine

```
                      session start --scope epic:T001
    (not exists) ──────────────────────────────────────→ ACTIVE
                                                           │
                                                           │
                    ┌──────── suspend ─────────┐          │
                    │                          │          │
                    ▼                          │          │
               SUSPENDED ◄─────────────────────┼──────────┤
                    │                          │          │
                    │                          │          │
                    └────── resume ────────────┘          │
                                                          │
                    ┌──────── end ─────────────┐          │
                    │                          │          │
                    ▼                          │          │
                 ENDED ◄───────────────────────┼──────────┤
                    │                          │          │
                    │                          │          │
                    └────── resume ────────────┘          │
                                                          │
                                                          │
                 All tasks complete + session close       │
                              │                           │
                              ▼                           │
                           CLOSED ◄───────────────────────┘
                              │
                              │
                              ▼
                       (NOT resumable)
```

### Session Commands

```bash
# Start session with scope
cleo session start --scope epic:T001 --auto-focus --name "Auth Work"

# Check current session
cleo session status

# Suspend (quick pause)
cleo session suspend --note "Waiting for API"

# End (formal end)
cleo session end --note "Completed auth middleware"

# Resume
cleo session resume <session-id>
cleo session resume --last --scope epic:T001

# List sessions
cleo session list --status active
```

### Session Startup Protocol (Orchestrator)

```bash
# Every new conversation, orchestrator executes:

# 1. Check existing sessions
cleo session list --status active

# 2. Check for pending work in manifest
cleo research pending

# 3. Check current focus
cleo focus show

# 4. Review project state
cleo dash --compact

# Decision matrix:
# • Active session with focus → Resume, continue focused task
# • Active session, no focus → Query manifest needs_followup, spawn next
# • No session, manifest has followup → Create session, spawn for followup
# • No session, no followup → Ask user for direction
```

---

## The Complete Flow

### From User Request to Completion

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                                                                              │
│  USER: "Build user authentication with JWT"                                  │
│                                                                              │
└───────────────────────────────────────────┬─────────────────────────────────┘
                                            │
                                            ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                         ORCHESTRATOR                                         │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  1. Create session: cleo session start --scope epic:T001 --auto-focus       │
│                                                                              │
│  2. Spawn ct-epic-architect subagent:                                       │
│     → Subagent decomposes into tasks with dependencies                      │
│     → Writes epic plan to manifest                                          │
│     → Returns: "Research complete. See MANIFEST.jsonl for summary."         │
│                                                                              │
│  3. Read manifest key_findings (NOT full file):                             │
│     → 5 tasks created: T1001-T1005                                          │
│     → Wave 0: T1001 (research), T1002 (spec)                                │
│     → Wave 1: T1003-T1005 (implementation)                                  │
│                                                                              │
│  4. Spawn Wave 0 subagents sequentially:                                    │
│     → ct-research-agent for T1001                                           │
│     → ct-spec-writer for T1002                                              │
│     → Read manifest summaries after each                                    │
│                                                                              │
│  5. After Wave 0 complete, spawn Wave 1:                                    │
│     → ct-task-executor for T1003, T1004, T1005                              │
│     → Each writes output + manifest entry                                   │
│     → cleo complete marks tasks done                                        │
│                                                                              │
│  6. Spawn validation:                                                        │
│     → ct-test-writer-bats writes tests                                      │
│     → ct-validator runs validation                                          │
│     → Sets verification gates                                               │
│                                                                              │
│  7. When all children verified:                                              │
│     → Epic T001 auto-completes                                              │
│     → Session can be closed                                                 │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
                                            │
                                            ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                                                                              │
│  USER receives: "Authentication system complete. 5 tasks executed,           │
│                  all tests passing, documentation generated."                │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Metrics Summary

### Token Efficiency

| Component | Tokens | Notes |
|-----------|--------|-------|
| Orchestrator budget | 10K | Hard limit, protects conversation |
| Manifest entry | ~200 | 3-7 key_findings |
| Full research file | ~5,000+ | Never read by orchestrator |
| Subagent context | 200K | Fresh each spawn |
| **Savings per research** | **96%** | Manifest vs full file |

### Scalability

| Metric | Value | Impact |
|--------|-------|--------|
| Max concurrent sessions | 5 (configurable) | Parallel agent work |
| Max epic depth | 3 levels | Epic → Task → Subtask |
| Max siblings | Unlimited (default) | LLM-agent-first design |
| Subagents per orchestrator session | Hundreds | Each gets fresh context |
| Conversation duration | Days/weeks | Context never exhausts |

### Quality Gates

| Gate | Set By | When |
|------|--------|------|
| implemented | Auto | `cleo complete` |
| testsPassed | ct-validator | Tests pass |
| qaPassed | Orchestrator/HITL | QA review |
| securityPassed | ct-validator | Security scan |
| documented | ct-documentor | Docs complete |

---

## Quick Reference

### Orchestrator Mantra
```
Stay high-level. Delegate everything. Read only manifests. Spawn in order.
```

### Subagent Mantra
```
Focus. Execute. Write file. Append manifest. Complete task. Return message.
```

### Required Return Message
```
"Research complete. See MANIFEST.jsonl for summary."
```

### Session Startup Commands
```bash
cleo session list --status active
cleo research pending
cleo focus show
cleo dash --compact
```

### Manifest Query Commands
```bash
cleo research list
cleo research show <id>
cleo research pending
```

---

## Related Documentation

| Document | Purpose |
|----------|---------|
| [ORCHESTRATOR-VISION.md](ORCHESTRATOR-VISION.md) | Philosophy and rationale |
| [guides/ORCHESTRATOR-PROTOCOL.md](guides/ORCHESTRATOR-PROTOCOL.md) | Operational procedures |
| [specs/ORCHESTRATOR-PROTOCOL-SPEC.md](specs/ORCHESTRATOR-PROTOCOL-SPEC.md) | RFC 2119 specification |
| [skills/ct-orchestrator/SKILL.md](../skills/ct-orchestrator/SKILL.md) | Orchestrator skill |
| [skills/_shared/subagent-protocol-base.md](../skills/_shared/subagent-protocol-base.md) | Subagent protocol |

---

*This document is the canonical source for understanding how CLEO, the Orchestrator Protocol, Skills, Manifest, and Claude Code work together as a unified system.*
