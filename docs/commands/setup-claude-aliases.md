# setup-claude-aliases

Install optimized Claude Code CLI aliases across shells.

## Synopsis

```bash
cleo setup-claude-aliases [OPTIONS]
```

## Description

The `setup-claude-aliases` command installs a set of optimized aliases for Claude Code CLI into your shell configuration files. These aliases provide:

- Pre-configured environment variables for improved performance
- Quick access to interactive and headless modes
- Session resume functionality
- Controlled vs. unrestricted execution modes

The command uses marker-based injection for idempotent installation, allowing safe re-runs and upgrades.

## Options

| Option | Description |
|--------|-------------|
| `--dry-run` | Preview changes without modifying files |
| `--force` | Force reinstall even if current version installed |
| `--shell SHELL` | Target specific shell (bash\|zsh\|powershell\|cmd) |
| `--remove` | Remove installed aliases |
| `-f, --format FMT` | Output format: text (default) or json |
| `--json` | Shorthand for --format json |
| `-q, --quiet` | Suppress non-essential output |
| `-h, --help` | Show help message |

## Aliases Installed

| Alias | Mode | Description |
|-------|------|-------------|
| `cc` | Interactive | Standard mode with optimized environment |
| `ccy` | Interactive | Skip permissions (for trusted projects) |
| `ccr` | Interactive | Resume previous session |
| `ccry` | Interactive | Resume + skip permissions |
| `cc-headless` | Headless | Controlled tools, JSON output |
| `cc-headfull` | Headless | Full autonomy, JSON output |
| `cc-headfull-stream` | Headless | Full autonomy, streaming JSON |

### Interactive Aliases

| Alias | Command | Use Case |
|-------|---------|----------|
| `cc` | `claude` | Daily development |
| `ccy` | `claude --dangerously-skip-permissions` | Trusted environments, rapid iteration |
| `ccr` | `claude --resume` | Continue previous work |
| `ccry` | `claude --resume --dangerously-skip-permissions` | Continue without interruptions |

### Headless Aliases

| Alias | Command | Use Case |
|-------|---------|----------|
| `cc-headless` | `claude --print --allowedTools` | CI/CD pipelines, safe automation |
| `cc-headfull` | `claude --print --dangerously-skip-permissions` | Autonomous agents, scripted tasks |
| `cc-headfull-stream` | `claude --print --dangerously-skip-permissions --output-format stream-json` | Real-time monitoring |

## Environment Variables

All aliases automatically set these environment variables:

| Variable | Value | Purpose |
|----------|-------|---------|
| `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` | `true` | Disables telemetry, auto-updater |
| `ENABLE_BACKGROUND_TASKS` | `true` | Enables background task functionality |
| `FORCE_AUTO_BACKGROUND_TASKS` | `true` | Auto-backgrounds long-running tasks |
| `CLAUDE_CODE_ENABLE_UNIFIED_READ_TOOL` | `true` | Enhanced file reading |

## Supported Shells

| Shell | RC File | Platform |
|-------|---------|----------|
| bash | `~/.bashrc` or `~/.bash_profile` | All |
| zsh | `~/.zshrc` | All |
| powershell | `~/Documents/PowerShell/Microsoft.PowerShell_profile.ps1` (Windows) or `~/.config/powershell/Microsoft.PowerShell_profile.ps1` (Unix) | All |
| cmd | `~/cleo-aliases.cmd` | Windows |

## Examples

```bash
# Install for all detected shells
cleo setup-claude-aliases

# Install for specific shell only
cleo setup-claude-aliases --shell zsh

# Preview changes without installing
cleo setup-claude-aliases --dry-run

# Force reinstall (even if current)
cleo setup-claude-aliases --force

# Remove all installed aliases
cleo setup-claude-aliases --remove

# JSON output for scripting
cleo setup-claude-aliases --json
```

### Post-Installation

After installation, activate the aliases:

```bash
# Bash
source ~/.bashrc

# Zsh
source ~/.zshrc

# PowerShell
. $PROFILE
```

Or restart your terminal.

### Using the Aliases

```bash
# Start interactive session
cc

# Start with full permissions (trusted project)
ccy

# Resume yesterday's work
ccr

# Run headless task with JSON result
cc-headfull "Refactor the auth module" | jq '.result'

# Watch long-running task with streaming
cc-headfull-stream "Run full test suite"
```

## Exit Codes

| Code | Name | Description |
|:----:|------|-------------|
| 0 | Success | Aliases installed/removed successfully |
| 2 | `E_INVALID_INPUT` | Invalid option or shell type |
| 5 | `E_DEPENDENCY_ERROR` | Claude CLI not installed |
| 102 | `E_NO_CHANGE` | No changes needed (aliases already current) |

## Output Structure (JSON)

```json
{
  "success": true,
  "version": "1.0.0",
  "removeMode": false,
  "installed": 2,
  "skipped": 0,
  "removed": 0,
  "failed": 0,
  "results": [
    {"action": "added", "file": "/home/user/.bashrc", "version": "1.0.0"},
    {"action": "added", "file": "/home/user/.zshrc", "version": "1.0.0"}
  ]
}
```

### Action Values

| Action | Meaning |
|--------|---------|
| `created` | New RC file created with aliases |
| `added` | Aliases appended to existing RC file |
| `updated` | Existing aliases replaced with new version |
| `skipped` | No changes needed (already current or not installed) |
| `removed` | Aliases removed from RC file |
| `failed` | Operation failed (see reason) |

## Doctor Integration

The `cleo doctor` command checks alias installation status as part of global health checks:

```bash
cleo doctor --global

# Output includes:
# CLAUDE ALIASES:
# ✓ bash: installed (v1.0.0)
# ✓ zsh: installed (v1.0.0)
# ⚠ powershell: not installed
```

To fix detected issues:

```bash
cleo doctor --fix
# Or install directly:
cleo setup-claude-aliases
```

## Marker-Based Injection

Aliases are injected between markers for safe, idempotent updates:

```bash
# CLEO-CLAUDE-ALIASES:START v1.0.0
# ... alias definitions ...
# CLEO-CLAUDE-ALIASES:END
```

This pattern allows:
- Safe re-installation (replaces existing block)
- Version tracking for upgrades
- Clean removal without affecting other content

## Security Considerations

### When Using `ccy` / `cc-headfull`

These aliases skip all permission prompts. Use only in:
- Isolated Docker containers
- Sandboxed development environments
- Trusted, well-understood codebases

Avoid using in:
- Production systems
- Environments with sensitive data
- Untrusted codebases

### Safer Alternative

Use `cc-headless` with `--allowedTools` for controlled automation:

```bash
cc-headless "Run tests" --allowedTools "Bash(npm test:*),Read"
```

## Implementation

| Component | Location |
|-----------|----------|
| Main script | `scripts/setup-claude-aliases.sh` |
| Library | `lib/claude-aliases.sh` |
| Constants | `CLAUDE_ALIASES_VERSION`, `SUPPORTED_SHELLS` |

## Version History

| Version | Changes |
|---------|---------|
| 1.0.0 | Initial release |

---

**See also**: `cleo doctor`, [CLAUDE-CLI-IMPROVED.md](../integration/CLAUDE-CLI-IMPROVED.md)
