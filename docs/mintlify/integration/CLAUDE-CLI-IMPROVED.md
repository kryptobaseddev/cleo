# Claude Code CLI - Improved Configuration

Optimized shell functions and aliases for autonomous Claude Code usage. These configurations reduce friction for interactive sessions and enable headless automation.

## Installation

### Option 1: CLEO Installation (Recommended)

The CLEO task management system provides a convenient command to install all optimized Claude Code aliases automatically:

```bash
# Install aliases for all detected shells
cleo setup-claude-aliases

# Install for specific shell only
cleo setup-claude-aliases --shell bash

# Preview changes without installing
cleo setup-claude-aliases --dry-run

# Remove installed aliases
cleo setup-claude-aliases --remove
```

This is the recommended method for CLEO users as it:
- Automatically detects available shells (bash, zsh, powershell, cmd)
- Uses marker-based injection for clean updates and removal
- Integrates with `cleo doctor` for health checks
- Supports idempotent installation (safe to re-run)
- Tracks version for automatic upgrades

After installation, restart your terminal or run:
```bash
source ~/.bashrc  # or source ~/.zshrc
```

For more details, see the [setup-claude-aliases command documentation](../commands/setup-claude-aliases.md).

### Option 2: Manual Installation

Add the following to your `~/.bashrc` or `~/.zshrc`:

```bash
# =============================================================================
# Claude Code Aliases
# =============================================================================

# Base environment for all Claude commands
_cc_env() {
  env \
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=true \
    ENABLE_BACKGROUND_TASKS=true \
    FORCE_AUTO_BACKGROUND_TASKS=true \
    CLAUDE_CODE_ENABLE_UNIFIED_READ_TOOL=true \
    "$@"
}

# -----------------------------------------------------------------------------
# Interactive Modes
# -----------------------------------------------------------------------------

# Standard interactive
cc() {
  _cc_env claude "$@"
}

# YOLO mode - skip all permissions (use in safe environments only)
ccy() {
  _cc_env claude --dangerously-skip-permissions "$@"
}

# Resume last session
ccr() {
  _cc_env claude --resume "$@"
}

# Resume + YOLO
ccry() {
  _cc_env claude --resume --dangerously-skip-permissions "$@"
}

# -----------------------------------------------------------------------------
# Headless Modes (for scripts/CI)
# -----------------------------------------------------------------------------

# Headless - controlled tools, JSON output
cc-headless() {
  _cc_env claude -p \
    --allowedTools "Bash(git:*),Bash(npm:*),Read,Edit" \
    --output-format json \
    "$@"
}

# Headfull - all tools, no restrictions, JSON output
cc-headfull() {
  _cc_env claude -p \
    --dangerously-skip-permissions \
    --output-format json \
    "$@"
}

# Headfull with streaming (see output as it happens)
cc-headfull-stream() {
  _cc_env claude -p \
    --dangerously-skip-permissions \
    --output-format stream-json \
    "$@"
}
```

After adding, activate with:
```bash
source ~/.bashrc  # or source ~/.zshrc
```

---

## Command Reference

### Interactive Commands

| Command | Description | Use Case |
|---------|-------------|----------|
| `cc` | Standard interactive mode with optimized environment | Daily development |
| `ccy` | YOLO mode - skips all permission prompts | Trusted environments, rapid iteration |
| `ccr` | Resume the last Claude session | Continue previous work |
| `ccry` | Resume + YOLO combined | Continue without interruptions |

### Headless Commands

| Command | Description | Use Case |
|---------|-------------|----------|
| `cc-headless` | Controlled tools, JSON output | CI/CD pipelines, safe automation |
| `cc-headfull` | Full tool access, JSON output | Autonomous agents, scripted tasks |
| `cc-headfull-stream` | Full access with streaming JSON | Real-time monitoring, long tasks |

---

## Environment Variables Explained

### Official (Documented)

#### `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=true`

**Status**: Officially documented

**What it disables**:
| Component | Purpose |
|-----------|---------|
| Statsig telemetry | Usage metrics (latency, reliability patterns) |
| Sentry error reporting | Crash and error logs sent to Anthropic |
| Auto-updater | Background version checks and updates |
| `/bug` command | Bug report submission system |

**Benefits**:
- **Privacy**: No telemetry data transmitted to external services
- **Network**: Eliminates background HTTP requests
- **Compliance**: Helps with data governance policies
- **Air-gapped environments**: Required for isolated networks

**Trade-offs**:
- Must manually update Claude Code (`claude update`)
- Cannot use `/bug` to report issues
- Anthropic cannot see errors affecting your usage

**Granular alternatives** (if you want selective control):
```bash
DISABLE_TELEMETRY=1           # Just Statsig metrics
DISABLE_ERROR_REPORTING=1     # Just Sentry crash reports
DISABLE_AUTOUPDATER=1         # Just auto-updates
DISABLE_BUG_COMMAND=1         # Just /bug reports
```

---

### Experimental (Community-Discovered)

These variables are **not officially documented** but have been discovered by the community. They may change or stop working in future versions.

#### `ENABLE_BACKGROUND_TASKS=true`

**Status**: Undocumented / Experimental

**Purpose**: Enables background task functionality for long-running commands in interactive mode.

**Behavior**: Allows Claude to run commands in the background without blocking the conversation. Normally, you would press `Ctrl+B` to background a running command - this may enable automatic backgrounding.

**Note**: The official way to background commands is:
- Press `Ctrl+B` during command execution (interactive)
- Use `run_in_background: true` in prompts (programmatic)

---

#### `FORCE_AUTO_BACKGROUND_TASKS=true`

**Status**: Undocumented / Experimental

**Purpose**: Automatically sends long-running tasks to background without requiring user confirmation.

**Behavior**: When Claude detects a command will take a long time, it automatically backgrounds it instead of asking for confirmation.

**Use case**: Reduces interactive friction when running builds, tests, or installations.

---

#### `CLAUDE_CODE_ENABLE_UNIFIED_READ_TOOL=true`

**Status**: Undocumented / Experimental

**Purpose**: Unifies file reading capabilities across different file types.

**Behavior**: Enables enhanced reading for:
- Standard text files
- Jupyter notebooks (`.ipynb`)
- Potentially other structured formats

**Note**: This may already be default behavior in recent versions.

---

## CLI Flags Explained

### `--dangerously-skip-permissions`

**What it does**: Bypasses ALL permission checks and safety guardrails.

**Implications**:
- No prompts before file edits
- No prompts before bash commands
- No prompts before any tool use
- Full autonomous execution

**Safety warnings** (from Anthropic):
- Intended **only for isolated environments** (Docker containers with no internet)
- Risk of data loss (irreversible file deletion)
- Risk of system compromise (unrestricted command execution)
- Vulnerable to prompt injection attacks

**When to use**:
- Isolated Docker containers
- Sandboxed development environments
- Trusted, well-understood codebases
- When you've reviewed what Claude will do

**When NOT to use**:
- Production systems
- Environments with sensitive data
- Untrusted codebases
- Systems with network access to sensitive resources

---

### `-p` / `--print` (Headless Mode)

**What it does**: Runs Claude non-interactively without the TUI.

**Behavior**:
- Accepts a prompt as argument
- Executes to completion
- Returns structured output
- Exits when done

**Output formats**:
| Format | Flag | Use Case |
|--------|------|----------|
| Text | `--output-format text` | Human reading |
| JSON | `--output-format json` | Parsing, automation |
| Stream JSON | `--output-format stream-json` | Real-time monitoring |

**Example output** (JSON):
```json
{
  "type": "result",
  "subtype": "success",
  "is_error": false,
  "duration_ms": 6526,
  "result": "Task completed successfully",
  "session_id": "a940b2a5-c5d7-444a-aa7e-8930791e3c66",
  "total_cost_usd": 0.39
}
```

---

### `--allowedTools`

**What it does**: Pre-approves specific tools without prompting.

**Syntax**:
```bash
--allowedTools "Tool1,Tool2,Tool3"
--allowedTools "Bash(pattern:*),Read,Edit"
```

**Pattern matching**:
| Pattern | Meaning |
|---------|---------|
| `Bash` | All bash commands |
| `Bash(git:*)` | Only git commands |
| `Bash(npm run:*)` | Only npm run scripts |
| `Read` | All file reads |
| `Edit` | All file edits |
| `Write` | All file writes |

**Example - safe CI configuration**:
```bash
claude -p "Run tests" --allowedTools "Bash(npm test:*),Read"
```

---

### `--resume`

**What it does**: Resumes the most recent Claude session.

**Behavior**:
- Restores conversation context
- Continues where you left off
- Maintains tool approvals from previous session

**With session ID**:
```bash
claude --resume abc123-session-id
```

---

## Usage Examples

### Interactive Development

```bash
# Start a new session
cc

# Start with full permissions (trusted project)
ccy

# Resume yesterday's work
ccr

# Resume with full permissions
ccry
```

### Scripted Automation

```bash
# Run tests and get JSON result
cc-headless "Run the test suite and report failures" | jq '.result'

# Autonomous bug fixing
cc-headfull "Find and fix all TypeScript errors in src/"

# Watch long-running task
cc-headfull-stream "Refactor the authentication module" | while read line; do
  echo "$line" | jq -r '.content // empty'
done
```

### CI/CD Pipeline

```bash
#!/bin/bash
# ci-review.sh - Automated code review

result=$(cc-headless "Review the changes in this PR for bugs and security issues")

if echo "$result" | jq -e '.is_error' > /dev/null; then
  echo "Review failed"
  exit 1
fi

echo "$result" | jq -r '.result'
```

### Chaining Sessions

```bash
# Start a task, get session ID
session=$(cc-headfull "Start refactoring auth module" | jq -r '.session_id')

# Continue in same session
cc-headfull "Continue with the tests" --resume "$session"
```

---

## Configuration Files

### `~/.claude/settings.json`

For persistent permission configuration:

```json
{
  "permissions": {
    "allow": [
      "Bash(git:*)",
      "Bash(npm run:*)",
      "Bash(pnpm:*)",
      "Read",
      "Edit"
    ],
    "deny": [
      "Bash(rm -rf:*)",
      "Bash(curl:*)",
      "Read(.env)",
      "Read(.env.*)"
    ],
    "defaultMode": "acceptEdits"
  }
}
```

### Permission Modes

| Mode | Behavior |
|------|----------|
| `default` | Prompts for each tool on first use |
| `acceptEdits` | Auto-accepts file edits for session |
| `plan` | Read-only, no modifications allowed |
| `bypassPermissions` | Skip all prompts (like `--dangerously-skip-permissions`) |

---

## Troubleshooting

### Functions not found after adding to bashrc

```bash
source ~/.bashrc
type cc  # Should show function definition
```

### Permission denied errors in YOLO mode

YOLO mode skips Claude's permission prompts, not system permissions:
```bash
# Still need sudo for system files
ccy  # Then ask Claude to use sudo if needed
```

### Headless command hangs

Check if Claude is waiting for input:
```bash
# Add timeout
timeout 300 cc-headfull "Your prompt"

# Or use streaming to see progress
cc-headfull-stream "Your prompt"
```

### JSON parsing errors

Ensure you're using headless mode for JSON output:
```bash
# Wrong - interactive mode doesn't output JSON
cc "prompt" | jq '.'

# Right - headless mode outputs JSON
cc-headfull "prompt" | jq '.'
```

---

## Security Considerations

### When using `ccy` / `cc-headfull`:

1. **Understand the risks**: Claude can execute any command without confirmation
2. **Use in isolation**: Prefer Docker containers or VMs for untrusted tasks
3. **Review first**: Consider using `cc` first to see what Claude plans to do
4. **Limit scope**: Use `--allowedTools` instead of full bypass when possible
5. **Monitor output**: Use streaming mode to watch what's happening

### Recommended safe pattern:

```bash
# Instead of full bypass:
cc-headfull "Do everything"

# Use controlled permissions:
cc-headless "Do specific thing" --allowedTools "Read,Edit,Bash(npm test:*)"
```

---

## Related Documentation

- [Claude Code Official Docs](https://docs.anthropic.com/en/docs/claude-code)
- [Claude Code Settings](https://docs.anthropic.com/en/docs/claude-code/settings)
- [Claude Code Headless Mode](https://docs.anthropic.com/en/docs/claude-code/headless)
- [Claude Code Best Practices](https://www.anthropic.com/engineering/claude-code-best-practices)

---

## Version History

| Date | Change |
|------|--------|
| 2025-01-22 | Added CLEO installation method (cleo setup-claude-aliases) |
| 2024-12-31 | Initial documentation |

---

*These configurations are community-optimized and include experimental features. Use at your own discretion.*
