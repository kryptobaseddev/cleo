# CLAUDE-TODO

> **The task management protocol for solo developers and their AI coding agents**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Version](https://img.shields.io/badge/version-0.23.0-blue.svg)](CHANGELOG.md)
[![LLM-Agent-First](https://img.shields.io/badge/design-LLM--Agent--First-purple.svg)](docs/specs/LLM-AGENT-FIRST-SPEC.md)
[![Tests](https://img.shields.io/badge/tests-passing-brightgreen.svg)](tests/)

<!-- VERSION_SYNC: This badge version should match VERSION file. Run ./dev/bump-version.sh to update. -->

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
# Piped/scripted → JSON automatically (agent-friendly)
claude-todo list | jq '.tasks[0].id'

# Terminal → human-readable (developer-friendly)
claude-todo list --human

# Exit codes for programmatic branching (17 documented codes)
claude-todo exists T042 --quiet && echo "Found"
```

### Anti-Hallucination Protection

Four layers of validation prevent AI-generated errors:

1. **Schema Validation** — JSON Schema enforcement for structure
2. **Semantic Checks** — ID uniqueness, timestamp sanity, status transitions
3. **Cross-File Integrity** — Referential consistency across todo/archive/log
4. **State Machine Rules** — Only valid transitions allowed

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

### Installation

```bash
# Clone and install globally
git clone https://github.com/kryptobaseddev/claude-todo.git
cd claude-todo
./install.sh

# Initialize in your project
cd /path/to/your/project
claude-todo init
```

### Essential Commands

```bash
# Task lifecycle
claude-todo add "Implement authentication"
claude-todo complete T001
claude-todo archive

# Session workflow
claude-todo session start
claude-todo focus set T001
claude-todo focus note "Working on JWT validation"
claude-todo session end

# Analysis
claude-todo dash              # Project overview
claude-todo next --explain    # What should I work on?
claude-todo analyze           # Task triage with leverage scoring

# Agent-friendly output
claude-todo list | jq '.tasks[] | select(.status == "pending")'
claude-todo show T001 --format json
```

### The `ct` Shortcut

```bash
ct list        # Same as claude-todo list
ct add "Task"  # Same as claude-todo add "Task"
ct done T001   # Same as claude-todo complete T001
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
```

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

---

## Project Structure

```
~/.claude-todo/              # Global installation
├── scripts/                 # Command implementations
├── lib/                     # Shared libraries
├── schemas/                 # JSON Schema definitions
└── docs/                    # Documentation

your-project/.claude/        # Per-project instance
├── todo.json               # Active tasks (source of truth)
├── todo-archive.json       # Completed tasks
├── todo-log.json           # Immutable audit trail
├── todo-config.json        # Project configuration
└── .backups/               # Automatic versioned backups
```

---

## Output Formats

### JSON by Default (Non-TTY)

When piped or scripted, output is JSON:

```bash
claude-todo list | jq '.tasks'
```

```json
{
  "$schema": "https://claude-todo.dev/schemas/v1/output.schema.json",
  "_meta": {"command": "list", "version": "0.23.0", "timestamp": "..."},
  "success": true,
  "tasks": [...]
}
```

### Human-Readable (Opt-In)

```bash
claude-todo list --human
```

```
TASKS
=====
T001 [active] high - Implement JWT middleware
T002 [pending] medium - Add session management
```

### Exit Codes

17 documented exit codes for programmatic handling:

| Range | Purpose |
|-------|---------|
| `0` | Success |
| `1-9` | General errors |
| `10-19` | Hierarchy errors |
| `20-29` | Concurrency errors |
| `100+` | Special conditions |

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

Every file modification:

1. Write to temp file
2. Validate (schema + semantic)
3. Backup original
4. Atomic rename
5. Rollback on any failure

**No partial writes. No corruption.**

### Anti-Hallucination Checks

```bash
# Before any operation, validate:
- ID exists (prevent hallucinated references)
- ID unique (prevent duplicates)
- Status valid (enum enforcement)
- Timestamps sane (not future, completion after creation)
- Dependencies acyclic (no circular references)
- Parent exists (hierarchy integrity)
```

---

## Phase Tracking

Organize work into project phases:

```bash
# Define phases
claude-todo add "Design API" --phase planning --add-phase
claude-todo add "Implement core" --phase development

# Manage phases
claude-todo phase set development
claude-todo phases              # View all phases with progress
claude-todo phases stats        # Detailed breakdown
```

---

## Configuration

Priority resolution (later overrides earlier):

```
Defaults → Global → Project → Environment → CLI Flags
```

Key options:

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
  }
}
```

---

## For Claude Code Users

Claude-TODO integrates seamlessly with Claude Code:

### CLAUDE.md Integration

```bash
# Update your project's CLAUDE.md with task instructions
claude-todo init --update-claude-md
```

### TodoWrite Sync

Bidirectional sync with Claude Code's ephemeral todo system:

```bash
claude-todo sync --inject   # Push to TodoWrite (session start)
claude-todo sync --extract  # Pull from TodoWrite (session end)
```

### Agent Workflow Pattern

```bash
# Agent verifies before operating
if claude-todo exists T042 --quiet; then
  claude-todo update T042 --notes "Progress update"
else
  echo "ERROR: Task T042 not found" >&2
  exit 1
fi

# Agent parses structured output
ACTIVE=$(claude-todo list | jq -r '.tasks[] | select(.status=="active") | .id')
claude-todo focus note "Working on $ACTIVE"
```

---

## Documentation

| Category | Documents |
|----------|-----------|
| **Start Here** | [Quick Start](docs/getting-started/quick-start.md) · [Design Philosophy](docs/guides/design-philosophy.md) |
| **Reference** | [Command Index](docs/commands/COMMANDS-INDEX.json) · [Quick Reference](docs/QUICK-REFERENCE.md) |
| **Architecture** | [System Architecture](docs/architecture/ARCHITECTURE.md) · [Data Flows](docs/architecture/DATA-FLOWS.md) |
| **Specifications** | [LLM-Agent-First Spec](docs/specs/LLM-AGENT-FIRST-SPEC.md) · [Task ID System](docs/specs/LLM-TASK-ID-SYSTEM-DESIGN-SPEC.md) · [Hierarchy Spec](docs/specs/TASK-HIERARCHY-SPEC.md) |
| **Integration** | [Claude Code Guide](docs/integration/CLAUDE-CODE.md) · [CI/CD Integration](docs/ci-cd-integration.md) |

**Complete documentation**: [docs/INDEX.md](docs/INDEX.md)

---

## Requirements

### Critical
- **Bash 4.0+** — Required for associative arrays
- **jq** — JSON processing (`apt install jq` or `brew install jq`)

### Recommended
- **flock** — File locking (`brew install flock` on macOS)
- **sha256sum/shasum** — Checksum verification

```bash
# Check dependencies
./install.sh --check-deps
```

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

# Validate installation
claude-todo --validate
```

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
