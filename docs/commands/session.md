# session Command

Manage work sessions with automatic logging and context restoration.

## Usage

```bash
cleo session <command> [OPTIONS]
```

## Description

The `session` command manages work sessions to track when you're actively working on tasks. Sessions provide:

- Automatic session ID generation
- Context restoration (focus, notes, next action)
- Session logging in the audit trail
- CLAUDE.md injection version checks

## Subcommands

| Subcommand | Description |
|------------|-------------|
| `start` | Start a new work session |
| `end` | End the current session |
| `status` | Show current session status |
| `info` | Show detailed session information |
| (none) | Show help message (default) |

## Options

| Option | Description |
|--------|-------------|
| `--note TEXT` | Add a note when ending session |
| `--json` | Output in JSON format |
| `--help`, `-h` | Show help message |

## Examples

### Start a Session

```bash
cleo session start
```

Output:
```
[SESSION] Session started: session_20251213_100000_abc123

[INFO] Resume focus: Implement authentication (T001)
[INFO] Last session note: Working on JWT implementation
[INFO] Suggested next action: Write integration tests
```

### End a Session

```bash
# End with a note
cleo session end --note "Completed auth middleware, tests passing"

# End without note
cleo session end
```

Output:
```
[SESSION] Session ended: session_20251213_100000_abc123
[INFO] Note saved: Completed auth middleware, tests passing
```

### Check Session Status

```bash
# Text format
cleo session status

# JSON format
cleo session status --json
```

Output (text):
```
Session Active: session_20251213_100000_abc123
Focus Task: Implement authentication (T001)
Session Note: Working on JWT implementation
Next Action: Write integration tests
```

Output (JSON):
```json
{
  "active": true,
  "sessionId": "session_20251213_100000_abc123",
  "focusTask": "T001",
  "sessionNote": "Working on JWT implementation",
  "nextAction": "Write integration tests"
}
```

### Detailed Session Info

```bash
cleo session info
cleo session info --json
```

Output:
```
=== Session Information ===

Session ID: session_20251213_100000_abc123
Last Modified: 2025-12-13T10:30:00Z

=== Focus State ===
  currentTask: T001
  sessionNote: Working on JWT implementation
  nextAction: Write integration tests

=== Task Counts ===
  Total: 15
  Pending: 10
  Active: 1
  Blocked: 2
  Done: 2
```

## Session Lifecycle

```
┌─────────────────┐
│ session start   │ → Creates activeSession in _meta
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│   (do work)     │ → Tasks, focus, notes
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  session end    │ → Clears activeSession, saves notes
└─────────────────┘
```

## Session ID Format

```
session_YYYYMMDD_HHMMSS_<6hex>
```

Example: `session_20251213_100000_abc123`

## Session State in todo.json

```json
{
  "_meta": {
    "activeSession": "session_20251213_100000_abc123",
    "lastModified": "2025-12-13T10:30:00Z"
  },
  "focus": {
    "currentTask": "T001",
    "sessionNote": "Working on authentication",
    "nextAction": "Write tests"
  }
}
```

## Session Start Behavior

When starting a session:
1. Checks no session is already active
2. Generates new session ID
3. Updates `_meta.activeSession`
4. Logs session start to audit trail
5. Shows current focus context if any
6. Checks CLAUDE.md injection version

## Session End Behavior

When ending a session:
1. Clears `_meta.activeSession`
2. Optionally saves session note to `focus.sessionNote`
3. Logs session end to audit trail
4. Triggers log rotation if configured

## Warning Messages

Session start may show warnings:
- **Session already active**: Another session is running
- **CLAUDE.md injection outdated**: Update recommended

## See Also

- [focus](focus.md) - Manage task focus
- [list](list.md) - View tasks
- [validate](validate.md) - Check project integrity
