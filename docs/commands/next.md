# next Command

Intelligently suggest the next task to work on based on priority, dependencies, and current focus.

## Usage

```bash
claude-todo next [OPTIONS]
```

## Description

The `next` command analyzes your task list and suggests the most appropriate task to work on next. It considers multiple factors including task priority, dependency status, phase alignment with current focus, and task age to provide intelligent recommendations.

This command is particularly useful for:
- Deciding what to work on next when multiple tasks are available
- Understanding why certain tasks are recommended
- Finding tasks that are ready to start (dependencies satisfied)
- Maintaining workflow momentum by automatically selecting optimal tasks

## Algorithm

The recommendation engine works as follows:

1. **Filter eligible tasks**: Only consider tasks with status `pending` and not blocked
2. **Check dependencies**: Exclude tasks with incomplete dependencies
3. **Calculate priority score**:
   - `critical` = 100 points
   - `high` = 75 points
   - `medium` = 50 points
   - `low` = 25 points
4. **Apply phase bonus**: +30 points if task phase matches current focus phase
5. **Break ties**: Use creation date (older tasks first)

## Options

| Option | Short | Description | Default |
|--------|-------|-------------|---------|
| `--explain` | `-e` | Show detailed reasoning for the suggestion | `false` |
| `--count N` | `-n` | Show top N suggestions instead of just one | `1` |
| `--format FORMAT` | `-f` | Output format: `text` or `json` | `text` |
| `--help` | `-h` | Show help message | |

## Exit Codes

| Code | Meaning |
|------|---------|
| 0 | Success |
| 1 | Error (validation failed, file read error, no tasks available) |

## Examples

### Basic Suggestion

```bash
# Get the single best next task
claude-todo next
```

Output:
```
NEXT TASK SUGGESTION

📌 T015 - Implement user authentication
   Priority: critical
   Phase: core
   Created: 2025-12-10

Ready to start (all dependencies satisfied)
```

### With Explanation

```bash
# Show why this task was chosen
claude-todo next --explain
```

Output:
```
NEXT TASK SUGGESTION

📌 T015 - Implement user authentication
   Priority: critical (score: 100)
   Phase: core (matches focus: +30 bonus)
   Created: 2025-12-10
   Final Score: 130

WHY THIS TASK?

✓ Highest priority (critical)
✓ Phase matches current focus (core)
✓ All dependencies satisfied
✓ Not blocked

ALTERNATIVES CONSIDERED:
  T018 - Add error logging (score: 75, high priority)
  T022 - Optimize API calls (score: 60, medium priority + phase bonus)
  T019 - Refactor user service (score: 50, medium priority)

DEPENDENCY STATUS:
  No dependencies

BLOCKING:
  This task blocks 2 other tasks: T020, T023
```

### Multiple Suggestions

```bash
# Show top 3 task suggestions
claude-todo next --count 3
```

Output:
```
NEXT TASK SUGGESTIONS (Top 3)

1. 📌 T015 - Implement user authentication
   Priority: critical
   Phase: core
   Score: 130

2. 📌 T022 - Optimize API calls
   Priority: medium
   Phase: core
   Score: 80

3. 📌 T018 - Add error logging
   Priority: high
   Phase: polish
   Score: 75
```

### JSON Output

```bash
# Machine-readable format
claude-todo next --format json
```

Output structure:
```json
{
  "_meta": {
    "version": "2.1.0",
    "timestamp": "2025-12-12T10:00:00Z",
    "algorithm": "priority + dependencies + phase alignment",
    "count": 1
  },
  "suggestions": [
    {
      "id": "T015",
      "title": "Implement user authentication",
      "status": "pending",
      "priority": "critical",
      "phase": "core",
      "createdAt": "2025-12-10T10:00:00Z",
      "score": 130,
      "breakdown": {
        "priorityScore": 100,
        "phaseBonus": 30,
        "ageBonus": 0
      },
      "dependencies": {
        "total": 0,
        "satisfied": 0,
        "pending": 0
      },
      "blocks": ["T020", "T023"],
      "ready": true
    }
  ]
}
```

### Combined with Focus

```bash
# Get suggestion and immediately set it as focus
TASK_ID=$(claude-todo next --format json | jq -r '.suggestions[0].id')
claude-todo focus set "$TASK_ID"
```

## Use Cases

### Decision Paralysis

When you have many pending tasks and aren't sure what to tackle next:

```bash
# Let the algorithm decide
claude-todo next --explain
```

The explanation helps you understand the recommendation and make an informed decision.

### Workflow Automation

```bash
# Auto-select next task after completing current one
claude-todo complete T015 --notes "Done"
claude-todo next | grep "T[0-9]" | head -1
```

### Sprint Planning

```bash
# Get top 5 tasks for sprint planning
claude-todo next --count 5 --format json | \
  jq '.suggestions[] | "\(.priority) - \(.title)"'
```

### Blocked Work Discovery

```bash
# If next returns nothing, check what's blocking
claude-todo next || claude-todo list --status blocked
```

## Understanding Scores

### Priority Scores

| Priority | Base Score | Description |
|----------|-----------|-------------|
| `critical` | 100 | Urgent, blocking, or high-impact work |
| `high` | 75 | Important tasks that should be done soon |
| `medium` | 50 | Standard priority work |
| `low` | 25 | Nice to have, can be deferred |

### Bonuses

**Phase Alignment (+30)**:
If the task's phase matches the current project phase or focused task's phase, it receives a significant bonus. This strongly encourages completing work in the current phase before context-switching to other phases.

**Age Tiebreaker**:
When two tasks have identical scores, older tasks are prioritized to prevent task starvation.

## Dependency Handling

The `next` command only suggests tasks where all dependencies are satisfied:

```bash
# Task T020 depends on T015, T018
# T020 will NOT be suggested until both T015 and T018 are done

# Check dependencies
claude-todo next --explain
# Shows: "Dependencies: 2 pending (T015, T018)"
```

To see what's blocking a task from being suggested:

```bash
# List all tasks with their dependency status
claude-todo list --format json | \
  jq '.tasks[] | select(.depends != null) | {id, title, depends}'
```

## Integration Examples

### Shell Function for Quick Start

```bash
# Add to .bashrc or .zshrc
ct-start() {
  local task_id
  task_id=$(claude-todo next --format json | jq -r '.suggestions[0].id')

  if [[ -n "$task_id" && "$task_id" != "null" ]]; then
    echo "Starting task: $task_id"
    claude-todo focus set "$task_id"
  else
    echo "No available tasks"
  fi
}
```

### Morning Routine Script

```bash
#!/usr/bin/env bash
# morning-standup.sh

echo "=== Morning Standup ==="
echo ""
echo "Dashboard:"
claude-todo dash --compact
echo ""
echo "Suggested next task:"
claude-todo next --explain
```

### CI/CD Task Validation

```bash
# Fail build if no tasks are ready to work
claude-todo next --format json | \
  jq -e '.suggestions | length > 0' || \
  (echo "ERROR: No tasks ready to start" && exit 1)
```

### Task Suggestion Bot

```bash
# Slack/Discord bot integration
SUGGESTION=$(claude-todo next --explain)
curl -X POST "$WEBHOOK_URL" -d "{\"text\":\"$SUGGESTION\"}"
```

## When Next Returns Nothing

If `next` doesn't suggest any tasks, check:

1. **All tasks blocked**:
   ```bash
   claude-todo list --status blocked
   ```

2. **All tasks have pending dependencies**:
   ```bash
   claude-todo list --format json | jq '.tasks[] | select(.depends != null)'
   ```

3. **No pending tasks**:
   ```bash
   claude-todo list --status pending
   ```

4. **All tasks completed**:
   ```bash
   claude-todo stats
   ```

## Tips

1. **Use with Focus**: Combine `next` with `focus set` for seamless workflow
2. **Enable Explanations**: Use `--explain` to understand and trust the algorithm
3. **Multiple Options**: Use `--count 3` to see alternatives when top choice isn't suitable
4. **Review Dependencies**: Before starting, verify dependencies are truly complete
5. **Phase Alignment**: Organize work into phases to benefit from phase bonus scoring

## Customization

While the scoring algorithm is built-in, you can influence recommendations by:

**Setting Appropriate Priorities**:
```bash
claude-todo update T015 --priority critical  # Will be suggested first
```

**Using Phases**:
```bash
# Tasks in same phase as focus get +30 bonus
claude-todo add "Backend work" --phase core
claude-todo focus set T015  # Also in core phase
claude-todo next  # Will strongly prefer core phase tasks
```

**Managing Dependencies**:
```bash
# Ensure dependencies are set correctly
claude-todo update T020 --depends T015,T018
```

## Related Commands

- `claude-todo focus set ID` - Set focus to a specific task
- `claude-todo list --status pending` - See all pending tasks
- `claude-todo dash` - View comprehensive dashboard
- `claude-todo update ID --priority PRIORITY` - Change task priority

## Version History

- **v0.8.0**: Initial implementation with priority-based scoring
- **v0.8.2**: Added phase alignment bonus (+10) and explain mode
- **v0.13.0**: Increased phase alignment bonus to +30 for stronger phase prioritization
