# CLEO Installation Instructions for AI Agents

This document provides task-oriented installation instructions optimized for AI coding assistants like Claude Code, Cursor, and ChatGPT.

## Objective

Install CLEO, a task management system designed for solo developers and their AI coding agents. CLEO provides structured task tracking with anti-hallucination validation, context persistence, and LLM-agent-first output formats.

## Success Criteria

- `cleo version` returns version number without errors
- `cleo validate` passes all checks
- `.cleo/` directory exists in project with valid JSON files

## Prerequisites

- Bash 4.0+ (`bash --version`)
- jq 1.5+ (`jq --version`)
- Git (for cloning)
- Write access to `~/.cleo/` and `~/.local/bin/`

## Installation Steps

### Step 1: Clone Repository

```bash
git clone https://github.com/kryptobaseddev/cleo.git /tmp/cleo
cd /tmp/cleo
```

### Step 2: Run Installer

```bash
chmod +x install.sh
./install.sh
```

**Expected output:** Installation progress messages ending with success confirmation.

### Step 3: Verify Global Installation

```bash
cleo version
cleo --validate
```

**Expected:** Version number and "Installation valid" message.

### Step 4: Initialize Project

```bash
cd /path/to/your/project
cleo init
```

**Creates:**
- `.cleo/todo.json` - Active tasks
- `.cleo/todo-archive.json` - Completed tasks
- `.cleo/config.json` - Configuration
- `.cleo/todo-log.json` - Audit trail

**Auto-injects:** Task management instructions into `CLAUDE.md`, `AGENTS.md`, `GEMINI.md`

### Step 5: Verify Project Initialization

```bash
cleo validate
cleo list
```

**Expected:** No errors, empty task list.

## Quick Reference

| Command | Purpose |
|---------|---------|
| `cleo add "Task"` | Create task |
| `cleo list` | View tasks (JSON when piped) |
| `cleo complete T001` | Mark done |
| `cleo focus set T001` | Set active task |
| `cleo session start` | Begin work session |
| `cleo dash` | Project overview |

## Troubleshooting

**Command not found:**
```bash
export PATH="$HOME/.local/bin:$PATH"
source ~/.bashrc
```

**Permission denied:**
```bash
chmod +x ~/.cleo/scripts/*.sh
```

**Validation errors:**
```bash
cleo validate --fix
cleo restore  # If needed
```

## Key Principles

1. **JSON output by default** - All commands output structured JSON when piped
2. **Exit codes matter** - 0 = success, 1-22 = error, 100+ = special
3. **CLI only** - Never edit `.cleo/*.json` directly
4. **Atomic operations** - All writes are validated and backed up

## MCP Server Integration

Connect your AI tools directly to CLEO documentation:

### Claude Code
```bash
claude mcp add --transport http CLEO https://cleo.dev/docs/mcp
claude mcp list  # Verify connection
```

### Cursor
Add to `.cursor/mcp.json`:
```json
{
  "mcpServers": {
    "CLEO": {
      "url": "https://cleo.dev/docs/mcp"
    }
  }
}
```

### VS Code (Continue)
Add to Continue settings:
```json
{
  "contextProviders": [
    {
      "name": "mcp",
      "params": {
        "url": "https://cleo.dev/docs/mcp"
      }
    }
  ]
}
```

## Core Capabilities

CLEO provides:
- **Task Management**: Hierarchical tasks (epic → task → subtask)
- **Session Tracking**: Multi-session with scope isolation
- **Anti-Hallucination**: Schema validation on all operations
- **Context Persistence**: State preserved across conversations
- **LLM-First Output**: JSON by default, human-readable opt-in

## Documentation

- Full docs: https://cleo.dev/docs
- MCP Server: https://cleo.dev/docs/mcp
- GitHub: https://github.com/kryptobaseddev/cleo
- Command reference: `cleo help <command>`

Execute installation now. Begin with Step 1.
