# Orchestrator: Subagent Spawning

> Referenced from: @skills/ct-orchestrator/SKILL.md
> Load when: Need details on spawning subagents, skill dispatch, template selection, or programmatic spawning workflows

## Subagent Spawning

### Quick Spawn Workflow

```bash
# 1. Get next ready task
cleo orchestrator next --epic T1575

# 2. Generate spawn command with prompt
cleo orchestrator spawn T1586

# 3. Or specify a skill template
cleo orchestrator spawn T1586 --template ct-research-agent
cleo orchestrator spawn T1586 --template RESEARCH-AGENT  # aliases work
```

### Manual Spawn (when CLI spawn unavailable)

Use Task tool with `subagent_type="general-purpose"` and include:
1. Subagent protocol block (RFC 2119 requirements)
2. Context from previous agents (manifest `key_findings` ONLY)
3. Clear task definition and completion criteria

### Spawn Output

The `spawn` command returns:
- `taskId`: Target task
- `template`: Skill used
- `topicSlug`: Slugified topic name
- `outputFile`: Expected output filename
- `prompt`: Complete prompt ready for Task tool

---

## Skill Dispatch Rules

Use the appropriate skill for each task type. The `spawn` command accepts skill names in multiple formats.

### Skill Selection Matrix

| Task Type | Skill | Trigger Keywords |
|-----------|-------|------------------|
| Generic implementation | `ct-task-executor` | "implement", "execute task", "do the work", "build component" |
| Research/investigation | `ct-research-agent` | "research", "investigate", "gather info", "explore options" |
| Epic/project planning | `ct-epic-architect` | "create epic", "plan tasks", "decompose", "wave planning" |
| Specification writing | `ct-spec-writer` | "write spec", "define protocol", "RFC", "specification" |
| Test writing (BATS) | `ct-test-writer-bats` | "write tests", "BATS", "bash tests", "integration tests" |
| Bash library creation | `ct-library-implementer-bash` | "create library", "bash functions", "lib/*.sh" |
| Compliance validation | `ct-validator` | "validate", "verify", "check compliance", "audit" |
| Documentation | `ct-documentor` | "write docs", "document", "update README" |

### Skill Name Aliases

The `spawn` command supports multiple name formats:

| Format | Example |
|--------|---------|
| Full name | `ct-task-executor`, `ct-research-agent` |
| Uppercase | `TASK-EXECUTOR`, `RESEARCH-AGENT` |
| Lowercase | `task-executor`, `research-agent` |
| Short aliases | `EXECUTOR`, `RESEARCH`, `BATS`, `SPEC` |

### Skill Paths

```
skills/ct-epic-architect/SKILL.md
skills/ct-spec-writer/SKILL.md
skills/ct-research-agent/SKILL.md
skills/ct-test-writer-bats/SKILL.md
skills/ct-library-implementer-bash/SKILL.md
skills/ct-task-executor/SKILL.md
skills/ct-validator/SKILL.md
skills/ct-documentor/SKILL.md
```

---

## Complete Spawning Workflow

### Automated Workflow (Recommended)

```bash
# Step 1: Get ready task
cleo orchestrator next --epic T1575
# Returns: { nextTask: { id: "T1586", title: "...", priority: "high" } }

# Step 2: Generate spawn prompt (handles all token injection)
spawn_result=$(cleo orchestrator spawn T1586)

# Step 3: Extract prompt and use with Task tool
prompt=$(echo "$spawn_result" | jq -r '.result.prompt')
# Pass $prompt to Task tool
```

---

## Programmatic Spawning with orchestrator_spawn_for_task()

For advanced automation, use the `orchestrator_spawn_for_task()` function from `lib/orchestrator-spawn.sh`. This consolidates the manual 6-step workflow into a single function call.

### Basic Usage

```bash
source lib/orchestrator-spawn.sh

# Prepare complete subagent prompt for a task
prompt=$(orchestrator_spawn_for_task "T1234")

# With explicit skill override (bypasses auto-dispatch)
prompt=$(orchestrator_spawn_for_task "T1234" "ct-research-agent")

# With target model validation
prompt=$(orchestrator_spawn_for_task "T1234" "" "sonnet")
```

### What orchestrator_spawn_for_task() Does

The function performs these steps automatically:

| Step | Action | Details |
|------|--------|---------|
| 1 | Read task from CLEO | `cleo show T1234 --format json` |
| 2 | Select skill | Auto-dispatch from task type/labels or use override |
| 3 | Validate skill | Check compatibility with target model |
| 4 | Inject protocol | Load skill template + subagent protocol |
| 5 | Set tokens | `{{TASK_ID}}`, `{{DATE}}`, `{{TOPIC_SLUG}}`, `{{EPIC_ID}}` |
| 6 | Return prompt | Complete JSON with prompt ready for Task tool |

### Return Value Structure

```json
{
  "_meta": { "command": "orchestrator", "operation": "spawn_for_task" },
  "success": true,
  "result": {
    "taskId": "T1234",
    "skill": "ct-research-agent",
    "topicSlug": "auth-implementation",
    "date": "2026-01-20",
    "epicId": "T1200",
    "outputFile": "2026-01-20_auth-implementation.md",
    "spawnTimestamp": "2026-01-20T15:30:00Z",
    "targetModel": "auto",
    "taskContext": {
      "title": "Implement auth module",
      "description": "Full task description..."
    },
    "instruction": "Use Task tool to spawn subagent with the following prompt:",
    "prompt": "Complete injected prompt content..."
  }
}
```

### Helper Functions

| Function | Purpose |
|----------|---------|
| `orchestrator_spawn_for_task()` | Main function - prepare single task spawn |
| `orchestrator_spawn_batch()` | Prepare prompts for multiple tasks |
| `orchestrator_spawn_preview()` | Preview skill selection without injection |

### Complete Workflow Example

```bash
#!/usr/bin/env bash
# Example: Spawn research subagent for task T1586

source lib/orchestrator-spawn.sh

# 1. Generate spawn result (includes all tokens and context)
spawn_result=$(orchestrator_spawn_for_task "T1586")

# 2. Check success
if [[ $(echo "$spawn_result" | jq -r '.success') != "true" ]]; then
    echo "Spawn failed: $(echo "$spawn_result" | jq -r '.error.message')" >&2
    exit 1
fi

# 3. Extract prompt for Task tool
prompt=$(echo "$spawn_result" | jq -r '.result.prompt')
output_file=$(echo "$spawn_result" | jq -r '.result.outputFile')
skill=$(echo "$spawn_result" | jq -r '.result.skill')

# 4. Log spawn metadata
echo "Spawning $skill for task T1586"
echo "Expected output: $output_file"

# 5. Pass $prompt to Task tool (in orchestrator context)
# The Task tool invocation would include:
#   - description: "Execute task T1586 with $skill"
#   - prompt: $prompt
```

### Debug Mode

Enable debug output for troubleshooting:

```bash
export ORCHESTRATOR_SPAWN_DEBUG=1
prompt=$(orchestrator_spawn_for_task "T1234")
# Logs to stderr: [orchestrator-spawn] DEBUG: ...
```

---

### Manual Workflow

#### Step 1: Identify Task Type

```bash
# Check task details
cleo show T1234 | jq '{title, description, labels}'
```

#### Step 2: Select Skill

Match task keywords to skill selection matrix above.

#### Step 3: Prepare Context

```bash
source lib/token-inject.sh

# Set required tokens
ti_set_context "T1234" "$(date +%Y-%m-%d)" "auth-implementation"

# Set defaults and get task context
ti_set_defaults
task_json=$(cleo show T1234 --format json)
ti_set_task_context "$task_json"
```

#### Step 4: Load Skill Template

```bash
template=$(ti_load_template "skills/ct-task-executor/SKILL.md")
```

#### Step 5: Spawn Subagent

Use Task tool with:
1. Injected skill template
2. Subagent protocol block
3. Context from previous agents (manifest `key_findings` ONLY)
4. Clear task definition and completion criteria

#### Step 6: Monitor Completion

```bash
# Check manifest for completion
{{RESEARCH_SHOW_CMD}} <research-id>

# Or use jq
jq -s '.[-1] | {id, status, key_findings}' {{MANIFEST_PATH}}
```
