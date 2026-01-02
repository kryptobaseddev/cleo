# cleo safestop

Graceful shutdown for agents approaching context limits.

## Synopsis

```bash
cleo safestop --reason <reason> [OPTIONS]
```

## Description

The `safestop` command performs a graceful shutdown sequence when an agent needs to stop, typically due to approaching context window limits. It ensures work state is properly saved for session continuation.

## Required Arguments

| Argument | Description |
|----------|-------------|
| `--reason <text>` | Reason for stopping (e.g., "context-limit", "manual", "checkpoint") |

## Options

| Option | Description |
|--------|-------------|
| `--commit` | Commit pending git changes with WIP message |
| `--handoff <file>` | Generate handoff document (use `-` for stdout) |
| `--no-session-end` | Update notes but don't end session |
| `--dry-run` | Show actions without executing |
| `--format <format>` | Output format: text (default) or json |
| `--json` | Shortcut for `--format json` |
| `--help` | Show help message |

## Shutdown Sequence

When executed, `safestop` performs these steps:

1. **Capture state** - Read focused task, session info, git status
2. **Update task notes** - Add safestop note with context percentage and reason
3. **Git commit** (if `--commit`) - Stage and commit with WIP message
4. **Generate handoff** (if `--handoff`) - Create JSON document for continuation
5. **End session** - Properly end CLEO session with summary note

## Examples

```bash
# Full graceful shutdown
cleo safestop --reason "context-limit" --commit --handoff ./handoff.json

# Preview what would happen (no changes)
cleo safestop --reason "context-limit" --dry-run

# Just update notes and commit, keep session open
cleo safestop --reason "checkpoint" --commit --no-session-end

# Output handoff to stdout for orchestrator
cleo safestop --reason "context-limit" --handoff -

# Use in agent safeguard loop
if ! cleo context check; then
    cleo safestop --reason "context-limit" --commit --handoff ./handoff.json
fi
```

## Handoff Document

The handoff document contains all information needed to resume work:

```json
{
  "$schema": "https://cleo-dev.com/schemas/v1/handoff.schema.json",
  "version": "1.0.0",
  "generatedAt": "2026-01-02T12:00:00Z",
  "reason": "context-limit",
  "contextPercentage": 92,
  "session": {
    "cleoSessionId": "session_20260102_001434_ab3e6d"
  },
  "focusedTask": {
    "id": "T1199",
    "title": "Define context state file schema",
    "progressNote": "Drafted schema, needs review"
  },
  "workInProgress": {
    "gitStatus": "5 files changed",
    "filesModified": ["lib/context-monitor.sh", "scripts/context.sh"]
  },
  "resumeCommand": "cleo session resume session_20260102_001434_ab3e6d"
}
```

## Integration with PreCompact Hook

For automatic safestop when Claude Code triggers PreCompact (95% context), install the hook:

```json
// ~/.claude/settings.json
{
  "hooks": {
    "PreCompact": [{
      "type": "command",
      "command": "~/.cleo/hooks/precompact-safestop.sh",
      "timeout": 30
    }]
  }
}
```

Copy the hook template:
```bash
cp ~/.cleo/templates/hooks/precompact-safestop.sh ~/.cleo/hooks/
```

## Agent Protocol

Agents should follow this protocol:

1. **Periodic check**: Every 10-15 tool calls, run `cleo context check`
2. **Threshold response**:
   - Warning (70%): Log awareness, continue
   - Caution (85%): Start wrapping up current subtask
   - Critical (90%): Complete current operation, then safestop
   - Emergency (95%): PreCompact hook handles automatically

3. **Safestop**: When threshold exceeded:
   ```bash
   cleo safestop --reason "context-limit" --commit --handoff -
   ```

4. **Handoff**: Output handoff content for orchestrator to resume

## See Also

- `cleo context` - Monitor context window usage
- `cleo session` - Manage work sessions
- [Context Safeguard Spec](../specs/CONTEXT-SAFEGUARD-SPEC.md)
