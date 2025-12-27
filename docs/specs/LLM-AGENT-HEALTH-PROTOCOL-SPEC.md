# LLM-Agent-First Health Check Protocol Specification

> **Authoritative standard for agent-native health monitoring and recovery**
>
> **Version**: 1.0.0 | **Created**: 2025-12-20
> **Status**: DRAFT - Pending Implementation
> **Supersedes**: Portions of VERSION-GUARD-FINAL-DESIGN.md

---

## RFC 2119 Conformance

| Keyword | Meaning |
|---------|---------|
| **MUST** | Absolute requirement. Non-compliance is a specification violation. |
| **MUST NOT** | Absolute prohibition. |
| **SHOULD** | Recommended but not mandatory. Valid reasons may exist to ignore. |
| **MAY** | Optional. Implementations can choose to include or omit. |

---

## Related Specifications

| Document | Relationship |
|----------|--------------|
| **[LLM-AGENT-FIRST-SPEC.md](LLM-AGENT-FIRST-SPEC.md)** | Parent specification for all LLM-agent-first design |
| **[VERSION-GUARD-FINAL-DESIGN.md](VERSION-GUARD-FINAL-DESIGN.md)** | **SUPERSEDED** for error output format |
| **[VERSION-GUARD-SPEC.md](VERSION-GUARD-SPEC.md)** | Original version guard proposal |

---

## Executive Summary

### Problem Statement

The VERSION-GUARD-FINAL-DESIGN.md contains critical violations of LLM-Agent-First principles:

1. **Warnings suppressed in non-TTY mode** - Agents receive no notification of schema mismatch
2. **Errors output as plain text** - No JSON error envelope for machine parsing
3. **Single exit code (25)** - Cannot differentiate between recovery actions
4. **No comprehensive health check** - Only reactive validation, no proactive monitoring
5. **No multi-agent coordination** - Lock exists but no agent identity or handoff protocol

### Solution Overview

This specification defines:

1. **`ct health` command** - Proactive health monitoring with structured output
2. **Granular exit codes** - Semantic codes enabling agent decision-making
3. **JSON error output** - All errors as structured JSON from day 1
4. **Multi-agent coordination** - Agent identity, ownership, and handoff protocols
5. **Self-healing patterns** - Auto-fix with dry-run and backup guarantees

---

## Part 1: Critical Gaps in VERSION-GUARD-FINAL-DESIGN

### Gap 1: JSON Error Output Deferred to Phase 2

**Current Design (Line 274):**
```
### Phase 2: Integration (v0.25.0)
- [ ] Add JSON error output for non-TTY mode
```

**Problem:** Phase 1 would deploy version checking with plain text errors, violating LLM-Agent-First Principle #3 (Structured Errors).

**Required Change:** JSON error output MUST be in Phase 1.

### Gap 2: Warning Suppression in Non-TTY

**Current Design:**
```bash
if [[ -t 2 ]]; then
    echo "[WARN] Schema outdated. Run: ct migrate run" >&2
fi
```

**Problem:** When an agent pipes output, warnings are silently suppressed. Agent has no way to know schema is outdated.

**Required Change:** Warnings MUST be output as JSON to stderr even in non-TTY mode.

### Gap 3: Single Exit Code Insufficient

**Current Design:** Only `EXIT_MIGRATION_REQUIRED=25`

**Problem:** Agent cannot differentiate between:
- "Run migrate" (schema outdated)
- "Upgrade CLI" (project ahead of CLI)
- "Wait and retry" (migration in progress)
- "Human required" (major version mismatch)

**Required Change:** Granular exit codes 30-39 for schema/version issues.

---

## Part 2: Exit Code Architecture

### Exit Code Ranges

```
0       SUCCESS
1-9     General Errors (existing)
10-19   Hierarchy Errors (existing)
20-29   Concurrency Errors (existing)
30-39   Schema/Version Errors (NEW)
40-49   Coordination Errors (NEW)
50-59   Health Check Errors (NEW)
100+    Special Conditions (existing)
```

### Complete Exit Code Table

```bash
# lib/exit-codes.sh - Additions

# === Schema/Version (30-39) ===
readonly EXIT_SCHEMA_OUTDATED=30        # Minor mismatch, migration available
readonly EXIT_SCHEMA_INCOMPATIBLE=31    # Major mismatch, cannot proceed
readonly EXIT_SCHEMA_AHEAD=32           # Project newer than CLI
readonly EXIT_SCHEMA_CORRUPT=33         # Cannot parse version
readonly EXIT_SCHEMA_UNKNOWN=34         # Unknown schema type
readonly EXIT_MIGRATION_IN_PROGRESS=35  # Migration lock held
readonly EXIT_MIGRATION_FAILED=36       # Migration started but failed
readonly EXIT_MIGRATION_ROLLBACK=37     # Requires manual rollback

# === Coordination (40-49) ===
readonly EXIT_LOCK_HELD=40              # Lock held by another agent
readonly EXIT_SESSION_OWNED=41          # Session owned by another agent
readonly EXIT_TASK_CLAIMED=42           # Task being worked on by another
readonly EXIT_HANDOFF_PENDING=43        # Handoff in progress
readonly EXIT_AGENT_CONFLICT=44         # Conflicting operations detected
readonly EXIT_QUEUE_FULL=45             # Too many agents waiting

# === Health (50-59) ===
readonly EXIT_HEALTH_ERROR=50           # Health check found errors
readonly EXIT_HEALTH_WARNING=51         # Health check found warnings only
readonly EXIT_HEALTH_UNFIXABLE=52       # Issues require human intervention
readonly EXIT_FIX_FAILED=53             # Auto-fix attempted but failed
readonly EXIT_FIX_PARTIAL=54            # Some fixes succeeded, some failed
```

### Exit Code Recoverability Matrix

| Exit Code | Name | Recoverable | Recovery Action |
|-----------|------|-------------|-----------------|
| 30 | SCHEMA_OUTDATED | Yes | `ct migrate run` |
| 31 | SCHEMA_INCOMPATIBLE | No | Human: major migration |
| 32 | SCHEMA_AHEAD | Yes | Upgrade CLI |
| 33 | SCHEMA_CORRUPT | No | Human: fix JSON manually |
| 34 | SCHEMA_UNKNOWN | No | Human: investigate |
| 35 | MIGRATION_IN_PROGRESS | Yes | Wait 1s, retry (max 5) |
| 36 | MIGRATION_FAILED | Yes | `ct restore --latest` |
| 37 | MIGRATION_ROLLBACK | No | Human: manual rollback |
| 40 | LOCK_HELD | Yes | Wait 100ms, retry (max 3) |
| 41 | SESSION_OWNED | No | Human: coordinate agents |
| 42 | TASK_CLAIMED | Yes | Request handoff or wait |
| 43 | HANDOFF_PENDING | Yes | Wait for handoff completion |
| 44 | AGENT_CONFLICT | No | Human: resolve conflict |
| 50 | HEALTH_ERROR | Partial | `ct health --fix` |
| 51 | HEALTH_WARNING | Yes | `ct health --fix` (optional) |
| 52 | HEALTH_UNFIXABLE | No | Human intervention required |
| 53 | FIX_FAILED | Yes | `ct restore`, retry |
| 54 | FIX_PARTIAL | Partial | Review, retry remaining |

### Error Code Mapping

```bash
# lib/error-codes.sh - Additions

# Schema Errors
E_SCHEMA_OUTDATED="E_SCHEMA_OUTDATED"           # Exit 30
E_SCHEMA_INCOMPATIBLE="E_SCHEMA_INCOMPATIBLE"   # Exit 31
E_SCHEMA_AHEAD="E_SCHEMA_AHEAD"                 # Exit 32
E_SCHEMA_CORRUPT="E_SCHEMA_CORRUPT"             # Exit 33
E_MIGRATION_REQUIRED="E_MIGRATION_REQUIRED"     # Exit 30 (alias)
E_MIGRATION_FAILED="E_MIGRATION_FAILED"         # Exit 36

# Coordination Errors
E_LOCK_HELD="E_LOCK_HELD"                       # Exit 40
E_SESSION_CONFLICT="E_SESSION_CONFLICT"         # Exit 41
E_TASK_CLAIMED="E_TASK_CLAIMED"                 # Exit 42
E_AGENT_CONFLICT="E_AGENT_CONFLICT"             # Exit 44

# Health Errors
E_HEALTH_CHECK_FAILED="E_HEALTH_CHECK_FAILED"   # Exit 50
E_AUTO_FIX_FAILED="E_AUTO_FIX_FAILED"           # Exit 53
```

---

## Part 3: Health Check Command

### Command Specification

```bash
ct health [OPTIONS]

Options:
  --quick             Fast check (schema + session only)
  --full              Complete check (all categories)
  --category CATS     Comma-separated categories to check
  --fix               Attempt to auto-fix issues
  --dry-run           Preview fixes without applying
  --format FORMAT     Output format (json|text)
  --quiet             Suppress non-essential output

Categories:
  schema              Schema version compatibility
  data                Task data integrity
  files               File system health
  session             Session state validity
  sync                TodoWrite sync status
  coordination        Multi-agent coordination
```

### Health Check Categories

#### 1. Schema Health (`schema`)

| Check ID | Description | Auto-Fixable |
|----------|-------------|--------------|
| `schema.version.compatibility` | CLI vs project version | Yes (minor) |
| `schema.version.parse` | Version field parseable | No |
| `schema.validation` | JSON Schema validation | Partial |
| `schema.checksum` | Checksum integrity | Yes |

#### 2. Data Health (`data`)

| Check ID | Description | Auto-Fixable |
|----------|-------------|--------------|
| `data.task.id_unique` | No duplicate task IDs | No |
| `data.task.id_format` | All IDs match pattern | No |
| `data.dependency.valid` | All dependencies exist | Yes (remove) |
| `data.dependency.acyclic` | No circular dependencies | Yes (break) |
| `data.status.valid` | All statuses in enum | No |
| `data.timestamp.sane` | No future timestamps | Yes (set now) |
| `data.hierarchy.valid` | Parent/child relationships | Partial |

#### 3. File Health (`files`)

| Check ID | Description | Auto-Fixable |
|----------|-------------|--------------|
| `files.todo.exists` | todo.json exists | No |
| `files.todo.readable` | todo.json readable | No |
| `files.todo.writable` | todo.json writable | No |
| `files.todo.parseable` | Valid JSON | No |
| `files.config.exists` | Config file exists | Yes (create) |
| `files.backup.available` | Recent backup exists | Yes (create) |

#### 4. Session Health (`session`)

| Check ID | Description | Auto-Fixable |
|----------|-------------|--------------|
| `session.active.single` | Max 1 active task | Yes |
| `session.focus.valid` | Focus references valid task | Yes (clear) |
| `session.lock.stale` | No stale locks | Yes (release) |
| `session.state.consistent` | Session state consistent | Yes (end) |

#### 5. Sync Health (`sync`)

| Check ID | Description | Auto-Fixable |
|----------|-------------|--------------|
| `sync.todowrite.state` | Sync state valid | Yes |
| `sync.todowrite.conflicts` | No unresolved conflicts | No |
| `sync.todowrite.timestamp` | Reasonable last sync | No |

#### 6. Coordination Health (`coordination`)

| Check ID | Description | Auto-Fixable |
|----------|-------------|--------------|
| `coordination.lock.valid` | Lock file valid | Yes |
| `coordination.session.owner` | Session ownership clear | No |
| `coordination.agents.conflict` | No agent conflicts | No |

### JSON Output Schema

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "$id": "https://cleo.dev/schemas/v1/health.schema.json",
  "title": "Claude-TODO Health Check Response",
  "type": "object",
  "required": ["_meta", "success", "healthy", "summary", "categories"],
  "properties": {
    "$schema": {"type": "string"},
    "_meta": {
      "type": "object",
      "required": ["command", "timestamp", "version"],
      "properties": {
        "format": {"const": "json"},
        "version": {"type": "string"},
        "command": {"const": "health"},
        "timestamp": {"type": "string", "format": "date-time"},
        "execution_ms": {"type": "integer", "minimum": 0},
        "mode": {"enum": ["quick", "full"]}
      }
    },
    "success": {"type": "boolean"},
    "healthy": {
      "type": "boolean",
      "description": "True if all checks pass with no errors"
    },
    "summary": {
      "type": "object",
      "required": ["total_checks", "passed", "warnings", "errors"],
      "properties": {
        "total_checks": {"type": "integer", "minimum": 0},
        "passed": {"type": "integer", "minimum": 0},
        "warnings": {"type": "integer", "minimum": 0},
        "errors": {"type": "integer", "minimum": 0},
        "auto_fixable": {"type": "integer", "minimum": 0}
      }
    },
    "categories": {
      "type": "object",
      "additionalProperties": {
        "$ref": "#/definitions/category"
      }
    },
    "auto_fixable": {
      "type": "array",
      "items": {"$ref": "#/definitions/fix_action"}
    },
    "next_action": {"$ref": "#/definitions/next_action"}
  },
  "definitions": {
    "category": {
      "type": "object",
      "required": ["status", "checks"],
      "properties": {
        "status": {"enum": ["pass", "warning", "error", "skipped"]},
        "checks": {
          "type": "array",
          "items": {"$ref": "#/definitions/check_result"}
        }
      }
    },
    "check_result": {
      "type": "object",
      "required": ["id", "status", "message"],
      "properties": {
        "id": {
          "type": "string",
          "pattern": "^[a-z]+\\.[a-z_]+\\.[a-z_]+$"
        },
        "status": {"enum": ["pass", "warning", "error"]},
        "message": {"type": "string"},
        "recoverable": {"type": "boolean"},
        "auto_fix": {"type": "boolean"},
        "fix_command": {"type": "string"},
        "suggestion": {"type": "string"},
        "context": {"type": "object"}
      }
    },
    "fix_action": {
      "type": "object",
      "required": ["check_id", "fix_command", "description"],
      "properties": {
        "check_id": {"type": "string"},
        "fix_command": {"type": "string"},
        "description": {"type": "string"},
        "risk_level": {"enum": ["low", "medium", "high", "critical"]},
        "reversible": {"type": "boolean"},
        "backup_required": {"type": "boolean"}
      }
    },
    "next_action": {
      "type": "object",
      "required": ["priority", "action"],
      "properties": {
        "priority": {"enum": ["critical", "high", "medium", "low", "none"]},
        "action": {
          "enum": ["fix_errors", "fix_warnings", "upgrade_cli", "escalate", "proceed"]
        },
        "command": {"type": "string"},
        "reason": {"type": "string"}
      }
    }
  }
}
```

### Example Output

```json
{
  "$schema": "https://cleo.dev/schemas/v1/health.schema.json",
  "_meta": {
    "format": "json",
    "version": "0.24.0",
    "command": "health",
    "timestamp": "2025-12-20T10:00:00Z",
    "execution_ms": 45,
    "mode": "full"
  },
  "success": true,
  "healthy": false,
  "summary": {
    "total_checks": 25,
    "passed": 22,
    "warnings": 2,
    "errors": 1,
    "auto_fixable": 2
  },
  "categories": {
    "schema": {
      "status": "warning",
      "checks": [
        {
          "id": "schema.version.compatibility",
          "status": "warning",
          "message": "Project schema v2.2.0, CLI expects v2.3.0",
          "recoverable": true,
          "auto_fix": true,
          "fix_command": "ct migrate run",
          "context": {
            "project_version": "2.2.0",
            "cli_version": "2.3.0",
            "breaking": false
          }
        }
      ]
    },
    "data": {
      "status": "error",
      "checks": [
        {
          "id": "data.task.id_unique",
          "status": "error",
          "message": "Duplicate task ID: T042",
          "recoverable": false,
          "auto_fix": false,
          "suggestion": "Manually resolve duplicate in .cleo/todo.json",
          "context": {
            "task_id": "T042",
            "occurrences": 2,
            "locations": [".tasks[5]", ".tasks[12]"]
          }
        }
      ]
    },
    "files": {"status": "pass", "checks": []},
    "session": {"status": "pass", "checks": []},
    "sync": {"status": "warning", "checks": []}
  },
  "auto_fixable": [
    {
      "check_id": "schema.version.compatibility",
      "fix_command": "ct migrate run",
      "description": "Migrate project schema to v2.3.0",
      "risk_level": "low",
      "reversible": true,
      "backup_required": true
    }
  ],
  "next_action": {
    "priority": "high",
    "action": "escalate",
    "reason": "1 error requires human intervention (duplicate task ID)"
  }
}
```

---

## Part 4: Agent Recovery Protocol

### Session Lifecycle with Health Checks

```
+------------------------------------------------------------------+
|                    AGENT SESSION LIFECYCLE                        |
+------------------------------------------------------------------+
|                                                                   |
|  1. SESSION START                                                 |
|     +-- ct health --quick                                         |
|     |   +-- Exit 0: Proceed to work                               |
|     |   +-- Exit 50: Run ct health --fix, retry                   |
|     |   +-- Exit 51: Log warnings, proceed                        |
|     |   +-- Exit 52: Escalate to human                            |
|                                                                   |
|  2. PRE-WRITE CHECK (write operations only)                       |
|     +-- ct health --category schema,session --quick               |
|     |   +-- Schema outdated? -> ct migrate run                    |
|     |   +-- Session conflict? -> ct session end && start          |
|                                                                   |
|  3. OPERATION EXECUTION                                           |
|     +-- ct add/update/complete/...                                |
|     |   +-- Success: Continue                                     |
|     |   +-- Failure: Check exit code                              |
|     |       +-- Recoverable: Execute recovery action              |
|     |       +-- Not recoverable: Escalate to human                |
|                                                                   |
|  4. POST-FAILURE RECOVERY                                         |
|     +-- ct health --full                                          |
|     |   +-- Identify root cause                                   |
|     |   +-- ct health --fix --dry-run (preview)                   |
|     |   +-- ct health --fix (if safe)                             |
|     |   +-- Retry original operation                              |
|                                                                   |
|  5. SESSION END                                                   |
|     +-- ct health --quick                                         |
|     |   +-- Log any warnings for next session                     |
|     +-- ct session end                                            |
|                                                                   |
+------------------------------------------------------------------+
```

### Recovery Decision Algorithm

```python
def handle_operation_failure(exit_code: int, error_json: dict) -> Action:
    """
    Agent decision algorithm for operation failures.
    Returns the appropriate recovery action.
    """

    # Schema errors (30-39)
    if 30 <= exit_code <= 39:
        if exit_code == 30:  # Schema outdated
            return Action.RUN("ct migrate run")
        if exit_code == 31:  # Major incompatibility
            return Action.ESCALATE("Major version mismatch - requires human")
        if exit_code == 32:  # CLI outdated
            return Action.ESCALATE("Upgrade CLI: pipx upgrade cleo")
        if exit_code == 35:  # Migration in progress
            return Action.WAIT_RETRY(delay_ms=1000, max_retries=5)
        if exit_code == 36:  # Migration failed
            return Action.RUN("ct restore --latest")
        return Action.ESCALATE(f"Schema error {exit_code}")

    # Coordination errors (40-49)
    if 40 <= exit_code <= 49:
        if exit_code == 40:  # Lock held
            delay = error_json.get("retry_delay_ms", 100)
            return Action.WAIT_RETRY(delay_ms=delay, max_retries=3)
        if exit_code == 42:  # Task claimed
            return Action.RUN("ct task handoff-request")
        return Action.ESCALATE(f"Coordination error {exit_code}")

    # Health errors (50-59)
    if 50 <= exit_code <= 59:
        if exit_code in [50, 51]:  # Fixable
            return Action.RUN("ct health --fix")
        if exit_code == 53:  # Fix failed
            return Action.RUN("ct restore --latest")
        return Action.ESCALATE(f"Health error {exit_code}")

    # Concurrency errors (20-29)
    if 20 <= exit_code <= 29:
        if error_json.get("recoverable"):
            delay = error_json.get("retry_delay_ms", 100)
            return Action.WAIT_RETRY(delay_ms=delay, max_retries=3)
        return Action.ESCALATE("Unrecoverable concurrency error")

    # Hierarchy errors (10-19) - check if auto-fixable
    if 10 <= exit_code <= 19:
        if error_json.get("auto_fix"):
            return Action.RUN(error_json["fix_command"])
        return Action.ESCALATE(f"Hierarchy error: {error_json['message']}")

    # General errors (1-9)
    if error_json.get("recoverable"):
        return Action.RETRY_ONCE()

    return Action.ESCALATE(error_json.get("message", "Unknown error"))


class Action:
    """Recovery action types."""

    @staticmethod
    def RUN(command: str) -> dict:
        return {"type": "run", "command": command}

    @staticmethod
    def WAIT_RETRY(delay_ms: int, max_retries: int) -> dict:
        return {"type": "wait_retry", "delay_ms": delay_ms, "max_retries": max_retries}

    @staticmethod
    def RETRY_ONCE() -> dict:
        return {"type": "retry", "max_retries": 1}

    @staticmethod
    def ESCALATE(reason: str) -> dict:
        return {"type": "escalate", "reason": reason}
```

### Retry Protocol

| Exit Code Range | Initial Delay | Backoff Factor | Max Retries | Max Wait |
|-----------------|---------------|----------------|-------------|----------|
| 20-29 (Concurrency) | 100ms | 2x | 3 | 1.4s |
| 30-39 (Schema) | 1000ms | 1.5x | 5 | 7.6s |
| 40-49 (Coordination) | 100ms | 2x | 5 | 3.1s |
| 50-59 (Health) | 500ms | 1.5x | 3 | 1.6s |

**Maximum Total Wait:** 5 seconds per operation to avoid blocking workflows.

---

## Part 5: Self-Healing Patterns

### Auto-Fix Classification

| Issue Type | Auto-Fixable | Risk Level | Rationale |
|------------|--------------|------------|-----------|
| Schema version outdated (minor) | YES | Low | Non-breaking, additive |
| Schema version outdated (major) | NO | Critical | Potential data loss |
| Checksum mismatch | YES | Low | Checksum is derived |
| Orphan dependencies | YES | Low | Cleans invalid refs |
| Duplicate task IDs | NO | Critical | Requires human choice |
| Circular dependencies | YES | Medium | Auto-picks edge to break |
| Future timestamps | YES | Low | Obvious correction |
| Invalid status enum | NO | High | Unknown intent |
| Missing required fields | PARTIAL | Medium | Can set defaults |
| File permission errors | NO | Critical | System-level |
| Stale lock | YES | Low | Cleanup orphaned state |
| Orphaned session | YES | Low | End orphaned session |

### Risk Level Definitions

| Risk Level | Definition | Auto-Fix Policy |
|------------|------------|-----------------|
| `low` | Fully reversible, no data loss | Auto-fix allowed |
| `medium` | Reversible with backup, minor modification | Auto-fix with backup |
| `high` | Potentially destructive, may lose data | Require `--force` |
| `critical` | Irreversible, significant impact | Human required |

### Dry-Run Semantics

All fix operations MUST support `--dry-run`:

```json
{
  "$schema": "https://cleo.dev/schemas/v1/health-fix.schema.json",
  "_meta": {
    "command": "health --fix --dry-run",
    "timestamp": "2025-12-20T10:00:00Z"
  },
  "dry_run": true,
  "would_fix": [
    {
      "check_id": "schema.version.compatibility",
      "current_state": "v2.2.0",
      "proposed_state": "v2.3.0",
      "operation": "migrate",
      "reversible": true,
      "backup_path": ".cleo/backups/safety/safety_pre-migrate/",
      "risk_level": "low"
    }
  ],
  "would_not_fix": [
    {
      "check_id": "data.task.id_unique",
      "reason": "requires_human_decision",
      "message": "Two tasks have ID T042 - choose which to keep",
      "suggestion": "Manually edit .cleo/todo.json"
    }
  ],
  "summary": {
    "auto_fixable": 1,
    "requires_human": 1,
    "total_issues": 2
  },
  "proceed_command": "ct health --fix"
}
```

### Backup-First Guarantee

Every auto-fix operation MUST:

1. **Create backup** before any modification
2. **Log operation** to audit trail
3. **Verify success** after fix
4. **Provide rollback** command in output

```json
{
  "fix_result": {
    "success": true,
    "fixes_applied": 2,
    "backup_path": ".cleo/backups/safety/safety_1734693600_health_fix/",
    "rollback_command": "ct restore .cleo/backups/safety/safety_1734693600_health_fix/",
    "audit_log_entry": {
      "operation": "health_auto_fix",
      "timestamp": "2025-12-20T10:00:00Z",
      "fixes": ["schema.migrate", "dependency.orphan.remove"],
      "agent_id": "claude-code-main-12345"
    }
  }
}
```

---

## Part 6: Multi-Agent Coordination

### Agent Identity

Every agent operation SHOULD include agent identity:

```json
{
  "agent_identity": {
    "agent_id": "claude-code-main-12345",
    "agent_type": "claude-code",
    "session_id": "sess_abc123",
    "started_at": "2025-12-20T10:00:00Z",
    "pid": 12345
  }
}
```

### Lock File Schema

```json
{
  "path": ".cleo/.lock",
  "content": {
    "holder": {
      "agent_id": "claude-code-main-12345",
      "pid": 12345,
      "started_at": "2025-12-20T10:00:00Z",
      "operation": "update T042",
      "timeout_at": "2025-12-20T10:00:30Z"
    },
    "queue": [
      {
        "agent_id": "subagent-backend-67890",
        "requested_at": "2025-12-20T10:00:05Z",
        "operation": "add task",
        "priority": "normal"
      }
    ]
  }
}
```

### Coordination Commands

```bash
# Check lock status
ct lock status
{
  "locked": true,
  "holder": {
    "agent_id": "claude-code-main-12345",
    "operation": "update T042",
    "held_for_ms": 150,
    "timeout_in_ms": 29850
  },
  "queue_position": null,
  "can_acquire": false,
  "suggestion": "Wait 150ms or use --force"
}

# Check task ownership
ct task owner T042
{
  "task_id": "T042",
  "claimed_by": "claude-code-main-12345",
  "claimed_at": "2025-12-20T10:00:00Z",
  "status": "active",
  "can_claim": false,
  "suggestion": "Request handoff or wait for completion"
}

# Request session handoff
ct session handoff --to "subagent-backend-67890"
{
  "success": true,
  "handoff": {
    "from": "claude-code-main-12345",
    "to": "subagent-backend-67890",
    "tasks_transferred": ["T042"],
    "context": {
      "focus_note": "Working on JWT middleware",
      "files_modified": ["src/middleware/jwt.ts"]
    }
  }
}
```

---

## Part 7: Revised VERSION-GUARD-FINAL-DESIGN

### Required Changes

| Original | Issue | Required Change |
|----------|-------|-----------------|
| Exit code 25 only | Cannot differentiate | Exit codes 30-37 |
| JSON output in Phase 2 | Too late | JSON output in Phase 1 |
| Plain text errors | Not parseable | JSON error envelope |
| Warning suppression in non-TTY | Silent failure | JSON warnings to stderr |

### Revised Fast Version Check

```bash
fast_version_check() {
    # Skip if disabled
    [[ "${CLEO_VERSION_CHECK:-1}" == "0" ]] && return 0

    # Skip for non-write commands
    [[ " $WRITE_COMMANDS " != *" $1 "* ]] && return 0

    # Skip if no project
    [[ ! -f ".cleo/todo.json" ]] && return 0

    # Fast version extraction
    local project_version
    project_version=$(head -n 5 .cleo/todo.json 2>/dev/null | \
                      grep -oP '"version"\s*:\s*"\K[^"]+' | head -1)
    project_version="${project_version:-1.0.0}"

    local expected_major="${SCHEMA_VERSION_TODO%%.*}"
    local project_major="${project_version%%.*}"

    # Determine result
    if [[ "$project_major" -lt "$expected_major" ]]; then
        # Major version behind - BLOCK
        output_schema_error "E_SCHEMA_INCOMPATIBLE" \
            "Major schema version mismatch" \
            "$project_version" "$SCHEMA_VERSION_TODO" \
            false "Run ct migrate run for major upgrade"
        exit $EXIT_SCHEMA_INCOMPATIBLE
    elif [[ "$project_major" -gt "$expected_major" ]]; then
        # Project ahead of CLI - WARN
        output_schema_warning "W_SCHEMA_AHEAD" \
            "Project schema newer than CLI" \
            "$project_version" "$SCHEMA_VERSION_TODO" \
            "Upgrade CLI: pipx upgrade cleo"
        return 0  # Allow but warn
    elif [[ "$project_version" != "$SCHEMA_VERSION_TODO" ]]; then
        # Minor mismatch - WARN
        output_schema_warning "W_SCHEMA_OUTDATED" \
            "Schema version outdated" \
            "$project_version" "$SCHEMA_VERSION_TODO" \
            "Run ct migrate run"
        return 0  # Allow but warn
    fi

    return 0  # Versions match
}

output_schema_error() {
    local code="$1" message="$2" current="$3" expected="$4"
    local recoverable="$5" suggestion="$6"

    jq -n \
        --arg code "$code" \
        --arg msg "$message" \
        --arg cur "$current" \
        --arg exp "$expected" \
        --argjson rec "$recoverable" \
        --arg sug "$suggestion" \
        '{
            "$schema": "https://cleo.dev/schemas/v1/error.schema.json",
            "_meta": {
                "command": "version-check",
                "timestamp": (now | strftime("%Y-%m-%dT%H:%M:%SZ"))
            },
            "success": false,
            "error": {
                "code": $code,
                "message": $msg,
                "exitCode": 31,
                "recoverable": $rec,
                "suggestion": $sug,
                "context": {
                    "project_version": $cur,
                    "expected_version": $exp
                }
            }
        }'
}

output_schema_warning() {
    local code="$1" message="$2" current="$3" expected="$4" suggestion="$5"

    # Output warning to stderr as JSON
    jq -n \
        --arg code "$code" \
        --arg msg "$message" \
        --arg cur "$current" \
        --arg exp "$expected" \
        --arg sug "$suggestion" \
        '{
            "warning": {
                "code": $code,
                "message": $msg,
                "current_version": $cur,
                "expected_version": $exp,
                "suggestion": $sug
            }
        }' >&2
}
```

### Revised Phase Plan

**Phase 1 (v0.24.0) - CRITICAL:**
- [x] Add exit codes 30-37 (schema/version)
- [x] JSON error output for version check (MOVED from Phase 2)
- [x] JSON warning output to stderr
- [x] Basic `ct health --quick` with schema check
- [x] `_meta.lastWriterVersion` tracking

**Phase 2 (v0.25.0) - HIGH:**
- [ ] Full `ct health` command with all categories
- [ ] `ct health --fix` with dry-run and backup
- [ ] Exit codes 50-54 (health)
- [ ] Integrate version check into write scripts

**Phase 3 (v0.26.0) - MEDIUM:**
- [ ] Multi-agent coordination (exit codes 40-45)
- [ ] Lock/session/task ownership commands
- [ ] Conflict detection
- [ ] `ct migrate wizard` for batch migration

---

## Part 8: Testing Requirements

### Exit Code Tests

```bash
@test "exit 30 on minor schema mismatch" {
    setup_project_with_version "2.2.0"
    run ct add "Test task"
    [ "$status" -eq 0 ]  # Allowed with warning
    # Check stderr for warning JSON
    echo "$stderr" | jq -e '.warning.code == "W_SCHEMA_OUTDATED"'
}

@test "exit 31 on major schema mismatch" {
    setup_project_with_version "1.5.0"
    run ct add "Test task"
    [ "$status" -eq 31 ]
    echo "$output" | jq -e '.error.code == "E_SCHEMA_INCOMPATIBLE"'
}

@test "exit 32 on project ahead of CLI" {
    setup_project_with_version "3.0.0"
    run ct add "Test task"
    [ "$status" -eq 0 ]  # Allowed with warning
    echo "$stderr" | jq -e '.warning.code == "W_SCHEMA_AHEAD"'
}
```

### Health Check Tests

```bash
@test "ct health --quick returns JSON" {
    run ct health --quick
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '._meta.command == "health"'
    echo "$output" | jq -e '.healthy == true'
}

@test "ct health detects schema mismatch" {
    setup_project_with_version "2.2.0"
    run ct health --quick
    [ "$status" -eq 51 ]  # Warning
    echo "$output" | jq -e '.categories.schema.status == "warning"'
}

@test "ct health --fix --dry-run previews changes" {
    setup_project_with_version "2.2.0"
    run ct health --fix --dry-run
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.dry_run == true'
    echo "$output" | jq -e '.would_fix | length > 0'
}

@test "ct health --fix creates backup" {
    setup_project_with_version "2.2.0"
    run ct health --fix
    [ "$status" -eq 0 ]
    echo "$output" | jq -e '.backup_path != null'
    [ -f "$(echo "$output" | jq -r '.backup_path')" ]
}
```

---

## Part 9: Implementation Checklist

### Phase 1 Checklist

- [ ] Add exit codes 30-37 to `lib/exit-codes.sh`
- [ ] Add error codes E_SCHEMA_* to `lib/error-codes.sh`
- [ ] Create `output_schema_error()` function
- [ ] Create `output_schema_warning()` function
- [ ] Update `fast_version_check()` for JSON output
- [ ] Create `scripts/health.sh` with `--quick` mode
- [ ] Add schema category checks
- [ ] Add `health.schema.json`
- [ ] Add tests for exit codes 30-37
- [ ] Add tests for health --quick
- [ ] Update VERSION-GUARD-FINAL-DESIGN.md

### Phase 2 Checklist

- [ ] Add exit codes 50-54 to `lib/exit-codes.sh`
- [ ] Add error codes E_HEALTH_* to `lib/error-codes.sh`
- [ ] Implement full health check categories
- [ ] Implement `ct health --fix`
- [ ] Implement `ct health --fix --dry-run`
- [ ] Add `health-fix.schema.json`
- [ ] Integrate version check into write scripts
- [ ] Add backup-first guarantee
- [ ] Add tests for all health checks
- [ ] Add tests for fix operations

### Phase 3 Checklist

- [ ] Add exit codes 40-45 to `lib/exit-codes.sh`
- [ ] Add error codes E_LOCK_*, E_SESSION_*, E_TASK_*
- [ ] Implement agent identity in lock files
- [ ] Implement `ct lock status`
- [ ] Implement `ct task owner`
- [ ] Implement `ct session handoff`
- [ ] Add coordination category to health check
- [ ] Add `coordination.schema.json`
- [ ] Add tests for coordination commands

---

## Appendix A: JSON Schema Files

### health.schema.json

See Part 3 for complete schema.

### health-fix.schema.json

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "$id": "https://cleo.dev/schemas/v1/health-fix.schema.json",
  "title": "Claude-TODO Health Fix Response",
  "type": "object",
  "required": ["_meta", "success"],
  "properties": {
    "$schema": {"type": "string"},
    "_meta": {
      "type": "object",
      "required": ["command", "timestamp", "version"]
    },
    "success": {"type": "boolean"},
    "dry_run": {"type": "boolean", "default": false},
    "would_fix": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["check_id", "operation", "risk_level"],
        "properties": {
          "check_id": {"type": "string"},
          "current_state": {"type": "string"},
          "proposed_state": {"type": "string"},
          "operation": {"type": "string"},
          "reversible": {"type": "boolean"},
          "backup_path": {"type": "string"},
          "risk_level": {"enum": ["low", "medium", "high", "critical"]}
        }
      }
    },
    "would_not_fix": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["check_id", "reason"],
        "properties": {
          "check_id": {"type": "string"},
          "reason": {
            "enum": ["requires_human_decision", "high_risk", "no_auto_fix", "dependency_conflict"]
          },
          "message": {"type": "string"},
          "suggestion": {"type": "string"}
        }
      }
    },
    "fixes_applied": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["check_id", "success"],
        "properties": {
          "check_id": {"type": "string"},
          "success": {"type": "boolean"},
          "operation": {"type": "string"},
          "error": {"type": "string"}
        }
      }
    },
    "backup_path": {"type": "string"},
    "rollback_command": {"type": "string"}
  }
}
```

### coordination.schema.json

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "$id": "https://cleo.dev/schemas/v1/coordination.schema.json",
  "title": "Claude-TODO Multi-Agent Coordination",
  "definitions": {
    "agent_identity": {
      "type": "object",
      "required": ["agent_id", "agent_type"],
      "properties": {
        "agent_id": {"type": "string", "pattern": "^[a-z0-9-]+$"},
        "agent_type": {"enum": ["claude-code", "cursor", "copilot", "custom"]},
        "session_id": {"type": "string"},
        "started_at": {"type": "string", "format": "date-time"},
        "pid": {"type": "integer"}
      }
    },
    "lock_state": {
      "type": "object",
      "required": ["locked"],
      "properties": {
        "locked": {"type": "boolean"},
        "holder": {"$ref": "#/definitions/agent_identity"},
        "operation": {"type": "string"},
        "acquired_at": {"type": "string", "format": "date-time"},
        "timeout_at": {"type": "string", "format": "date-time"},
        "queue": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "agent_id": {"type": "string"},
              "requested_at": {"type": "string", "format": "date-time"},
              "operation": {"type": "string"},
              "priority": {"enum": ["low", "normal", "high"]}
            }
          }
        }
      }
    },
    "task_claim": {
      "type": "object",
      "required": ["task_id"],
      "properties": {
        "task_id": {"type": "string", "pattern": "^T[0-9]{3,}$"},
        "claimed_by": {"type": "string"},
        "claimed_at": {"type": "string", "format": "date-time"},
        "status": {"enum": ["claimed", "available", "conflict"]},
        "can_claim": {"type": "boolean"},
        "suggestion": {"type": "string"}
      }
    }
  }
}
```

---

## Appendix B: Quick Reference

### Exit Code Quick Reference

```
SCHEMA/VERSION (30-39)
30  SCHEMA_OUTDATED         Minor mismatch, run migrate
31  SCHEMA_INCOMPATIBLE     Major mismatch, human required
32  SCHEMA_AHEAD            Upgrade CLI
33  SCHEMA_CORRUPT          Cannot parse version
34  SCHEMA_UNKNOWN          Unknown schema type
35  MIGRATION_IN_PROGRESS   Wait and retry
36  MIGRATION_FAILED        Restore and retry
37  MIGRATION_ROLLBACK      Human rollback required

COORDINATION (40-49)
40  LOCK_HELD               Wait and retry
41  SESSION_OWNED           Human coordination
42  TASK_CLAIMED            Request handoff
43  HANDOFF_PENDING         Wait for completion
44  AGENT_CONFLICT          Human resolution
45  QUEUE_FULL              Wait or escalate

HEALTH (50-59)
50  HEALTH_ERROR            Run ct health --fix
51  HEALTH_WARNING          Fix optional
52  HEALTH_UNFIXABLE        Human required
53  FIX_FAILED              Restore and retry
54  FIX_PARTIAL             Review and retry
```

### Health Command Quick Reference

```bash
ct health --quick              # Fast check (schema + session)
ct health --full               # All categories
ct health --category schema    # Specific category
ct health --fix                # Auto-fix issues
ct health --fix --dry-run      # Preview fixes
ct health --format json        # JSON output (default when piped)
```

### Agent Recovery Quick Reference

```python
# Retry for recoverable errors
if exit_code in [30, 35, 40, 50, 51]:
    if exit_code == 30:
        run("ct migrate run")
    elif exit_code in [35, 40]:
        wait_and_retry()
    elif exit_code in [50, 51]:
        run("ct health --fix")

# Escalate for unrecoverable errors
if exit_code in [31, 33, 41, 44, 52]:
    escalate_to_human(error_json["message"])
```

---

*Specification v1.0.0 - LLM-Agent-First Health Check Protocol*
*Created: 2025-12-20*
*Status: DRAFT - Pending Implementation*
