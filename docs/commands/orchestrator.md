# cleo orchestrator

Orchestrator Protocol CLI for LLM agent coordination.

## Synopsis

```bash
cleo orchestrator <command> [options]
```

## Commands

### skill

Manage orchestrator skill installation.

```bash
cleo orchestrator skill [options]
```

**Options:**
- (none): Display installation instructions
- `--install`: Copy skill to project's `.cleo/skills/`
- `--verify`: Check skill is properly installed

**Examples:**
```bash
cleo orchestrator skill           # Show instructions
cleo orchestrator skill --install # Install to project
cleo orchestrator skill --verify  # Verify installation
```

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

### start

Initialize orchestrator session and get complete startup state.

```bash
cleo orchestrator start [--epic <id>]
```

**Options:**
- `--epic, -e <id>`: Epic ID to scope the session

**Output:**
- Session status (active/none)
- Current focus
- Pending manifest followups
- Recommended action (resume/spawn_followup/create_and_spawn/request_direction)
- Next ready task (if epic specified)

**Example:**
```bash
cleo orchestrator start --epic T1575
```

### status

Check pending work from manifest and CLEO tasks.

```bash
cleo orchestrator status
```

**Output:**
- `hasPending`: Boolean indicating pending work exists
- `manifestEntries`: Entries with non-empty needs_followup
- `followupTaskIds`: Unique task IDs from followups

### next

Get the next task to spawn an agent for.

```bash
cleo orchestrator next --epic <id>
```

**Options:**
- `--epic, -e <id>`: Epic ID (required)

**Output:**
- `hasReadyTask`: Boolean indicating ready tasks exist
- `readyCount`: Number of tasks ready to spawn
- `nextTask`: Task details (id, title, priority, size, phase, description, depends)
- `hasLinkedResearch`: Boolean indicating prior research exists

**Example:**
```bash
cleo orchestrator next --epic T1575
```

### ready

Get all tasks that can be spawned in parallel.

```bash
cleo orchestrator ready --epic <id>
```

**Options:**
- `--epic, -e <id>`: Epic ID (required)

**Output:**
- `readyCount`: Number of parallel-safe tasks
- `parallelSafe`: Always true (filtered for safety)
- `tasks`: Array of task summaries

### spawn

Generate spawn command for a task with prompt template.

```bash
cleo orchestrator spawn <task-id> [--template <name>]
```

**Arguments:**
- `<task-id>`: Task to spawn agent for

**Options:**
- `--template, -T <name>`: Template name (default: TASK-EXECUTOR)

**Templates:**
| Name | Purpose |
|------|---------|
| TASK-EXECUTOR | General task execution |
| RESEARCH-AGENT | Research and investigation |
| EPIC-CREATOR | Epic planning and decomposition |
| VALIDATOR | Testing and validation |

**Output:**
- `taskId`: Target task
- `template`: Template used
- `topicSlug`: Slugified topic name
- `outputFile`: Expected output filename
- `prompt`: Complete prompt for Task tool

**Example:**
```bash
cleo orchestrator spawn T1586
cleo orchestrator spawn T1586 --template RESEARCH-AGENT
```

### analyze

Show dependency analysis for an epic.

```bash
cleo orchestrator analyze <epic-id>
```

**Output:**
- `totalTasks`: Total tasks under epic
- `completedTasks`: Count of done tasks
- `waves`: Tasks grouped by execution wave
- `readyToSpawn`: Tasks ready for immediate spawning
- `blockedTasks`: Tasks with unmet dependencies

**Example:**
```bash
cleo orchestrator analyze T1575
```

### parallel

Show parallel execution waves for an epic.

```bash
cleo orchestrator parallel <epic-id>
```

**Output:**
- `totalWaves`: Number of execution waves
- `currentlySpawnable`: Tasks safe to spawn now
- `waves`: Detailed wave information with pending/done counts

### check

Check if multiple tasks can be spawned in parallel.

```bash
cleo orchestrator check <task-id> [<task-id>...]
```

**Output:**
- `canParallelize`: Boolean indicating parallel safety
- `conflicts`: Tasks with inter-dependencies
- `safeToSpawn`: Tasks that can safely run in parallel

**Example:**
```bash
cleo orchestrator check T1578 T1580 T1582
```

### context

Check orchestrator context limits.

```bash
cleo orchestrator context [--tokens <n>]
```

**Options:**
- `--tokens, -t <n>`: Current token usage

**Output:**
- `currentTokens`: Reported or estimated tokens
- `budgetTokens`: Maximum budget (default: 10000)
- `usagePercent`: Percentage of budget used
- `status`: ok/warning/critical
- `recommendation`: Action guidance

**Exit Codes:**
- `0`: OK (<70% usage)
- `52`: Critical (>=90% usage)

### validate

Validate protocol compliance.

```bash
cleo orchestrator validate [options]
```

**Options:**
- `--subagent, -s <id>`: Validate specific subagent output
- `--manifest, -m`: Validate manifest only
- `--orchestrator, -o`: Validate orchestrator compliance only
- `--epic, -e <id>`: Epic ID for orchestrator validation

**Validation Types:**

**Subagent validation** (`--subagent`):
- Required fields present (id, file, title, date, status, topics, key_findings, actionable)
- key_findings count 3-7 items
- Status enum valid (complete|partial|blocked|archived)
- File exists in research outputs
- needs_followup tasks exist in CLEO

**Manifest validation** (`--manifest`):
- Valid JSON syntax per line
- Unique IDs across all entries
- All referenced files exist
- Followup task IDs are valid

**Orchestrator validation** (`--orchestrator`):
- No ORC-004 violations (spawned in dependency order)
- Manifest summaries used (ORC-005)
- Context budget respected

**Examples:**
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
| `research.outputDir` | `docs/claudedocs/research-outputs` | Research output directory |
| `research.manifestFile` | `MANIFEST.jsonl` | Manifest filename |

## Related Commands

- [`cleo session`](session.md) - Session management
- [`cleo research`](research.md) - Research manifest operations
- [`cleo analyze`](analyze.md) - Task analysis

## See Also

- [Orchestrator Protocol Guide](../guides/ORCHESTRATOR-PROTOCOL.md)
- [Example Session](../examples/orchestrator-example-session.md)
