# CLEO System Architecture Specification

**Version**: 1.0.0
**Status**: DRAFT
**Created**: 2025-12-29
**Last Updated**: 2025-12-29
**Purpose**: High-level architecture connecting all CLEO subsystems

---

## RFC 2119 Conformance

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT",
"SHOULD", "SHOULD NOT", "RECOMMENDED", "NOT RECOMMENDED", "MAY", and
"OPTIONAL" in this document are to be interpreted as described in
BCP 14 [RFC 2119] [RFC 8174] when, and only when, they appear in all
capitals, as shown here.

[RFC 2119]: https://www.rfc-editor.org/rfc/rfc2119
[RFC 8174]: https://www.rfc-editor.org/rfc/rfc8174.html

---

## Preamble

### Purpose

This specification provides the **definitive high-level architecture** for CLEO, showing how all subsystems connect into a unified task management and development orchestration platform. It serves as the "system nervous system" view, establishing the complete lifecycle from idea inception through implementation, release, and feedback.

### Authority

This specification is **AUTHORITATIVE** for:

- System-wide architecture and subsystem boundaries
- Inter-spec relationships and data flow
- Complete lifecycle model (Idea → Release → Feedback)
- Pipeline stage boundaries and handoff protocols
- Single source of truth principles
- Exit code range allocation across subsystems

This specification **DEFERS TO** the domain-specific specifications for all implementation details. This document defines HOW specs relate; each spec defines WHAT it covers.

### Core Principle

> **Everything is a Task.** All work in CLEO is represented as Tasks or Epics. There are no separate "issue", "bug", or "feature" entities. Different work types are distinguished by fields (`origin`, `labels`, `epicLifecycle`), not by entity type.

---

## Part 1: The Complete CLEO Lifecycle

### 1.1 Lifecycle Overview

```
┌─────────────────────────────────────────────────────────────────────────────────────────────┐
│                              CLEO COMPLETE LIFECYCLE                                         │
├─────────────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                              │
│   ┌────────────────────────────────────────────────────────────────────────────────────┐    │
│   │                              INPUT SOURCES                                          │    │
│   │                                                                                     │    │
│   │    ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐             │    │
│   │    │   Ideas     │  │ Bug Reports │  │ Feature     │  │ Technical   │             │    │
│   │    │ (Internal)  │  │ (External)  │  │ Requests    │  │ Debt        │             │    │
│   │    └──────┬──────┘  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘             │    │
│   │           │                │                │                │                     │    │
│   │           └────────────────┴────────────────┴────────────────┘                     │    │
│   │                                     │                                               │    │
│   └─────────────────────────────────────┼───────────────────────────────────────────────┘    │
│                                         │                                                    │
│                                         ▼                                                    │
│   ╔═════════════════════════════════════════════════════════════════════════════════════╗   │
│   ║                    STAGE 1: INGESTION & TRIAGE                                      ║   │
│   ║                    Authoritative: ISSUE-LIFECYCLE-SPEC                               ║   │
│   ║                                                                                      ║   │
│   ║    ct add "Epic: ..." --origin bug-report --severity major                          ║   │
│   ║    ct issue triage T500 --phase maintenance --priority high                         ║   │
│   ║                                                                                      ║   │
│   ║    Output: Task/Epic with origin tracking, severity, priority                       ║   │
│   ╚═══════════════════════════════════════╦═════════════════════════════════════════════╝   │
│                                           │                                                  │
│                        ┌──────────────────┴──────────────────┐                              │
│                        │ Simple Fix?                         │ Complex Feature?             │
│                        ▼                                     ▼                              │
│   ╔═════════════════════════════════╗    ╔═════════════════════════════════════════════╗   │
│   ║ Direct to IMPLEMENTATION        ║    ║ STAGE 2: RCSD PIPELINE                       ║   │
│   ║ (Skip RCSD for simple fixes)    ║    ║ Authoritative: RCSD-PIPELINE-SPEC            ║   │
│   ╚════════════════╦════════════════╝    ║                                              ║   │
│                    │                      ║    Research → Consensus → Spec → Decompose   ║   │
│                    │                      ║                                              ║   │
│                    │                      ║    Epic: epicLifecycle = "planning"          ║   │
│                    │                      ║    Output: Decomposed tasks with phases/deps ║   │
│                    │                      ╚═══════════════════╦═════════════════════════╝   │
│                    │                                          │                              │
│                    └──────────────────────────────────────────┤                              │
│                                                               │                              │
│                                                               ▼                              │
│   ╔═════════════════════════════════════════════════════════════════════════════════════╗   │
│   ║                    STAGE 3: IMPLEMENTATION ORCHESTRATION                            ║   │
│   ║                    Authoritative: IMPLEMENTATION-ORCHESTRATION-SPEC                  ║   │
│   ║                                                                                      ║   │
│   ║    ┌────────────────────────────────────────────────────────────────────────────┐   ║   │
│   ║    │  Planner → Coder → Testing → QA → Cleanup → Security → Docs               │   ║   │
│   ║    │      ↑                  │       │                │                         │   ║   │
│   ║    │      └──────────────────┴───────┴────────────────┘                         │   ║   │
│   ║    │                        (on failure, return to Coder)                       │   ║   │
│   ║    └────────────────────────────────────────────────────────────────────────────┘   ║   │
│   ║                                                                                      ║   │
│   ║    Task: verification.passed = true                                                 ║   │
│   ║    Epic: epicLifecycle = "active" → "review"                                        ║   │
│   ╚═══════════════════════════════════════╦═════════════════════════════════════════════╝   │
│                                           │                                                  │
│                                           ▼                                                  │
│   ╔═════════════════════════════════════════════════════════════════════════════════════╗   │
│   ║                    STAGE 4: RELEASE MANAGEMENT                                      ║   │
│   ║                    Authoritative: RELEASE-MANAGEMENT-SPEC                            ║   │
│   ║                                                                                      ║   │
│   ║    ct release create v0.42.0 --name "Multi-Session"                                 ║   │
│   ║    ct release plan v0.42.0 --add T998,T999                                          ║   │
│   ║    ct release changelog v0.42.0                                                     ║   │
│   ║    ct release ship v0.42.0                                                          ║   │
│   ║                                                                                      ║   │
│   ║    Release: planned → in-progress → staging → released                              ║   │
│   ║    Epic: epicLifecycle = "released"                                                 ║   │
│   ║    Git: Tag created                                                                 ║   │
│   ╚═══════════════════════════════════════╦═════════════════════════════════════════════╝   │
│                                           │                                                  │
│                                           ▼                                                  │
│   ┌─────────────────────────────────────────────────────────────────────────────────────┐   │
│   │                              PRODUCTION                                              │   │
│   │                              Users experience the release                            │   │
│   └──────────────────────────────────────┬──────────────────────────────────────────────┘   │
│                                          │                                                   │
│                          ┌───────────────┴───────────────┐                                  │
│                          ▼                               ▼                                  │
│                    ┌───────────┐                   ┌───────────┐                            │
│                    │   Bugs    │                   │ Feedback  │                            │
│                    │  Found    │                   │(Features) │                            │
│                    └─────┬─────┘                   └─────┬─────┘                            │
│                          │                               │                                  │
│                          └───────────────┬───────────────┘                                  │
│                                          │                                                  │
│                                          ▼                                                  │
│   ┌─────────────────────────────────────────────────────────────────────────────────────┐   │
│   │                          FEEDBACK LOOP → INPUT SOURCES                               │   │
│   │                          (Cycle Continues)                                           │   │
│   └─────────────────────────────────────────────────────────────────────────────────────┘   │
│                                                                                              │
└─────────────────────────────────────────────────────────────────────────────────────────────┘
```

### 1.2 Stage Summary Table

| Stage | Input | Output | Authoritative Spec | Exit Codes |
|-------|-------|--------|-------------------|------------|
| **Ingestion & Triage** | External inputs, ideas | Triaged Task/Epic | ISSUE-LIFECYCLE-SPEC | 60-69 |
| **RCSD Pipeline** | Epic requiring research | Decomposed tasks | RCSD-PIPELINE-SPEC | 30-39 |
| **Implementation** | Ready tasks | Verified code | IMPLEMENTATION-ORCHESTRATION-SPEC | 40-49 |
| **Release** | Completed Epics | Shipped release | RELEASE-MANAGEMENT-SPEC | 50-59 |

---

## Part 2: The Data Model

### 2.1 Single Source of Truth: todo.json

All state is stored in `.cleo/todo.json`. There are no separate issue trackers, feature databases, or release registries. Everything is derived from or stored in this single file:

```json
{
  "schemaVersion": "2.5.0",
  "meta": {
    "lastId": 1050,
    "projectName": "my-project"
  },
  "project": {
    "currentPhase": "core"
  },
  "phases": [...],
  "tasks": [...],
  "releases": {
    "v0.42.0": { ... }
  }
}
```

### 2.2 The Task Entity

Every work item is a Task with optional extensions:

```json
{
  "id": "T1000",
  "type": "task",           // epic | task | subtask
  "title": "...",
  "description": "...",
  "status": "pending",      // pending | active | blocked | done | cancelled
  "priority": "medium",     // critical | high | medium | low
  "phase": "core",          // setup | core | testing | polish | maintenance
  "labels": [],
  "depends": [],
  "parentId": null,

  // === EXTENSIONS (null when not applicable) ===

  // Epic Lifecycle (type=epic only)
  "epicLifecycle": null,    // backlog | planning | active | review | released | archived

  // Release Targeting
  "release": null,          // "v0.42.0"

  // Issue Origin (for externally-sourced work)
  "origin": null,           // { type, ref, severity, resolution, ... }

  // Implementation Verification
  "verification": null      // { passed, round, gates: {...}, failureLog: [...] }
}
```

### 2.3 Schema Extensions by Spec

| Spec | Adds to Task | Adds to Root |
|------|--------------|--------------|
| IMPLEMENTATION-ORCHESTRATION | `verification`, `epicLifecycle` | - |
| RELEASE-MANAGEMENT | `release` | `releases` |
| ISSUE-LIFECYCLE | `origin` | - |

For complete schema details, see [SCHEMA-CHANGES-SUMMARY.md](SCHEMA-CHANGES-SUMMARY.md).

---

## Part 3: Subsystem Boundaries

### 3.1 Specification Authority Matrix

```
┌──────────────────────────────────────────────────────────────────────────────────────────┐
│                           SPECIFICATION AUTHORITY MATRIX                                  │
├──────────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                          │
│  FOUNDATION LAYER                                                                        │
│  ┌────────────────────┐  ┌────────────────────┐  ┌────────────────────┐                 │
│  │ LLM-TASK-ID-SPEC   │  │ LLM-AGENT-FIRST    │  │ SPEC-BIBLE         │                 │
│  │ (ID format)        │  │ (CLI output)       │  │ (Doc standards)    │                 │
│  │ IMMUTABLE          │  │ ACTIVE             │  │ IMMUTABLE          │                 │
│  └─────────┬──────────┘  └─────────┬──────────┘  └────────────────────┘                 │
│            │                       │                                                     │
│  ══════════╪═══════════════════════╪═════════════════════════════════════════════════   │
│            │                       │                                                     │
│  INFRASTRUCTURE LAYER              │                                                     │
│  ┌─────────┴──────────┐  ┌─────────┴──────────┐  ┌────────────────────┐                 │
│  │ TASK-HIERARCHY     │  │ CONFIG-SYSTEM      │  │ FILE-LOCKING       │                 │
│  │ (Epic→Task→Sub)    │  │ (Config handling)  │  │ (Concurrency)      │                 │
│  │ APPROVED           │  │ ACTIVE             │  │ ACTIVE             │                 │
│  └─────────┬──────────┘  └────────────────────┘  └────────────────────┘                 │
│            │                                                                             │
│  ══════════╪═════════════════════════════════════════════════════════════════════════   │
│            │                                                                             │
│  WORKFLOW LAYER        │                                                                 │
│  ┌─────────┴──────────┐  ┌────────────────────┐  ┌────────────────────┐                 │
│  │ PHASE-SYSTEM       │  │ MULTI-SESSION      │  │ CONSENSUS-FRAMEWORK│                 │
│  │ (Project phases)   │  │ (Concurrent work)  │  │ (Multi-agent)      │                 │
│  │ ACTIVE             │  │ ACTIVE             │  │ ACTIVE             │                 │
│  └─────────┬──────────┘  └────────────────────┘  └────────────────────┘                 │
│            │                                                                             │
│  ══════════╪═════════════════════════════════════════════════════════════════════════   │
│            │                                                                             │
│  PIPELINE LAYER (This is where work flows)                                              │
│  ┌─────────┴───────────────────────────────────────────────────────────────────────┐    │
│  │                                                                                  │    │
│  │  ┌────────────────┐   ┌────────────────┐   ┌────────────────┐   ┌────────────┐ │    │
│  │  │ ISSUE-LIFECYCLE│ → │ RCSD-PIPELINE  │ → │ IMPLEMENTATION │ → │ RELEASE-   │ │    │
│  │  │ (Ingestion)    │   │ (Planning)     │   │ ORCHESTRATION  │   │ MANAGEMENT │ │    │
│  │  │ Exit: 60-69    │   │ Exit: 30-39    │   │ Exit: 40-49    │   │ Exit: 50-59│ │    │
│  │  └────────────────┘   └────────────────┘   └────────────────┘   └────────────┘ │    │
│  │                                                                                  │    │
│  └──────────────────────────────────────────────────────────────────────────────────┘    │
│                                                                                          │
│  INTEGRATION LAYER                                                                       │
│  ┌────────────────────┐  ┌────────────────────┐  ┌────────────────────┐                 │
│  │ TODOWRITE-SYNC     │  │ PROJECT-LIFECYCLE  │  │ CLEO-SYSTEM-ARCH   │                 │
│  │ (Claude Code sync) │  │ (Greenfield/Brown) │  │ (This document)    │                 │
│  │ ACTIVE             │  │ DRAFT              │  │ DRAFT              │                 │
│  └────────────────────┘  └────────────────────┘  └────────────────────┘                 │
│                                                                                          │
└──────────────────────────────────────────────────────────────────────────────────────────┘
```

### 3.2 Exit Code Allocation

| Range | Subsystem | Authoritative Spec |
|-------|-----------|-------------------|
| 0-9 | Core CLI | LLM-AGENT-FIRST-SPEC |
| 10-19 | Hierarchy | TASK-HIERARCHY-SPEC |
| 20-29 | Session | MULTI-SESSION-SPEC |
| **30-39** | **RCSD Pipeline** | RCSD-PIPELINE-SPEC |
| **40-49** | **Implementation** | IMPLEMENTATION-ORCHESTRATION-SPEC |
| **50-59** | **Release** | RELEASE-MANAGEMENT-SPEC |
| **60-69** | **Issue/Bug** | ISSUE-LIFECYCLE-SPEC |
| 100+ | Special (not errors) | LLM-AGENT-FIRST-SPEC |

### 3.3 Inter-Spec Data Flow

```
┌─────────────────────────────────────────────────────────────────────────────────────┐
│                              DATA FLOW BETWEEN SPECS                                 │
├─────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                      │
│  ISSUE-LIFECYCLE                                                                     │
│  ┌─────────────────────────────────────────────────────────────────────────────┐    │
│  │  INPUT: Bug report (GH-123), Feature request, Security issue                │    │
│  │  CREATES: Task with origin field populated                                  │    │
│  │  OUTPUT: Task { origin: { type: "bug-report", ref: "GH-123", ... } }       │    │
│  └───────────────────────────────────────────────┬─────────────────────────────┘    │
│                                                  │                                   │
│                            ┌─────────────────────┴─────────────────────┐            │
│                            ▼                                           ▼            │
│            Simple fix (Task)                            Complex (Epic)              │
│                    │                                           │                    │
│                    │                                           ▼                    │
│                    │                          RCSD-PIPELINE                         │
│                    │                          ┌─────────────────────────────────┐   │
│                    │                          │  INPUT: Epic (epicLifecycle:    │   │
│                    │                          │         backlog)                │   │
│                    │                          │  UPDATES: epicLifecycle →       │   │
│                    │                          │           "planning"            │   │
│                    │                          │  CREATES: Child tasks with      │   │
│                    │                          │           phases, dependencies   │   │
│                    │                          │  OUTPUT: Decomposed task DAG    │   │
│                    │                          └──────────────────┬──────────────┘   │
│                    │                                             │                  │
│                    └─────────────────────┬───────────────────────┘                  │
│                                          ▼                                          │
│  IMPLEMENTATION-ORCHESTRATION                                                       │
│  ┌─────────────────────────────────────────────────────────────────────────────┐   │
│  │  INPUT: Task (status: pending, verification: null)                          │   │
│  │  UPDATES: verification.gates.*, verification.round, lastAgent               │   │
│  │  UPDATES: Epic epicLifecycle: planning → active → review                    │   │
│  │  OUTPUT: Task (status: done, verification.passed: true)                     │   │
│  └──────────────────────────────────────────────────────────┬──────────────────┘   │
│                                                              │                      │
│                                                              ▼                      │
│  RELEASE-MANAGEMENT                                                                 │
│  ┌─────────────────────────────────────────────────────────────────────────────┐   │
│  │  INPUT: Epics with epicLifecycle: review                                    │   │
│  │  CREATES: Release { epics: [...], issues: [...] }                           │   │
│  │  UPDATES: Task.release = "v0.42.0"                                          │   │
│  │  UPDATES: Epic epicLifecycle: review → released                             │   │
│  │  UPDATES: Issue origin.fixedIn = "v0.42.0"                                  │   │
│  │  OUTPUT: Git tag, changelog, shipped release                                │   │
│  └─────────────────────────────────────────────────────────────────────────────┘   │
│                                                                                      │
└─────────────────────────────────────────────────────────────────────────────────────┘
```

---

## Part 4: The Two-Dimensional Work Model

### 4.1 Epics vs Phases

From PROJECT-LIFECYCLE-SPEC, work is organized in two dimensions:

```
                    PHASES (Lifecycle Time →)
                    ┌─────────┬─────────┬─────────┬─────────┬─────────┐
                    │ setup   │ core    │ testing │ polish  │ maint.  │
             ┌──────┼─────────┼─────────┼─────────┼─────────┼─────────┤
             │ Epic │ [tasks] │ [tasks] │ [tasks] │ [tasks] │ [tasks] │
    EPICS    │  A   │         │         │         │         │         │
  (Vertical) ├──────┼─────────┼─────────┼─────────┼─────────┼─────────┤
             │ Epic │ [tasks] │ [tasks] │ [tasks] │ [tasks] │ [tasks] │
             │  B   │         │         │         │         │         │
             └──────┴─────────┴─────────┴─────────┴─────────┴─────────┘
```

**Key Insight**:
- **Phases** are WHERE you are in the project lifecycle (stored in `project.currentPhase`)
- **Epics** are WHAT capabilities you're building (tracked via `epicLifecycle`)
- **Tasks** are HOW you build them (at the intersection, with `phase` field)
- **Waves** are computed execution order from dependency DAG (not stored)

### 4.2 Epic Lifecycle vs Task Status

| Field | Purpose | Values | Scope |
|-------|---------|--------|-------|
| `task.status` | Current work state | pending, active, blocked, done, cancelled | All tasks |
| `epic.epicLifecycle` | Epic journey stage | backlog, planning, active, review, released, archived | Epics only |
| `project.currentPhase` | Project-wide focus | setup, core, testing, polish, maintenance | Global |

### 4.3 Wave Computation

Waves are parallel execution groups computed from dependencies:

```
Wave 0: Tasks with no dependencies
Wave 1: Tasks whose dependencies are all in Wave 0
Wave 2: Tasks whose dependencies are all in Wave 0-1
...
```

See [TASK-DECOMPOSITION-SPEC.md](TASK-DECOMPOSITION-SPEC.md) for the algorithm.

---

## Part 5: Agent Architecture

### 5.1 Agent Types by Pipeline Stage

| Stage | Agent | Purpose | Claude Code subagent_type |
|-------|-------|---------|---------------------------|
| **RCSD** | Research | Multi-source evidence | `deep-research-agent` |
| **RCSD** | Consensus (5) | Adversarial validation | Custom per role |
| **RCSD** | Synthesis | Artifact generation | `technical-writer` |
| **Impl** | Planner | Task selection, orchestration | Main session (HITL) |
| **Impl** | Coder | Code implementation | `python-expert`, `backend-architect` |
| **Impl** | Testing | Test execution | `quality-engineer` |
| **Impl** | QA | Acceptance validation | `frontend-architect` |
| **Impl** | Cleanup | Refactoring, docs | `refactoring-expert` |
| **Impl** | Security | Vulnerability scanning | `security-engineer` |
| **Impl** | Docs | Documentation | `technical-writer` |

### 5.2 Agent-CLEO Integration

All agents interact with CLEO via CLI commands:

```bash
# Reading state
ct show T005 --json
ct focus show --json
ct session status

# Updating state
ct update T005 --notes "Progress..."
ct verify T005 --gate implemented --value true --agent coder
ct complete T005

# Session management
ct session start --scope epic:T001
ct focus set T005
ct session end
```

---

## Part 6: Immutable Principles

### 6.1 Core Principles

| # | Principle | Rationale |
|---|-----------|-----------|
| 1 | **Everything is a Task** | Issues, bugs, features, research - all become Tasks/Epics. One data model. |
| 2 | **Single Source of Truth** | All state in `.cleo/todo.json` (+ minimal registry files like `releases`). |
| 3 | **Epics traverse phases** | Epic contains tasks across setup→core→testing→polish→maintenance. |
| 4 | **Epic has its own lifecycle** | Independent of individual task statuses (epicLifecycle field). |
| 5 | **Releases aggregate completed work** | Computed from tasks/Epics with release field. |
| 6 | **Changelog is derived, not authored** | Generated from completed task metadata. |
| 7 | **Waves are computed, not stored** | Parallel execution groups from dependency DAG. |
| 8 | **Deterministic queries** | Same input → same output, always. |
| 9 | **CLI is the API** | Agents interact via CLI, never by editing JSON directly. |

### 6.2 Data Integrity Rules

From LLM-AGENT-FIRST-SPEC:

1. **Atomic operations** - All writes use temp → validate → backup → rename
2. **JSON Schema validation** - Every write validated against schema
3. **Append-only audit log** - All operations logged to todo-log.json
4. **Anti-hallucination** - Every task has title AND description (different content)
5. **Unique IDs** - No duplicates across todo.json and archive

---

## Part 7: Configuration Integration

### 7.1 Pipeline Configuration

```json
{
  "rcsd": {
    "enabled": true,
    "consensusThreshold": 4,
    "evidenceMinSources": 3
  },
  "implementation": {
    "enabled": true,
    "maxRounds": 5,
    "requiredGates": ["implemented", "testsPassed", "qaPassed", "securityPassed", "documented"],
    "autoSpawnAgents": true,
    "sessionRequired": true
  },
  "release": {
    "gitIntegration": true,
    "autoTag": true,
    "autoPush": false,
    "changelogFormat": "keepachangelog"
  },
  "issue": {
    "defaultPhase": "maintenance",
    "severityToPriority": {
      "critical": "critical",
      "major": "high",
      "minor": "medium",
      "trivial": "low"
    }
  }
}
```

### 7.2 Multi-Session Configuration

```json
{
  "multiSession": {
    "enabled": true,
    "maxConcurrentSessions": 5,
    "maxActiveTasksPerScope": 1,
    "scopeValidation": "strict"
  }
}
```

---

## Part 8: Quick Reference

### 8.1 Complete Command Reference by Stage

**Ingestion & Triage**:
```bash
ct issue create "Title" --type bug-report --severity major
ct issue triage T500 --priority high --phase maintenance
ct issue list --type bug-report --severity critical
ct issue verify T500 --verified-by @qa
ct issue close T500 --resolution fixed
```

**RCSD Pipeline**:
```bash
ct research "topic" --depth deep
ct consensus T001 --threshold 4
ct spec T001 --generate
ct decompose T001 --phases auto
```

**Implementation**:
```bash
ct session start --scope epic:T001
ct focus set T005
ct verify T005 --gate implemented --value true --agent coder
ct verify T005 --gate testsPassed --value false --reason "3 tests failed"
ct complete T005
ct session end
```

**Release**:
```bash
ct release create v0.42.0 --name "Feature Name"
ct release plan v0.42.0 --add T998,T999
ct release stage v0.42.0
ct release changelog v0.42.0
ct release ship v0.42.0
ct roadmap
```

### 8.2 State Transitions Summary

```
EPIC LIFECYCLE:
  backlog → planning → active → review → released → archived
            (RCSD)    (Impl)   (All done) (Ship)

RELEASE LIFECYCLE:
  planned → in-progress → staging → released → deprecated

TASK STATUS:
  pending → active → (blocked) → done
                               → cancelled

VERIFICATION GATES:
  null → implemented → testsPassed → qaPassed → cleanupDone → securityPassed → documented
```

---

## Part 9: Related Specifications

### 9.1 Specification Index

#### Foundation Layer (Immutable/Core)

| Spec | Purpose | Status |
|------|---------|--------|
| [SPEC-BIBLE-GUIDELINES](SPEC-BIBLE-GUIDELINES.md) | How to write specifications | IMMUTABLE |
| [LLM-TASK-ID-SYSTEM-DESIGN-SPEC](LLM-TASK-ID-SYSTEM-DESIGN-SPEC.md) | Task ID format (T### format) | IMMUTABLE |
| [LLM-AGENT-FIRST-SPEC](LLM-AGENT-FIRST-SPEC.md) | CLI design, JSON output, exit codes | ACTIVE |

#### Infrastructure Layer

| Spec | Purpose | Status |
|------|---------|--------|
| [CONFIG-SYSTEM-SPEC](CONFIG-SYSTEM-SPEC.md) | Configuration management | ACTIVE |
| [FILE-LOCKING-SPEC](FILE-LOCKING-SPEC.md) | Concurrency & atomic operations | ACTIVE |
| [BACKUP-SYSTEM-SPEC](BACKUP-SYSTEM-SPEC.md) | Backup & recovery | ACTIVE |
| [MIGRATION-SYSTEM-SPEC](MIGRATION-SYSTEM-SPEC.md) | Schema migrations | ACTIVE |

#### Task Management Layer

| Spec | Purpose | Status |
|------|---------|--------|
| [TASK-HIERARCHY-SPEC](TASK-HIERARCHY-SPEC.md) | Epic→Task→Subtask structure | APPROVED |
| [PHASE-SYSTEM-SPEC](PHASE-SYSTEM-SPEC.md) | Project phases (setup→maintenance) | ACTIVE |
| [TASK-DECOMPOSITION-SPEC](TASK-DECOMPOSITION-SPEC.md) | Breaking work into atomic tasks | ACTIVE |

#### Session & Lifecycle Layer

| Spec | Purpose | Status |
|------|---------|--------|
| [MULTI-SESSION-SPEC](MULTI-SESSION-SPEC.md) | Concurrent agent sessions | ACTIVE |
| [EPIC-SESSION-SPEC](EPIC-SESSION-SPEC.md) | Epic-bound session architecture | ACTIVE |
| [PROJECT-LIFECYCLE-SPEC](PROJECT-LIFECYCLE-SPEC.md) | Greenfield/brownfield patterns | DRAFT |

#### Pipeline Layer (Work Flow)

| Spec | Purpose | Exit Codes |
|------|---------|------------|
| [ISSUE-LIFECYCLE-SPEC](ISSUE-LIFECYCLE-SPEC.md) | Bug/issue ingestion & triage | 60-69 |
| [RCSD-PIPELINE-SPEC](RCSD-PIPELINE-SPEC.md) | Research→Consensus→Spec→Decompose | 30-39 |
| [CONSENSUS-FRAMEWORK-SPEC](CONSENSUS-FRAMEWORK-SPEC.md) | Multi-agent adversarial validation | - |
| [IMPLEMENTATION-ORCHESTRATION-SPEC](IMPLEMENTATION-ORCHESTRATION-SPEC.md) | 7-agent implementation workflow | 40-49 |
| [RELEASE-MANAGEMENT-SPEC](RELEASE-MANAGEMENT-SPEC.md) | Release lifecycle & changelog | 50-59 |

#### Integration Layer

| Spec | Purpose | Status |
|------|---------|--------|
| [CLEO-SYSTEM-ARCHITECTURE-SPEC](CLEO-SYSTEM-ARCHITECTURE-SPEC.md) | **This document** - System overview | DRAFT |
| [TODOWRITE-SYNC-SPEC](TODOWRITE-SYNC-SPEC.md) | Claude Code TodoWrite sync | ACTIVE |

#### Reference Documents

| Doc | Purpose |
|-----|---------|
| [SCHEMA-CHANGES-SUMMARY](SCHEMA-CHANGES-SUMMARY.md) | Pending schema updates from new specs |

### 9.2 Dependency Graph

```
┌─────────────────────────────────────────────────────────────────────────────────────────┐
│                              SPECIFICATION DEPENDENCY GRAPH                              │
└─────────────────────────────────────────────────────────────────────────────────────────┘

FOUNDATION LAYER
================
SPEC-BIBLE-GUIDELINES (Meta authority - how to write specs)
    │
    └─► LLM-TASK-ID-SYSTEM-DESIGN-SPEC (ID format - IMMUTABLE)
            │
            └─► All specs use T### task ID format

LLM-AGENT-FIRST-SPEC (CLI output - AUTHORITATIVE)
    │
    ├─► All command implementations
    ├─► Exit code standards
    └─► JSON envelope format

INFRASTRUCTURE LAYER
====================
CONFIG-SYSTEM-SPEC ────────────────────────► All configurable features
FILE-LOCKING-SPEC ─────────────────────────► All write operations
BACKUP-SYSTEM-SPEC ────────────────────────► Data recovery
MIGRATION-SYSTEM-SPEC ─────────────────────► Schema evolution

TASK MANAGEMENT LAYER
=====================
LLM-TASK-ID-SYSTEM-DESIGN-SPEC
    │
    ├─► TASK-HIERARCHY-SPEC (Epic→Task→Subtask)
    │       │
    │       └─► TASK-DECOMPOSITION-SPEC (Atomicity, waves)
    │
    └─► PHASE-SYSTEM-SPEC (setup→core→testing→polish→maintenance)
            │
            └─► PROJECT-LIFECYCLE-SPEC (Greenfield/brownfield)

SESSION LAYER
=============
MULTI-SESSION-SPEC (Concurrent sessions)
    │
    └─► EPIC-SESSION-SPEC (Epic-bound sessions)
            │
            └─► IMPLEMENTATION-ORCHESTRATION-SPEC (Session-aware agents)

PIPELINE LAYER (Data Flow)
==========================
                                    ┌──────────────────────────────┐
                                    │  CONSENSUS-FRAMEWORK-SPEC    │
                                    │  (Multi-agent patterns)      │
                                    └──────────────┬───────────────┘
                                                   │
    ┌──────────────────────────────────────────────┼─────────────────────────────────────┐
    │                                              │                                      │
    │                                              ▼                                      │
    │  ┌────────────────────┐   ┌────────────────────┐   ┌────────────────────┐          │
    │  │ ISSUE-LIFECYCLE    │──►│ RCSD-PIPELINE      │──►│ IMPLEMENTATION-    │          │
    │  │ (Ingestion)        │   │ (Research→Tasks)   │   │ ORCHESTRATION      │          │
    │  │ Exit: 60-69        │   │ Exit: 30-39        │   │ Exit: 40-49        │          │
    │  └────────────────────┘   └────────────────────┘   └─────────┬──────────┘          │
    │                                                               │                      │
    │                                                               ▼                      │
    │                                              ┌────────────────────┐                  │
    │                                              │ RELEASE-MANAGEMENT │                  │
    │                                              │ Exit: 50-59        │                  │
    │                                              └────────────────────┘                  │
    └─────────────────────────────────────────────────────────────────────────────────────┘

INTEGRATION LAYER
=================
CLEO-SYSTEM-ARCHITECTURE-SPEC (This document)
    │
    ├─► Ties all specs together
    └─► Defines inter-spec data flow

TODOWRITE-SYNC-SPEC
    │
    └─► Claude Code integration
```

---

## Part 10: Conformance

### 10.1 Conformance Requirements

A conforming CLEO implementation MUST:

1. Store all state in `.cleo/todo.json` (single source of truth)
2. Implement the Task schema with all extensions
3. Support all four pipeline stages
4. Use exit codes within allocated ranges
5. Follow LLM-AGENT-FIRST-SPEC for CLI output
6. Implement atomic write operations

A conforming implementation SHOULD:

1. Implement all agent types in Implementation Orchestration
2. Support multi-session concurrent work
3. Generate changelogs from task metadata
4. Integrate with git for tagging

A conforming implementation MAY:

1. Support external tracker sync (GitHub, Jira)
2. Implement custom agent types
3. Add custom workflow hooks
4. Extend schema with project-specific fields

---

## Appendix A: Version History

### Version 1.0.0 (2025-12-29)

- Initial specification
- Complete lifecycle model
- Subsystem boundaries and exit code allocation
- Data flow documentation
- Agent architecture overview
- Integration with all domain specs

---

*End of Specification*
