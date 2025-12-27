# Quick Start Guide

Get productive with cleo in 5 minutes.

## Prerequisites

Before installing, ensure you have:

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

   **Installation if missing:**
   - Ubuntu/Debian: `sudo apt-get install jq`
   - macOS: `brew install jq`
   - RHEL/CentOS: `sudo yum install jq`

## Installation (3 Steps)

### 1. Clone and Install

```bash
# Clone repository
git clone https://github.com/kryptobaseddev/cleo.git
cd cleo

# Run installer
./install.sh
```

This installs to `~/.cleo/` and creates symlinks in `~/.local/bin/` for immediate access.

### 2. Initialize Your Project

```bash
# Navigate to your project
cd /path/to/your/project

# Initialize todo system
cleo init
```

This creates `.cleo/` directory with:
- `todo.json` - Active tasks
- `todo-archive.json` - Completed tasks
- `config.json` - Configuration
- `todo-log.json` - Change history

### 3. Verify Installation

```bash
# Check version
cleo version

# Validate setup
cleo validate
```

## Your First Task

### Create a Task

```bash
# Simple task
cleo add "Fix login bug"

# Task with details
cleo add "Implement authentication" \
  --priority high \
  --labels backend,security \
  --description "Add JWT-based authentication"
```

### List Tasks

```bash
# View all tasks
cleo list

# High-priority tasks only
cleo list --priority high

# Compact view
cleo list --compact
```

### Complete a Task

```bash
# Mark task complete
cleo complete T001

# View statistics
cleo stats
```

## Daily Workflow Pattern

### Morning: Session Start

```bash
# Start work session
cleo session start

# Review pending tasks
cleo list --status pending

# Set focus on one task
cleo focus set T002
```

### During Work

```bash
# Add new tasks as discovered
cleo add "Fix navigation bug" --priority medium

# Update task progress
cleo update T002 --notes "Implementing JWT middleware"

# Complete finished tasks
cleo complete T001
```

### Evening: Session End

```bash
# Archive completed tasks
cleo archive

# End work session
cleo session end

# Review day's progress
cleo stats --period 1
```

## Common Commands

### Quick Reference

```bash
# Create task
cleo add "Task title" --priority high --labels tag1,tag2

# List tasks
cleo list                           # All active tasks
cleo list --status pending          # Pending only
cleo list --priority high           # High priority
cleo list --label backend           # By label

# Update task
cleo update T001 --priority critical
cleo update T001 --labels bug,urgent
cleo update T001 --notes "Progress update"

# Complete task
cleo complete T001

# Archive old tasks
cleo archive

# Validate system
cleo validate

# View statistics
cleo stats
```

### Command Aliases (Faster Workflows)

```bash
cleo ls              # Same as: list
cleo done T001       # Same as: complete T001
cleo new "Task"      # Same as: add "Task"
cleo edit T001       # Same as: update T001
cleo check           # Same as: validate
```

## Output Formats

```bash
# Human-readable (default)
cleo list

# JSON for scripting
cleo list --format json

# CSV export (via export command)
cleo export --format csv > tasks.csv

# Markdown checklist
cleo list --format markdown
```

## Essential Configuration

Edit `.cleo/config.json`:

```json
{
  "archive": {
    "daysUntilArchive": 7,      // Days before auto-archive
    "preserveRecentCount": 3     // Keep recent completed tasks
  },
  "validation": {
    "maxActiveTasks": 1          // Enforce focus
  },
  "defaults": {
    "priority": "medium",        // Default priority
    "phase": "core"             // Default phase
  }
}
```

## Tips for Success

1. **One Active Task**: Set focus to maintain clarity
   ```bash
   cleo focus set T002
   ```

2. **Use Labels**: Organize with labels
   ```bash
   cleo add "Fix bug" --labels bug,backend,urgent
   ```

3. **Regular Archiving**: Keep active list clean
   ```bash
   cleo archive --dry-run   # Preview
   cleo archive              # Execute
   ```

4. **Track Progress**: Add notes for context
   ```bash
   cleo update T001 --notes "Implemented JWT validation"
   ```

5. **Disable Colors When Needed**: Follow NO_COLOR standard
   ```bash
   NO_COLOR=1 cleo list
   ```

## Next Steps

Now that you're up and running:

1. **Detailed Usage**: See [usage.md](../usage.md) for complete command reference
2. **Configuration Guide**: See [configuration.md](../reference/configuration.md) for all settings
3. **CLI Output Formats**: See [CLI-OUTPUT-REFERENCE.md](../../claudedocs/CLI-OUTPUT-REFERENCE.md)
4. **Architecture**: See [ARCHITECTURE.md](../architecture/ARCHITECTURE.md) for system design
5. **Troubleshooting**: See [troubleshooting.md](../reference/troubleshooting.md) for common issues

## Common Issues

### Command Not Found

```bash
# Check symlink
ls -l ~/.local/bin/cleo

# If missing, verify PATH
echo $PATH | grep ".local/bin"

# Reload shell if needed
source ~/.bashrc  # or ~/.zshrc
```

### Validation Errors

```bash
# Check file integrity
cleo validate

# Attempt automatic fix
cleo validate --fix

# Restore from backup if needed
cleo restore .cleo/.backups/todo.json.1
```

### jq Not Installed

```bash
# Ubuntu/Debian
sudo apt-get install jq

# macOS
brew install jq

# Verify
jq --version
```

## Support

- **Documentation**: `~/.cleo/docs/`
- **GitHub Issues**: Report bugs and request features
- **Quick Help**: `cleo help`
- **Command Help**: `cleo <command> --help`

---

**Ready to dive deeper?** Continue to [usage.md](../usage.md) for comprehensive documentation.
