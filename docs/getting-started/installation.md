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
git clone https://github.com/kryptobaseddev/claude-todo.git
cd claude-todo
```

### Step 2: Run the Installation Script

The installer will set up CLAUDE-TODO in `~/.claude-todo/` by default.

```bash
# Run the installer
chmod +x install.sh
./install.sh
```

**Custom installation directory (optional):**
```bash
# Install to a custom location
CLAUDE_TODO_HOME=/opt/claude-todo ./install.sh
```

### Step 3: Installation Process

The installer performs the following operations:

1. **Checks for existing installation**
   - Detects `~/.claude-todo/` directory
   - Compares versions if installation exists
   - Prompts for confirmation before overwriting

2. **Creates directory structure**
   ```
   ~/.claude-todo/
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
   - Generates `claude-todo` command wrapper
   - Configures script routing

5. **Creates symlinks for immediate access**
   - Creates `~/.local/bin/claude-todo` symlink
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
ls -la ~/.claude-todo/

# Verify command wrapper
claude-todo version
# Should output: 2.1.0 (or current version)

# Display help
claude-todo help
```

**Expected directory structure:**
```
~/.claude-todo/
├── VERSION                      # Version file
├── schemas/
│   ├── todo.schema.json         # Main task schema
│   ├── archive.schema.json      # Archive schema
│   ├── config.schema.json       # Configuration schema
│   └── log.schema.json          # Change log schema
├── templates/
│   └── config.template.json     # Default configuration
├── scripts/
│   ├── claude-todo              # CLI wrapper (executable)
│   ├── init.sh             # Project initialization
│   ├── validate.sh         # Validation script
│   ├── archive.sh          # Archive script
│   └── log.sh              # Logging script
└── docs/
    └── QUICK-REFERENCE.md           # Quick reference

~/.local/bin/                        # Symlinks for PATH access
├── claude-todo → ~/.claude-todo/scripts/claude-todo
└── ct → ~/.claude-todo/scripts/claude-todo  (shortcut)
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
claude-todo init

# Or specify project name explicitly
claude-todo init my-project-name
```

**Options:**
- `--force`: Overwrite existing files without prompting
- `--no-claude-md`: Skip CLAUDE.md integration
- `-h, --help`: Display help message

### Step 3: What Gets Created

The initialization creates a `.claude/` subdirectory with the following files:

```
your-project/
└── .claude/
    ├── todo.json              # Active tasks list
    ├── todo-archive.json      # Completed/archived tasks
    ├── todo-config.json       # Project-specific configuration
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

**`todo-config.json`** - Configuration
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
.claude/todo.json
.claude/todo-archive.json
.claude/todo-log.json
.claude/.backups/

# Optional: Keep config in version control
# Remove this line to track todo-config.json
.claude/todo-config.json
```

**Alternative**: Track only configuration
```gitignore
# CLAUDE-TODO files
.claude/todo.json
.claude/todo-archive.json
.claude/todo-log.json
.claude/.backups/
# Note: todo-config.json is tracked for team consistency
```

### Step 5: CLAUDE.md Integration (Optional)

If your project has a `CLAUDE.md` file, the initialization script automatically adds task management instructions.

**Added section:**
```markdown
<!-- CLAUDE-TODO:START -->
## Task Management

Tasks in `.claude/todo.json`. **Read at session start, verify checksum.**

### Protocol
- **START**: Read .claude/todo-config.json → Read .claude/todo.json → Verify checksum → Log session_start
- **WORK**: ONE active task only → Update notes → Log changes to .claude/todo-log.json
- **END**: Update sessionNote → Update checksum → Log session_end

### Anti-Hallucination
- **ALWAYS** verify checksum before writing
- **NEVER** have 2+ active tasks
- **NEVER** modify .claude/todo-archive.json
- **ALWAYS** log all changes

### Files
- `.claude/todo.json` - Active tasks
- `.claude/todo-archive.json` - Completed (immutable)
- `.claude/todo-config.json` - Settings
- `.claude/todo-log.json` - Audit trail
<!-- CLAUDE-TODO:END -->
```

To skip this integration, use:
```bash
claude-todo init --no-claude-md
```

---

## Verification Steps

After installation and initialization, verify the system is working correctly.

### 1. Verify Global Installation

```bash
# Check version
claude-todo version
# Expected: 2.1.0

# Display help
claude-todo help
# Expected: Command list with usage

# Verify schema files
ls ~/.claude-todo/schemas/
# Expected: todo.schema.json, archive.schema.json, config.schema.json, log.schema.json

# Check executability
[ -x ~/.claude-todo/scripts/claude-todo ] && echo "✓ Executable" || echo "✗ Not executable"
```

### 2. Verify Project Initialization

```bash
# From your project directory
cd /path/to/your/project

# Check .claude directory
ls -la .claude/
# Expected: todo.json, todo-archive.json, todo-config.json, todo-log.json

# Validate todo.json structure
claude-todo validate
# Expected: "✓ Validation passed" or specific errors

# Check file permissions
ls -l .claude/
# Expected: -rw-r--r-- (644) for all JSON files
```

### 3. Test Basic Operations

```bash
# Validate todo files
claude-todo validate
# Expected: ✓ All files valid

# Try dry-run archive
claude-todo archive --dry-run
# Expected: No tasks to archive (or list of archivable tasks)

# Check log entries
cat .claude/todo-log.json | jq '.entries | length'
# Expected: 1 (initialization entry)
```

---

## Troubleshooting Installation

### Issue: Command Not Found

**Symptom:**
```bash
$ claude-todo version
bash: claude-todo: command not found
```

**Solutions:**

1. **Check symlink exists:**
   ```bash
   ls -l ~/.local/bin/claude-todo
   # Should show: ~/.local/bin/claude-todo -> /home/username/.claude-todo/scripts/claude-todo
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
   ~/.local/bin/claude-todo version
   # or
   ~/.claude-todo/scripts/claude-todo version
   ```

5. **Check script permissions:**
   ```bash
   ls -l ~/.claude-todo/scripts/claude-todo
   # Should be: -rwxr-xr-x (executable)

   # Fix if needed:
   chmod +x ~/.claude-todo/scripts/claude-todo
   ```

### Issue: Permission Denied

**Symptom:**
```bash
$ claude-todo init
bash: /home/username/.claude-todo/scripts/init.sh: Permission denied
```

**Solution:**
```bash
# Make all scripts executable
chmod +x ~/.claude-todo/scripts/*.sh

# Or fix installation
cd /path/to/claude-todo-repo
./install.sh --force
```

### Issue: jq Not Installed

**Symptom:**
```bash
$ claude-todo validate
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
$ claude-todo validate
Error: Invalid JSON schema
```

**Diagnostic steps:**

1. **Check JSON syntax:**
   ```bash
   cat .claude/todo.json | jq empty
   # No output = valid JSON
   # Error = syntax issue
   ```

2. **Verify schema path:**
   ```bash
   head -n 3 .claude/todo.json
   # Should show: "$schema": "./schemas/todo.schema.json"
   ```

3. **Validate manually:**
   ```bash
   claude-todo validate --fix
   # Attempts automatic repairs
   ```

4. **Check file integrity:**
   ```bash
   # Re-initialize with backup
   mv .claude .claude.backup
   claude-todo init
   ```

### Issue: Files Already Exist

**Symptom:**
```bash
$ claude-todo init
[ERROR] .claude/todo.json already exists. Use --force to overwrite.
```

**Solutions:**

1. **Force overwrite (destroys existing data):**
   ```bash
   claude-todo init --force
   ```

2. **Backup existing files:**
   ```bash
   # Create backup
   mkdir -p .claude-backups
   cp -r .claude/* .claude-backups/

   # Then force init
   claude-todo init --force
   ```

3. **Manual cleanup:**
   ```bash
   rm -rf .claude/
   claude-todo init
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
claude-todo validate --fix
```

### Issue: Installation Directory Conflicts

**Symptom:**
```bash
$ ./install.sh
[WARN] Existing installation found at /home/username/.claude-todo
```

**Solutions:**

1. **Upgrade existing installation:**
   ```bash
   ./install.sh
   # Answer 'y' to overwrite prompt
   ```

2. **Clean install:**
   ```bash
   rm -rf ~/.claude-todo
   ./install.sh
   ```

3. **Install to different location:**
   ```bash
   CLAUDE_TODO_HOME=/opt/claude-todo ./install.sh
   export PATH="$PATH:/opt/claude-todo/scripts"
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
   - Copy content from `~/.claude-todo/docs/QUICK-REFERENCE.md`
   - Paste into CLAUDE.md

3. **Re-initialize without CLAUDE.md:**
   ```bash
   claude-todo init --no-claude-md
   ```

---

## Upgrade/Update Instructions

### Upgrading CLAUDE-TODO

```bash
# Navigate to repository
cd /path/to/claude-todo

# Pull latest changes
git pull origin main

# Run installer (will prompt before overwriting)
./install.sh

# Verify new version
claude-todo version
```

### Migrating Projects

If schema versions change, existing project files may need migration:

```bash
# Backup current data
cp .claude/todo.json .claude/todo.json.backup

# Run validation
claude-todo validate

# If validation fails due to schema changes, re-initialize
mv .claude .claude-old
claude-todo init

# Manually migrate tasks from .claude-old/todo.json to .claude/todo.json
```

---

## Uninstallation

### Remove Global Installation

```bash
# Remove installation directory
rm -rf ~/.claude-todo

# Remove PATH entry from shell config
# Edit ~/.bashrc, ~/.zshrc, or ~/.config/fish/config.fish
# Delete line: export PATH="$PATH:$HOME/.claude-todo/scripts"

# Reload shell
source ~/.bashrc  # or restart terminal
```

### Remove Per-Project Files

```bash
# From project directory
rm -rf .claude/

# Remove .gitignore entries (if added)
# Edit .gitignore and remove .claude/ references

# Remove CLAUDE.md integration (if added)
# Edit CLAUDE.md and remove section between:
# <!-- CLAUDE-TODO:START --> and <!-- CLAUDE-TODO:END -->
```

---

## Next Steps

After successful installation and initialization:

1. **Read Quick Reference**: `~/.claude-todo/docs/QUICK-REFERENCE.md`
2. **Configure settings**: Edit `.claude/todo-config.json` for your workflow
3. **Add first task**: Manually edit `.claude/todo.json` or use Claude Code
4. **Learn workflows**: See `usage.md` for complete task management patterns
5. **Understand schemas**: Review `schema-reference.md` for data structures

---

## Support and Resources

- **Documentation**: `~/.claude-todo/docs/`
- **Issue Tracker**: GitHub repository issues
- **Schema Reference**: `schema-reference.md`
- **Configuration Guide**: `configuration.md`
- **Troubleshooting**: `troubleshooting.md`

---

## Summary

**Global Installation:**
1. Clone repository
2. Run `./install.sh`
3. Add `~/.claude-todo/scripts` to PATH
4. Verify with `claude-todo version`

**Per-Project Initialization:**
1. Navigate to project root: `cd /path/to/project`
2. Run `claude-todo init`
3. Add `.claude/*.json` to `.gitignore`
4. Verify with `claude-todo validate`

**Key Files Created:**
- `~/.claude-todo/` - Global installation directory
- `.claude/todo.json` - Active tasks (per-project)
- `.claude/todo-archive.json` - Completed tasks (per-project)
- `.claude/todo-config.json` - Configuration (per-project)
- `.claude/todo-log.json` - Change history (per-project)

**Task Status Values:**
- `pending` - Not started
- `active` - Currently working on (max 1)
- `blocked` - Waiting on dependency
- `done` - Completed (ready for archive)

Installation complete! Proceed to `usage.md` for task management workflows.
