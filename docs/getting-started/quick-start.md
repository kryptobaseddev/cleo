# Quick Start Guide

Get productive with claude-todo in 5 minutes.

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
git clone https://github.com/kryptobaseddev/claude-todo.git
cd claude-todo

# Run installer
./install.sh
```

This installs to `~/.claude-todo/` and creates symlinks in `~/.local/bin/` for immediate access.

### 2. Initialize Your Project

```bash
# Navigate to your project
cd /path/to/your/project

# Initialize todo system
claude-todo init
```

This creates `.claude/` directory with:
- `todo.json` - Active tasks
- `todo-archive.json` - Completed tasks
- `todo-config.json` - Configuration
- `todo-log.json` - Change history

### 3. Verify Installation

```bash
# Check version
claude-todo version

# Validate setup
claude-todo validate
```

## Your First Task

### Create a Task

```bash
# Simple task
claude-todo add "Fix login bug"

# Task with details
claude-todo add "Implement authentication" \
  --priority high \
  --labels backend,security \
  --description "Add JWT-based authentication"
```

### List Tasks

```bash
# View all tasks
claude-todo list

# High-priority tasks only
claude-todo list --priority high

# Compact view
claude-todo list --compact
```

### Complete a Task

```bash
# Mark task complete
claude-todo complete T001

# View statistics
claude-todo stats
```

## Daily Workflow Pattern

### Morning: Session Start

```bash
# Start work session
claude-todo session start

# Review pending tasks
claude-todo list --status pending

# Set focus on one task
claude-todo focus set T002
```

### During Work

```bash
# Add new tasks as discovered
claude-todo add "Fix navigation bug" --priority medium

# Update task progress
claude-todo update T002 --notes "Implementing JWT middleware"

# Complete finished tasks
claude-todo complete T001
```

### Evening: Session End

```bash
# Archive completed tasks
claude-todo archive

# End work session
claude-todo session end

# Review day's progress
claude-todo stats --period 1
```

## Common Commands

### Quick Reference

```bash
# Create task
claude-todo add "Task title" --priority high --labels tag1,tag2

# List tasks
claude-todo list                           # All active tasks
claude-todo list --status pending          # Pending only
claude-todo list --priority high           # High priority
claude-todo list --label backend           # By label

# Update task
claude-todo update T001 --priority critical
claude-todo update T001 --labels bug,urgent
claude-todo update T001 --notes "Progress update"

# Complete task
claude-todo complete T001

# Archive old tasks
claude-todo archive

# Validate system
claude-todo validate

# View statistics
claude-todo stats
```

### Command Aliases (Faster Workflows)

```bash
claude-todo ls              # Same as: list
claude-todo done T001       # Same as: complete T001
claude-todo new "Task"      # Same as: add "Task"
claude-todo edit T001       # Same as: update T001
claude-todo check           # Same as: validate
```

## Output Formats

```bash
# Human-readable (default)
claude-todo list

# JSON for scripting
claude-todo list --format json

# CSV export
claude-todo list --format csv > tasks.csv

# Markdown checklist
claude-todo list --format markdown
```

## Essential Configuration

Edit `.claude/todo-config.json`:

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
   claude-todo focus set T002
   ```

2. **Use Labels**: Organize with labels
   ```bash
   claude-todo add "Fix bug" --labels bug,backend,urgent
   ```

3. **Regular Archiving**: Keep active list clean
   ```bash
   claude-todo archive --dry-run   # Preview
   claude-todo archive              # Execute
   ```

4. **Track Progress**: Add notes for context
   ```bash
   claude-todo update T001 --notes "Implemented JWT validation"
   ```

5. **Disable Colors When Needed**: Follow NO_COLOR standard
   ```bash
   NO_COLOR=1 claude-todo list
   ```

## Next Steps

Now that you're up and running:

1. **Detailed Usage**: See [usage.md](../usage.md) for complete command reference
2. **Configuration Guide**: See [configuration.md](../guides/configuration.md) for all settings
3. **CLI Output Formats**: See [CLI-OUTPUT-REFERENCE.md](../../claudedocs/CLI-OUTPUT-REFERENCE.md)
4. **Architecture**: See [ARCHITECTURE.md](../architecture/ARCHITECTURE.md) for system design
5. **Troubleshooting**: See [troubleshooting.md](../reference/troubleshooting.md) for common issues

## Common Issues

### Command Not Found

```bash
# Check symlink
ls -l ~/.local/bin/claude-todo

# If missing, verify PATH
echo $PATH | grep ".local/bin"

# Reload shell if needed
source ~/.bashrc  # or ~/.zshrc
```

### Validation Errors

```bash
# Check file integrity
claude-todo validate

# Attempt automatic fix
claude-todo validate --fix

# Restore from backup if needed
claude-todo restore .claude/.backups/todo.json.1
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

- **Documentation**: `~/.claude-todo/docs/`
- **GitHub Issues**: Report bugs and request features
- **Quick Help**: `claude-todo help`
- **Command Help**: `claude-todo <command> --help`

---

**Ready to dive deeper?** Continue to [usage.md](../usage.md) for comprehensive documentation.
