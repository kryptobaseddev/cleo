# CLEO Features

> **Auto-generated from FEATURES.json** - Do not edit directly. Run `./scripts/generate-features.sh` to regenerate.

**Version**: 0.47.0
**Generated**: 2026-01-02T12:26:57Z

---

## Table of Contents

- [Task Management](#task-management)
- [Task Hierarchy](#hierarchy)
- [Session System](#sessions)
- [Focus System](#focus)
- [Phase Tracking](#phases)
- [Smart Analyze](#analyze)
- [Verification System](#verification)
- [Context Safeguard](#context-safeguard)
- [Roadmap Generation](#roadmap)
- [Data Integrity](#data-integrity)
- [Archive System](#archive)
- [Configuration](#configuration)
- [Migration & Compatibility](#migration)
- [Integration](#integration)
- [Output & Error Handling](#output)
- [Analysis Commands](#analysis-commands)

---

## Task Management

**Status**: stable  
Core CRUD operations for tasks

| Feature | Command | Status | Version |
|---------|---------|--------|---------|
| Task Creation | `cleo add` | complete | 0.1.0 |
| Task Updates | `cleo update` | complete | 0.1.0 |
| Task Completion | `cleo complete` | complete | 0.1.0 |
| Task Cancellation | `cleo delete` | complete | 0.32.0 |
| Task Details | `cleo show` | complete | 0.1.0 |
| Task Listing | `cleo list` | complete | 0.1.0 |
| Fuzzy Search | `cleo find` | complete | 0.19.2 |
| Task Existence Check | `cleo exists` | complete | 0.15.0 |

<details>
<summary>Feature Details</summary>

### Task Creation
Create tasks with hierarchy, priority, labels, phase, size, dependencies

### Task Updates
Modify any task field, add timestamped notes

### Task Completion
Mark tasks done, trigger parent auto-complete, initialize verification

### Task Cancellation
Soft-delete/cancel tasks with required reason, cascade options

### Task Details
Display full task details, history, related tasks

### Task Listing
Filter by status/priority/phase/label, sort, tree view

### Fuzzy Search
Context-efficient fuzzy search (99% less tokens than list)

### Task Existence Check
Verify task ID exists for scripting (exit code 0/1)

</details>

---

## Task Hierarchy

**Status**: stable  
Epic -> Task -> Subtask structure with 3-level depth

| Feature | Command | Status | Version |
|---------|---------|--------|---------|
| Task Types | `-` | complete | 0.17.0 |
| Parent Reference | `-` | complete | 0.17.0 |
| Task Reparenting | `cleo reparent` | complete | 0.17.0 |
| Task Promotion | `cleo promote` | complete | 0.17.0 |
| Hierarchy Population | `cleo populate-hierarchy` | complete | 0.38.0 |
| Parent Auto-Complete | `-` | complete | 0.24.0 |
| Hierarchy Constraints | `-` | complete | 0.17.0 |

<details>
<summary>Feature Details</summary>

### Task Types
Three types: epic (strategic), task (primary), subtask (atomic)

### Parent Reference
parentId field decouples hierarchy from task ID

### Task Reparenting
Move tasks between parents

### Task Promotion
Remove parent (make task a root)

### Hierarchy Population
Infer parentId from naming conventions (T001.1 -> parentId: T001)

### Parent Auto-Complete
Parent tasks auto-complete when all children are done

### Hierarchy Constraints
Configurable max depth (3), max siblings (unlimited by default)

</details>

---

## Session System

**Status**: stable  
Multi-agent session management with scope isolation

| Feature | Command | Status | Version |
|---------|---------|--------|---------|
| Session Lifecycle | `cleo session` | complete | 0.41.0 |
| Session Scopes | `-` | complete | 0.37.0 |
| Scope Conflict Detection | `-` | complete | 0.41.0 |
| Focus Locking | `-` | complete | 0.41.0 |
| Session Enforcement | `-` | complete | 0.41.0 |
| Multi-Agent Concurrency | `-` | complete | 0.37.1 |

<details>
<summary>Feature Details</summary>

### Session Lifecycle
4-state lifecycle: Active -> Suspended -> Ended -> Closed

### Session Scopes
6 scope types: task, taskGroup, subtree, epicPhase, epic, custom

### Scope Conflict Detection
HARD/SOFT overlap detection between concurrent sessions

### Focus Locking
Per-scope single active task enforcement

### Session Enforcement
Block/warn on writes without active session

### Multi-Agent Concurrency
Parallel sessions on different scopes for multiple LLM agents

</details>

---

## Focus System

**Status**: stable  
Single active task management with progress tracking

| Feature | Command | Status | Version |
|---------|---------|--------|---------|
| Focus Management | `cleo focus` | complete | 0.1.0 |
| Session Notes | `cleo focus note` | complete | 0.10.0 |
| Next Action | `cleo focus next` | complete | 0.10.0 |

<details>
<summary>Feature Details</summary>

### Focus Management
Set/show/clear active task (only ONE can be active)

### Session Notes
Add session-level progress notes

### Next Action
Set suggested next action for handoff

</details>

---

## Phase Tracking

**Status**: stable  
Project phase workflow organization

| Feature | Command | Status | Version |
|---------|---------|--------|---------|
| 5-Phase System | `-` | complete | 0.14.0 |
| Phase Synchronization | `-` | complete | 0.35.0 |
| Phase Commands | `cleo phase, cleo phases` | complete | 0.14.0 |

<details>
<summary>Feature Details</summary>

### 5-Phase System
setup, core, testing, polish, maintenance phases

### Phase Synchronization
Focus changes automatically update project.currentPhase

### Phase Commands
Set current phase, view phases with progress bars

</details>

---

## Smart Analyze

**Status**: stable  
Intelligent task triage and recommendation engine

| Feature | Command | Status | Version |
|---------|---------|--------|---------|
| Leverage Scoring | `cleo analyze` | complete | 0.20.0 |
| Hierarchy-Aware Scoring | `-` | complete | 0.39.0 |
| Phase-Priority Boost | `-` | complete | 0.43.0 |
| Size Weighting | `-` | complete | 0.43.0 |
| Stale Task Detection | `-` | complete | 0.42.0 |
| Lock File Detection | `-` | complete | 0.43.0 |
| Confidence Scoring | `-` | complete | 0.46.0 |
| Critical Path Analysis | `cleo blockers analyze` | complete | 0.20.0 |
| Epic-Scoped Analysis | `cleo analyze --parent` | complete | 0.41.0 |
| Auto-Focus | `cleo analyze --auto-focus` | complete | 0.42.0 |

<details>
<summary>Feature Details</summary>

### Leverage Scoring
Weighted dependency unlocks for prioritization

### Hierarchy-Aware Scoring
Parent/cross-epic/cross-phase dependency weights

### Phase-Priority Boost
Current phase tasks get 1.5x, adjacent 1.25x boost

### Size Weighting
quick-wins/big-impact/balanced strategies for task sizing

### Stale Task Detection
Identifies neglected, blocked, or aging tasks

### Lock File Detection
Warns about concurrent operations and conflicts

### Confidence Scoring
0.0-1.0 confidence per recommendation for agent decision-making

### Critical Path Analysis
Dependency chain analysis for bottleneck detection

### Epic-Scoped Analysis
Analyze within specific epic scope

### Auto-Focus
Automatically set focus to highest leverage task

</details>

---

## Verification System

**Status**: stable  
Progressive verification gates for task quality assurance

| Feature | Command | Status | Version |
|---------|---------|--------|---------|
| Verification Gates | `cleo verify` | complete | 0.43.1 |
| Epic Lifecycle | `-` | complete | 0.43.1 |
| Verification Schema | `-` | complete | 0.43.0 |
| Verification Filtering | `cleo list --verification-status` | complete | 0.43.1 |

<details>
<summary>Feature Details</summary>

### Verification Gates
Configurable gates (implemented, tested, reviewed, documented)

### Epic Lifecycle
Auto-transition epics based on children verification status

### Verification Schema
verification and epicLifecycle fields in task schema

### Verification Filtering
Filter tasks by verification status (pending/in-progress/passed/failed)

</details>

---

## Context Safeguard

**Status**: stable  
Graceful agent shutdown at context limits

| Feature | Command | Status | Version |
|---------|---------|--------|---------|
| Context Monitoring | `cleo context` | complete | 0.47.0 |
| Graceful Shutdown | `cleo safestop` | complete | 0.47.0 |
| Context Exit Codes | `-` | complete | 0.47.0 |

<details>
<summary>Feature Details</summary>

### Context Monitoring
Monitor context window usage (status/check)

### Graceful Shutdown
Generate handoff with session state preservation

### Context Exit Codes
EXIT_CONTEXT_WARNING (50) through EXIT_CONTEXT_STALE (54)

</details>

---

## Roadmap Generation

**Status**: stable  
Automated roadmap generation from task data

| Feature | Command | Status | Version |
|---------|---------|--------|---------|
| Roadmap Command | `cleo roadmap` | complete | 0.44.0 |
| Markdown Output | `cleo roadmap -o` | complete | 0.44.0 |
| Changelog Integration | `cleo roadmap --include-history` | complete | 0.44.0 |

<details>
<summary>Feature Details</summary>

### Roadmap Command
Generate roadmap from pending epics with progress bars

### Markdown Output
Write directly to ROADMAP.md file

### Changelog Integration
Include CHANGELOG.md release history

</details>

---

## Data Integrity

**Status**: stable  
Anti-hallucination validation and atomic operations

| Feature | Command | Status | Version |
|---------|---------|--------|---------|
| JSON Schema Validation | `-` | complete | 0.1.0 |
| Atomic Writes | `-` | complete | 0.1.0 |
| Checksum System | `cleo validate` | complete | 0.1.0 |
| Backup System | `cleo backup, cleo restore` | complete | 0.1.0 |
| Audit Logging | `cleo log` | complete | 0.1.0 |

<details>
<summary>Feature Details</summary>

### JSON Schema Validation
4-layer validation: schema, semantic, cross-file, state machine

### Atomic Writes
temp -> validate -> backup -> rename pattern

### Checksum System
SHA256 checksums for corruption detection

### Backup System
2-tier backups: operational (per-write) and recovery (snapshots)

### Audit Logging
Append-only todo-log.json for all operations

</details>

---

## Archive System

**Status**: stable  
Task lifecycle completion and restoration

| Feature | Command | Status | Version |
|---------|---------|--------|---------|
| Archive Tasks | `cleo archive` | complete | 0.1.0 |
| Restore from Archive | `cleo unarchive` | complete | 0.15.0 |
| Restore Cancelled | `cleo uncancel` | complete | 0.39.2 |
| Reopen Completed | `cleo reopen` | complete | 0.36.0 |

<details>
<summary>Feature Details</summary>

### Archive Tasks
Move old done/cancelled tasks to archive

### Restore from Archive
Restore archived tasks to active

### Restore Cancelled
Restore cancelled tasks from archive

### Reopen Completed
Restore done tasks to pending with reason

</details>

---

## Configuration

**Status**: stable  
Global and project configuration management

| Feature | Command | Status | Version |
|---------|---------|--------|---------|
| Config Priority | `-` | complete | 0.10.0 |
| Config Commands | `cleo config` | complete | 0.10.0 |
| Interactive Editor | `cleo config edit` | complete | 0.45.0 |

<details>
<summary>Feature Details</summary>

### Config Priority
Defaults -> Global -> Project -> Environment -> CLI flags

### Config Commands
get/set/show/reset/edit configuration

### Interactive Editor
Interactive config editing with $EDITOR

</details>

---

## Migration & Compatibility

**Status**: stable  
Schema migrations and legacy support

| Feature | Command | Status | Version |
|---------|---------|--------|---------|
| Schema Migrations | `cleo migrate` | complete | 0.14.0 |
| CLEO Rebrand Migration | `cleo claude-migrate` | complete | 0.37.0 |

<details>
<summary>Feature Details</summary>

### Schema Migrations
Automatic schema version upgrades

### CLEO Rebrand Migration
Migrate from claude-todo to cleo

</details>

---

## Integration

**Status**: stable  
External system integrations

| Feature | Command | Status | Version |
|---------|---------|--------|---------|
| TodoWrite Sync | `cleo sync` | complete | 0.20.0 |
| CLAUDE.md Injection | `cleo init --update-claude-md` | complete | 0.20.0 |
| Research Command | `cleo research` | complete | 0.23.0 |

<details>
<summary>Feature Details</summary>

### TodoWrite Sync
Bidirectional sync with Claude Code's ephemeral todos

### CLAUDE.md Injection
Inject task management instructions into CLAUDE.md

### Research Command
Multi-source web research with Context7 and Tavily

</details>

---

## Output & Error Handling

**Status**: stable  
LLM-Agent-First output design

| Feature | Command | Status | Version |
|---------|---------|--------|---------|
| JSON by Default | `-` | complete | 0.1.0 |
| Compact JSON | `-` | complete | 0.41.3 |
| Human-Readable Output | `--human` | complete | 0.1.0 |
| Verbose Output | `--verbose, -v` | complete | 0.45.0 |
| Dry Run | `--dry-run` | complete | 0.45.0 |
| Exit Codes | `-` | complete | 0.1.0 |
| Actionable Errors | `-` | complete | 0.40.0 |

<details>
<summary>Feature Details</summary>

### JSON by Default
All commands output JSON for agent consumption

### Compact JSON
Single-line output to prevent truncation

### Human-Readable Output
Opt-in human-readable formatting

### Verbose Output
Extended details for show/stats/dash

### Dry Run
Preview changes without execution

### Exit Codes
47+ documented exit codes for programmatic handling

### Actionable Errors
error.fix and error.alternatives for recovery

</details>

---

## Analysis Commands

**Status**: stable  
Project analysis and planning tools

| Feature | Command | Status | Version |
|---------|---------|--------|---------|
| Dashboard | `cleo dash` | complete | 0.10.0 |
| Next Task Suggestion | `cleo next` | complete | 0.10.0 |
| Dependency Visualization | `cleo deps` | complete | 0.15.0 |
| Blocker Analysis | `cleo blockers` | complete | 0.15.0 |
| Statistics | `cleo stats` | complete | 0.10.0 |
| Completion History | `cleo history` | complete | 0.20.0 |
| Label Management | `cleo labels` | complete | 0.15.0 |

<details>
<summary>Feature Details</summary>

### Dashboard
Project overview with stats, phases, activity

### Next Task Suggestion
AI-informed next task recommendation

### Dependency Visualization
Dependency tree and chain visualization

### Blocker Analysis
Show blocked tasks and critical path

### Statistics
Task statistics and metrics

### Completion History
Recent completion timeline

### Label Management
View labels with task counts

</details>

---

## Summary

| Metric | Count |
|--------|-------|
| Categories | 16 |
| Features | 85 |
| Complete | 85 |
| Commands | 48 |
| Libraries | 34 |

---

*Generated from [FEATURES.json](FEATURES.json) by `scripts/generate-features.sh`*
