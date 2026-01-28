# CLEO Claude Code Plugin

**Version**: 0.70.1
**Status**: Optional Enhancement
**Architecture**: Hybrid (Injection + Plugin)

---

## Overview

CLEO uses a **hybrid approach** for multi-agent integration:

| Component | Purpose | Support |
|-----------|---------|---------|
| **Injection System** | Multi-agent task management | 16+ agents (Claude, Cursor, Windsurf, Gemini, etc.) |
| **Plugin System** | Claude Code hooks | Claude Code only |

**Most users need injection only.** The plugin adds optional Claude Code-specific hooks for advanced users.

---

## Architecture

### Primary: Injection System

The injection system provides CLEO task management to **all LLM agents** via registry-based auto-discovery:

**Location**: `schemas/agent-registry.json`
**Agents Supported**: claude-code, cursor, windsurf, gemini, copilot, roo-code, cline, continue, aider, bolt, replit, lovable, v0, devin, and more.

**How it works**:
1. `cleo init` discovers installed agents automatically
2. Injects task management instructions to agent config files
3. Agents reference external docs via `@~/.cleo/docs/TODO_Task_Management.md`
4. Works with any agent that supports config file injection

**Supported files**: `CLAUDE.md`, `CURSOR.md`, `.windsurfrules`, `GEMINI.md`, etc.

### Optional: Plugin System

The plugin adds **Claude Code-specific hooks** for terminal integration:

**Location**: `.claude-plugin/`
**Capabilities**: SessionStart hook for automatic session binding
**Limitation**: Claude Code only (not portable to other agents)

**What the plugin provides**:
- **SessionStart Hook**: Auto-binds CLEO session to Claude terminal via `CLEO_SESSION` env var
- **TTY Integration**: Seamless session continuity across Claude Code restarts

**What it does NOT provide**:
- ❌ Slash commands (future enhancement)
- ❌ Custom agents (future enhancement)
- ❌ Portability to other agents (injection system handles this)

---

## When to Use Plugin

### Use Injection Only (Default) ✓

**Recommended for**:
- Multi-agent workflows (Cursor, Windsurf, Gemini, etc.)
- Standard Claude Code usage
- Users who don't need automatic session binding

**What you get**:
- Full CLEO task management (`cleo` CLI)
- Multi-session support
- Orchestration and subagents
- Works in all supported agents

### Add Plugin (Advanced) ⚡

**Recommended for**:
- Heavy Claude Code users
- Multi-session power users
- Users who want automatic session binding

**What you get**:
- Everything from injection system
- **PLUS**: SessionStart hook for automatic `CLEO_SESSION` binding
- **PLUS**: TTY-aware session continuity

---

## Installation

### Default Installation (Injection Only)

```bash
# Install CLEO with multi-agent support
curl -fsSL https://github.com/kryptobaseddev/cleo/releases/latest/download/install.sh | bash

# Setup agent configurations (auto-discovers installed agents)
cleo init

# Verify injection
cleo doctor
```

**Result**: CLEO works in all supported agents via injection system.

### Advanced Installation (Injection + Plugin)

```bash
# Install CLEO with Claude Code plugin
curl -fsSL https://github.com/kryptobaseddev/cleo/releases/latest/download/install.sh | bash -s -- --with-plugin

# Setup agent configurations
cleo init

# Verify both injection and plugin
cleo doctor
```

**Result**: CLEO works in all agents + Claude Code gets SessionStart hook.

---

## Plugin Structure

```
.claude-plugin/
├── plugin.json           # Plugin manifest
├── hooks/
│   ├── hooks.json       # Hook configuration
│   └── scripts/
│       └── session-start.sh   # SessionStart hook implementation
└── README.md            # This file
```

### plugin.json

Plugin manifest defining capabilities:

```json
{
  "name": "cleo",
  "version": "0.70.1",
  "capabilities": {
    "task_management": true,
    "multi_session": true,
    "orchestration": true
  },
  "hooks": {
    "enabled": true,
    "directory": "hooks",
    "manifest": "hooks/hooks.json"
  }
}
```

### hooks.json

Hook configuration for SessionStart event:

```json
{
  "SessionStart": [{
    "matcher": "*",
    "hooks": [{
      "type": "command",
      "command": "bash ${CLAUDE_PLUGIN_ROOT}/hooks/scripts/session-start.sh",
      "timeout": 10
    }]
  }]
}
```

### session-start.sh

Auto-binds active CLEO session to Claude terminal:

**What it does**:
1. Checks for active CLEO session (`.cleo/.current-session`)
2. Verifies session is active via `cleo session status`
3. Exports `CLEO_SESSION` env var for terminal
4. Creates `.cleo/.session-env` for manual sourcing (if needed)

**Exit conditions** (silent):
- CLEO not installed
- No `.cleo` directory (not a CLEO project)
- No active session
- Session inactive/ended

---

## Usage

### With Injection Only

Standard CLI workflow:

```bash
# Start session manually
cleo session start --scope epic:T1074 --auto-focus

# Use cleo commands with CLEO_SESSION env var
export CLEO_SESSION="session_20260127_123456_abc123"
cleo list --parent T1074
cleo complete T1087

# End session
cleo session end --note "Completed plugin docs"
```

### With Plugin

Plugin auto-binds session on Claude Code start:

```bash
# Start session (manually or via orchestrator)
cleo session start --scope epic:T1074 --auto-focus

# Claude Code starts → plugin auto-exports CLEO_SESSION
# ✓ CLEO session bound: session_20260127_123456_abc123

# Use cleo commands (no manual export needed)
cleo list --parent T1074
cleo complete T1087

# End session
cleo session end --note "Completed plugin docs"
```

**Key difference**: Plugin eliminates manual `export CLEO_SESSION=...` step.

---

## Hybrid Benefits

| Benefit | Injection | Plugin |
|---------|-----------|--------|
| Multi-agent support | ✓ | ❌ |
| Claude Code support | ✓ | ✓ |
| Task management | ✓ | ✓ |
| Multi-session | ✓ | ✓ |
| Auto session binding | ❌ | ✓ |
| TTY continuity | ❌ | ✓ |

**Philosophy**: Injection provides portability, plugin provides polish.

---

## Decision Tree

```
Do you use Claude Code exclusively?
├─ Yes
│   └─ Do you want automatic session binding?
│       ├─ Yes → Install with --with-plugin
│       └─ No  → Install default (injection only)
└─ No (multi-agent workflow)
    └─ Install default (injection only)
```

---

## Troubleshooting

### Plugin Not Working

**Symptom**: SessionStart hook not firing

**Check**:
1. Plugin installed: `ls .claude-plugin/`
2. Hooks enabled: `cat .claude-plugin/plugin.json | jq '.hooks.enabled'`
3. CLEO session active: `cleo session status`
4. Claude Code version: Plugin requires Claude Code 1.0.0+

### Session Not Auto-Binding

**Symptom**: `CLEO_SESSION` not set after Claude Code start

**Check**:
1. Active session exists: `cat .cleo/.current-session`
2. Session is active: `cleo session status`
3. Hook script executable: `ls -l .claude-plugin/hooks/scripts/session-start.sh`
4. Manual test: `bash .claude-plugin/hooks/scripts/session-start.sh`

### Injection vs Plugin Conflict

**Symptom**: Duplicate task management instructions

**Resolution**: No conflict. Injection and plugin are complementary:
- Injection: Provides task management docs to agent
- Plugin: Provides terminal integration hooks

Both can coexist safely.

---

## Future Enhancements

**Planned plugin features** (not in v0.70.1):
- Slash commands (`/cleo add "Task"`)
- Custom agents (`ct-orchestrator`, `ct-epic-architect`)
- Agent-to-agent communication (consensus protocol)
- Git workflow integration

**Current status**: Plugin provides SessionStart hook only. All other features use standard CLI.

---

## References

- **Injection System**: `schemas/agent-registry.json`
- **Setup Guide**: `docs/guides/AGENT-REGISTRATION.md`
- **Subagent Architecture**: `docs/architecture/CLEO-SUBAGENT.md`
- **Protocol Stack**: `protocols/`

---

**Key Insight**: CLEO uses injection for portability, plugin for Claude Code polish. Most users need injection only.
