---
title: "self-update"
description: "Update CLEO to the latest version from GitHub releases"
icon: "cloud-arrow-down"
---

# self-update Command

Update CLEO to the latest version from GitHub releases. Supports version checking, specific version installation, and automatic backup creation.

## Usage

```bash
cleo self-update [OPTIONS]
```

## Description

The `self-update` command allows CLEO to update itself from GitHub releases. It downloads the release tarball, verifies the SHA256 checksum, creates a backup of the current installation, and runs the bundled installer.

This command is essential for:
- Keeping CLEO up to date with bug fixes and features
- Upgrading to specific versions
- Scripted/automated update workflows
- Checking if updates are available without installing

**Note:** For development mode installations (symlinks to git repository), use `git pull` instead of `self-update`.

## Options

| Option | Short | Description | Default |
|--------|-------|-------------|---------|
| `--check` | | Check if update is available without installing | `false` |
| `--status` | | Show current and latest version information | `false` |
| `--version VERSION` | | Update to specific version (e.g., "0.58.0") | (latest) |
| `--force` | | Skip confirmation prompts | `false` |
| `--format FMT` | `-f` | Output format: `json` or `human` | TTY-aware |
| `--json` | | Shorthand for `--format json` | |
| `--human` | | Shorthand for `--format human` | |
| `--quiet` | `-q` | Suppress non-essential output | `false` |
| `--help` | `-h` | Show help message | |

### Mode Switching Options

| Option | Description |
|--------|-------------|
| `--to-release` | Switch from dev mode to release mode (downloads latest release) |
| `--to-dev PATH` | Switch from release mode to dev mode (creates symlinks to repo at PATH) |

## Exit Codes

| Code | Name | Description |
|------|------|-------------|
| 0 | Success | Update successful or already up to date |
| 1 | Update Available | Update available (with `--check`) |
| 2 | Download Failed | Failed to download release from GitHub |
| 3 | Checksum Mismatch | SHA256 verification failed |
| 4 | Install Failed | Installation process failed |
| 5 | GitHub API Error | Failed to query GitHub API |
| 100 | Dev Mode | Development installation (use git pull or --to-release) |
| 101 | Mode Switch Success | Mode switch completed successfully |
| 102 | Invalid Repo | Invalid repository path for --to-dev |

## Examples

### Check for Updates

```bash
# Check if a newer version is available
cleo self-update --check
```

Output when update available:
```
Current version: 0.56.0
Latest version:  0.57.0

Update available: 0.56.0 -> 0.57.0
Run 'cleo self-update' to install
```

Output when up to date:
```
Current version: 0.57.0
Latest version:  0.57.0

Already up to date
```

**Exit code behavior:** Returns 1 if update available (useful for scripting), 0 if up to date.

### Show Version Status

```bash
# Display detailed version information
cleo self-update --status
```

Output:
```
CLEO Version Status
===================

Installed:  0.56.0
Latest:     0.57.0
Up to date: No

Installation path: /home/user/.cleo
Mode: Release
```

### Update to Latest Version

```bash
# Update to the latest release
cleo self-update
```

Output:
```
Checking for updates...

Update CLEO from v0.56.0 to v0.57.0?
Continue? [y/N] y

Downloading v0.57.0...
Verifying checksum...
Creating backup...
Installing v0.57.0...

Successfully updated CLEO to v0.57.0

Backup created at:
  /home/user/.cleo/backups/self-update/pre-update_20260120_143000.*

Run 'cleo --version' to verify
```

### Update to Specific Version

```bash
# Install a specific version
cleo self-update --version 0.55.0

# Version can include 'v' prefix
cleo self-update --version v0.55.0
```

### Non-Interactive Update

```bash
# Skip confirmation prompts (for scripts/CI)
cleo self-update --force
```

### JSON Output

```bash
# Get update status as JSON
cleo self-update --status --json
```

Output:
```json
{
  "$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
  "_meta": {
    "format": "json",
    "command": "self-update",
    "timestamp": "2026-01-20T14:30:00Z"
  },
  "current_version": "0.56.0",
  "latest_version": "0.57.0",
  "update_available": true,
  "action": "status",
  "message": ""
}
```

### Scripted Update Workflow

```bash
#!/usr/bin/env bash
# Automated update script

# Check if update available (exit code 1 = update available)
if ! cleo self-update --check --quiet; then
    echo "Update available, proceeding..."

    # Create manual backup first
    cleo backup --name "pre-auto-update"

    # Perform update
    if cleo self-update --force; then
        echo "Update successful"
        cleo --version
    else
        echo "Update failed, restoring from backup..."
        # Restore logic here
    fi
else
    echo "Already up to date"
fi
```

## Mode Switching

CLEO supports two installation modes: **development** (symlinks to a local repository) and **release** (copied files from GitHub releases). The `self-update` command provides options to switch between these modes.

### Switch from Dev to Release Mode

When you want to transition from a development installation to a stable release:

```bash
# Switch to release mode (downloads latest release)
cleo self-update --to-release

# Non-interactive switch
cleo self-update --to-release --force
```

**What happens:**
1. Creates backup of current installation
2. Removes symlinks to development repository
3. Downloads latest release from GitHub
4. Installs release files to `~/.cleo`

### Switch from Release to Dev Mode

When you want to contribute or test development changes:

```bash
# Switch to dev mode (requires path to local repository)
cleo self-update --to-dev /path/to/cleo-repo

# Non-interactive switch
cleo self-update --to-dev /path/to/cleo-repo --force
```

**What happens:**
1. Creates backup of current installation
2. Removes copied release files
3. Validates the repository structure
4. Creates symlinks to the local repository

**Repository validation checks:**
- Directory exists
- Contains `VERSION` file
- Contains `scripts/` directory
- Contains `lib/` directory
- Contains `scripts/cleo.sh` entry point

### Mode Switching Examples

```bash
# Check current mode
cleo self-update --status

# Switch from dev to release
cleo self-update --to-release

# Switch from release to dev (absolute path)
cleo self-update --to-dev ~/projects/cleo

# Switch from release to dev (relative path - resolved to absolute)
cleo self-update --to-dev ./cleo

# Re-point dev mode to different repository
cleo self-update --to-dev /new/path/to/cleo-repo --force
```

### JSON Output for Mode Switching

```bash
# Switch to release mode with JSON output
cleo self-update --to-release --json
```

Output:
```json
{
  "$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
  "_meta": {
    "format": "json",
    "command": "self-update",
    "timestamp": "2026-01-20T14:30:00Z"
  },
  "success": true,
  "action": "mode_switch",
  "from_mode": "dev",
  "to_mode": "release",
  "version": "0.57.0",
  "message": "Successfully switched to release mode v0.57.0"
}
```

## Development Mode

For development installations (symlinks to a git repository), regular `self-update` (without mode switching flags) detects this and exits with code 100:

```bash
$ cleo self-update

[INFO] Development mode detected.

CLEO is installed in development mode (symlinked to source repository).

To update:
  cd /path/to/cleo-repo && git pull

To switch to release mode:
  cleo self-update --to-release
```

**Development mode detection checks:**
1. Is the `cleo` binary a symlink?
2. Is `~/.cleo/scripts` a symlink?
3. Does `~/.cleo/.git` directory exist?

If any of these are true, CLEO is in development mode.

## How Self-Update Works

1. **Version Check**: Queries GitHub API for latest release (or specific version if `--version` specified)
2. **Comparison**: Compares current version with target version using semver
3. **Confirmation**: Prompts for confirmation (unless `--force`)
4. **Download**: Fetches release tarball from GitHub
5. **Verification**: Validates SHA256 checksum (if available in release)
6. **Backup**: Creates backup in `~/.cleo/backups/self-update/`
7. **Installation**: Extracts tarball and runs bundled installer

## Backup Location

Self-update creates backups before updating:

```
~/.cleo/backups/self-update/
├── pre-update_20260120_143000.scripts/
├── pre-update_20260120_143000.lib/
└── pre-update_20260120_143000.VERSION
```

These can be used to manually restore if needed.

## GitHub API

Self-update queries the GitHub API at:
- Latest release: `https://api.github.com/repos/kryptobaseddev/cleo/releases/latest`
- Specific version: `https://api.github.com/repos/kryptobaseddev/cleo/releases/tags/vX.Y.Z`

**Rate limiting:** GitHub API has rate limits (60 requests/hour for unauthenticated). For frequent checks, consider caching or using authenticated requests.

## Troubleshooting

### GitHub API Error

```bash
ERROR: GitHub API returned HTTP 404
```

**Causes:**
- No releases exist yet
- Specified version doesn't exist
- Network connectivity issues

**Solutions:**
- Check available releases: https://github.com/kryptobaseddev/cleo/releases
- Verify version exists
- Check network connectivity

### Checksum Mismatch

```bash
ERROR: Checksum mismatch
  Expected: abc123...
  Got: def456...
```

**Causes:**
- Download was corrupted
- Release was tampered with
- Incomplete download

**Solutions:**
- Retry the update
- Manually download and verify from GitHub
- Report if issue persists

### Installation Failed

```bash
ERROR: Installation failed
```

**Causes:**
- Permission issues
- Disk space
- Incomplete extraction

**Solutions:**
- Check permissions on `~/.cleo`
- Verify disk space
- Check backup for restore: `~/.cleo/backups/self-update/`

### Development Mode Detected

```bash
CLEO is installed in development mode.
```

**This is not an error.** For development installations:

```bash
# Update via git instead
cd /path/to/cleo-repo
git pull
```

## Related Commands

- `cleo version` - Show current CLEO version
- `cleo --validate` - Validate CLEO installation
- `cleo backup` - Create backup of task data
- `cleo upgrade` - Upgrade project schemas and configuration

## Tips

1. **Check Before Update**: Use `--check` to see what's available before committing
2. **Backup First**: Self-update creates automatic backups, but consider manual backup of task data
3. **Review Release Notes**: Check GitHub releases for breaking changes before updating
4. **Use Specific Versions**: In CI/CD, pin to specific versions with `--version`
5. **Test Updates**: On critical systems, test updates in a development environment first
6. **Mode Switching**: Use `--to-release` or `--to-dev` to switch installation modes without reinstalling

## See Also

- [Installation Modes Guide](../guides/INSTALLATION-MODES.md) - Detailed guide on dev vs release modes
- [Installer Architecture](../guides/installer-architecture.md) - Technical details of the installer
- [Installer Migration](../guides/installer-migration.md) - Migrating from legacy installer

## Version History

- **v0.58.0**: Added mode switching with `--to-release` and `--to-dev` flags
- **v0.57.0**: Initial implementation of self-update command
