# blockers Command

**Alias**: `block`

Analyze blocked tasks and their dependency chains to understand what's preventing work from progressing.

## Usage

```bash
cleo blockers [SUBCOMMAND] [OPTIONS]
```

## Description

The `blockers` command helps you identify and analyze blocked tasks in your todo system. It shows which tasks are blocked, what dependencies are preventing them from being worked on, and provides recommendations for unblocking your workflow.

This command is ideal for:
- Identifying tasks that are stuck waiting on dependencies
- Understanding blocking chains and their depth
- Finding bottleneck tasks that unblock the most work
- Prioritizing which tasks to complete first

> **Note**: Critical path and bottleneck analysis features require the `analysis.sh` library to be available.

## Subcommands

| Subcommand | Description |
|------------|-------------|
| `list` | List all blocked tasks with their blockers (default) |
| `analyze` | Detailed analysis of blocking chains and recommendations |

## Options

| Option | Short | Description | Default |
|--------|-------|-------------|---------|
| `--format FORMAT` | `-f` | Output format: `text`, `json`, or `markdown` | `text` |
| `--quiet` | `-q` | Suppress informational messages | `false` |
| `--help` | `-h` | Show help message | |

## Examples

### List Blocked Tasks

```bash
# List all blocked tasks
cleo blockers

# Same as above (explicit)
cleo blockers list
```

Output:
```
BLOCKED TASKS
=============

T005 - Implement login page
  Blocked by: T003 (Set up authentication backend)
  Chain depth: 1

T008 - Deploy to production
  Blocked by: T005 (Implement login page), T007 (Add tests)
  Chain depth: 2

Total: 2 blocked tasks
```

### Status Symbols

The text output uses these status indicators:
| Symbol | Status | Color |
|--------|--------|-------|
| `✓` | Done | Green |
| `→` | Active | Yellow |
| `⊗` | Blocked | Red |
| ` ` | Pending | Default |

### Analyze Blocking Chains

```bash
# Detailed analysis with recommendations
cleo blockers analyze
```

Output:
```
BLOCKING CHAIN ANALYSIS
=======================

Critical Path:
  T001 -> T003 -> T005 -> T008
  Chain length: 4 tasks

Bottleneck Tasks (unblock the most work):
  1. T003 - Set up authentication backend
     Directly unblocks: T005
     Transitively unblocks: T008
     Impact: 2 tasks

  2. T007 - Add tests
     Directly unblocks: T008
     Impact: 1 task

Recommendations:
  * Complete T003 first to unblock the longest chain
  * T007 and T003 can be worked in parallel
```

### Output Formats

```bash
# JSON output for scripting
cleo blockers --format json

# Markdown output for documentation
cleo blockers --format markdown
```

JSON output example:
```json
{
  "_meta": {
    "version": "0.9.0",
    "timestamp": "2025-12-12T10:30:00Z",
    "command": "blockers"
  },
  "blockedTasks": [
    {
      "id": "T005",
      "title": "Implement login page",
      "blockedBy": ["T003"],
      "chainDepth": 1
    }
  ],
  "totalBlocked": 1
}
```

### Quiet Mode

```bash
# Suppress info messages (for scripts)
cleo blockers --quiet --format json
```

## Integration with Other Commands

### With deps command

```bash
# See full dependency graph
cleo deps tree

# Then analyze blockers
cleo blockers analyze
```

### With focus command

```bash
# Find what to work on next
cleo blockers analyze

# Set focus to the bottleneck task
cleo focus set T003
```

### With complete command

```bash
# Complete a blocker
cleo complete T003 --notes "Authentication backend ready"

# Verify blocked tasks are unblocked
cleo blockers
```

## Best Practices

1. **Start with analysis**: Run `blockers analyze` at the start of each session to understand dependencies
2. **Focus on bottlenecks**: Prioritize tasks that unblock the most other work
3. **Clear blockers early**: Address blocking tasks before starting new work
4. **Use JSON for automation**: Integrate with CI/CD pipelines to detect blocked work

## Troubleshooting

### No blocked tasks found

If `blockers` shows no results but you expect blocked tasks:
- Check that blocked tasks have `status: blocked` and `blockedBy` reason
- Verify dependencies are set with `cleo deps`
- Run `cleo validate` to check data integrity

### Incorrect blocking information

If blocking chains seem wrong:
- Verify dependency relationships with `cleo deps T001`
- Check for completed dependencies that should have unblocked tasks
- Run `cleo validate` to detect circular dependencies

## See Also

- [deps](deps.md) - Visualize task dependencies
- [next](next.md) - Get intelligent next task suggestions
- [dash](dash.md) - Full project dashboard
