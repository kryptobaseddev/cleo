# Project-Level Phase Concept: Schema Design Analysis

**Date**: 2025-12-15
**Status**: Research & Design
**Version**: 1.0

## Executive Summary

This document analyzes schema changes needed to support project-level "current phase" tracking in cleo. The proposed design introduces a structured project metadata object that unifies phase definitions with project-level phase state tracking while maintaining backward compatibility.

---

## Current State Analysis

### Existing Phase Implementation

**Location**: `todo.json` root object

```json
{
  "phases": {
    "setup": { "order": 1, "name": "Setup & Foundation" },
    "core": { "order": 2, "name": "Core Development" },
    "polish": { "order": 3, "name": "Polish & Launch" }
  }
}
```

**Schema Definition** (lines 82-97 in `schemas/todo.schema.json`):
```json
"phases": {
  "type": "object",
  "description": "Optional phase definitions. Keys are slugs referenced by task.phase.",
  "patternProperties": {
    "^[a-z][a-z0-9-]*$": {
      "type": "object",
      "required": ["order", "name"],
      "additionalProperties": false,
      "properties": {
        "order": { "type": "integer", "minimum": 1 },
        "name": { "type": "string", "maxLength": 50 }
      }
    }
  },
  "additionalProperties": false
}
```

### Current Limitations

1. **No Project-Level Phase State**: System tracks which phase each task belongs to, but not which phase the project is currently in
2. **Implicit Current Phase**: Derived only from `focus.currentTask` → task's phase field (see `next.sh` lines 133-142)
3. **No Phase Lifecycle**: No way to mark phases as completed, active, or pending
4. **Limited Metadata**: Phases only have `order` and `name`, no status or timestamps
5. **Phase Transitions Not Tracked**: No audit trail of when project moved between phases

### How Current Phase is Inferred

**From `scripts/next.sh` (lines 128-142)**:
```bash
get_current_phase() {
  local focus_id
  focus_id=$(get_current_focus)
  if [[ -n "$focus_id" && "$focus_id" != "null" ]]; then
    jq -r --arg id "$focus_id" '.tasks[] | select(.id == $id) | .phase // ""' "$TODO_FILE"
  else
    echo ""
  fi
}
```

**Limitations of Current Approach**:
- Current phase is undefined when no task is focused
- Cannot set project phase independently of active task
- Phase changes only happen implicitly when focus changes
- No way to mark entire phases as complete

---

## Design Goals

1. **Project-Level Phase Tracking**: Explicit field for current active phase
2. **Phase Lifecycle Management**: Track status (pending/active/completed) per phase
3. **Backward Compatibility**: Existing projects without new fields continue working
4. **Audit Trail**: Track phase transitions in log
5. **Validation Rules**: Only one phase active at a time, logical progression
6. **Migration Safety**: Clear migration path from current schema

---

## Proposed Schema Structure

### Option A: Unified Project Object (Recommended)

**Rationale**: Consolidates project-level metadata into single structured object, provides clear namespace for phase state.

```json
{
  "version": "2.2.0",
  "project": {
    "name": "cleo",
    "currentPhase": "core",
    "phases": {
      "setup": {
        "order": 1,
        "name": "Setup & Foundation",
        "description": "Initial project setup and configuration",
        "status": "completed",
        "startedAt": "2025-11-01T00:00:00Z",
        "completedAt": "2025-11-15T00:00:00Z"
      },
      "core": {
        "order": 2,
        "name": "Core Development",
        "description": "Build core functionality",
        "status": "active",
        "startedAt": "2025-11-15T00:00:00Z",
        "completedAt": null
      },
      "polish": {
        "order": 3,
        "name": "Polish & Launch",
        "description": "Refinement and release prep",
        "status": "pending",
        "startedAt": null,
        "completedAt": null
      }
    }
  },
  "lastUpdated": "2025-12-15T10:00:00Z",
  "_meta": { ... },
  "focus": { ... },
  "tasks": [ ... ],
  "labels": { ... }
}
```

**Schema Definition**:

```json
{
  "properties": {
    "project": {
      "type": "object",
      "required": ["name", "phases"],
      "additionalProperties": false,
      "properties": {
        "name": {
          "type": "string",
          "minLength": 1,
          "description": "Project identifier for cross-session context."
        },
        "currentPhase": {
          "type": ["string", "null"],
          "pattern": "^[a-z][a-z0-9-]*$",
          "description": "Slug of currently active phase. Must match a phase with status=active."
        },
        "phases": {
          "type": "object",
          "description": "Phase definitions with lifecycle tracking.",
          "patternProperties": {
            "^[a-z][a-z0-9-]*$": {
              "$ref": "#/definitions/phaseDefinition"
            }
          },
          "additionalProperties": false
        }
      }
    }
  },

  "definitions": {
    "phaseDefinition": {
      "type": "object",
      "required": ["order", "name", "status"],
      "additionalProperties": false,
      "properties": {
        "order": {
          "type": "integer",
          "minimum": 1,
          "description": "Display order for phase sequencing."
        },
        "name": {
          "type": "string",
          "minLength": 1,
          "maxLength": 50,
          "description": "Human-readable phase name."
        },
        "description": {
          "type": "string",
          "maxLength": 200,
          "description": "Phase purpose and scope."
        },
        "status": {
          "type": "string",
          "enum": ["pending", "active", "completed"],
          "description": "Phase lifecycle state. Only one phase can be active."
        },
        "startedAt": {
          "type": ["string", "null"],
          "format": "date-time",
          "description": "When phase became active. Required if status=active or completed."
        },
        "completedAt": {
          "type": ["string", "null"],
          "format": "date-time",
          "description": "When phase was completed. Required if status=completed."
        }
      },
      "allOf": [
        {
          "if": {
            "properties": { "status": { "enum": ["active", "completed"] } }
          },
          "then": { "required": ["startedAt"] }
        },
        {
          "if": {
            "properties": { "status": { "const": "completed" } }
          },
          "then": { "required": ["completedAt"] }
        }
      ]
    }
  }
}
```

---

### Option B: Minimal Extension (Simpler Migration)

**Rationale**: Adds only essential fields to existing structure, minimizes schema changes.

```json
{
  "version": "2.2.0",
  "project": "cleo",
  "currentPhase": "core",
  "phases": {
    "setup": {
      "order": 1,
      "name": "Setup & Foundation",
      "status": "completed"
    },
    "core": {
      "order": 2,
      "name": "Core Development",
      "status": "active"
    },
    "polish": {
      "order": 3,
      "name": "Polish & Launch",
      "status": "pending"
    }
  },
  "lastUpdated": "2025-12-15T10:00:00Z",
  "_meta": { ... },
  "focus": { ... },
  "tasks": [ ... ],
  "labels": { ... }
}
```

**Schema Changes**:
```json
{
  "properties": {
    "currentPhase": {
      "type": ["string", "null"],
      "pattern": "^[a-z][a-z0-9-]*$",
      "description": "Currently active phase slug."
    },
    "phases": {
      "patternProperties": {
        "^[a-z][a-z0-9-]*$": {
          "required": ["order", "name", "status"],
          "properties": {
            "order": { "type": "integer", "minimum": 1 },
            "name": { "type": "string", "maxLength": 50 },
            "status": {
              "type": "string",
              "enum": ["pending", "active", "completed"],
              "default": "pending"
            }
          }
        }
      }
    }
  }
}
```

---

## Validation Rules

### Phase Status Validation

1. **Single Active Phase**: Only ONE phase can have `status: "active"` at any time
2. **Current Phase Consistency**: If `currentPhase` is set, that phase MUST have `status: "active"`
3. **Completion Order**: Cannot mark phase as completed if it has `status: "pending"` (must go through active)
4. **Timestamp Ordering**: `startedAt` ≤ `completedAt` (if both present)
5. **Timestamp Sanity**: Timestamps cannot be in the future

### Cross-Object Validation

1. **Phase Reference**: `currentPhase` slug MUST exist in `phases` object
2. **Task Phase Alignment**: Tasks can reference any defined phase (pending/active/completed)
3. **Focus Alignment**: `focus.currentTask` phase should typically match `currentPhase` (warn if mismatch)

### Transition Rules

**Valid Transitions**:
- `pending` → `active` (start phase)
- `active` → `completed` (finish phase)
- `active` → `pending` (rollback, rare)

**Invalid Transitions**:
- `pending` → `completed` (must go through active)
- `completed` → `pending` (completed is final)
- `completed` → `active` (completed is final)

---

## Backward Compatibility

### Migration Strategy

#### For Existing Projects (v2.1.0 → v2.2.0)

**Option A Migration**:
```javascript
// Transform existing structure
{
  "project": "my-project",  // OLD (string)
  "phases": {
    "setup": { "order": 1, "name": "Setup" }
  }
}

// Becomes:
{
  "project": {
    "name": "my-project",  // NEW (nested object)
    "currentPhase": null,  // NEW (default to null)
    "phases": {
      "setup": {
        "order": 1,
        "name": "Setup",
        "status": "pending",  // NEW (default)
        "startedAt": null,    // NEW
        "completedAt": null   // NEW
      }
    }
  }
}
```

**Option B Migration**:
```javascript
// Transform existing structure
{
  "project": "my-project",
  "phases": {
    "setup": { "order": 1, "name": "Setup" }
  }
}

// Becomes:
{
  "project": "my-project",       // UNCHANGED
  "currentPhase": null,          // NEW (top-level)
  "phases": {
    "setup": {
      "order": 1,
      "name": "Setup",
      "status": "pending"        // NEW (only addition)
    }
  }
}
```

### Default Values

When migrating from v2.1.0:

| Field | Default Value | Rationale |
|-------|---------------|-----------|
| `currentPhase` | `null` | Unknown until user sets it |
| `phase.status` | `"pending"` | Conservative default, user must activate |
| `phase.description` | `""` (or omit) | Optional field, no default needed |
| `phase.startedAt` | `null` | Unknown historical data |
| `phase.completedAt` | `null` | Unknown historical data |

### Reading Old Versions

**System Behavior with v2.1.0 Files**:
- Missing `currentPhase`: Treat as null, fall back to current behavior (derive from focus)
- Missing `phase.status`: Treat as `"pending"`
- Missing timestamps: Treat as null, don't enforce temporal validation

**Graceful Degradation**:
```bash
# In scripts, check for field existence
CURRENT_PHASE=$(jq -r '.currentPhase // .project.currentPhase // null' "$TODO_FILE")

if [[ "$CURRENT_PHASE" == "null" ]]; then
  # Fall back to old behavior: derive from focused task
  CURRENT_PHASE=$(get_current_phase_from_focus)
fi
```

---

## History & Audit Tracking

### Log Entry for Phase Transitions

**New Action Type**: `phase_changed`

```json
{
  "id": "log_abc123def456",
  "timestamp": "2025-12-15T10:30:00Z",
  "action": "phase_changed",
  "actor": "human",
  "sessionId": "session_20251215_103000_xyz",
  "before": {
    "currentPhase": "setup",
    "phase": {
      "slug": "setup",
      "status": "active"
    }
  },
  "after": {
    "currentPhase": "core",
    "phase": {
      "slug": "core",
      "status": "active"
    }
  },
  "details": {
    "transitionType": "completion",
    "completedPhase": "setup",
    "activatedPhase": "core",
    "command": "cleo phase activate core"
  }
}
```

### Phase Completion Log Entry

```json
{
  "id": "log_def456ghi789",
  "timestamp": "2025-12-15T10:30:00Z",
  "action": "phase_completed",
  "actor": "human",
  "sessionId": "session_20251215_103000_xyz",
  "before": {
    "phase": {
      "slug": "setup",
      "status": "active",
      "startedAt": "2025-11-01T00:00:00Z",
      "completedAt": null
    }
  },
  "after": {
    "phase": {
      "slug": "setup",
      "status": "completed",
      "startedAt": "2025-11-01T00:00:00Z",
      "completedAt": "2025-12-15T10:30:00Z"
    }
  },
  "details": {
    "durationDays": 44,
    "tasksCompleted": 12,
    "tasksTotal": 12
  }
}
```

---

## Implementation Considerations

### New CLI Commands Required

```bash
# Phase activation
cleo phase activate <slug>        # Set phase as active, mark previous as completed
cleo phase set <slug>             # Alias for activate

# Phase status queries
cleo phase current                # Show current active phase
cleo phase status                 # Show all phases with status

# Phase lifecycle
cleo phase start <slug>           # Mark phase as active (from pending)
cleo phase complete <slug>        # Mark phase as completed
cleo phase rollback <slug>        # Mark active phase back to pending (rare)

# Phase metadata
cleo phase update <slug> --name "New Name"
cleo phase update <slug> --description "Details"
```

### Modified Commands

**`cleo phases`** (existing):
- Add status column to output
- Show current phase indicator (★ or highlight)
- Filter by status: `--status active`

**`cleo next`** (existing):
- Use `project.currentPhase` instead of deriving from focus
- Give bonus score to tasks in current phase

**`cleo dash`** (existing):
- Display current phase prominently
- Show phase progress section

**`cleo add`** (existing):
- Default new tasks to current phase if not specified
- Option: `--phase auto` uses current phase

### Validation Updates

**New Validation Checks** (in `validate.sh`):

```bash
# Check 1: Only one active phase
ACTIVE_PHASE_COUNT=$(jq '[.project.phases[] | select(.status == "active")] | length' "$TODO_FILE")
if [[ $ACTIVE_PHASE_COUNT -gt 1 ]]; then
  ERROR "Multiple phases marked as active (only one allowed)"
fi

# Check 2: Current phase consistency
CURRENT_PHASE=$(jq -r '.project.currentPhase // null' "$TODO_FILE")
if [[ "$CURRENT_PHASE" != "null" ]]; then
  PHASE_STATUS=$(jq -r --arg p "$CURRENT_PHASE" '.project.phases[$p].status // null' "$TODO_FILE")
  if [[ "$PHASE_STATUS" != "active" ]]; then
    ERROR "Current phase '$CURRENT_PHASE' does not have status=active"
  fi
fi

# Check 3: Timestamp ordering
jq -r '.project.phases | to_entries[] |
  select(.value.startedAt != null and .value.completedAt != null) |
  select(.value.startedAt > .value.completedAt) |
  .key' "$TODO_FILE" | while read phase_slug; do
  ERROR "Phase '$phase_slug': startedAt is after completedAt"
done
```

---

## Migration Plan

### Phase 1: Schema Update (v2.2.0)

1. **Update `schemas/todo.schema.json`**:
   - Add `phaseDefinition` to definitions
   - Update `project` property (Option A) or add `currentPhase` (Option B)
   - Add conditional validations for phase status

2. **Update `templates/todo.template.json`**:
   - Add default phase structure with status fields
   - Set all phases to `pending` status
   - Set `currentPhase` to `null`

3. **Update Documentation**:
   - Schema reference docs
   - Migration guide
   - Command documentation

### Phase 2: Migration Script

**File**: `lib/migrate-2.2.0.sh`

```bash
migrate_to_2_2_0() {
  local file="$1"
  local backup="${file}.pre-2.2.0"

  # Backup
  cp "$file" "$backup"

  # Option A: Transform project to object
  jq '
    # Save old project string
    .project as $old_project |

    # Transform structure
    .project = {
      name: $old_project,
      currentPhase: null,
      phases: (.phases // {} |
        to_entries |
        map({
          key: .key,
          value: (.value + {
            status: "pending",
            description: (.value.description // ""),
            startedAt: null,
            completedAt: null
          })
        }) |
        from_entries
      )
    } |

    # Remove old top-level phases
    del(.phases) |

    # Update version
    .version = "2.2.0"
  ' "$file" > "${file}.tmp" && mv "${file}.tmp" "$file"

  # Validate
  if ! validate_json_schema "$file" "todo"; then
    # Rollback on failure
    mv "$backup" "$file"
    return 1
  fi

  echo "Migrated to v2.2.0 successfully"
}
```

### Phase 3: Code Updates

1. **Update `lib/file-ops.sh`**:
   - Add `get_current_phase()` helper
   - Add `set_current_phase()` helper
   - Add phase validation functions

2. **Update Existing Scripts**:
   - `next.sh`: Use `project.currentPhase` instead of deriving
   - `phases.sh`: Add status display, current phase indicator
   - `dash.sh`: Show current phase

3. **New Scripts**:
   - `scripts/phase-activate.sh`
   - `scripts/phase-complete.sh`

### Phase 4: Testing

1. **Unit Tests**:
   - Phase status validation
   - Current phase consistency checks
   - Timestamp ordering validation

2. **Integration Tests**:
   - Migration from v2.1.0 to v2.2.0
   - Phase activation/completion workflows
   - Backward compatibility with old files

3. **Edge Cases**:
   - No phases defined
   - All phases completed
   - Invalid phase transitions

---

## Comparison: Option A vs Option B

| Aspect | Option A (Unified Object) | Option B (Minimal Extension) |
|--------|---------------------------|------------------------------|
| **Complexity** | Higher (nested structure) | Lower (flat addition) |
| **Future Extensibility** | Better (project metadata namespace) | Limited |
| **Migration Difficulty** | Harder (restructure required) | Easier (add fields only) |
| **Breaking Change** | Yes (project becomes object) | No (project stays string) |
| **Clarity** | Better (clear separation) | Good |
| **Metadata Support** | Excellent (timestamps, descriptions) | Basic (status only) |
| **Backward Compat** | Requires migration | Mostly compatible |
| **CLI Impact** | Moderate (path changes) | Low (minimal changes) |

---

## Recommendation

**Recommended Approach**: **Option A (Unified Project Object)**

**Justification**:

1. **Long-Term Architecture**: Provides clean namespace for future project-level metadata (tags, goals, team members, etc.)

2. **Schema Clarity**: Clear separation between project configuration and task data reduces ambiguity

3. **Richer Metadata**: Support for phase descriptions, timestamps enables better analytics and reporting

4. **Audit Trail**: Full lifecycle tracking (started/completed timestamps) provides valuable project insights

5. **One-Time Migration Pain**: While migration is harder, it's a one-time cost with long-term benefits

6. **Industry Patterns**: Matches common patterns in project management tools (Jira, Linear, etc.)

**Migration Timeline**: Target v0.11.0 or v1.0.0 (coordinate with other breaking changes if possible)

---

## Default Values for New Projects

When initializing new projects with v2.2.0:

```json
{
  "project": {
    "name": "{{PROJECT_NAME}}",
    "currentPhase": "setup",
    "phases": {
      "setup": {
        "order": 1,
        "name": "Setup & Foundation",
        "description": "Initial project setup and configuration",
        "status": "active",
        "startedAt": "{{TIMESTAMP}}",
        "completedAt": null
      },
      "core": {
        "order": 2,
        "name": "Core Development",
        "description": "Build core functionality and features",
        "status": "pending",
        "startedAt": null,
        "completedAt": null
      },
      "polish": {
        "order": 3,
        "name": "Polish & Launch",
        "description": "Refinement, testing, and release preparation",
        "status": "pending",
        "startedAt": null,
        "completedAt": null
      }
    }
  }
}
```

**Rationale**: New projects start in "setup" phase by default, providing immediate context for initial tasks.

---

## Related Systems Impact

### TodoWrite Integration

**TodoWrite Format** (ephemeral session tasks):
- Does NOT need project-level phase tracking
- Individual task phases sufficient
- No changes required to TodoWrite schema

### Export Formats

**TodoWrite Export**:
- Include current phase in metadata
- Tasks export with phase field unchanged

**CSV Export**:
- Add "Current Phase" column to header
- Include phase status in phase-specific exports

### Backup System

**Backup Compatibility**:
- v2.2.0 backups can restore to v2.2.0+ systems
- v2.1.0 backups require migration before restore to v2.2.0

---

## Open Questions

1. **Phase Auto-Progression**: Should system automatically move to next phase when current phase tasks all completed?
   - **Recommendation**: No (explicit user action required)

2. **Phase Reactivation**: Allow moving back to completed phase?
   - **Recommendation**: Yes, with warning (log transition)

3. **Multiple Active Phases**: Support concurrent phases (e.g., frontend + backend)?
   - **Recommendation**: No for v2.2.0 (keep simple), revisit if user demand

4. **Phase Dependencies**: Should phases have dependency relationships?
   - **Recommendation**: No (use order field for sequencing), revisit later

5. **Phase-Based Filtering**: Filter tasks by current phase only?
   - **Recommendation**: Add as option to `list` command: `--current-phase-only`

6. **Phase Templates**: Predefined phase sets for common project types?
   - **Recommendation**: Future enhancement (v2.3.0+)

---

## Performance Considerations

### Read Performance

**Impact**: Negligible
- Project object read once per operation
- Phase lookup O(1) (hash map)
- No performance degradation expected

### Write Performance

**Impact**: Minimal
- Additional validation checks: O(P) where P = number of phases (typically 3-7)
- Timestamp generation: O(1)
- Overall impact: <1ms per operation

### Migration Performance

**Impact**: Low for typical projects
- v2.1.0 → v2.2.0 migration: O(P) where P = number of phases
- Expected time: <100ms for projects with <10 phases
- Large projects (>50 phases): <500ms

---

## Success Metrics

**Post-Implementation Validation**:

1. **Functionality**:
   - All phase commands work as specified
   - Validation catches invalid states
   - Migration preserves all data

2. **Backward Compatibility**:
   - v2.1.0 files readable with warnings
   - Migration success rate >99%
   - No data loss in migration

3. **Usability**:
   - Current phase clearly visible in `dash` output
   - Phase transitions require <3 commands
   - Documentation clarity (user testing)

4. **Performance**:
   - No operation slowdown >10ms
   - Migration time <1 second for 95% of projects

---

## References

- **Current Schema**: `schemas/todo.schema.json` v2.1.0
- **Phase Command**: `scripts/phases.sh`
- **Next Command**: `scripts/next.sh` (current phase inference)
- **Migration Guide**: `docs/reference/migration-guide.md`
- **Schema Docs**: `docs/architecture/SCHEMAS.md`

---

## Appendix A: Complete Schema Definition (Option A)

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "$id": "cleo-schema-v2.2",
  "title": "CLAUDE-TODO Task Schema with Project Phases",
  "version": "2.2.0",

  "type": "object",
  "required": ["version", "project", "lastUpdated", "tasks", "_meta"],
  "additionalProperties": false,

  "properties": {
    "version": {
      "type": "string",
      "pattern": "^\\d+\\.\\d+\\.\\d+$",
      "description": "Schema version (semver)"
    },

    "project": {
      "type": "object",
      "required": ["name", "phases"],
      "additionalProperties": false,
      "properties": {
        "name": {
          "type": "string",
          "minLength": 1,
          "description": "Project identifier for cross-session context."
        },
        "currentPhase": {
          "type": ["string", "null"],
          "pattern": "^[a-z][a-z0-9-]*$",
          "description": "Slug of currently active phase. Must match a phase with status=active."
        },
        "phases": {
          "type": "object",
          "description": "Phase definitions with lifecycle tracking.",
          "patternProperties": {
            "^[a-z][a-z0-9-]*$": {
              "$ref": "#/definitions/phaseDefinition"
            }
          },
          "additionalProperties": false
        }
      }
    },

    "lastUpdated": {
      "type": "string",
      "format": "date-time",
      "description": "ISO 8601 timestamp of last modification."
    },

    "_meta": {
      "type": "object",
      "required": ["checksum", "configVersion"],
      "additionalProperties": false,
      "properties": {
        "checksum": {
          "type": "string",
          "pattern": "^[a-f0-9]{16}$"
        },
        "configVersion": {
          "type": "string"
        },
        "lastSessionId": {
          "type": ["string", "null"]
        },
        "activeSession": {
          "type": ["string", "null"]
        }
      }
    },

    "focus": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "currentTask": {
          "type": ["string", "null"],
          "pattern": "^T\\d{3,}$"
        },
        "blockedUntil": {
          "type": ["string", "null"]
        },
        "sessionNote": {
          "type": ["string", "null"],
          "maxLength": 1000
        },
        "nextAction": {
          "type": ["string", "null"],
          "maxLength": 500
        }
      }
    },

    "tasks": {
      "type": "array",
      "items": { "$ref": "#/definitions/task" }
    },

    "labels": {
      "type": "object",
      "patternProperties": {
        "^[a-z][a-z0-9.-]*$": {
          "type": "array",
          "items": { "type": "string", "pattern": "^T\\d{3,}$" }
        }
      },
      "additionalProperties": false
    }
  },

  "definitions": {
    "phaseDefinition": {
      "type": "object",
      "required": ["order", "name", "status"],
      "additionalProperties": false,
      "properties": {
        "order": {
          "type": "integer",
          "minimum": 1,
          "description": "Display order for phase sequencing."
        },
        "name": {
          "type": "string",
          "minLength": 1,
          "maxLength": 50,
          "description": "Human-readable phase name."
        },
        "description": {
          "type": "string",
          "maxLength": 200,
          "description": "Phase purpose and scope."
        },
        "status": {
          "type": "string",
          "enum": ["pending", "active", "completed"],
          "description": "Phase lifecycle state. Only one phase can be active."
        },
        "startedAt": {
          "type": ["string", "null"],
          "format": "date-time",
          "description": "When phase became active. Required if status=active or completed."
        },
        "completedAt": {
          "type": ["string", "null"],
          "format": "date-time",
          "description": "When phase was completed. Required if status=completed."
        }
      },
      "allOf": [
        {
          "if": {
            "properties": { "status": { "enum": ["active", "completed"] } }
          },
          "then": { "required": ["startedAt"] }
        },
        {
          "if": {
            "properties": { "status": { "const": "completed" } }
          },
          "then": { "required": ["completedAt"] }
        }
      ]
    },

    "task": {
      "type": "object",
      "required": ["id", "title", "status", "priority", "createdAt"],
      "additionalProperties": false,
      "properties": {
        "id": {
          "type": "string",
          "pattern": "^T\\d{3,}$"
        },
        "title": {
          "type": "string",
          "minLength": 1,
          "maxLength": 120
        },
        "status": {
          "type": "string",
          "enum": ["pending", "active", "blocked", "done"]
        },
        "priority": {
          "type": "string",
          "enum": ["critical", "high", "medium", "low"]
        },
        "phase": {
          "type": "string",
          "pattern": "^[a-z][a-z0-9-]*$",
          "description": "Phase slug (must exist in project.phases)"
        },
        "description": {
          "type": "string",
          "maxLength": 2000
        },
        "files": {
          "type": "array",
          "items": { "type": "string" }
        },
        "acceptance": {
          "type": "array",
          "items": { "type": "string", "maxLength": 200 },
          "minItems": 1
        },
        "depends": {
          "type": "array",
          "items": { "type": "string", "pattern": "^T\\d{3,}$" },
          "uniqueItems": true
        },
        "blockedBy": {
          "type": "string",
          "maxLength": 300
        },
        "notes": {
          "type": "array",
          "items": { "type": "string", "maxLength": 500 }
        },
        "labels": {
          "type": "array",
          "items": { "type": "string", "pattern": "^[a-z][a-z0-9.-]*$" },
          "uniqueItems": true
        },
        "createdAt": {
          "type": "string",
          "format": "date-time"
        },
        "completedAt": {
          "type": "string",
          "format": "date-time"
        }
      },
      "allOf": [
        {
          "if": { "properties": { "status": { "const": "blocked" } } },
          "then": { "required": ["blockedBy"] }
        },
        {
          "if": { "properties": { "status": { "const": "done" } } },
          "then": { "required": ["completedAt"] }
        }
      ]
    }
  }
}
```

---

**Document Version**: 1.0
**Last Updated**: 2025-12-15
**Status**: Research Complete - Awaiting Implementation Decision
