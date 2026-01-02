# cleo context

Monitor context window usage for agent safeguard system.

## Synopsis

```bash
cleo context [status|check|watch] [OPTIONS]
```

## Description

The `context` command monitors Claude Code's context window usage in real-time. It reads from the `.cleo/.context-state.json` file, which is populated by the CLEO status line integration script.

This command is part of the Context Safeguard System, designed to help agents gracefully stop when approaching context limits.

## Subcommands

| Subcommand | Description |
|------------|-------------|
| `status` | Show current context state (default) |
| `check` | Check threshold, return exit code for scripting |
| `watch` | Continuous monitoring mode (planned) |

## Options

| Option | Description |
|--------|-------------|
| `--format <format>` | Output format: text (default) or json |
| `--json` | Shortcut for `--format json` |
| `--human` | Shortcut for `--format text` |
| `--help` | Show help message |

## Exit Codes

The `check` subcommand returns the following exit codes:

| Code | Status | Threshold |
|------|--------|-----------|
| 0 | OK | <70% |
| 50 | Warning | 70-84% |
| 51 | Caution | 85-89% |
| 52 | Critical | 90-94% |
| 53 | Emergency | 95%+ |
| 54 | Stale/No data | State file missing or outdated |

## Examples

```bash
# Show current context status
cleo context

# Show status in JSON format
cleo context status --json

# Check threshold for scripting (silent, exit code only)
cleo context check

# Use in agent safeguard loop
if ! cleo context check; then
    cleo safestop --reason "context-limit" --commit
fi

# Check specific exit code
cleo context check
case $? in
    0)  echo "OK - continue working" ;;
    50) echo "Warning - be mindful of context usage" ;;
    51) echo "Caution - start wrapping up" ;;
    52) echo "Critical - stop and run safestop" ;;
    53) echo "Emergency - immediate safestop required" ;;
    54) echo "Stale - status line not running" ;;
esac
```

## Setup

To enable context monitoring, configure Claude Code's status line:

```json
// ~/.claude/settings.json
{
  "statusLine": {
    "type": "command",
    "command": "~/.cleo/lib/context-monitor.sh"
  }
}
```

The status line script writes to `.cleo/.context-state.json` with each update (~300ms).

## Output Format

### Text Output
```
Context: 🟢 ok
Usage: 45% (90000 / 200000 tokens)
Updated: 2026-01-02T12:00:00Z
```

### JSON Output
```json
{
  "success": true,
  "version": "1.0.0",
  "timestamp": "2026-01-02T12:00:00Z",
  "contextWindow": {
    "maxTokens": 200000,
    "currentTokens": 90000,
    "percentage": 45
  },
  "status": "ok"
}
```

## See Also

- `cleo safestop` - Graceful shutdown when context limits approached
- [Context Safeguard Spec](../specs/CONTEXT-SAFEGUARD-SPEC.md)
