# context Command

> Monitor context window usage for agent safeguard system

## Usage

```bash
cleo context [SUBCOMMAND] [OPTIONS]
```

**Output**: Text by default (TTY), JSON when piped

## Subcommands

| Subcommand | Description | Default |
|------------|-------------|---------|
| `status` | Show current context state | Yes |
| `check` | Check threshold, return exit code for scripting | |
| `list` | List all context state files (multi-session) | |
| `watch` | Continuous monitoring mode (planned) | |

## Options

| Option | Short | Description | Default |
|--------|-------|-------------|---------|
| `--session` | | Check specific CLEO session ID | current/global |
| `--format` | `-f` | Output format (text\|json) | auto |
| `--json` | | Shortcut for `--format json` | |
| `--human` | | Shortcut for `--format text` | |
| `--help` | `-h` | Show help message | |

## Exit Codes

The `check` subcommand returns exit codes based on context usage thresholds:

| Code | Status | Usage | Action |
|------|--------|-------|--------|
| 0 | OK | <70% | Continue normally |
| 50 | Warning | 70-84% | Consider wrapping up |
| 51 | Caution | 85-89% | Start graceful shutdown |
| 52 | Critical | 90-94% | Immediate safe stop |
| 53 | Emergency | 95%+ | Emergency shutdown |
| 54 | Stale | N/A | No data or stale timestamp |

## Session Binding

Context tracking is session-aware:

- **With active CLEO session**: Reads session-specific state file (`.context-state-{sessionId}.json`)
- **Without session**: Reads global `.context-state.json`
- **Multi-session**: Each agent has isolated context tracking

## Examples

### Show Current Status

```bash
cleo context
# Context: 🟢 ok
# Usage: 45% (90000 / 200000 tokens)
# Updated: 2026-01-03T17:20:00Z
```

### JSON Output

```bash
cleo context status --json
```

Output:
```json
{
  "success": true,
  "status": "ok",
  "contextWindow": {
    "percentage": 45,
    "currentTokens": 90000,
    "maxTokens": 200000
  },
  "timestamp": "2026-01-03T17:20:00Z"
}
```

### Scripting with Exit Codes

```bash
# Check threshold and act
if ! cleo context check; then
  cleo safestop --reason "context-limit"
fi

# More granular handling
cleo context check
case $? in
  0)  echo "OK - continue" ;;
  50) echo "Warning - wrap up soon" ;;
  51) echo "Caution - start shutdown" ;;
  52) echo "Critical - stop now" ;;
  53) echo "Emergency - immediate stop" ;;
  54) echo "Stale - no data" ;;
esac
```

### List All Context Files (Multi-Session)

```bash
cleo context list
# Context state files:
#   .context-state.json                      45% ok         2026-01-03T17:20:00Z
#   .context-state-session_abc123.json       72% warning    2026-01-03T17:19:30Z
```

### Check Specific Session

```bash
cleo context --session abc123
```

## State File Schema

The context state file (`.context-state.json`) contains:

```json
{
  "timestamp": "2026-01-03T17:20:00Z",
  "status": "ok",
  "contextWindow": {
    "percentage": 45,
    "currentTokens": 90000,
    "maxTokens": 200000
  },
  "staleAfterMs": 5000,
  "sessionId": "session_abc123"
}
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

## Agent Loop Pattern

```bash
# Start of agent work loop
while true; do
  # Check context before major operations
  if ! cleo context check; then
    echo "Context limit reached, initiating graceful shutdown"
    cleo safestop --reason "context-limit"
    break
  fi

  # Do work...
done
```

## Related Commands

- `session` - Work session lifecycle management
- `safestop` - Graceful agent shutdown (planned)
- `dash` - Project dashboard (includes context status when available)

## Automatic Alerts

When a CLEO session is active, context alerts trigger automatically after key task operations:

- Task completion (`cleo complete`)
- Focus changes (`cleo focus set`)
- Task creation (`cleo add`)
- Session lifecycle (`cleo session start`, `cleo session end`)

Alerts appear on **stderr BEFORE command output**, ensuring visibility while keeping JSON output on stdout clean.

### Alert Format

Alerts use a visual box format with Unicode characters (fallback to ASCII on unsupported terminals):

```
╔═══════════════════════════════════════════════════════════╗
║ 🟡  WARNING: Context window at 78%                        ║
║   Usage: 156000/200000 tokens                             ║
║   Monitor: Consider session cleanup soon                  ║
╚═══════════════════════════════════════════════════════════╝
```

Threshold levels:
- **🟡 Warning (70-84%)**: Monitor and consider cleanup soon
- **🟠 Caution (85-89%)**: Consider `ct archive; ct session suspend`
- **🔴 Critical (90-94%)**: Recommended: `ct session end --note "..."`
- **🚨 Emergency (95%+)**: IMMEDIATE: `ct session end --note "..."`

### Alert Behavior

Alerts only trigger on **threshold crossings** (not every command):
- First time crossing into warning zone → Alert
- Staying in warning zone → No repeat alert
- Crossing from warning to caution → New alert
- Dropping below threshold then crossing again → Alert

### Configuration

Configure alert behavior with `cleo config`:

```bash
# Enable/disable alerts
cleo config set contextAlerts.enabled true

# Set minimum threshold (warning|caution|critical|emergency)
cleo config set contextAlerts.minThreshold warning

# Suppress repeat alerts for N seconds
cleo config set contextAlerts.suppressDuration 300

# Limit alerts to specific commands (empty array = all commands)
cleo config set contextAlerts.triggerCommands '["complete","add","focus"]'
```

See [Configuration Guide](../config-reference.md) for full details.

### Session-Only Alerts

Alerts **only** trigger when a CLEO session is active. Without an active session:
- Context monitoring continues (statusline updates)
- Manual `cleo context` commands work
- Automatic alerts are suppressed

This prevents alert noise during non-session CLI usage.

## Version History

- **v0.48.0**: Automatic context alerts during session workflow
- **v0.46.0**: Initial implementation as part of Context Safeguard System
