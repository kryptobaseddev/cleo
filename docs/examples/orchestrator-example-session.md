# Orchestrator Protocol Example Session

This example demonstrates the complete orchestrator workflow for implementing a feature epic.

## Scenario

Implementing a "User Authentication" epic with 4 tasks:
1. T100: Research auth patterns (no deps)
2. T101: Design schema (depends: T100)
3. T102: Implement API (depends: T101)
4. T103: Write tests (depends: T102)

## Step 1: Create Epic and Tasks

```bash
# Create the epic
cleo add "User Authentication" --type epic --phase core

# Create tasks with dependencies
cleo add "Research auth patterns" --parent T100 --priority high
cleo add "Design database schema" --parent T100 --depends T101
cleo add "Implement auth API" --parent T100 --depends T102
cleo add "Write integration tests" --parent T100 --depends T103
```

## Step 2: Start Orchestrator Session

```bash
# Initialize orchestrator
cleo orchestrator start --epic T100
```

Example output:
```json
{
  "_meta": {"command": "orchestrator", "operation": "startup_state"},
  "success": true,
  "result": {
    "session": {
      "activeSessions": 0,
      "hasFocus": false,
      "hasPending": false,
      "recommendedAction": "request_direction",
      "actionReason": "No session, no pending work - await user direction"
    },
    "nextTask": {
      "hasReadyTask": true,
      "readyCount": 1,
      "nextTask": {
        "id": "T101",
        "title": "Research auth patterns",
        "priority": "high"
      }
    }
  }
}
```

## Step 3: Start Session and Spawn First Agent

```bash
# Start scoped session
cleo session start --scope epic:T100 --auto-focus --name "Auth Epic"

# Generate spawn command for first task
cleo orchestrator spawn T101
```

Example spawn output:
```json
{
  "success": true,
  "result": {
    "taskId": "T101",
    "template": "TASK-EXECUTOR",
    "outputFile": "2026-01-18_research-auth-patterns.md",
    "prompt": "You are the research-auth-patterns subagent..."
  }
}
```

### Spawning the Subagent

Using the Task tool in Claude Code:

```
<task>
You are the research-auth-patterns subagent. Your job is to complete CLEO task T101.

## SUBAGENT PROTOCOL (RFC 2119 - MANDATORY)

OUTPUT REQUIREMENTS:
1. MUST write findings to: claudedocs/research-outputs/2026-01-18_research-auth-patterns.md
2. MUST append ONE line to: claudedocs/research-outputs/MANIFEST.jsonl
3. MUST return ONLY: "Research complete. See MANIFEST.jsonl for summary."
4. MUST NOT return research content in response.

## YOUR TASK

1. Read task details: `cleo show T101`
2. Set focus: `cleo focus set T101`
3. Research authentication patterns: JWT, session-based, OAuth
4. Document trade-offs and recommendations
5. Write output file and manifest entry
6. Complete task: `cleo complete T101`
</task>
```

## Step 4: Read Manifest (Not Files!)

After subagent completes, orchestrator reads manifest:

```bash
# Get latest manifest entry
jq -s '.[-1]' claudedocs/research-outputs/MANIFEST.jsonl
```

Example manifest entry:
```json
{
  "id": "research-auth-patterns-2026-01-18",
  "file": "2026-01-18_research-auth-patterns.md",
  "title": "Authentication Patterns Research",
  "date": "2026-01-18",
  "status": "complete",
  "topics": ["authentication", "jwt", "oauth", "sessions"],
  "key_findings": [
    "JWT recommended for stateless API auth with 15min access tokens",
    "Session-based better for server-rendered apps with sensitive data",
    "OAuth required for third-party integrations, adds complexity",
    "Recommend JWT with refresh token rotation for this project"
  ],
  "actionable": true,
  "needs_followup": ["T102"],
  "linked_tasks": ["T100", "T101"]
}
```

**Important**: Orchestrator reads `key_findings` from manifest, NOT the full research file.

## Step 5: Spawn Next Agent

```bash
# Check what's ready
cleo orchestrator next --epic T100
```

Output shows T102 is now ready (T101 completed):

```bash
# Spawn schema design agent
cleo orchestrator spawn T102 --template TASK-EXECUTOR
```

Include context from previous work in the spawn prompt:

```markdown
## REFERENCE FROM PREVIOUS AGENTS:

T101 (Research auth patterns):
- JWT recommended for stateless API auth with 15min access tokens
- Recommend JWT with refresh token rotation for this project
```

## Step 6: Continue Until Complete

Repeat for remaining tasks:

```bash
# After T102 completes
cleo orchestrator spawn T103  # Implement API

# After T103 completes
cleo orchestrator spawn T104  # Write tests
```

## Step 7: Complete Epic

After final subagent completes:

```bash
# Verify all children done
cleo list --parent T100 --status done

# Complete epic
cleo complete T100

# End session
cleo session end --note "Auth epic complete. 4 tasks finished."
```

## Parallel Execution Example

If T102 and T103 had no dependencies on each other:

```bash
# Check parallel safety
cleo orchestrator check T102 T103
```

Output:
```json
{
  "result": {
    "canParallelize": true,
    "taskCount": 2,
    "conflicts": [],
    "safeToSpawn": ["T102", "T103"]
  }
}
```

Spawn both agents simultaneously using separate Task tool invocations.

## Error Recovery

If a subagent fails to complete properly:

```bash
# Check subagent output validity
cleo orchestrator validate --subagent research-auth-patterns-2026-01-18

# Manual completion if needed
cleo complete T101

# Spawn retry with clearer instructions
cleo orchestrator spawn T101 --template TASK-EXECUTOR
```

## Key Takeaways

1. **Always use manifest summaries** - Never read full research files as orchestrator
2. **Spawn in dependency order** - Use `cleo orchestrator next` to determine order
3. **Check parallel safety** - Use `cleo orchestrator check` before parallel spawns
4. **Include context in prompts** - Pass relevant `key_findings` to subsequent agents
5. **Validate completions** - Use `cleo orchestrator validate` after suspicious outputs
