# cleo orchestrator

Orchestrator Protocol CLI for LLM agent coordination and multi-agent workflows using the 2-tier architecture.

## Synopsis

```bash
cleo orchestrator <command> [options]
```

## Overview

The orchestrator command provides tools for LLM agents operating as orchestrators in CLEO's **2-tier architecture**:

| Tier | Component | Role |
|------|-----------|------|
| **0** | ct-orchestrator | HITL coordinator, delegates ALL work |
| **1** | cleo-subagent | Universal executor with skill injection |

> **Architecture Reference**: See [CLEO-SUBAGENT.md](../architecture/CLEO-SUBAGENT.md) for complete architecture documentation.

The orchestrator implements the ORC-001 through ORC-005 constraints:

| Constraint | Rule | Description |
|------------|------|-------------|
| ORC-001 | Stay high-level | No implementation details |
| ORC-002 | Delegate ALL work | Use Task tool for everything |
| ORC-003 | No full file reads | Manifest summaries only |
| ORC-004 | Dependency order | No overlapping agents |
| ORC-005 | Context budget | Stay under 10K tokens |

## Commands

### start

Initialize orchestrator session and get complete startup state.

```bash
cleo orchestrator start [--epic <id>]
```

**Options:**
- `--epic, -e <id>`: Epic ID to scope the session

**Output Fields:**
- `session`: Session state (activeSessions, hasFocus, focusedTask, recommendedAction)
- `context`: Context budget status (currentTokens, budgetTokens, usagePercent)
- `nextTask`: Next ready task details (if epic specified)
- `readyTasks`: All parallel-safe tasks (if epic specified)

**Decision Matrix:**
| State | Recommended Action |
|-------|-------------------|
| Active session + focus | `resume` - Continue focused task |
| Active session, no focus | `spawn_followup` - Query manifest and spawn |
| No session + pending | `create_and_spawn` - Create session and spawn |
| No session, no pending | `request_direction` - Await user direction |

**Example:**
```bash
cleo orchestrator start --epic T1575
```

**Sample Output:**
```json
{
  "_meta": {"command": "orchestrator", "operation": "startup_state"},
  "success": true,
  "result": {
    "session": {
      "activeSessions": 1,
      "activeSessionId": "session_20260120_...",
      "hasFocus": false,
      "recommendedAction": "spawn_followup",
      "actionReason": "Active session without focus - query manifest and spawn next agent"
    },
    "context": {
      "currentTokens": 0,
      "budgetTokens": 10000,
      "usagePercent": 0,
      "status": "ok"
    },
    "nextTask": {
      "hasReadyTask": true,
      "readyCount": 3,
      "nextTask": {"id": "T1586", "title": "...", "priority": "high"}
    }
  }
}
```

### status

Check pending work from manifest and CLEO tasks.

```bash
cleo orchestrator status
```

**Output Fields:**
- `hasPending`: Boolean indicating pending work exists
- `manifestEntries`: Entries with non-empty `needs_followup`
- `manifestCount`: Number of manifest entries needing followup
- `followupTaskIds`: Unique task IDs from followups
- `followupTaskCount`: Number of followup tasks

**Example:**
```bash
cleo orchestrator status
```

### next

Get the next task to spawn an agent for.

```bash
cleo orchestrator next --epic <id> [--phase <slug>]
```

**Options:**
- `--epic, -e <id>`: Epic ID (required)
- `--phase, -p <slug>`: Filter by project phase (optional)

**Output Fields:**
- `hasReadyTask`: Boolean indicating ready tasks exist
- `readyCount`: Number of tasks ready to spawn
- `nextTask`: Task details (id, title, priority, size, phase, description, depends)
- `hasLinkedResearch`: Boolean indicating prior research exists
- `linkedResearchCount`: Number of linked research entries

**Example:**
```bash
# Get next task from any phase
cleo orchestrator next --epic T1575

# Get next task from testing phase only
cleo orchestrator next --epic T1575 --phase testing
```

### ready

Get all tasks that can be spawned in parallel (no inter-dependencies).

```bash
cleo orchestrator ready --epic <id> [--phase <slug>]
```

**Options:**
- `--epic, -e <id>`: Epic ID (required)
- `--phase, -p <slug>`: Filter by project phase (optional)

**Output Fields:**
- `epicId`: Epic being analyzed
- `readyCount`: Number of parallel-safe tasks
- `parallelSafe`: Always `true` (filtered for safety)
- `tasks`: Array of task summaries (id, title, priority, size, phase)

**Example:**
```bash
cleo orchestrator ready --epic T1575
```

**Sample Output:**
```json
{
  "success": true,
  "result": {
    "epicId": "T1575",
    "readyCount": 3,
    "parallelSafe": true,
    "tasks": [
      {"id": "T1586", "title": "Implement auth...", "priority": "high", "size": "medium", "phase": "core"}
    ]
  }
}
```

### spawn

Generate spawn command for a task with prompt template.

```bash
cleo orchestrator spawn <task-id> [--template <skill>]
```

**Arguments:**
- `<task-id>`: Task to spawn agent for

**Options:**
- `--template, -T <skill>`: Skill name (default: `ct-task-executor`)

**Skill Dispatch Matrix:**

| Task Type | Skill | Trigger Keywords |
|-----------|-------|------------------|
| Implementation work | `ct-task-executor` | "implement", "execute task", "do the work", "build component" |
| Research/investigation | `ct-research-agent` | "research", "investigate", "gather info", "explore options" |
| Epic/project planning | `ct-epic-architect` | "create epic", "plan tasks", "decompose", "wave planning" |
| Spec/protocol writing | `ct-spec-writer` | "write spec", "define protocol", "RFC", "specification" |
| Test writing (BATS) | `ct-test-writer-bats` | "write tests", "BATS", "bash tests", "integration tests" |
| Bash library work | `ct-library-implementer-bash` | "create library", "bash functions", "lib/*.sh" |
| Validation/auditing | `ct-validator` | "validate", "verify", "check compliance", "audit" |
| Documentation | `ct-documentor` | "write docs", "document", "update README" |

**Skill Name Aliases:**
The spawn command supports multiple name formats:
- Uppercase: `TASK-EXECUTOR`, `RESEARCH-AGENT`
- Lowercase: `task-executor`, `research-agent`
- Full name: `ct-task-executor`, `ct-research-agent`
- Short aliases: `EXECUTOR`, `RESEARCH`, `BATS`, `SPEC`

**Output Fields:**
- `taskId`: Target task
- `template`: Skill used
- `topicSlug`: Slugified topic name
- `outputFile`: Expected output filename
- `spawnTimestamp`: When spawn was generated
- `prompt`: Complete prompt for Task tool (with tokens injected)

**Example:**
```bash
# Default skill (ct-task-executor)
cleo orchestrator spawn T1586

# Specific skill
cleo orchestrator spawn T1586 --template ct-research-agent
cleo orchestrator spawn T1586 --template RESEARCH-AGENT
cleo orchestrator spawn T1586 --template research
```

### analyze

Show dependency analysis for an epic, including execution waves.

```bash
cleo orchestrator analyze <epic-id>
```

**Output Fields:**
- `epicId`: Epic being analyzed
- `totalTasks`: Total tasks under epic
- `completedTasks`: Count of done tasks
- `pendingTasks`: Count of pending tasks
- `activeTasks`: Count of active tasks
- `waves`: Tasks grouped by execution wave
- `readyToSpawn`: Tasks ready for immediate spawning
- `blockedTasks`: Tasks with unmet dependencies

**Example:**
```bash
cleo orchestrator analyze T1575
```

**Sample Output:**
```json
{
  "success": true,
  "result": {
    "epicId": "T1575",
    "totalTasks": 20,
    "completedTasks": 15,
    "pendingTasks": 4,
    "waves": [
      {"wave": 0, "tasks": [...]},
      {"wave": 1, "tasks": [...]}
    ],
    "readyToSpawn": [
      {"id": "T1586", "title": "...", "priority": "high", "wave": 2}
    ],
    "blockedTasks": [
      {"id": "T1590", "title": "...", "depends": ["T1586"]}
    ]
  }
}
```

### parallel

Show parallel execution waves for an epic with detailed wave statistics.

```bash
cleo orchestrator parallel <epic-id>
```

**Output Fields:**
- `totalWaves`: Number of execution waves
- `currentlySpawnable`: Tasks safe to spawn now
- `spawnableCount`: Number of currently spawnable tasks
- `waves`: Detailed wave information with pending/done counts per wave
- `summary`: Overall epic statistics (total, completed, pending, active, blocked)

**Example:**
```bash
cleo orchestrator parallel T1575
```

**Sample Output:**
```json
{
  "success": true,
  "result": {
    "epicId": "T1575",
    "totalWaves": 4,
    "spawnableCount": 2,
    "currentlySpawnable": [
      {"id": "T1586", "title": "...", "priority": "high", "wave": 2}
    ],
    "waves": [
      {"wave": 0, "taskCount": 5, "pendingCount": 0, "doneCount": 5, "tasks": [...]},
      {"wave": 1, "taskCount": 3, "pendingCount": 1, "doneCount": 2, "tasks": [...]}
    ],
    "summary": {"total": 20, "completed": 15, "pending": 4, "active": 1, "blocked": 2}
  }
}
```

### check

Check if multiple tasks can be spawned in parallel (no inter-dependencies).

```bash
cleo orchestrator check <task-id> [<task-id>...]
```

**Output Fields:**
- `canParallelize`: Boolean indicating parallel safety
- `taskCount`: Number of tasks checked
- `conflicts`: Tasks with inter-dependencies
- `safeToSpawn`: Tasks that can safely run in parallel
- `reason`: Explanation

**Example:**
```bash
cleo orchestrator check T1578 T1580 T1582
```

### context

Check orchestrator context limits against budget.

```bash
cleo orchestrator context [--tokens <n>]
```

**Options:**
- `--tokens, -t <n>`: Current token usage (reads from state file if not provided)

**Output Fields:**
- `currentTokens`: Reported or estimated tokens
- `budgetTokens`: Maximum budget (default: 10000)
- `usagePercent`: Percentage of budget used
- `status`: `ok` | `warning` | `critical`
- `recommendation`: Action guidance

**Status Thresholds:**
| Status | Usage | Recommendation |
|--------|-------|----------------|
| `ok` | <70% | Continue orchestration |
| `warning` | 70-89% | Delegate current work |
| `critical` | >=90% | STOP - Delegate immediately |

**Exit Codes:**
- `0`: OK (<70% usage)
- `52`: Critical (>=90% usage)

**Example:**
```bash
cleo orchestrator context --tokens 5000
```

### validate

Validate protocol compliance for manifest, subagents, or orchestrator behavior.

```bash
cleo orchestrator validate [options]
```

**Options:**
- `--subagent, -s <id>`: Validate specific subagent output
- `--manifest, -m`: Validate manifest only
- `--orchestrator, -o`: Validate orchestrator compliance only
- `--epic, -e <id>`: Epic ID for orchestrator validation

**Validation Types:**

**Full validation** (no options):
- Manifest integrity
- Orchestrator compliance
- All subagent outputs

**Subagent validation** (`--subagent <id>`):
- Required fields present (id, file, title, date, status, topics, key_findings, actionable)
- `key_findings` count 3-7 items
- Status enum valid (`complete` | `partial` | `blocked` | `archived`)
- File exists in research outputs
- `needs_followup` tasks exist in CLEO

**Manifest validation** (`--manifest`):
- Valid JSON syntax per line
- Unique IDs across all entries
- All referenced files exist
- Followup task IDs are valid

**Orchestrator validation** (`--orchestrator`):
- No ORC-004 violations (spawned in dependency order)
- Manifest summaries used (ORC-005)
- Context budget respected

**Example:**
```bash
# Full validation
cleo orchestrator validate

# Epic-scoped validation
cleo orchestrator validate --epic T1575

# Validate specific subagent
cleo orchestrator validate --subagent research-auth-2026-01-18

# Manifest only
cleo orchestrator validate --manifest
```

### skill

Manage orchestrator skill installation.

```bash
cleo orchestrator skill [--install | --verify]
```

**Options:**
- (none): Display installation instructions
- `--install`: Copy skill to project's `.cleo/skills/`
- `--verify`: Check skill is properly installed

**Installation Details:**
When `--install` is used:
1. Creates `.cleo/skills/orchestrator/` directory if not exists
2. Copies `SKILL.md` and supporting files from CLEO's skill templates
3. Skill becomes available via natural language or Skill tool

**Why Skill-Based?**
The skill approach is preferred over CLAUDE.md injection because:
- **Selective Activation**: Only the HITL orchestrator agent receives the protocol
- **Subagent Isolation**: Subagents spawn without orchestrator constraints
- **On-Demand Loading**: Reduces context overhead when not in orchestrator mode
- **Clean Separation**: Orchestrator vs worker roles are architecturally distinct

**Example:**
```bash
cleo orchestrator skill           # Show instructions
cleo orchestrator skill --install # Install to project
cleo orchestrator skill --verify  # Verify installation
```

## Token Injection System

The orchestrator uses `lib/token-inject.sh` to populate skill templates with task-specific values before spawning subagents.

### Required Tokens

| Token | Description | Source |
|-------|-------------|--------|
| `{{TASK_ID}}` | Current task identifier | Task system |
| `{{DATE}}` | Current date (YYYY-MM-DD) | Generated |
| `{{TOPIC_SLUG}}` | URL-safe topic name | Generated from title |

### Task Command Tokens

| Token | Default Value |
|-------|---------------|
| `{{TASK_SHOW_CMD}}` | `cleo show` |
| `{{TASK_FOCUS_CMD}}` | `cleo focus set` |
| `{{TASK_COMPLETE_CMD}}` | `cleo complete` |
| `{{TASK_LINK_CMD}}` | `cleo research link` |
| `{{TASK_LIST_CMD}}` | `cleo list` |
| `{{TASK_FIND_CMD}}` | `cleo find` |
| `{{TASK_ADD_CMD}}` | `cleo add` |

### Task Context Tokens

| Token | Description |
|-------|-------------|
| `{{TASK_NAME}}` | Task title |
| `{{TASK_DESCRIPTION}}` | Full description |
| `{{TASK_INSTRUCTIONS}}` | Execution instructions |
| `{{DELIVERABLES_LIST}}` | Expected outputs |
| `{{ACCEPTANCE_CRITERIA}}` | Completion criteria |
| `{{DEPENDS_LIST}}` | Completed dependencies |
| `{{MANIFEST_SUMMARIES}}` | Key findings from dependency tasks |
| `{{NEXT_TASK_IDS}}` | Tasks unblocked after completion |

### Output Tokens

| Token | Default Value |
|-------|---------------|
| `{{OUTPUT_DIR}}` | `claudedocs/agent-outputs` |
| `{{MANIFEST_PATH}}` | `claudedocs/agent-outputs/MANIFEST.jsonl` |

### Token Injection Workflow

The `spawn` command automatically:
1. Loads the skill template from `skills/ct-{skill}/SKILL.md`
2. Sets required context tokens (TASK_ID, DATE, TOPIC_SLUG)
3. Sets CLEO command defaults (TASK_SHOW_CMD, etc.)
4. Extracts task context from CLEO (description, instructions, deliverables)
5. Gets manifest summaries from dependency tasks
6. Injects all tokens into the template
7. Returns the complete prompt ready for Task tool

## Exit Codes

| Code | Meaning |
|------|---------|
| 0 | Success |
| 2 | Invalid input (missing required argument) |
| 4 | Not found (task, epic, or file) |
| 52 | Context critical (>=90% budget) |

## Environment

The orchestrator commands use these configuration values:

| Config Key | Default | Description |
|------------|---------|-------------|
| `research.outputDir` | `claudedocs/agent-outputs` | Research output directory |
| `research.manifestFile` | `MANIFEST.jsonl` | Manifest filename |

## Related Commands

- [`cleo session`](session.md) - Session management
- [`cleo research`](research.md) - Research manifest operations
- [`cleo analyze`](analyze.md) - Task analysis

## Related Skills

- **ct-orchestrator** - The orchestrator skill itself, for HITL multi-agent coordination
- **ct-epic-architect** - Epic creation and task decomposition
- **ct-task-executor** - General task execution (default spawn template)
- **ct-research-agent** - Research and investigation
- **ct-spec-writer** - Technical specification writing
- **ct-test-writer-bats** - BATS integration test writing
- **ct-library-implementer-bash** - Bash library implementation
- **ct-validator** - Compliance validation
- **ct-documentor** - Documentation orchestration

## cleo-subagent Usage

The 2-tier architecture uses a single `cleo-subagent` type with skill injection:

### Spawning a cleo-subagent

```bash
# Generate spawn command with auto-selected skill
cleo orchestrator spawn T1234

# With explicit skill
cleo orchestrator spawn T1234 --template ct-research-agent
```

### What cleo-subagent Receives

1. **Skill Template**: Loaded from `skills/ct-{skill}/SKILL.md`
2. **Protocol Base**: Injected from `skills/_shared/subagent-protocol-base.md`
3. **Resolved Tokens**: All `{{TOKEN}}` placeholders pre-resolved

### cleo-subagent Requirements

Every spawned subagent MUST:

1. Write findings to: `claudedocs/agent-outputs/{{DATE}}_{{TOPIC_SLUG}}.md`
2. Append ONE line to: `claudedocs/agent-outputs/MANIFEST.jsonl`
3. Return ONLY: "Research complete. See MANIFEST.jsonl for summary."
4. Complete task via: `cleo complete {{TASK_ID}}`

### Programmatic Spawning

```bash
source lib/orchestrator-spawn.sh

# Full spawn preparation
result=$(orchestrator_spawn_for_task "T1234")
prompt=$(echo "$result" | jq -r '.result.prompt')

# Verify protocol injection
orchestrator_verify_protocol_injection "$prompt"

# After completion, verify manifest entry
orchestrator_verify_manifest_entry "auth-research-2026-01-26"
```

### Skill Selection API

```bash
source lib/skill-dispatch.sh

# Auto-select skill based on task metadata
skill=$(skill_auto_dispatch "T1234")

# Get spawn context with all tokens resolved
context=$(skill_prepare_spawn "$skill" "T1234")
```

## See Also

- [CLEO-SUBAGENT Architecture](../architecture/CLEO-SUBAGENT.md)
- [Orchestrator Protocol Spec](../specs/ORCHESTRATOR-PROTOCOL-SPEC.md)
- [Orchestrator Protocol Guide](../guides/ORCHESTRATOR-PROTOCOL.md)
- [Example Session](../examples/orchestrator-example-session.md)
