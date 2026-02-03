# CLEO MCP Gateway Specification

**Version**: 1.0.0
**Status**: DRAFT
**Date**: 2026-01-31

## Overview

This specification defines a complete set of MCP (Model Context Protocol) gateways that expose CLEO's capabilities through a unified interface. The gateways are designed for LLM agents to interact with CLEO without requiring direct CLI invocation.

### Design Principles

1. **Domain Cohesion**: Each gateway groups related operations
2. **Consistent Response Format**: All gateways return structured JSON with `_meta`, `success`, `data`/`error`
3. **Protocol Enforcement**: Gateways enforce RCSD-IVTR lifecycle where applicable
4. **Exit Code Mapping**: CLI exit codes map to structured error responses

### Architecture Alignment

```
MCP Gateways
    │
    ├── cleo_tasks      ─────► Task CRUD (66 scripts)
    ├── cleo_session    ─────► Session + Focus Management
    ├── cleo_orchestrate ────► Multi-Agent Coordination
    ├── cleo_research   ─────► Research Protocol + Manifest
    ├── cleo_lifecycle  ─────► RCSD-IVTR Gate Management
    ├── cleo_validate   ─────► Protocol Validation + Compliance
    ├── cleo_release    ─────► Release Workflow
    └── cleo_system     ─────► Config, Backup, Health
```

---

## Gateway 1: cleo_tasks

**Purpose**: Task CRUD operations and hierarchy management

### Operations

| Operation | Parameters | Returns | CLI Mapping |
|-----------|------------|---------|-------------|
| `create` | `title`, `description?`, `parent?`, `depends?[]`, `labels?[]`, `priority?` | Task JSON | `cleo add` |
| `read` | `id` | Task JSON with full details | `cleo show` |
| `update` | `id`, `title?`, `description?`, `status?`, `priority?`, `notes?`, `labels?[]` | Updated task | `cleo update` |
| `complete` | `id`, `notes?` | Completion confirmation | `cleo complete` |
| `delete` | `id`, `strategy?` (orphan\|cascade\|reparent) | Deletion confirmation | `cleo delete` |
| `reopen` | `id` | Reopened task | `cleo reopen` |
| `reparent` | `id`, `newParent` | Updated task | `cleo reparent` |
| `promote` | `id`, `toType` (task\|epic) | Promoted task | `cleo promote` |
| `list` | `parent?`, `status?`, `labels?[]`, `limit?` | Task array | `cleo list` |
| `find` | `query`, `id?`, `fuzzy?` | Matching tasks | `cleo find` |
| `exists` | `id` | Boolean | `cleo exists` |
| `deps` | `id`, `direction?` (up\|down\|both) | Dependency graph | `cleo deps` |
| `blockers` | `id?` | Blocked tasks with reasons | `cleo blockers` |
| `next` | `epic?`, `criteria?` | Suggested next task | `cleo next` |
| `archive` | `days?`, `limit?`, `dryRun?` | Archived task IDs | `cleo archive` |
| `unarchive` | `id` | Restored task | `cleo unarchive` |

### Parameter Schemas

```typescript
interface CreateTaskParams {
  title: string;                    // Required, 3-200 chars
  description?: string;             // Optional, max 2000 chars
  parent?: string;                  // Task ID (T####)
  depends?: string[];               // Task IDs for dependencies
  labels?: string[];                // Taxonomy labels
  priority?: 'low' | 'medium' | 'high' | 'critical';
  type?: 'task' | 'epic' | 'subtask'; // Inferred from parent
}

interface UpdateTaskParams {
  id: string;                       // Required
  title?: string;
  description?: string;
  status?: 'pending' | 'active' | 'blocked' | 'done' | 'cancelled';
  priority?: 'low' | 'medium' | 'high' | 'critical';
  notes?: string;                   // Append to notes array
  labels?: string[];                // Replace labels
}
```

### Response Format

```json
{
  "_meta": {
    "gateway": "cleo_tasks",
    "operation": "create",
    "version": "1.0.0"
  },
  "success": true,
  "data": {
    "task": {
      "id": "T2901",
      "title": "Implement MCP gateway",
      "type": "task",
      "status": "pending",
      "parentId": "T2900",
      "created": "2026-01-31T10:00:00Z"
    }
  }
}
```

### Error Mapping

| Exit Code | Error Code | Description |
|-----------|------------|-------------|
| 4 | `E_NOT_FOUND` | Task ID not found |
| 10 | `E_PARENT_NOT_FOUND` | Parent task does not exist |
| 11 | `E_DEPTH_EXCEEDED` | Max depth 3 exceeded |
| 12 | `E_SIBLING_LIMIT` | Max 7 siblings exceeded |
| 14 | `E_CIRCULAR_REFERENCE` | Circular dependency detected |

---

## Gateway 2: cleo_session

**Purpose**: Session lifecycle and focus management for multi-agent coordination

### Operations

| Operation | Parameters | Returns | CLI Mapping |
|-----------|------------|---------|-------------|
| `start` | `scope` (epic:T###), `name?`, `autoFocus?`, `focus?` | Session object | `cleo session start` |
| `end` | `sessionId?`, `note?` | Ended session | `cleo session end` |
| `resume` | `sessionId` | Resumed session | `cleo session resume` |
| `suspend` | `sessionId?` | Suspended session | `cleo session suspend` |
| `list` | `status?`, `scope?` | Session array | `cleo session list` |
| `status` | `sessionId?` | Current session status | `cleo session status` |
| `focus_set` | `taskId` | Focus confirmation | `cleo focus set` |
| `focus_show` | - | Current focus | `cleo focus show` |
| `focus_clear` | - | Cleared confirmation | `cleo focus clear` |
| `claim` | `taskId` | Claimed task | `cleo focus set` (with claim) |
| `release` | `taskId` | Released task | Focus clear for task |
| `conflicts` | `scope?` | Scope conflicts | Conflict detection |

### Parameter Schemas

```typescript
interface StartSessionParams {
  scope: string;                    // Required: "epic:T####" format
  name?: string;                    // Optional session name
  autoFocus?: boolean;              // Auto-focus first pending task
  focus?: string;                   // Specific task to focus
}

interface EndSessionParams {
  sessionId?: string;               // Defaults to current
  note?: string;                    // Session completion note
}
```

### Session States

```
active → suspended → active (resume)
   │          │
   └──────────┴──────► ended → archived
```

### Error Mapping

| Exit Code | Error Code | Description |
|-----------|------------|-------------|
| 30 | `E_SESSION_EXISTS` | Session already active for scope |
| 31 | `E_SESSION_NOT_FOUND` | Session ID not found |
| 32 | `E_SCOPE_CONFLICT` | Overlapping scope with other session |
| 33 | `E_SCOPE_INVALID` | Invalid scope specification |
| 34 | `E_TASK_NOT_IN_SCOPE` | Task outside session scope |
| 35 | `E_TASK_CLAIMED` | Task claimed by another session |
| 38 | `E_FOCUS_REQUIRED` | Operation requires focused task |

---

## Gateway 3: cleo_orchestrate

**Purpose**: Multi-agent coordination and subagent spawning

### Operations

| Operation | Parameters | Returns | CLI Mapping |
|-----------|------------|---------|-------------|
| `start` | `epicId` | Orchestrator startup state | `cleo orchestrator start` |
| `status` | - | Pending agents/tasks | `cleo orchestrator status` |
| `next` | `epicId` | Next task to spawn | `cleo orchestrator next` |
| `ready` | `epicId` | All parallel-safe tasks | `cleo orchestrator ready` |
| `spawn` | `taskId`, `skill?`, `model?` | Spawn prompt JSON | `cleo orchestrator spawn` |
| `analyze` | `epicId` | Dependency analysis | `cleo orchestrator analyze` |
| `parallel` | `epicId` | Execution waves | `cleo orchestrator parallel` |
| `check` | `taskIds[]` | Parallel safety check | `cleo orchestrator check` |
| `validate` | `target?` (subagent\|manifest\|orchestrator) | Validation result | `cleo orchestrator validate` |
| `context` | `tokens?` | Context usage | `cleo orchestrator context` |
| `skill_dispatch` | `taskId` | Selected skill for task | `skill_auto_dispatch()` |
| `skill_prepare` | `skill`, `taskId` | Resolved spawn context | `skill_prepare_spawn()` |

### Parameter Schemas

```typescript
interface SpawnParams {
  taskId: string;                   // Required: Task to spawn for
  skill?: string;                   // Override skill selection
  model?: 'opus' | 'sonnet';        // Target model
}

interface SpawnResult {
  prompt: string;                   // Fully-resolved prompt for cleo-subagent
  skill: string;                    // Selected skill/protocol
  tokenEstimate: number;            // Estimated token usage
  tokenResolution: {
    fullyResolved: boolean;         // All @/{{}} tokens resolved
    unresolvedTokens: string[];     // Any unresolved tokens
  };
}
```

### Skill Dispatch Matrix

| Task Type | Skill Protocol | Protocol Type |
|-----------|----------------|---------------|
| research | ct-research-agent | research |
| planning | ct-epic-architect | decomposition |
| implementation | ct-task-executor | implementation |
| testing | ct-test-writer-bats | implementation |
| documentation | ct-documentor | implementation |
| specification | ct-spec-writer | specification |
| validation | ct-validator | consensus |
| release | ct-dev-workflow | release |

### Universal Subagent Architecture

All spawns use single agent type: `cleo-subagent`
Skills are protocol identifiers injected as context, NOT separate agent types.

```typescript
interface SubagentSpawn {
  subagentType: 'cleo-subagent';    // Always this value
  skill: string;                    // Protocol identifier
  prompt: string;                   // Resolved protocol + task context
  constraints: {
    maxContextTokens: number;
    requiresSession: boolean;
    requiresEpic: boolean;
  };
}
```

---

## Gateway 4: cleo_research

**Purpose**: Research protocol and manifest operations

### Operations

| Operation | Parameters | Returns | CLI Mapping |
|-----------|------------|---------|-------------|
| `query` | `query`, `depth?`, `includeReddit?` | Research plan/results | `cleo research "query"` |
| `url` | `urls[]` | Extracted content | `cleo research --url` |
| `library` | `name`, `topic` | Library docs | `cleo research --library` |
| `execute` | `planId?` | Execution results | `cleo research --execute` |
| `manifest_list` | `status?`, `topic?`, `since?`, `limit?` | Manifest entries | `cleo research list` |
| `manifest_show` | `id`, `full?` | Single entry | `cleo research show` |
| `manifest_append` | `entry` (JSON) | Appended entry | `append_manifest()` |
| `manifest_archive` | `threshold?`, `dryRun?` | Archived entries | `cleo research archive` |
| `manifest_validate` | `fix?` | Validation result | `cleo research validate` |
| `link` | `taskId`, `researchId`, `notes?` | Link confirmation | `cleo research link` |
| `unlink` | `taskId`, `researchId` | Unlink confirmation | `cleo research link --unlink` |
| `links` | `taskId` | Research linked to task | `cleo research links` |
| `pending` | `brief?` | Actionable pending items | `cleo research pending` |

### Manifest Entry Schema

```typescript
interface ManifestEntry {
  id: string;                       // Unique: {topic-slug}-{date}
  file: string;                     // Output filename
  title: string;                    // Human-readable title
  date: string;                     // ISO date YYYY-MM-DD
  status: 'complete' | 'partial' | 'blocked' | 'archived';
  agent_type: 'research' | 'implementation' | 'validation' | 'documentation' | 'analysis';
  topics: string[];                 // Categorization tags
  key_findings: string[];           // 3-7 one-sentence findings
  actionable: boolean;              // Requires action
  needs_followup: string[];         // Task IDs needing attention
  linked_tasks: string[];           // Associated task IDs
  sources?: string[];               // Optional: citation sources
  audit?: {                         // Optional: provenance tracking
    createdBy: string;
    createdAt: string;
    modifiedBy?: string;
    modifiedAt?: string;
  };
}
```

### Research Protocol Compliance (RSCH-*)

| Rule | Enforcement |
|------|-------------|
| RSCH-001 | MUST NOT modify code files |
| RSCH-002 | SHOULD document sources |
| RSCH-004 | MUST append to MANIFEST.jsonl |
| RSCH-006 | MUST include 3-7 key findings |
| RSCH-007 | MUST set agent_type: research |

---

## Gateway 5: cleo_lifecycle

**Purpose**: RCSD-IVTR lifecycle gate management

### Lifecycle States (Ordered)

```
research → consensus → specification → decomposition →
implementation → validation → testing → release
```

### Operations

| Operation | Parameters | Returns | CLI Mapping |
|-----------|------------|---------|-------------|
| `get_state` | `taskId` | Current lifecycle state | `get_lifecycle_state()` |
| `validate_transition` | `taskId`, `fromState`, `toState` | Transition validity | `validate_lifecycle_transition()` |
| `check_gate` | `epicId`, `targetState` | Gate check result | `check_lifecycle_gate()` |
| `get_history` | `epicId` | State progression history | `get_lifecycle_history()` |
| `record_completion` | `epicId`, `stage`, `status` | Updated RCSD manifest | `record_rcsd_stage_completion()` |
| `get_prerequisites` | `targetState` | Required prior states | State dependency lookup |
| `enforce_mode` | `mode?` | Current/set enforcement mode | Config read/write |
| `release_gates` | `epicId` | All validation gates | `enforce_release_gates()` |

### Gate Check Response

```typescript
interface GateCheckResult {
  allowed: boolean;
  currentState: string | null;
  targetState: string;
  missingPrerequisites: string[];
  enforcementMode: 'strict' | 'advisory' | 'off';
  rcsdManifest: string;             // Path to RCSD manifest
  fix?: string;                     // Actionable fix command
}
```

### RCSD Pipeline

```
┌─────────────────── RCSD PIPELINE (setup phase) ───────────────────┐
│  Research → Consensus → Specification → Decomposition             │
└───────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────── IVTR PIPELINE (execution) ─────────────────────┐
│  Implementation → Validation → Testing → Release                  │
└───────────────────────────────────────────────────────────────────┘
```

### Error Mapping

| Exit Code | Error Code | Description |
|-----------|------------|-------------|
| 75 | `E_LIFECYCLE_GATE_FAILED` | Prerequisites not met |
| 76 | `E_AUDIT_MISSING` | Audit trail required |
| 77 | `E_CIRCULAR_VALIDATION` | Circular dependency in validation |
| 78 | `E_LIFECYCLE_TRANSITION_INVALID` | Invalid state transition |
| 79 | `E_PROVENANCE_REQUIRED` | Provenance documentation required |

---

## Gateway 6: cleo_validate

**Purpose**: Protocol validation and compliance checking

### Operations

| Operation | Parameters | Returns | CLI Mapping |
|-----------|------------|---------|-------------|
| `protocol` | `protocol`, `taskId`, `manifestEntry`, `strict?` | Validation result | `validate_*_protocol()` |
| `research` | `taskId`, `manifestEntry`, `strict?` | Research validation | `validate_research_protocol()` |
| `consensus` | `taskId`, `manifestEntry`, `strict?` | Consensus validation | `validate_consensus_protocol()` |
| `specification` | `taskId`, `manifestEntry`, `strict?` | Spec validation | `validate_specification_protocol()` |
| `decomposition` | `taskId`, `manifestEntry`, `strict?` | Decomposition validation | `validate_decomposition_protocol()` |
| `implementation` | `taskId`, `manifestEntry`, `strict?` | Implementation validation | `validate_implementation_protocol()` |
| `contribution` | `taskId`, `manifestEntry`, `strict?` | Contribution validation | `validate_contribution_protocol()` |
| `release` | `taskId`, `manifestEntry`, `strict?` | Release validation | `validate_release_protocol()` |
| `manifest` | `entry?`, `all?` | Manifest entry validation | Manifest validation |
| `compliance` | `taskId?`, `epicId?` | Full compliance check | `cleo compliance` |
| `doctor` | `fix?` | System health check | `cleo doctor` |

### Validation Response

```typescript
interface ValidationResult {
  valid: boolean;
  score: number;                    // 0-100
  protocol: string;
  violations: Array<{
    requirement: string;            // e.g., "RSCH-006"
    severity: 'error' | 'warning';
    message: string;
    fix: string;                    // Actionable fix
  }>;
  compliance: {
    passed: string[];               // Passed requirements
    failed: string[];               // Failed requirements
  };
}
```

### Protocol Exit Codes

| Exit Code | Protocol | Description |
|-----------|----------|-------------|
| 60 | Research | Missing key_findings or code modifications |
| 61 | Consensus | Invalid voting matrix or confidence scores |
| 62 | Specification | Missing RFC 2119 keywords or version |
| 63 | Decomposition | Too many siblings or unclear descriptions |
| 64 | Implementation | Missing @task tags on new functions |
| 65 | Contribution | Missing @task/@contribution tags |
| 66 | Release | Invalid semver or missing changelog |
| 67 | Generic | Unknown protocol or generic violation |

---

## Gateway 7: cleo_release

**Purpose**: Release workflow and version management

### Operations

| Operation | Parameters | Returns | CLI Mapping |
|-----------|------------|---------|-------------|
| `preview` | `type` (patch\|minor\|major), `dryRun?` | Release preview | `release-version.sh --dry-run` |
| `execute` | `type`, `push?`, `skipTests?` | Release result | `release-version.sh` |
| `bump` | `type` | Version bump only | `bump-version.sh` |
| `changelog` | `since?`, `format?` | Generated changelog | `generate-changelog.sh` |
| `gates` | - | Release gate status | `run_release_gates()` |
| `prerequisites` | - | Test/validation status | `validate_release_prerequisites()` |
| `version` | - | Current version info | `cleo version` |
| `tag` | `version`, `message?` | Git tag result | Git operations |
| `artifacts` | `version` | Build artifacts | Artifact generation |
| `provenance` | `version` | SLSA provenance | Provenance attestation |

### Release Type Effects

| Type | Version Change | Example |
|------|----------------|---------|
| patch | x.y.Z → x.y.Z+1 | 0.77.3 → 0.77.4 |
| minor | x.Y.z → x.Y+1.0 | 0.77.3 → 0.78.0 |
| major | X.y.z → X+1.0.0 | 0.77.3 → 1.0.0 |

### Release Pipeline

```
1. Prerequisites Check (tests, validation gates)
2. Version Bump (VERSION, README badge)
3. Changelog Generation (CHANGELOG.md)
4. Commit (chore: Release vX.Y.Z)
5. Tag (vX.Y.Z)
6. Push (origin main + tags)
```

### Error Mapping

| Exit Code | Error Code | Description |
|-----------|------------|-------------|
| 66 | `E_PROTOCOL_RELEASE` | Invalid semver or missing changelog |
| 1 | `E_TESTS_FAILED` | Test suite failed |
| 1 | `E_GATES_FAILED` | Validation gates failed |

---

## Gateway 8: cleo_system

**Purpose**: Configuration, backup, and system health

### Operations

| Operation | Parameters | Returns | CLI Mapping |
|-----------|------------|---------|-------------|
| `config_get` | `key`, `scope?` (project\|global) | Config value | `cleo config get` |
| `config_set` | `key`, `value`, `scope?` | Updated config | `cleo config set` |
| `config_list` | `scope?` | All config values | `cleo config list` |
| `backup_create` | `type` (snapshot\|safety\|archive\|migration), `name?` | Backup metadata | `cleo backup` |
| `backup_list` | `type?`, `limit?` | Backup list | `cleo backup list` |
| `backup_restore` | `id` | Restore result | `cleo restore` |
| `doctor` | `fix?` | Health check results | `cleo doctor` |
| `validate` | - | Installation validation | `cleo --validate` |
| `migrate` | `dryRun?` | Migration result | `cleo migrate` |
| `init` | `detect?`, `updateDocs?` | Initialization result | `cleo init` |
| `upgrade` | `version?` | Upgrade result | `cleo upgrade` |
| `stats` | - | Task statistics | `cleo stats` |
| `dash` | - | Dashboard data | `cleo dash` |
| `context` | - | Context window usage | `cleo context` |
| `log` | `limit?`, `operation?` | Audit log entries | `cleo log` |

### Config Hierarchy

```
CLI flags > Environment vars > Project config > Global config > Defaults
```

### Config Paths

| Scope | Location |
|-------|----------|
| Project | `.cleo/config.json` |
| Global | `~/.cleo/config.json` |

### Backup Types

| Type | Purpose | Retention | Trigger |
|------|---------|-----------|---------|
| snapshot | Point-in-time capture | 10 | Manual |
| safety | Pre-operation rollback | 5 + 7 days | Automatic |
| archive | Long-term preservation | 3 | Pre-archive ops |
| migration | Schema migration safety | Permanent | Pre-migration |

### Error Mapping

| Exit Code | Error Code | Description |
|-----------|------------|-------------|
| 8 | `E_CONFIG_ERROR` | Configuration error |
| 3 | `E_FILE_ERROR` | File system error |
| 6 | `E_VALIDATION_ERROR` | Data validation failed |
| 5 | `E_DEPENDENCY_ERROR` | Missing dependency |

---

## Cross-Gateway Patterns

### Standard Response Envelope

All gateways use consistent response structure:

```json
{
  "_meta": {
    "gateway": "cleo_*",
    "operation": "string",
    "version": "1.0.0",
    "timestamp": "ISO-8601"
  },
  "success": boolean,
  "data": { ... },
  "error": {
    "code": "E_*",
    "message": "Human-readable message",
    "exitCode": number,
    "fix": "Actionable fix command",
    "alternatives": [
      { "action": "description", "command": "ct ..." }
    ]
  }
}
```

### Error Recovery Flow

```
1. Check exit code (0 = success)
2. If error, parse error.code
3. Execute error.fix if provided
4. Or choose from error.alternatives
5. Retry operation
```

### Protocol Enforcement

Gateways that modify task state enforce:

1. **Session Requirements**: Operations requiring active session
2. **Focus Requirements**: Operations requiring focused task
3. **Lifecycle Gates**: RCSD-IVTR progression enforcement
4. **Protocol Validation**: Post-operation compliance checks

### Token Resolution

Orchestration operations resolve tokens before spawn:

| Token Type | Syntax | Resolution |
|------------|--------|------------|
| File reference | `@file.md` | Read and inline |
| Glob pattern | `@dir/*.md` | Glob, read, concat |
| Placeholder | `{{VAR}}` | Substitute value |
| Environment | `${ENV}` | Environment variable |
| Command | `` !`cmd` `` | Execute and inline |

---

## Implementation Notes

### Gateway → CLI Mapping

Each gateway operation maps to one or more CLI commands in `scripts/` and library functions in `lib/`.

### Library Dependencies

| Gateway | Primary Libraries |
|---------|-------------------|
| cleo_tasks | validation.sh, hierarchy.sh, task-mutate.sh |
| cleo_session | sessions.sh, session-enforcement.sh |
| cleo_orchestrate | orchestrator-spawn.sh, skill-dispatch.sh |
| cleo_research | research-manifest.sh |
| cleo_lifecycle | lifecycle.sh |
| cleo_validate | protocol-validation.sh, compliance-check.sh |
| cleo_release | release.sh, changelog.sh |
| cleo_system | config.sh, backup.sh, doctor-checks.sh |

### Exit Code Ranges

| Range | Category |
|-------|----------|
| 0 | Success |
| 1-9 | General errors |
| 10-19 | Hierarchy errors |
| 20-29 | Concurrency errors |
| 30-39 | Session errors |
| 40-49 | Verification errors |
| 50-59 | Context safeguard |
| 60-67 | Protocol violations |
| 75-79 | Lifecycle violations |
| 100+ | Special conditions (not errors) |

---

## Appendix A: Full Operation Index

| Gateway | Operations Count | Primary Use Case |
|---------|------------------|------------------|
| cleo_tasks | 16 | Task CRUD and hierarchy |
| cleo_session | 12 | Multi-agent session management |
| cleo_orchestrate | 12 | Subagent coordination |
| cleo_research | 14 | Research workflow and manifest |
| cleo_lifecycle | 8 | RCSD-IVTR gate enforcement |
| cleo_validate | 12 | Protocol compliance |
| cleo_release | 10 | Release management |
| cleo_system | 14 | System administration |
| **Total** | **98** | |

---

## Appendix B: Protocol Reference

### 7 Conditional Protocols

| Protocol | File | Skills | Exit Code |
|----------|------|--------|-----------|
| research | protocols/research.md | ct-research-agent | 60 |
| consensus | protocols/consensus.md | ct-validator | 61 |
| specification | protocols/specification.md | ct-spec-writer | 62 |
| decomposition | protocols/decomposition.md | ct-epic-architect | 63 |
| implementation | protocols/implementation.md | ct-task-executor | 64 |
| contribution | protocols/contribution.md | ct-task-executor | 65 |
| release | protocols/release.md | ct-dev-workflow | 66 |

---

## Appendix C: Skill Dispatch Reference

From `skills/manifest.json`:

```json
{
  "by_task_type": {
    "research": "ct-research-agent",
    "planning": "ct-epic-architect",
    "implementation": "ct-task-executor",
    "testing": "ct-test-writer-bats",
    "documentation": "ct-documentor",
    "specification": "ct-spec-writer",
    "validation": "ct-validator",
    "bash-library": "ct-library-implementer-bash",
    "release": "ct-dev-workflow"
  }
}
```

---

## Changelog

- **1.0.0** (2026-01-31): Initial specification draft
