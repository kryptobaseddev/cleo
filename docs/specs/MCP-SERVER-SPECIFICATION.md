# CLEO MCP Server Specification

**Version**: 1.1.0
**Status**: STABLE
**Date**: 2026-02-10
**Authors**: Claude Opus 4.5, CLEO Development Team

---

## 1. Executive Summary

This specification defines the Model Context Protocol (MCP) server interface for CLEO, the task management protocol for solo developers and AI coding agents. The server exposes CLEO through **two gateway tools** using a CQRS (Command Query Responsibility Segregation) pattern.

### 1.0 Authority and Implementation Source of Truth

This specification is canonical for MCP contract behavior.

Implementation operation counts and live operation matrices MUST be sourced from:

- `mcp-server/src/gateways/query.ts`
- `mcp-server/src/gateways/mutate.ts`

As of v0.86.0 deployment (T4269), implementation expected counts are:

- `cleo_query`: 56
- `cleo_mutate`: 51
- Total: 107

The original core contract matrix (96 operations) remains the baseline model; implementation may include documented parity extensions.

### 1.1 Design Goals

1. **Minimal Token Footprint**: 2 tools (~1,800 tokens) vs 65 tools (~32,500 tokens) = 94% reduction
2. **Full Capability Access**: All 93 operations accessible through domain routing (96 including implementation-only background job operations)
3. **Safety by Design**: Read operations cannot mutate state
4. **Protocol Enforcement**: RCSD-IVTR lifecycle with exit codes 60-70
5. **Anti-Hallucination**: 4-layer validation (schema → semantic → referential → protocol)

### 1.2 Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                            MCP TOOL LAYER (2 Entry Points)                       │
│                                                                                  │
│   ┌─────────────────────────────────┐    ┌─────────────────────────────────┐    │
│   │         cleo_query              │    │         cleo_mutate             │    │
│   │      (48 Read Operations)       │    │      (48 Write Operations)      │    │
│   └────────────────┬────────────────┘    └────────────────┬────────────────┘    │
└────────────────────┼──────────────────────────────────────┼──────────────────────┘
                     │                                      │
                     ▼                                      ▼
┌─────────────────────────────────────────────────────────────────────────────────┐
│                              DOMAIN ROUTER (8 Domains)                           │
│    tasks │ session │ orchestrate │ research │ lifecycle │ validate │ release    │
│                                   + system                                       │
└─────────────────────────────────────────────────────────────────────────────────┘
                                         │
                                         ▼
┌─────────────────────────────────────────────────────────────────────────────────┐
│                           PROTOCOL ENFORCEMENT LAYER                             │
│  RCSD: Research(60) → Consensus(61) → Specification(62) → Decomposition(63)     │
│  IVTR: Implementation(64) → Validation(68) → Testing(69/70) → Release(66)       │
│                         + Contribution(65) cross-cutting                         │
└─────────────────────────────────────────────────────────────────────────────────┘
                                         │
                                         ▼
┌─────────────────────────────────────────────────────────────────────────────────┐
│                              CLI LAYER (65 commands)                             │
└─────────────────────────────────────────────────────────────────────────────────┘
                                         │
                                         ▼
┌─────────────────────────────────────────────────────────────────────────────────┐
│                         LIB LAYER (99 modules, 280+ functions)                   │
└─────────────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Gateway Tool Definitions

### 2.1 `cleo_query` - Read Operations

**Purpose**: All read-only operations for discovery, status, analysis, and validation checks.

**Characteristics**:
- MUST NOT modify any state
- Results MAY be cached
- Safe to retry without side effects
- Can be granted as read-only access

#### 2.1.1 Tool Schema

```json
{
  "name": "cleo_query",
  "description": "CLEO read operations: task discovery, status checks, analysis, validation, and compliance metrics. Never modifies state.",
  "inputSchema": {
    "type": "object",
    "required": ["domain", "operation"],
    "properties": {
      "domain": {
        "type": "string",
        "enum": ["tasks", "session", "orchestrate", "research", "lifecycle", "validate", "system"],
        "description": "Functional domain to query"
      },
      "operation": {
        "type": "string",
        "description": "Domain-specific read operation (see operation matrix)"
      },
      "params": {
        "type": "object",
        "description": "Operation-specific parameters",
        "additionalProperties": true
      }
    }
  }
}
```

#### 2.1.2 Operations by Domain (48 Total: 46 spec + 2 background job ops)

##### tasks (9 operations)

| Operation | Description | Parameters | Returns |
|-----------|-------------|------------|---------|
| `get` | Get single task details | `taskId` | Full task object |
| `list` | List tasks with filters | `parent?`, `status?`, `limit?` | Task array |
| `find` | Fuzzy search tasks | `query`, `limit?` | Minimal task array |
| `exists` | Check task existence | `taskId` | Boolean |
| `tree` | Hierarchical task view | `rootId?`, `depth?` | Tree structure |
| `blockers` | Get blocking tasks | `taskId` | Blocker array |
| `deps` | Get dependencies | `taskId`, `direction?` | Dependency graph |
| `analyze` | Triage analysis | `epicId?` | Priority recommendations |
| `next` | Next task suggestion | `epicId?`, `count?` | Suggested tasks |

##### session (5 operations)

| Operation | Description | Parameters | Returns |
|-----------|-------------|------------|---------|
| `status` | Current session status | - | Session object |
| `list` | List all sessions | `active?` | Session array |
| `show` | Session details | `sessionId` | Full session object |
| `focus.get` | Get focused task | - | Task ID or null |
| `history` | Session history | `limit?` | History array |

##### orchestrate (7 operations)

| Operation | Description | Parameters | Returns |
|-----------|-------------|------------|---------|
| `status` | Orchestrator status | `epicId` | Orchestration state |
| `next` | Next task to spawn | `epicId` | Task + skill recommendation |
| `ready` | Parallel-safe tasks | `epicId` | Task IDs in current wave |
| `analyze` | Dependency analysis | `epicId` | Wave structure + critical path |
| `context` | Context usage check | `tokens?` | Context budget status |
| `waves` | Wave computation | `epicId` | Parallel execution waves |
| `skill.list` | Available skills | `filter?` | Skill definitions |

##### research (6 operations)

| Operation | Description | Parameters | Returns |
|-----------|-------------|------------|---------|
| `show` | Research entry details | `researchId` | Full entry |
| `list` | List research entries | `epicId?`, `status?` | Entry array |
| `query` | Search research | `query`, `confidence?` | Matched entries |
| `pending` | Pending research | `epicId?` | Entries needing follow-up |
| `stats` | Research statistics | `epicId?` | Aggregated metrics |
| `manifest.read` | Read manifest entries | `filter?`, `limit?` | JSONL entries |

##### lifecycle (5 operations)

| Operation | Description | Parameters | Returns |
|-----------|-------------|------------|---------|
| `check` | Check stage prerequisites | `taskId`, `targetStage` | Gate status |
| `status` | Current lifecycle state | `taskId` or `epicId` | Stage progression |
| `history` | Stage transition history | `taskId` | Transition log |
| `gates` | All gate statuses | `taskId` | Gate status array |
| `prerequisites` | Required prior stages | `targetStage` | Prerequisite list |

##### validate (9 operations)

| Operation | Description | Parameters | Returns |
|-----------|-------------|------------|---------|
| `schema` | JSON Schema validation | `fileType`, `filePath?` | Validation result |
| `protocol` | Protocol compliance | `taskId`, `protocolType` | Violations + score |
| `task` | Anti-hallucination check | `taskId`, `checkMode` | Rule violations |
| `manifest` | Manifest entry check | `entry` or `taskId` | Integrity status |
| `output` | Output file validation | `taskId`, `filePath` | Content validation |
| `compliance.summary` | Aggregated compliance | `scope?`, `since?` | Summary metrics |
| `compliance.violations` | List violations | `severity?`, `protocol?` | Violation array |
| `test.status` | Test suite status | `taskId?` | Pass/fail counts |
| `test.coverage` | Coverage metrics | `taskId?` | Coverage percentages |

##### system (5 operations)

| Operation | Description | Parameters | Returns |
|-----------|-------------|------------|---------|
| `version` | CLEO version | - | Version string |
| `doctor` | Health check | - | Health status |
| `config.get` | Get config value | `key` | Config value |
| `stats` | Project statistics | - | Task/session stats |
| `context` | Context window info | - | Token usage |

---

### 2.2 `cleo_mutate` - Write Operations

**Purpose**: All state-modifying operations for task management, orchestration, and system changes.

**Characteristics**:
- MUST be idempotent where possible
- MUST validate before committing
- MUST log to audit trail
- Requires appropriate permissions

#### 2.2.1 Tool Schema

```json
{
  "name": "cleo_mutate",
  "description": "CLEO write operations: create, update, complete tasks; manage sessions; spawn agents; progress lifecycle; execute releases. Modifies state with validation.",
  "inputSchema": {
    "type": "object",
    "required": ["domain", "operation"],
    "properties": {
      "domain": {
        "type": "string",
        "enum": ["tasks", "session", "orchestrate", "research", "lifecycle", "validate", "release", "system"],
        "description": "Functional domain to mutate"
      },
      "operation": {
        "type": "string",
        "description": "Domain-specific write operation (see operation matrix)"
      },
      "params": {
        "type": "object",
        "description": "Operation-specific parameters",
        "additionalProperties": true
      }
    }
  }
}
```

#### 2.2.2 Operations by Domain (48 Total: 47 spec + 1 background job op)

##### tasks (10 operations)

| Operation | Description | Parameters | Returns |
|-----------|-------------|------------|---------|
| `create` | Create new task | `title`, `description`, `parent?`, `depends?`, `priority?`, `labels?` | Created task |
| `update` | Update task fields | `taskId`, `title?`, `description?`, `status?`, `priority?`, `notes?` | Updated task |
| `complete` | Mark task done | `taskId`, `notes?`, `archive?` | Completion status |
| `delete` | Delete task | `taskId`, `force?` | Deletion status |
| `archive` | Archive done tasks | `taskId?`, `before?` | Archived count |
| `unarchive` | Restore from archive | `taskId` | Restored task |
| `reparent` | Change task parent | `taskId`, `newParent` | Updated hierarchy |
| `promote` | Promote subtask to task | `taskId` | Promoted task |
| `reorder` | Reorder siblings | `taskId`, `position` | New order |
| `reopen` | Reopen completed task | `taskId` | Reopened task |

##### session (7 operations)

| Operation | Description | Parameters | Returns |
|-----------|-------------|------------|---------|
| `start` | Start new session | `scope`, `name?`, `autoFocus?` | Session object |
| `end` | End current session | `notes?` | Session summary |
| `resume` | Resume existing session | `sessionId` | Resumed session |
| `suspend` | Suspend session | `notes?` | Suspended status |
| `focus.set` | Set focused task | `taskId` | Focus confirmation |
| `focus.clear` | Clear focus | - | Clear confirmation |
| `gc` | Garbage collect sessions | `olderThan?` | Cleaned count |

##### orchestrate (5 operations)

| Operation | Description | Parameters | Returns |
|-----------|-------------|------------|---------|
| `startup` | Initialize orchestration | `epicId` | Full startup state |
| `spawn` | Generate spawn prompt | `taskId`, `skill?`, `model?` | Spawn prompt + metadata |
| `validate` | Validate spawn readiness | `taskId` | Validation result |
| `parallel.start` | Start parallel wave | `epicId`, `wave` | Wave tasks |
| `parallel.end` | End parallel wave | `epicId`, `wave` | Wave completion |

##### research (4 operations)

| Operation | Description | Parameters | Returns |
|-----------|-------------|------------|---------|
| `inject` | Get protocol injection | `protocolType`, `taskId?`, `variant?` | Protocol block |
| `link` | Link research to task | `researchId`, `taskId`, `relationship?` | Link confirmation |
| `manifest.append` | Append manifest entry | `entry`, `validateFile?` | Entry confirmation |
| `manifest.archive` | Archive old entries | `beforeDate?`, `moveFiles?` | Archive count |

##### lifecycle (5 operations)

| Operation | Description | Parameters | Returns |
|-----------|-------------|------------|---------|
| `progress` | Record stage completion | `taskId`, `stage`, `status`, `notes?` | Progress confirmation |
| `skip` | Skip optional stage | `taskId`, `stage`, `reason` | Skip confirmation |
| `reset` | Reset stage (emergency) | `taskId`, `stage`, `reason` | Reset confirmation |
| `gate.pass` | Mark gate as passed | `taskId`, `gateName`, `agent`, `notes?` | Gate status |
| `gate.fail` | Mark gate as failed | `taskId`, `gateName`, `reason` | Gate status |

##### validate (2 operations)

| Operation | Description | Parameters | Returns |
|-----------|-------------|------------|---------|
| `compliance.record` | Record compliance check | `taskId`, `result` | Record confirmation |
| `test.run` | Execute test suite | `scope?`, `pattern?`, `parallel?` | Test results |

##### release (7 operations)

| Operation | Description | Parameters | Returns |
|-----------|-------------|------------|---------|
| `prepare` | Prepare release | `version`, `type` | Preparation status |
| `changelog` | Generate changelog | `version`, `sections?` | Changelog content |
| `commit` | Create release commit | `version`, `files?` | Commit hash |
| `tag` | Create git tag | `version`, `message?` | Tag name |
| `push` | Push to remote | `version`, `remote?` | Push status |
| `gates.run` | Run release gates | `gates?` | Gate results |
| `rollback` | Rollback release | `version`, `reason` | Rollback status |

##### system (7 operations)

| Operation | Description | Parameters | Returns |
|-----------|-------------|------------|---------|
| `init` | Initialize CLEO | `projectType?`, `detect?` | Init status |
| `config.set` | Set config value | `key`, `value` | Set confirmation |
| `backup` | Create backup | `type?`, `note?` | Backup path |
| `restore` | Restore from backup | `backupId` | Restore status |
| `migrate` | Run migrations | `version?`, `dryRun?` | Migration result |
| `sync` | Sync with TodoWrite | `direction?` | Sync result |
| `cleanup` | Cleanup stale data | `type`, `olderThan?` | Cleanup count |

---

## 3. Response Format

### 3.1 Success Response

All operations return a consistent envelope:

```json
{
  "_meta": {
    "gateway": "cleo_query|cleo_mutate",
    "domain": "tasks",
    "operation": "get",
    "version": "1.0.0",
    "timestamp": "2026-01-31T18:35:00Z",
    "duration_ms": 45
  },
  "success": true,
  "data": {
    // Operation-specific response data
  }
}
```

### 3.2 Error Response

```json
{
  "_meta": {
    "gateway": "cleo_mutate",
    "domain": "tasks",
    "operation": "create",
    "version": "1.0.0",
    "timestamp": "2026-01-31T18:35:00Z"
  },
  "success": false,
  "error": {
    "code": "E_VALIDATION_FAILED",
    "exitCode": 6,
    "message": "Title and description must be different",
    "details": {
      "field": "description",
      "value": "Same as title",
      "constraint": "must differ from title"
    },
    "fix": "Provide a unique description that differs from the title",
    "alternatives": [
      {
        "action": "Use generated description",
        "command": "cleo_mutate tasks create --title \"...\" --description \"Implementation of ...\""
      }
    ]
  }
}
```

### 3.3 Partial Success Response

For batch operations that partially succeed:

```json
{
  "_meta": { /* ... */ },
  "success": true,
  "partial": true,
  "data": {
    "succeeded": [
      { "taskId": "T2405", "status": "completed" },
      { "taskId": "T2406", "status": "completed" }
    ],
    "failed": [
      {
        "taskId": "T2407",
        "error": { "code": "E_BLOCKED", "message": "Task has unresolved dependencies" }
      }
    ]
  }
}
```

---

## 4. Protocol Enforcement

### 4.1 RCSD-IVTR Lifecycle

The MCP server enforces the complete RCSD-IVTR lifecycle pipeline:

```
SETUP PIPELINE (RCSD)
━━━━━━━━━━━━━━━━━━━━━
Research ────► Consensus ────► Specification ────► Decomposition
  (60)          (61)            (62)                (63)
   │              │               │                   │
   ▼              ▼               ▼                   ▼
 Evidence      Decisions       Requirements        Atomic tasks
 gathering     validation      formalization       breakdown

                              │
                              ▼
EXECUTION PIPELINE (IVTR)
━━━━━━━━━━━━━━━━━━━━━━━━━
Implementation ────► Validation ────► Testing ────► Release
     (64)              (68)           (69/70)        (66)
      │                  │               │             │
      ▼                  ▼               ▼             ▼
  Code with          Protocol       100% pass      Version +
  provenance         compliance     rate           changelog

      ╲                                           ╱
       ╲──────────► Contribution (65) ◄──────────╱
                     Cross-cutting
                     Work attribution
```

### 4.2 Protocol Requirements

#### 4.2.1 Research Protocol (Exit Code 60)

| ID | Level | Requirement |
|----|-------|-------------|
| RSCH-001 | MUST | NOT implement code or modify codebase |
| RSCH-002 | SHOULD | Document all sources with citations |
| RSCH-004 | MUST | Append entry to MANIFEST.jsonl |
| RSCH-006 | MUST | Include 3-7 key findings in manifest |
| RSCH-007 | MUST | Set `agent_type: "research"` |

#### 4.2.2 Consensus Protocol (Exit Code 61)

| ID | Level | Requirement |
|----|-------|-------------|
| CONS-001 | MUST | Use voting matrix with ≥2 options |
| CONS-003 | MUST | Include confidence scores (0.0-1.0) |
| CONS-004 | MUST | Meet 50% weighted threshold for PROVEN |
| CONS-006 | MUST | Escalate to HITL when threshold not reached |
| CONS-007 | MUST | Set `agent_type: "analysis"` |

#### 4.2.3 Specification Protocol (Exit Code 62)

| ID | Level | Requirement |
|----|-------|-------------|
| SPEC-001 | MUST | Use RFC 2119 keywords (MUST/SHOULD/MAY) |
| SPEC-002 | MUST | Include version number (semver) |
| SPEC-003 | SHOULD | Define scope and authority |
| SPEC-004 | SHOULD | Include conformance criteria |
| SPEC-007 | MUST | Set `agent_type: "specification"` |

#### 4.2.4 Decomposition Protocol (Exit Code 63)

| ID | Level | Requirement |
|----|-------|-------------|
| DCMP-001 | MUST | Follow MECE principle |
| DCMP-002 | MUST | Map dependencies (no cycles) |
| DCMP-003 | MUST | Respect max depth 3 (epic→task→subtask) |
| DCMP-004 | MUST | Verify atomicity for leaf tasks |
| DCMP-005 | MUST NOT | Include time estimates |
| DCMP-006 | MUST | Max 7 siblings per parent |
| DCMP-007 | MUST | Set `agent_type: "specification"` |

#### 4.2.5 Implementation Protocol (Exit Code 64)

| ID | Level | Requirement |
|----|-------|-------------|
| IMPL-003 | MUST | Include @task provenance tags |
| IMPL-004 | SHOULD | Pass all tests |
| IMPL-006 | SHOULD | Follow project code style |
| IMPL-007 | MUST | Set `agent_type: "implementation"` |

#### 4.2.6 Contribution Protocol (Exit Code 65)

| ID | Level | Requirement |
|----|-------|-------------|
| CONT-001 | MUST | Follow commit message conventions |
| CONT-002 | MUST | Include provenance tags (@task/@session) |
| CONT-003 | MUST | Pass validation gates before merge |
| CONT-005 | SHOULD | Flag conflicts with other sessions |
| CONT-007 | MUST | Set `agent_type: "implementation"` |

#### 4.2.7 Release Protocol (Exit Code 66)

| ID | Level | Requirement |
|----|-------|-------------|
| RLSE-001 | MUST | Follow semver (major.minor.patch) |
| RLSE-002 | MUST | Include changelog entry |
| RLSE-003 | SHOULD | Pass all tests |
| RLSE-004 | MUST | Git tag matches version |
| RLSE-007 | MUST | Set `agent_type: "documentation"` |

#### 4.2.8 Validation Protocol (Exit Code 68)

| ID | Level | Requirement |
|----|-------|-------------|
| VALID-001 | MUST | Verify output matches spec |
| VALID-002 | MUST | Execute test suite |
| VALID-003 | MUST | Check protocol compliance |
| VALID-006 | MUST | Set `agent_type: "validation"` |

#### 4.2.9 Testing Protocol (Exit Codes 69/70)

| ID | Level | Requirement |
|----|-------|-------------|
| TEST-001 | MUST | Use configured test framework |
| TEST-004 | MUST | Achieve 100% pass rate |
| TEST-005 | MUST | Cover all MUST requirements |
| TEST-007 | MUST | Set `agent_type: "testing"` |

Exit code 69 = tests skipped/incomplete, 70 = coverage insufficient.

### 4.3 Lifecycle Gate Enforcement

```
research ──GATE──► consensus ──GATE──► specification ──GATE──► decomposition
   ↓                 ↓                     ↓                       ↓
  (1)               (2)                   (3)                     (4)

                              │
                              ▼

implementation ──GATE──► validation ──GATE──► testing ──GATE──► release
     ↓                      ↓                   ↓                  ↓
    (5)                    (6)                 (7)                (8)
```

**Gate Check Behavior**:
- `completed` → proceed to next stage
- `skipped` → proceed (for optional stages)
- `pending` → BLOCKED (exit 75: E_LIFECYCLE_GATE_FAILED)

**Enforcement Modes** (configurable in `.cleo/config.json`):
- `strict`: Block spawn on gate failure (default)
- `advisory`: Warn but proceed
- `off`: Skip all checks (emergency only)

---

## 5. Exit Codes

### 5.1 General Errors (1-9)

| Code | Constant | Description |
|------|----------|-------------|
| 0 | SUCCESS | Operation completed successfully |
| 1 | E_GENERAL | General error |
| 2 | E_INVALID_INPUT | Invalid parameters |
| 3 | E_FILE_ERROR | File read/write error |
| 4 | E_NOT_FOUND | Resource not found |
| 5 | E_DEPENDENCY | Missing dependency |
| 6 | E_VALIDATION | Validation failed |
| 7 | E_RETRYABLE | Transient error, retry with backoff |

### 5.2 Hierarchy Errors (10-19)

| Code | Constant | Description |
|------|----------|-------------|
| 10 | E_PARENT_NOT_FOUND | Parent task does not exist |
| 11 | E_DEPTH_EXCEEDED | Max hierarchy depth (3) exceeded |
| 12 | E_SIBLING_LIMIT | Max siblings (7) exceeded |
| 13 | E_CIRCULAR_DEP | Circular dependency detected |

### 5.3 Session Errors (30-39)

| Code | Constant | Description |
|------|----------|-------------|
| 38 | E_FOCUS_REQUIRED | Focus must be set |
| 100 | E_SESSION_DISCOVERY | Session scope discovery mode |

### 5.4 Gate Errors (40-49)

| Code | Constant | Description |
|------|----------|-------------|
| 40 | E_GATE_UPDATE_FAILED | Cannot update gate status |
| 41 | E_VERIFICATION_LOCKED | Gate state locked |
| 42 | E_INVALID_GATE | Unknown gate name |
| 43 | E_INVALID_AGENT | Invalid agent ID |

### 5.5 Context Errors (50-59)

| Code | Constant | Description |
|------|----------|-------------|
| 50 | E_CONTEXT_CRITICAL | Context budget critical |
| 51 | E_CONTEXT_HIGH | Context budget high |
| 52 | E_CONTEXT_MEDIUM | Context budget medium |

### 5.6 Protocol Violations (60-70)

| Code | Constant | Protocol |
|------|----------|----------|
| 60 | E_PROTOCOL_RESEARCH | Research violations |
| 61 | E_PROTOCOL_CONSENSUS | Consensus violations |
| 62 | E_PROTOCOL_SPECIFICATION | Specification violations |
| 63 | E_PROTOCOL_DECOMPOSITION | Decomposition violations |
| 64 | E_PROTOCOL_IMPLEMENTATION | Implementation violations |
| 65 | E_PROTOCOL_CONTRIBUTION | Contribution violations |
| 66 | E_PROTOCOL_RELEASE | Release violations |
| 67 | E_PROTOCOL_GENERIC | Generic protocol violation |
| 68 | E_PROTOCOL_VALIDATION | Validation violations |
| 69 | E_TESTS_SKIPPED | Tests not run/incomplete |
| 70 | E_COVERAGE_INSUFFICIENT | Coverage below threshold |

### 5.7 Lifecycle Errors (75-79)

| Code | Constant | Description |
|------|----------|-------------|
| 75 | E_LIFECYCLE_GATE_FAILED | Prerequisites not met |
| 76 | E_AUDIT_MISSING | Required audit missing |
| 77 | E_CIRCULAR_VALIDATION | Circular dependency in validation |
| 78 | E_LIFECYCLE_TRANSITION_INVALID | Invalid state transition |
| 79 | E_PROVENANCE_REQUIRED | Provenance tags missing |

### 5.8 Special Codes (100+)

| Code | Constant | Description |
|------|----------|-------------|
| 100 | E_SESSION_DISCOVERY | Not an error - discovery mode |
| 101 | E_DUPLICATE_ID | Duplicate ID found |

---

## 6. Manifest System

### 6.1 MANIFEST.jsonl Structure

**Location**: Configurable, default `claudedocs/agent-outputs/MANIFEST.jsonl`

**Format**: JSON Lines (one JSON object per line, append-only)

#### 6.1.1 Required Fields

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Unique entry ID (format: `T####-slug`) |
| `file` | string | Relative path to output file |
| `title` | string | Human-readable title |
| `date` | string | ISO 8601 date (YYYY-MM-DD) |
| `status` | enum | `complete`, `partial`, `blocked` |
| `agent_type` | string | Protocol type used |
| `topics` | array | Category tags (3-7 items) |
| `key_findings` | array | Key outcomes (3-7 items for research) |
| `actionable` | boolean | Whether findings are actionable |

#### 6.1.2 Optional Fields

| Field | Type | Description |
|-------|------|-------------|
| `needs_followup` | array | Task IDs requiring follow-up |
| `linked_tasks` | array | Related task IDs |
| `confidence` | number | Confidence score (0.0-1.0) |
| `file_checksum` | string | SHA256 of output file |
| `duration_seconds` | integer | Wall-clock completion time |

#### 6.1.3 Example Entry

```json
{"id":"T2405-token-resolution","file":"lib/token-inject.sh","title":"Enhanced Token Pre-Resolution","date":"2026-01-26","status":"complete","agent_type":"implementation","topics":["token","injection","orchestrator"],"key_findings":["Added 30+ new tokens","Implemented ti_set_full_context()"],"actionable":true,"needs_followup":[],"linked_tasks":["T2392","T2405"]}
```

### 6.2 Output File Structure

All agent output files MUST include:

```markdown
# <Title>

**Task**: T####
**Epic**: T#### (if applicable)
**Date**: YYYY-MM-DD
**Status**: complete | partial | blocked
**Agent Type**: <protocol_type>

---

## Summary

<2-3 sentence executive summary>

## Content

<main deliverable>

## References

<citations and links>
```

---

## 7. Verification Gates

### 7.1 Gate Sequence

```
implemented ──► testsPassed ──► qaPassed ──► cleanupDone ──► securityPassed ──► documented
```

### 7.2 Gate Definitions

| Gate | Agent | Depends On | Description |
|------|-------|------------|-------------|
| `implemented` | coder | (none) | Code implementation complete |
| `testsPassed` | testing | implemented | All tests passing |
| `qaPassed` | qa | testsPassed | QA review approved |
| `cleanupDone` | cleanup | qaPassed | Code cleanup finished |
| `securityPassed` | security | cleanupDone | Security audit passed |
| `documented` | docs | securityPassed | Documentation complete |

### 7.3 Gate Status Values

- `null` - Not yet attempted
- `passed` - Gate passed successfully
- `failed` - Gate failed (blocks downstream)
- `blocked` - Cannot attempt (dependencies not met)

### 7.4 Failure Behavior

When a gate fails, all downstream gates reset to `null` and must be re-attempted after the failure is resolved.

---

## 8. Validation Rules

### 8.1 Task Anti-Hallucination

| Rule | Check | Severity |
|------|-------|----------|
| ID Uniqueness | Unique across todo.json AND archive | Error |
| Title/Description | Both present AND different content | Error |
| Status Enum | Must be valid status value | Error |
| No Future Timestamps | created/updated <= now | Error |
| No Duplicate Descriptions | Description not already in system | Error |
| Title Length | 5-100 characters | Error |
| Description Length | 10-1000 characters | Warning |
| Parent Exists | If parent specified, must exist | Error |
| Hierarchy Depth | Max 3 levels | Error |
| Sibling Limit | Max 7 per parent | Error |

### 8.2 Manifest Validation

| Rule | Check | Severity |
|------|-------|----------|
| Valid JSON | Single-line, properly escaped | Error |
| ID Format | Matches `^T\d{3,}-[a-z0-9-]+$` | Error |
| Date Format | ISO 8601 YYYY-MM-DD | Error |
| Status Enum | One of allowed values | Error |
| File Exists | Referenced file readable | Error |
| Key Findings Count | 3-7 items (for research) | Error |
| Agent Type Valid | Known protocol type | Error |

### 8.3 Protocol Validation

Each protocol has specific validation rules (see Section 4.2). Violations result in exit codes 60-70.

---

## 9. Error Recovery

### 9.1 Retryable Errors

Exit codes 7, 20, 21, 22, 60-63 support retry with exponential backoff:

```javascript
async function retryOperation(operation, maxAttempts = 3) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await operation();
    } catch (error) {
      if (!isRetryable(error.exitCode) || attempt === maxAttempts) {
        throw error;
      }
      await sleep(Math.pow(2, attempt) * 1000);
    }
  }
}
```

### 9.2 Non-Recoverable Errors

Exit codes 75, 78, 79 require human intervention:
- Lifecycle gates cannot be bypassed
- Invalid transitions must be reversed
- Provenance requirements cannot be waived

### 9.3 Error Response Pattern

All errors include actionable fix suggestions:

```json
{
  "error": {
    "code": "E_SIBLING_LIMIT",
    "exitCode": 12,
    "message": "Cannot add task: parent T001 already has 7 children",
    "fix": "Create a new parent task to group related work",
    "alternatives": [
      { "action": "List siblings", "command": "cleo list --parent T001" },
      { "action": "Create new epic", "command": "cleo add \"New Epic\" --type epic" }
    ]
  }
}
```

---

## 10. Implementation Notes

### 10.1 Transport

The MCP server supports:
- **stdio**: Primary transport for local Claude Code integration
- **StreamableHTTP**: For remote/shared access (future)

### 10.2 CLI Wrapper Architecture

The MCP server is a thin wrapper around existing CLI commands:

```
MCP Request → Domain Router → CLI Command → Bash Library → Response Formatter → MCP Response
```

This ensures:
- Single source of truth for business logic
- CLI tests cover MCP behavior
- Backward compatibility maintained

### 10.3 Atomic Operations

All write operations MUST use the atomic pattern:
1. Write to temporary file
2. Validate content
3. Create backup of original
4. Atomic rename to final path
5. Append to audit log

### 10.4 Implementation Parity Extensions

Implementation includes documented parity extensions beyond the original core matrix, introduced to align MCP behavior with deployed CLI capabilities (including T4269 updates).

Extensions are maintained in gateway registries and MUST be treated as live source of truth:

- `mcp-server/src/gateways/query.ts`
- `mcp-server/src/gateways/mutate.ts`

These include, among others, relationship operations and extended system/observability operations.

Current expected implementation totals:

- Query: 56
- Mutate: 51
- Total: 107

### 10.5 Thread Safety

Concurrent operations are protected via flock on critical files:
- `.cleo/todo.json.lock`
- `.cleo/MANIFEST.jsonl.lock`

### 10.6 CLI-MCP Parity Documentation Policy

Parity findings MUST be documented in canonical specifications, not in ad hoc working notes under `mcp-server/docs/`.

Required policy:

1. Intentional differences MUST be listed in this specification with rationale.
2. Accidental differences MUST be tracked as tasks and resolved or explicitly waived.
3. Working analysis documents MAY exist during implementation but MUST be consolidated into canonical docs before merge/release.

### 10.7 Known Parity Gaps (Canonical Tracking)

The following known gaps were identified during MCP parity review and MUST be tracked against implementation tasks:

1. Title length validation mismatch (MCP input layer vs CLI enforcement).
2. Task ID format mismatch risk (`T1`/`T12` acceptance vs CLI 3+ digits pattern).
3. Status enum coverage mismatch (ensure `cancelled` handling parity where applicable).
4. Content-length limit mismatch between MCP pre-validation and CLI field-specific limits.
5. Zero-width/invisible character handling mismatch between MCP sanitization and CLI validation.

These are implementation-alignment concerns. Canonical behavior remains CLI-semantic parity with explicit MCP pre-validation and safety layering.

---

## 11. Usage Examples

### 11.1 Task Workflow

```javascript
// 1. Find task
const result = await cleo_query({
  domain: "tasks",
  operation: "find",
  params: { query: "authentication" }
});

// 2. Get task details
const task = await cleo_query({
  domain: "tasks",
  operation: "get",
  params: { taskId: "T2405" }
});

// 3. Set focus
await cleo_mutate({
  domain: "session",
  operation: "focus.set",
  params: { taskId: "T2405" }
});

// 4. Complete task
await cleo_mutate({
  domain: "tasks",
  operation: "complete",
  params: { taskId: "T2405", notes: "Implemented successfully" }
});
```

### 11.2 Orchestrator Workflow

```javascript
// 1. Initialize orchestration
const startup = await cleo_mutate({
  domain: "orchestrate",
  operation: "startup",
  params: { epicId: "T2400" }
});

// 2. Check lifecycle prerequisites
const lifecycle = await cleo_query({
  domain: "lifecycle",
  operation: "check",
  params: { taskId: "T2405", targetStage: "implementation" }
});

// 3. Generate spawn prompt
const spawn = await cleo_mutate({
  domain: "orchestrate",
  operation: "spawn",
  params: { taskId: "T2405", skill: "ct-task-executor" }
});

// 4. Validate protocol compliance after completion
const validation = await cleo_query({
  domain: "validate",
  operation: "protocol",
  params: { taskId: "T2405", protocolType: "implementation" }
});
```

### 11.3 Release Workflow

```javascript
// 1. Run release gates
const gates = await cleo_mutate({
  domain: "release",
  operation: "gates.run",
  params: { gates: ["tests", "lint", "security"] }
});

// 2. Prepare release
await cleo_mutate({
  domain: "release",
  operation: "prepare",
  params: { version: "1.2.0", type: "minor" }
});

// 3. Generate changelog
await cleo_mutate({
  domain: "release",
  operation: "changelog",
  params: { version: "1.2.0" }
});

// 4. Create commit and tag
await cleo_mutate({
  domain: "release",
  operation: "commit",
  params: { version: "1.2.0" }
});

await cleo_mutate({
  domain: "release",
  operation: "tag",
  params: { version: "1.2.0" }
});

// 5. Push
await cleo_mutate({
  domain: "release",
  operation: "push",
  params: { version: "1.2.0" }
});
```

---

## 12. Configuration

### 12.1 MCP Server Config

In `.cleo/config.json`:

```json
{
  "mcp": {
    "enabled": true,
    "transport": "stdio",
    "version": "1.0.0",
    "features": {
      "queryCache": true,
      "queryCacheTtl": 30000,
      "auditLog": true,
      "strictValidation": true
    }
  }
}
```

### 12.2 Lifecycle Enforcement

```json
{
  "lifecycleEnforcement": {
    "mode": "strict",
    "allowSkip": ["consensus"],
    "emergencyBypass": false
  }
}
```

### 12.3 Protocol Validation

```json
{
  "protocolValidation": {
    "strictMode": true,
    "blockOnViolation": true,
    "logViolations": true
  }
}
```

---

## 13. Security Considerations

### 13.1 Input Validation

All inputs MUST be validated:
- Task IDs: Pattern `^T[0-9]+$`
- Paths: No traversal (`..`), within project root
- Content: Size limits, no control characters
- Enums: Strict value checking

### 13.2 Permission Model

The two-gateway design enables permission separation:
- **Read-only access**: Grant `cleo_query` only
- **Full access**: Grant both gateways
- **Audit trail**: All mutations logged

### 13.3 Rate Limiting

Recommended limits:
- Query operations: 100/minute
- Mutate operations: 30/minute
- Spawn operations: 10/minute

---

## 14. Appendices

### Appendix A: Domain Operation Quick Reference

#### cleo_query Domains

| Domain | Operations |
|--------|------------|
| tasks | get, list, find, exists, tree, blockers, deps, analyze, next |
| session | status, list, show, focus.get, history |
| orchestrate | status, next, ready, analyze, context, waves, skill.list |
| research | show, list, query, pending, stats, manifest.read |
| lifecycle | check, status, history, gates, prerequisites |
| validate | schema, protocol, task, manifest, output, compliance.summary, compliance.violations, test.status, test.coverage |
| system | version, doctor, config.get, stats, context |

#### cleo_mutate Domains

| Domain | Operations |
|--------|------------|
| tasks | create, update, complete, delete, archive, unarchive, reparent, promote, reorder, reopen |
| session | start, end, resume, suspend, focus.set, focus.clear, gc |
| orchestrate | startup, spawn, validate, parallel.start, parallel.end |
| research | inject, link, manifest.append, manifest.archive |
| lifecycle | progress, skip, reset, gate.pass, gate.fail |
| validate | compliance.record, test.run |
| release | prepare, changelog, commit, tag, push, gates.run, rollback |
| system | init, config.set, backup, restore, migrate, sync, cleanup |

### Appendix B: Exit Code Summary

| Range | Category | Retryable |
|-------|----------|-----------|
| 0 | Success | N/A |
| 1-9 | General errors | Some (7) |
| 10-19 | Hierarchy errors | No |
| 30-39 | Session errors | No |
| 40-49 | Gate errors | No |
| 50-59 | Context errors | Yes |
| 60-70 | Protocol violations | Some (60-63) |
| 75-79 | Lifecycle errors | No |
| 100+ | Special (not errors) | N/A |

### Appendix C: Token Budget

| Approach | Tools | Tokens | % of 200K |
|----------|-------|--------|-----------|
| Flat CLI (65 commands) | 65 | ~32,500 | 16.3% |
| 8 Gateways | 8 | ~4,000 | 2.0% |
| **2 Gateways (this spec)** | **2** | **~1,800** | **0.9%** |

---

## 15. References

- [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)
- [MCP Specification](https://modelcontextprotocol.io/specification)
- [CLEO CLAUDE.md](../CLAUDE.md)
- [RCSD Pipeline Spec](./RCSD-PIPELINE-SPEC.md)
- [Project Lifecycle Spec](./PROJECT-LIFECYCLE-SPEC.md)
- [Protocol Enforcement Guide](../guides/protocol-enforcement.md)
- [MCP-CLI Parity Matrix](./MCP-CLI-PARITY-MATRIX.md)

---

## 16. Changelog

### v1.0.1 (2026-02-10)

- Corrected operation counts in architecture diagram: 46 query + 47 mutate -> 48 + 48
- Updated section headers 2.1.2 and 2.2.2 to reflect implementation totals (93 spec + 3 background job ops = 96)
- Aligned changelog summary with actual implementation counts

### v1.0.0 (2026-01-31)

- Initial specification
- Two-gateway CQRS design (cleo_query + cleo_mutate)
- Full RCSD-IVTR protocol coverage
- 93 operations across 8 domains (46 query + 47 mutate)
- Complete exit code mapping
- Manifest and verification gate systems
