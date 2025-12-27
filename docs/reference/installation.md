# CLAUDE-TODO Installation Guide

## Overview

CLAUDE-TODO is a robust task management system designed for Claude Code with anti-hallucination validation, automatic archiving, and comprehensive change logging. This guide covers global installation and per-project initialization.

---

## Prerequisites

Before installing CLAUDE-TODO, ensure your system has the following:

### Required Software

1. **Bash 4.0 or higher**
   ```bash
   bash --version
   # Should output: GNU bash, version 4.0 or higher
   ```

2. **jq (JSON processor)**
   ```bash
   jq --version
   # Should output: jq-1.5 or higher
   ```

   **Installation:**
   - **Ubuntu/Debian**: `sudo apt-get install jq`
   - **macOS**: `brew install jq`
   - **RHEL/CentOS**: `sudo yum install jq`

3. **JSON Schema Validator** (one of the following):
   - **ajv-cli** (recommended): `npm install -g ajv-cli`
   - **jsonschema**: `pip install jsonschema`
   - **jq-based fallback**: Built-in (works without external validator)

4. **Standard Unix utilities**: `sha256sum`, `date`, `grep`, `sed`

### System Requirements

- **Operating System**: Linux, macOS, or WSL2 on Windows
- **Disk Space**: ~10 MB for installation
- **Permissions**: User home directory write access

---

## Global Installation

### Step 1: Clone the Repository

```bash
# Clone the repository
cd /tmp
git clone https://github.com/kryptobaseddev/cleo.git
cd cleo
```

### Step 2: Run the Installation Script

The installer will set up CLAUDE-TODO in `~/.cleo/` by default.

```bash
# Run the installer
chmod +x install.sh
./install.sh
```

**Custom installation directory (optional):**
```bash
# Install to a custom location
CLEO_HOME=/opt/cleo ./install.sh
```

### Step 3: Installation Process

The installer performs the following operations:

1. **Checks for existing installation**
   - Detects `~/.cleo/` directory
   - Compares versions if installation exists
   - Prompts for confirmation before overwriting

2. **Creates directory structure**
   ```
   ~/.cleo/
   ├── schemas/          # JSON Schema definitions
   ├── templates/        # Template files
   ├── scripts/          # Executable scripts
   └── docs/             # Documentation
   ```

3. **Installs core components**
   - Copies schema files for validation
   - Installs configuration templates
   - Makes scripts executable
   - Writes version information

4. **Creates wrapper script**
   - Generates `cleo` command wrapper
   - Configures script routing

5. **Creates symlinks for immediate access**
   - Creates `~/.local/bin/cleo` symlink
   - Creates `~/.local/bin/ct` shortcut symlink
   - Works immediately with Claude Code (no shell restart needed)

6. **Configures shell PATH (backup only)**
   - Adds PATH export to shell config as fallback
   - Adds convenience aliases
   - **Only needed if ~/.local/bin is not already in PATH**

> **Claude Code Compatible**: The installer creates symlinks in `~/.local/bin/`, which is already in PATH for Claude Code and most modern shells. The symlinks work immediately - no manual PATH configuration or shell restart required. The PATH export added to your shell config (~/.bashrc or ~/.zshrc) is a backup measure for shells that don't include ~/.local/bin by default.

### Step 4: Verify Installation

Confirm the installation was successful:

```bash
# Check installation location
ls -la ~/.cleo/

# Verify command wrapper
cleo version
# Should output: 2.1.0 (or current version)

# Display help
cleo help
```

**Expected directory structure:**
```
~/.cleo/
├── VERSION                      # Version file
├── schemas/
│   ├── todo.schema.json         # Main task schema
│   ├── archive.schema.json      # Archive schema
│   ├── config.schema.json       # Configuration schema
│   └── log.schema.json          # Change log schema
├── templates/
│   └── config.template.json     # Default configuration
├── scripts/
│   ├── cleo              # CLI wrapper (executable)
│   ├── init.sh             # Project initialization
│   ├── validate.sh         # Validation script
│   ├── archive.sh          # Archive script
│   └── log.sh              # Logging script
└── docs/
    └── QUICK-REFERENCE.md           # Quick reference

~/.local/bin/                        # Symlinks for PATH access
├── cleo → ~/.cleo/scripts/cleo
└── ct → ~/.cleo/scripts/cleo  (shortcut)
```

---

## Per-Project Initialization

Once globally installed, initialize CLAUDE-TODO in each project where you want task tracking.

### Step 1: Navigate to Project Root

```bash
cd /path/to/your/project
```

### Step 2: Run Initialization Script

```bash
# Initialize with automatic project name (from directory)
cleo init

# Or specify project name explicitly
cleo init my-project-name
```

**Options:**
- `--force`: Overwrite existing files without prompting
- `--no-claude-md`: Skip CLAUDE.md integration
- `-h, --help`: Display help message

### Step 3: What Gets Created

The initialization creates a `.cleo/` subdirectory with the following files:

```
your-project/
└── .cleo/
    ├── todo.json              # Active tasks list
    ├── todo-archive.json      # Completed/archived tasks
    ├── config.json       # Project-specific configuration
    └── todo-log.json          # Change history log
```

#### File Descriptions

**`todo.json`** - Active Tasks
- Current working tasks
- Task status: `pending`, `active`, `blocked`, `done`
- Focus tracking and session notes
- Checksum for integrity verification

**`todo-archive.json`** - Completed Tasks (Immutable)
- Tasks marked as `done` and archived
- Historical statistics
- Cycle time metrics
- **Never modify manually**

**`config.json`** - Configuration
- Archive settings (retention, auto-archive)
- Validation rules (strict mode, checksums)
- Logging preferences
- Session management settings

**`todo-log.json`** - Audit Trail
- Append-only change history
- Task lifecycle events
- Session start/end records
- Integrity verification

### Step 4: Configure .gitignore

**Recommended**: Exclude todo files from version control to prevent conflicts.

Add to `.gitignore`:
```gitignore
# CLAUDE-TODO files (exclude from version control)
.cleo/todo.json
.cleo/todo-archive.json
.cleo/todo-log.json
.cleo/.backups/

# Optional: Keep config in version control
# Remove this line to track config.json
.cleo/config.json
```

**Alternative**: Track only configuration
```gitignore
# CLAUDE-TODO files
.cleo/todo.json
.cleo/todo-archive.json
.cleo/todo-log.json
.cleo/.backups/
# Note: config.json is tracked for team consistency
```

### Step 5: CLAUDE.md Integration (Optional)

If your project has a `CLAUDE.md` file, the initialization script automatically adds task management instructions.

**Added section:**
```markdown
<!-- CLAUDE-TODO:START -->
## Task Management

Tasks in `.cleo/todo.json`. **Read at session start, verify checksum.**

### Protocol
- **START**: Read .cleo/config.json → Read .cleo/todo.json → Verify checksum → Log session_start
- **WORK**: ONE active task only → Update notes → Log changes to .cleo/todo-log.json
- **END**: Update sessionNote → Update checksum → Log session_end

### Anti-Hallucination
- **ALWAYS** verify checksum before writing
- **NEVER** have 2+ active tasks
- **NEVER** modify .cleo/todo-archive.json
- **ALWAYS** log all changes

### Files
- `.cleo/todo.json` - Active tasks
- `.cleo/todo-archive.json` - Completed (immutable)
- `.cleo/config.json` - Settings
- `.cleo/todo-log.json` - Audit trail
<!-- CLAUDE-TODO:END -->
```

To skip this integration, use:
```bash
cleo init --no-claude-md
```

---

## Verification Steps

After installation and initialization, verify the system is working correctly.

### 1. Verify Global Installation

```bash
# Check version
cleo version
# Expected: 2.1.0

# Display help
cleo help
# Expected: Command list with usage

# Verify schema files
ls ~/.cleo/schemas/
# Expected: todo.schema.json, archive.schema.json, config.schema.json, log.schema.json

# Check executability
[ -x ~/.cleo/scripts/cleo ] && echo "✓ Executable" || echo "✗ Not executable"
```

### 2. Verify Project Initialization

```bash
# From your project directory
cd /path/to/your/project

# Check .claude directory
ls -la .cleo/
# Expected: todo.json, todo-archive.json, config.json, todo-log.json

# Validate todo.json structure
cleo validate
# Expected: "✓ Validation passed" or specific errors

# Check file permissions
ls -l .cleo/
# Expected: -rw-r--r-- (644) for all JSON files
```

### 3. Test Basic Operations

```bash
# Validate todo files
cleo validate
# Expected: ✓ All files valid

# Try dry-run archive
cleo archive --dry-run
# Expected: No tasks to archive (or list of archivable tasks)

# Check log entries
cat .cleo/todo-log.json | jq '.entries | length'
# Expected: 1 (initialization entry)
```

---

## Troubleshooting Installation

### Issue: Command Not Found

**Symptom:**
```bash
$ cleo version
bash: cleo: command not found
```

**Solutions:**

1. **Check symlink exists:**
   ```bash
   ls -l ~/.local/bin/cleo
   # Should show: ~/.local/bin/cleo -> /home/username/.cleo/scripts/cleo
   ```

2. **Verify ~/.local/bin is in PATH:**
   ```bash
   echo $PATH | grep ".local/bin"
   # Should show: /home/username/.local/bin
   ```

3. **If ~/.local/bin not in PATH, reload shell configuration:**
   ```bash
   source ~/.bashrc  # or ~/.zshrc
   # This activates the PATH export added by installer
   ```

4. **Use absolute path temporarily:**
   ```bash
   ~/.local/bin/cleo version
   # or
   ~/.cleo/scripts/cleo version
   ```

5. **Check script permissions:**
   ```bash
   ls -l ~/.cleo/scripts/cleo
   # Should be: -rwxr-xr-x (executable)

   # Fix if needed:
   chmod +x ~/.cleo/scripts/cleo
   ```

### Issue: Permission Denied

**Symptom:**
```bash
$ cleo init
bash: /home/username/.cleo/scripts/init.sh: Permission denied
```

**Solution:**
```bash
# Make all scripts executable
chmod +x ~/.cleo/scripts/*.sh

# Or fix installation
cd /path/to/cleo-repo
./install.sh --force
```

### Issue: jq Not Installed

**Symptom:**
```bash
$ cleo validate
Error: jq command not found
```

**Solutions:**
- **Ubuntu/Debian**: `sudo apt-get install jq`
- **macOS**: `brew install jq`
- **RHEL/CentOS**: `sudo yum install jq`
- **Windows (WSL)**: `sudo apt-get install jq`

### Issue: Validation Fails

**Symptom:**
```bash
$ cleo validate
Error: Invalid JSON schema
```

**Diagnostic steps:**

1. **Check JSON syntax:**
   ```bash
   cat .cleo/todo.json | jq empty
   # No output = valid JSON
   # Error = syntax issue
   ```

2. **Verify schema path:**
   ```bash
   head -n 3 .cleo/todo.json
   # Should show: "$schema": "./schemas/todo.schema.json"
   ```

3. **Validate manually:**
   ```bash
   cleo validate --fix
   # Attempts automatic repairs
   ```

4. **Check file integrity:**
   ```bash
   # Re-initialize with backup
   mv .claude .claude.backup
   cleo init
   ```

### Issue: Files Already Exist

**Symptom:**
```bash
$ cleo init
[ERROR] .cleo/todo.json already exists. Use --force to overwrite.
```

**Solutions:**

1. **Force overwrite (destroys existing data):**
   ```bash
   cleo init --force
   ```

2. **Backup existing files:**
   ```bash
   # Create backup
   mkdir -p .claude-backups
   cp -r .cleo/* .claude-backups/

   # Then force init
   cleo init --force
   ```

3. **Manual cleanup:**
   ```bash
   rm -rf .cleo/
   cleo init
   ```

### Issue: Checksum Mismatch

**Symptom:**
```bash
Error: Checksum verification failed
Expected: abc123def456
Actual:   xyz789ghi012
```

**Solution:**
```bash
# Recalculate checksum
echo -n '[]' | sha256sum | cut -c1-16
# Copy result to _meta.checksum in todo.json

# Or use validation fix
cleo validate --fix
```

### Issue: Installation Directory Conflicts

**Symptom:**
```bash
$ ./install.sh
[WARN] Existing installation found at /home/username/.cleo
```

**Solutions:**

1. **Upgrade existing installation:**
   ```bash
   ./install.sh
   # Answer 'y' to overwrite prompt
   ```

2. **Clean install:**
   ```bash
   rm -rf ~/.cleo
   ./install.sh
   ```

3. **Install to different location:**
   ```bash
   CLEO_HOME=/opt/cleo ./install.sh
   export PATH="$PATH:/opt/cleo/scripts"
   ```

### Issue: CLAUDE.md Not Updated

**Symptom:**
CLAUDE.md exists but no task section added.

**Cause:**
Existing `<!-- CLAUDE-TODO:START -->` marker detected.

**Solutions:**

1. **Check for existing integration:**
   ```bash
   grep "CLAUDE-TODO:START" CLAUDE.md
   ```

2. **Manually add section:**
   - Copy content from `~/.cleo/docs/QUICK-REFERENCE.md`
   - Paste into CLAUDE.md

3. **Re-initialize without CLAUDE.md:**
   ```bash
   cleo init --no-claude-md
   ```

---

## Upgrade/Update Instructions

### Upgrading CLAUDE-TODO

```bash
# Navigate to repository
cd /path/to/cleo

# Pull latest changes
git pull origin main

# Run installer (will prompt before overwriting)
./install.sh

# Verify new version
cleo version
```

### Migrating Projects

If schema versions change, existing project files may need migration:

```bash
# Backup current data
cp .cleo/todo.json .cleo/todo.json.backup

# Run validation
cleo validate

# If validation fails due to schema changes, re-initialize
mv .claude .claude-old
cleo init

# Manually migrate tasks from .claude-old/todo.json to .cleo/todo.json
```

---

## Uninstallation

### Remove Global Installation

```bash
# Remove installation directory
rm -rf ~/.cleo

# Remove PATH entry from shell config
# Edit ~/.bashrc, ~/.zshrc, or ~/.config/fish/config.fish
# Delete line: export PATH="$PATH:$HOME/.cleo/scripts"

# Reload shell
source ~/.bashrc  # or restart terminal
```

### Remove Per-Project Files

```bash
# From project directory
rm -rf .cleo/

# Remove .gitignore entries (if added)
# Edit .gitignore and remove .cleo/ references

# Remove CLAUDE.md integration (if added)
# Edit CLAUDE.md and remove section between:
# <!-- CLAUDE-TODO:START --> and <!-- CLAUDE-TODO:END -->
```

---

## Next Steps

After successful installation and initialization:

1. **Read Quick Reference**: `~/.cleo/docs/QUICK-REFERENCE.md`
2. **Configure settings**: Edit `.cleo/config.json` for your workflow
3. **Add first task**: Manually edit `.cleo/todo.json` or use Claude Code
4. **Learn workflows**: See `usage.md` for complete task management patterns
5. **Understand schemas**: Review `architecture/SCHEMAS.md` for data structures

---

## Support and Resources

- **Documentation**: `~/.cleo/docs/`
- **Issue Tracker**: GitHub repository issues
- **Schema Reference**: `architecture/SCHEMAS.md`
- **Configuration Guide**: `configuration.md`
- **Troubleshooting**: `troubleshooting.md`

---

## Summary

**Global Installation:**
1. Clone repository
2. Run `./install.sh`
3. Add `~/.cleo/scripts` to PATH
4. Verify with `cleo version`

**Per-Project Initialization:**
1. Navigate to project root: `cd /path/to/project`
2. Run `cleo init`
3. Add `.cleo/*.json` to `.gitignore`
4. Verify with `cleo validate`

**Key Files Created:**
- `~/.cleo/` - Global installation directory
- `.cleo/todo.json` - Active tasks (per-project)
- `.cleo/todo-archive.json` - Completed tasks (per-project)
- `.cleo/config.json` - Configuration (per-project)
- `.cleo/todo-log.json` - Change history (per-project)

**Task Status Values:**
- `pending` - Not started
- `active` - Currently working on (max 1)
- `blocked` - Waiting on dependency
- `done` - Completed (ready for archive)

Installation complete! Proceed to `usage.md` for task management workflows.
