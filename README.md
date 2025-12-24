# CLAUDE-TODO

> **The task management protocol for solo developers and their AI coding agents**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Version](https://img.shields.io/badge/version-0.35.1-blue.svg)](CHANGELOG.md)
[![LLM-Agent-First](https://img.shields.io/badge/design-LLM--Agent--First-purple.svg)](docs/specs/LLM-AGENT-FIRST-SPEC.md)
[![Tests](https://img.shields.io/badge/tests-passing-brightgreen.svg)](tests/)

<!-- VERSION_SYNC: This badge version should match VERSION file. Run ./dev/bump-version.sh to update. -->

---

## Table of Contents

- [One Developer. One Agent. One Source of Truth.](#one-developer-one-agent-one-source-of-truth)
- [Why This Exists](#why-this-exists)
- [Core Principles](#core-principles)
- [Quick Start](#quick-start)
- [Command Reference](#command-reference)
- [Task Hierarchy](#task-hierarchy-v0170)
- [Session Protocol](#session-protocol)
- [Output Formats & Exit Codes](#output-formats--exit-codes)
- [Validation & Integrity](#validation--integrity)
- [Phase Tracking](#phase-tracking)
- [Configuration](#configuration)
- [Project Structure](#project-structure)
- [For Claude Code Users](#for-claude-code-users)
- [Extensibility](#extensibility)
- [Troubleshooting](#troubleshooting)
- [Performance](#performance)
- [Documentation](#documentation)
- [The Philosophy](#the-philosophy)
- [Contributing](#contributing)
- [Star History](#star-history)
- [License](#license)

---

## One Developer. One Agent. One Source of Truth.

Claude-TODO is the **contract between you and your AI coding agent**. It's not just a task tracker—it's a structured protocol designed for the unique challenges of AI-assisted development:

- **Agents hallucinate**. Claude-TODO validates every operation before execution.
- **Agents lose context**. Claude-TODO persists state across sessions with immutable audit trails.
- **Agents need structure**. Claude-TODO outputs JSON by default, with human-readable formatting opt-in.

Built specifically for [Claude Code](https://claude.ai/claude-code), but the principles apply to any LLM-agent workflow.

---

## Why This Exists

Traditional task management assumes human users. But when your primary "user" is an LLM agent:

| What Humans Need | What Agents Need |
|------------------|------------------|
| Natural language | Structured JSON |
| Descriptive errors | Exit codes |
| Flexibility | Constraints |
| Trust | Validation |
| Memory | Persistence |

**Claude-TODO is built for agents first.** The `--human` flag is for you—the developer reviewing what your agent sees.

---

## Core Principles

### LLM-Agent-First Design

Every command follows a consistent pattern:

```bash
# JSON by default (agent-first)
claude-todo list                              # Returns JSON
claude-todo list | jq '.tasks[0].id'          # Parse with jq

# Human-readable when you need it (developer-friendly)
claude-todo list --human                      # Formatted text output

# Exit codes for programmatic branching (17 documented codes)
claude-todo exists T042 --quiet && echo "Found"
```

### Anti-Hallucination Protection

Four layers of validation prevent AI-generated errors:

| Layer | Purpose | What It Catches |
|-------|---------|-----------------|
| **1. Schema** | JSON Schema enforcement | Missing fields, wrong types, invalid enums |
| **2. Semantic** | Business logic validation | Duplicate IDs, future timestamps, invalid status transitions |
| **3. Cross-File** | Referential integrity | Orphaned references, archive inconsistencies, data loss |
| **4. State Machine** | Transition rules | Invalid status changes, constraint violations |

Before any write operation:
```bash
✓ ID exists (prevent hallucinated references)
✓ ID unique (across todo.json AND archive)
✓ Status valid (pending|active|blocked|done)
✓ Timestamps sane (not future, completedAt > createdAt)
✓ Dependencies acyclic (no circular references)
✓ Parent exists (hierarchy integrity)
```

### Stable Task IDs

```
T001, T002, T042, T999, T1000...
```

IDs are **flat, sequential, and eternal**. No hierarchical IDs like `T001.2.3` that break when you restructure. Hierarchy is stored in the `parentId` field—identity and structure are decoupled.

**Every external reference stays valid forever:**
- Git commits: `"Fixes T042"` → always resolves
- Documentation: `See [T042]` → never orphaned
- Scripts: `grep T042` → always finds it

---

## Quick Start

### Prerequisites

| Dependency | Required | Install |
|------------|----------|---------|
| **Bash 4.0+** | Critical | Pre-installed (check: `bash --version`) |
| **jq** | Critical | `apt install jq` / `brew install jq` |
| **flock** | Recommended | `brew install flock` (macOS) |
| **sha256sum** | Recommended | Pre-installed / `brew install coreutils` |

```bash
# Check all dependencies
./install.sh --check-deps

# Auto-install missing (Linux/macOS)
./install.sh --install-deps
```

### Installation

```bash
# 1. Clone and install globally
git clone https://github.com/kryptobaseddev/claude-todo.git
cd claude-todo
./install.sh

# 2. Verify installation
claude-todo version
claude-todo --validate

# 3. Initialize in your project
cd /path/to/your/project
claude-todo init
```

> **Note**: The installer creates symlinks in `~/.local/bin/`, which works immediately with Claude Code and most modern shells.

### Upgrade Existing Installation

```bash
cd claude-todo
git pull origin main
./install.sh --upgrade

# For project schema migrations
claude-todo migrate status
claude-todo migrate run
```

### The `ct` Shortcut

```bash
ct list        # Same as claude-todo list
ct add "Task"  # Same as claude-todo add "Task"
ct done T001   # Same as claude-todo complete T001
ct find "auth" # Fast fuzzy search (99% less tokens than list)
```

**Built-in aliases**: `ls`, `done`, `new`, `edit`, `rm`, `check`, `tags`, `overview`, `dig`

### Tab Completion

Enable shell completion for faster command entry and context-aware suggestions:

**Bash** (add to `~/.bashrc`):
```bash
source ~/.claude-todo/completions/bash-completion.sh
```

**Zsh** (add to `~/.zshrc`):
```bash
fpath=(~/.claude-todo/completions $fpath)
autoload -Uz compinit && compinit
```

**Features:**
- Context-aware `--parent` completion (shows only valid parents: epics and tasks, not subtasks)
- All commands, subcommands, and flags
- Task ID completion with status filtering
- Phase, label, and priority value completion

```bash
# Example usage
claude-todo add --parent <TAB>     # Shows T001, T002 (epic/task only)
claude-todo list --status <TAB>    # Shows pending, active, blocked, done
claude-todo focus set <TAB>        # Shows pending/active task IDs
```

---

## Command Reference

### 37 Commands Across 4 Categories

| Category | Commands | Purpose |
|----------|----------|---------|
| **Write (10)** | `add`, `update`, `complete`, `focus`, `session`, `phase`, `archive`, `promote`, `reparent`, `populate-hierarchy` | Modify task state |
| **Read (17)** | `list`, `show`, `find`, `analyze`, `next`, `dash`, `deps`, `blockers`, `phases`, `labels`, `stats`, `log`, `commands`, `exists`, `export`, `history`, `research` | Query and analyze |
| **Sync (3)** | `sync`, `inject`, `extract` | TodoWrite integration |
| **Maintenance (7)** | `init`, `validate`, `backup`, `restore`, `migrate`, `migrate-backups`, `config` | System administration |

### Essential Commands

```bash
# Task lifecycle
claude-todo add "Implement authentication" --priority high
claude-todo list                     # View all tasks (JSON default)
claude-todo list --status pending    # Filter by status
claude-todo update T001 --labels "backend,security"
claude-todo complete T001
claude-todo archive

# Session workflow
claude-todo session start
claude-todo focus set T001           # Only ONE active task allowed
claude-todo focus note "Working on JWT validation"
claude-todo session end

# Analysis & planning
claude-todo dash                     # Project overview
claude-todo analyze                  # Task triage with leverage scoring
claude-todo analyze --auto-focus     # Auto-set focus to highest leverage task
claude-todo next --explain           # What should I work on?
claude-todo blockers analyze         # Critical path analysis

# Context-efficient search (v0.19.2+)
claude-todo find "auth"              # Fuzzy search (~1KB vs 355KB for full list)
claude-todo find --id 42             # Find T42, T420, T421...
claude-todo find "api" --status pending --field title

# Single task inspection
claude-todo show T001                # Full task details
claude-todo show T001 --history      # Include audit trail
claude-todo exists T001 --quiet      # Exit 0 if exists, 1 if not

# Research & discovery (v0.23.0+)
claude-todo research "TypeScript patterns"           # Multi-source web research
claude-todo research --library svelte --topic state  # Official docs via Context7
claude-todo research --url https://example.com       # Extract from URL
```

### Command Discovery (v0.21.0+)

```bash
# Native filters - no jq needed
claude-todo commands                     # List all (JSON by default)
claude-todo commands --human             # Human-readable
claude-todo commands --category write    # Filter by category
claude-todo commands --relevance critical # Filter by agent relevance
claude-todo commands --workflows         # Agent workflow sequences
claude-todo commands add                 # Details for specific command
```

### Agent-Friendly Output

**LLM-Agent-First**: JSON is the default output format for all commands. Use `--human` for human-readable text.

```bash
# Default behavior (JSON everywhere)
claude-todo list                    # JSON output (LLM-Agent-First default)
claude-todo analyze                 # JSON output
claude-todo show T001               # JSON output

# Human-readable when you need it
claude-todo list --human            # Human-readable text
claude-todo dash --human            # Formatted dashboard

# Pipe to jq for parsing
claude-todo list | jq '.tasks[0].id'
```

#### JSON Envelope Structure

All commands return a consistent envelope with `$schema`, `_meta`, and `success` fields:

```json
{
  "$schema": "https://claude-todo.dev/schemas/v1/output.schema.json",
  "_meta": {
    "format": "json",
    "command": "list",
    "version": "0.23.0",
    "timestamp": "2025-12-19T10:30:45Z"
  },
  "success": true,
  "tasks": [...]
}
```

#### Error Response Structure

Errors return structured JSON with error codes, exit codes, and recovery suggestions:

```json
{
  "$schema": "https://claude-todo.dev/schemas/v1/error.schema.json",
  "_meta": {
    "format": "json",
    "command": "show",
    "version": "0.23.0",
    "timestamp": "2025-12-19T10:30:45Z"
  },
  "success": false,
  "error": {
    "code": "E_TASK_NOT_FOUND",
    "message": "Task T999 does not exist",
    "exitCode": 4,
    "recoverable": false,
    "suggestion": "Use 'ct exists T999 --quiet' to verify task ID"
  }
}
```

---

## Task Hierarchy (v0.17.0+)

Three levels, no more:

```
Epic (strategic initiative)
  └── Task (primary work unit)
        └── Subtask (atomic operation)
```

```bash
# Create hierarchy
claude-todo add "Auth System" --type epic --size large
claude-todo add "JWT middleware" --parent T001 --size medium
claude-todo add "Validate tokens" --parent T002 --type subtask

# View tree
claude-todo list --tree
T001 [epic] Auth System
├── T002 [task] JWT middleware
│   └── T003 [subtask] Validate tokens
└── T004 [task] Session management

# Filter by hierarchy
claude-todo list --type epic
claude-todo list --parent T001
claude-todo list --children T001
```

### Hierarchy Constraints

| Constraint | Default | Configurable |
|------------|---------|--------------|
| Max depth | 3 levels | `hierarchy.maxDepth` |
| Max siblings | 20 per parent | `hierarchy.maxSiblings` |
| Max active siblings | 8 per parent | `hierarchy.maxActiveSiblings` |

### Scope-Based Sizing (No Time Estimates)

| Size | Scope | Action |
|------|-------|--------|
| **Small** | 1-2 files, straightforward | Execute |
| **Medium** | 3-7 files, moderate complexity | Execute |
| **Large** | 8+ files, architectural | **Decompose first** |

Time estimates are prohibited. They're unpredictable for humans and meaningless for agents.

---

## Session Protocol

Agents lose context between invocations. Sessions provide checkpoints:

```bash
# Morning routine
claude-todo session start
claude-todo dash              # Where am I?
claude-todo focus show        # What was I working on?

# Work session
claude-todo focus set T042
claude-todo focus note "Implementing validation logic"
claude-todo update T042 --notes "Tests passing"

# End of day
claude-todo complete T042
claude-todo session end
```

**Single active task enforcement**: Only ONE task can be `active` at a time. This prevents context confusion and scope creep.

### Session Notes vs Task Notes

| Command | Purpose | Storage |
|---------|---------|---------|
| `focus note "text"` | Session-level progress | Replaces `.focus.sessionNote` |
| `update T001 --notes "text"` | Task-specific history | Appends to `.tasks[].notes[]` with timestamp |

---

## Output Formats & Exit Codes

### LLM-Agent-First Output

All commands output **JSON by default**. This is the core LLM-Agent-First principle—agents are the primary consumer.

| Output Mode | How to Get It | Use Case |
|-------------|---------------|----------|
| **JSON** (default) | No flags needed | Agent automation, scripting, parsing |
| **Human-readable** | `--human` or `--format text` | Developer inspection, debugging |

```bash
# JSON is always the default
claude-todo list                    # JSON
claude-todo list --human            # Human-readable text
claude-todo list --format text      # Same as --human
```

### Exit Codes

17 documented exit codes for programmatic handling:

| Range | Purpose | Examples |
|-------|---------|----------|
| `0` | Success | Operation completed |
| `1-9` | General errors | Invalid input (2), File error (3), Not found (4), Validation (6) |
| `10-19` | Hierarchy errors | Parent not found (10), Depth exceeded (11), Sibling limit (12) |
| `20-29` | Concurrency errors | Checksum mismatch (20), Lock timeout (7) |
| `100+` | Special conditions | No data (100), Already exists (101), No change (102) |

```bash
claude-todo exists T042 --quiet
case $? in
  0) echo "Found" ;;
  1) echo "Not found" ;;
  2) echo "Invalid ID format" ;;
esac
```

---

## Validation & Integrity

### Atomic Write Pattern

Every file modification follows this exact sequence:

```
1. Write to temp file (.todo.json.tmp)
2. Validate temp (schema + anti-hallucination)
3. IF INVALID: Delete temp → Abort → Exit with error
4. IF VALID: Backup original → Atomic rename → Rotate backups
```

**No partial writes. No corruption.** The OS guarantees atomic rename.

### Checksum System

```bash
# SHA256 checksum of .tasks array
claude-todo validate           # Check integrity
claude-todo validate --fix     # Repair checksum mismatches
```

Checksums detect corruption but don't block multi-writer scenarios (CLI + TodoWrite).

### Backup System

- **Automatic**: Safety backup before every write
- **Rotation**: 10 versioned backups (`.backups/todo.json.1` through `.10`)
- **Recovery**: `claude-todo restore` or `claude-todo backup --list`

---

## Phase Tracking

Organize work into project phases:

```bash
# Define phases
claude-todo add "Design API" --phase planning --add-phase
claude-todo add "Implement core" --phase development

# Manage phases
claude-todo phase set development    # Set current project phase
claude-todo phase show               # Show current phase details
claude-todo phases                   # View all phases with progress
claude-todo phases stats             # Detailed breakdown

# Filter by phase
claude-todo list --phase core
```

**Phase lifecycle**: `pending` → `active` → `completed` (only ONE can be active)

---

## Configuration

### Priority Resolution

Values resolved in order (later overrides earlier):

```
Defaults → Global (~/.claude-todo/config.json) → Project (.claude/todo-config.json) → Environment (CLAUDE_TODO_*) → CLI Flags
```

### Key Options

```json
{
  "hierarchy": {
    "maxDepth": 3,
    "maxSiblings": 20,
    "maxActiveSiblings": 8
  },
  "validation": {
    "strictMode": false,
    "checksumEnabled": true,
    "maxActiveTasks": 1
  },
  "archive": {
    "daysUntilArchive": 7,
    "archiveOnSessionEnd": true
  },
  "backup": {
    "enabled": true,
    "maxSafetyBackups": 5
  }
}
```

### Configuration Commands

```bash
claude-todo config show              # View merged configuration
claude-todo config get hierarchy.maxDepth
claude-todo config set archive.daysUntilArchive 14
claude-todo config set --global validation.strictMode true
```

### Environment Variables

```bash
CLAUDE_TODO_HOME=/custom/path        # Installation directory
CLAUDE_TODO_DEBUG=1                  # Verbose output
CLAUDE_TODO_FORMAT=json              # Force output format
```

---

## Project Structure

```
~/.claude-todo/              # Global installation
├── scripts/                 # Command implementations (35 scripts)
├── lib/                     # Shared libraries (validation, file-ops, logging, phase-tracking)
├── schemas/                 # JSON Schema definitions
├── templates/               # Starter templates
└── docs/                    # Documentation

your-project/.claude/        # Per-project instance
├── todo.json               # Active tasks (source of truth)
├── todo-archive.json       # Completed tasks (immutable)
├── todo-log.json           # Audit trail (append-only)
├── todo-config.json        # Project configuration
└── .backups/               # Automatic versioned backups
```

---

## For Claude Code Users

Claude-TODO integrates seamlessly with Claude Code:

### CLAUDE.md Integration

```bash
# Update your project's CLAUDE.md with task instructions
claude-todo init --update-claude-md
```

This injects the essential commands and protocols between `<!-- CLAUDE-TODO:START -->` and `<!-- CLAUDE-TODO:END -->` markers.

### TodoWrite Sync

Bidirectional sync with Claude Code's ephemeral todo system:

```bash
claude-todo sync --inject              # Push to TodoWrite (session start)
claude-todo sync --inject --focused-only  # Only push focused task
claude-todo sync --extract             # Pull from TodoWrite (session end)
claude-todo sync --extract --dry-run   # Preview changes
```

### Agent Workflow Pattern

```bash
# Agent verifies before operating (anti-hallucination)
if claude-todo exists T042 --quiet; then
  claude-todo update T042 --notes "Progress update"
else
  echo "ERROR: Task T042 not found" >&2
  exit 1
fi

# Agent parses structured output
ACTIVE=$(claude-todo list | jq -r '.tasks[] | select(.status=="active") | .id')
claude-todo focus note "Working on $ACTIVE"

# Context-efficient task discovery
claude-todo find "auth" | jq '.matches[0].id'  # 99% less tokens than list
```

---

## Extensibility

Claude-TODO supports extension points for custom workflows:

```bash
.claude/validators/           # Custom validation scripts
.claude/hooks/                # Event hooks (on-complete, on-archive, etc.)
~/.claude-todo/formatters/    # Custom output formatters
~/.claude-todo/integrations/  # External system integrations
```

### Event Hooks Example

```bash
# .claude/hooks/on-task-complete.sh
#!/usr/bin/env bash
task_id="$1"
# Send notification, update external tracker, etc.
```

See [docs/PLUGINS.md](docs/PLUGINS.md) for extension development.

---

## Troubleshooting

### Common Issues

| Problem | Solution |
|---------|----------|
| `command not found` | Check `~/.local/bin` in PATH, run `source ~/.bashrc` |
| `Permission denied` | `chmod 755 ~/.claude-todo/scripts/*.sh` |
| `Invalid JSON` | `claude-todo validate --fix` or `claude-todo restore` |
| `Duplicate ID` | `claude-todo restore .claude/.backups/todo.json.1` |
| `Checksum mismatch` | `claude-todo validate --fix` |
| `Multiple active tasks` | `claude-todo focus set <correct-id>` (resets others) |
| `Schema outdated` | `claude-todo migrate run` |

### Debug Mode

```bash
CLAUDE_TODO_DEBUG=1 claude-todo list  # Verbose output
claude-todo --validate                # Check CLI integrity
claude-todo --list-commands           # Show all available commands
```

---

## Performance

Target metrics (optimized for 1000+ tasks):

| Operation | Target |
|-----------|--------|
| Task creation | < 100ms |
| Task completion | < 100ms |
| List tasks | < 50ms |
| Archive (100 tasks) | < 500ms |
| Validation (100 tasks) | < 200ms |

---

## Documentation

| Category | Documents |
|----------|-----------|
| **Start Here** | [Quick Start](docs/getting-started/quick-start.md) · [Design Philosophy](docs/guides/design-philosophy.md) |
| **Reference** | [Command Index](docs/commands/COMMANDS-INDEX.json) · [Quick Reference](docs/QUICK-REFERENCE.md) · [Task Management](docs/TODO_Task_Management.md) |
| **Architecture** | [System Architecture](docs/architecture/ARCHITECTURE.md) · [Data Flows](docs/architecture/DATA-FLOWS.md) |
| **Specifications** | [LLM-Agent-First Spec](docs/specs/LLM-AGENT-FIRST-SPEC.md) · [Task ID System](docs/specs/LLM-TASK-ID-SYSTEM-DESIGN-SPEC.md) · [Hierarchy Spec](docs/specs/TASK-HIERARCHY-SPEC.md) |
| **Integration** | [Claude Code Guide](docs/integration/CLAUDE-CODE.md) · [CI/CD Integration](docs/ci-cd-integration.md) |

**Complete documentation**: [docs/INDEX.md](docs/INDEX.md)

---

## The Philosophy

Claude-TODO is built on three pillars:

### 1. Agent-First, Human-Accessible
JSON output by default. Exit codes for branching. Structured errors. The `--human` flag is opt-in for developer visibility.

### 2. Validate Everything
LLMs hallucinate. Every operation validates before execution. Schema enforcement, semantic checks, state machine rules. If it fails validation, it doesn't happen.

### 3. Persist Everything
Agents lose context. Immutable audit trails, automatic backups, session checkpoints. Pick up exactly where you left off.

**One developer. One agent. One source of truth.**

---

## Contributing

Contributions welcome! See [CONTRIBUTING.md](CONTRIBUTING.md).

```bash
# Run tests
./tests/run-all-tests.sh

# Run specific test suite
./tests/test-validation.sh

# Validate installation
claude-todo --validate
```

---

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=kryptobaseddev/claude-todo&type=Date)](https://star-history.com/#kryptobaseddev/claude-todo&Date)

---

## License

MIT License — See [LICENSE](LICENSE)

---

<p align="center">
  <strong>Ready to build with your AI agent?</strong><br>
  <code>./install.sh && claude-todo init</code>
</p>

<p align="center">
  <a href="docs/INDEX.md">Documentation</a> ·
  <a href="docs/guides/design-philosophy.md">Design Philosophy</a> ·
  <a href="docs/specs/LLM-AGENT-FIRST-SPEC.md">LLM-Agent-First Spec</a> ·
  <a href="CONTRIBUTING.md">Contributing</a>
</p>
