# @cleocode/cleo

CLEO CLI — the assembled product consuming @cleocode/core.

## Overview

This is the main CLEO package that brings together all other packages into a unified command-line interface. It provides:

- **CLI**: 100+ commands for task management, sessions, memory, orchestration, and more
- **Dispatch Layer**: CQRS routing with query/mutate gateways, middleware pipeline, and LAFS envelope formatting
- **Admin Tools**: Configuration, backup, migration, and system management

The CLI is a thin wrapper — all business logic lives in [@cleocode/core](../core).

## Installation

### Global Installation (Recommended)

```bash
npm install -g @cleocode/cleo
```

### Batteries-Included (CleoOS)

```bash
npm install -g @cleocode/cleo-os
```

This installs `cleo`, `ct`, and `cleoos` binaries with CANT bridge and TUI extensions.

### Using npx (No Installation)

```bash
npx @cleocode/cleo <command>
```

## Quick Start

### Initialize CLEO in Your Project

```bash
cd my-project
cleo init
```

### Basic Commands

```bash
# Add a task
cleo add "Implement user authentication" --priority high --acceptance "AC1|AC2|AC3"

# Search tasks (returns readiness info: depends, type, size)
cleo find "auth" --status pending

# Start a work session
cleo session start --scope global --name "Auth Feature"

# Show current context
cleo current

# Complete a task
cleo complete T001

# Get help
cleo --help
cleo <command> --help
```

## CLI Commands

CLEO provides 100+ commands organized into domains:

### Task Management

| Command | Description |
|---------|-------------|
| `cleo add <title>` | Create a new task |
| `cleo add-batch --file tasks.json` | Batch create tasks from JSON |
| `cleo list` | List all tasks |
| `cleo show <id>` | Show task details |
| `cleo find <query>` | Search tasks (agent-optimized, includes readiness) |
| `cleo find <query> --verbose` | Search with full task fields |
| `cleo find <query> --fields labels,acceptance` | Search with specific extra fields |
| `cleo complete <id>` | Mark task as complete |
| `cleo update <id>` | Update task properties |
| `cleo delete <id>` | Delete a task |
| `cleo start <id>` | Start working on a task |
| `cleo stop` | Stop current task |
| `cleo current` | Show current task |
| `cleo next` | Get next task to work on |
| `cleo archive <ids...>` | Archive completed tasks |
| `cleo deps <id>` | Show task dependencies |
| `cleo tree <id>` | Show task tree |
| `cleo labels` | Manage labels |
| `cleo blockers` | Show blockers |
| `cleo stats` | Task statistics |
| `cleo history <id>` | Task history |
| `cleo reorder <id> <position>` | Reorder tasks |
| `cleo reparent <id> <parent>` | Change parent task |
| `cleo relates <id> <target>` | Add relation |
| `cleo exists <id>` | Check if task exists |
| `cleo promote <id>` | Promote task to root level |

### Session Management

| Command | Description |
|---------|-------------|
| `cleo session start [--scope] [--name]` | Start a new session |
| `cleo session list` | List sessions |
| `cleo session resume <id>` | Resume a session |
| `cleo session end [id]` | End current session |
| `cleo briefing` | Generate session briefing |
| `cleo phase` | Phase management |
| `cleo checkpoint` | Create checkpoint |
| `cleo safestop` | Safe stop with context |

### Memory & Context

| Command | Description |
|---------|-------------|
| `cleo memory` | Memory operations |
| `cleo memory-brain` | Brain memory search |
| `cleo observe <text>` | Save observation to brain.db |
| `cleo context` | Show context |
| `cleo inject` | Inject context |
| `cleo sync` | Sync memory |
| `cleo sticky` | Sticky notes |
| `cleo refresh-memory` | Refresh memory bridge |

### Validation & Compliance

| Command | Description |
|---------|-------------|
| `cleo validate` | Validate tasks |
| `cleo verify` | Verify compliance |
| `cleo compliance` | Compliance checks |
| `cleo doctor` | System health check |
| `cleo analyze` | Analyze project |

### Pipeline & Lifecycle

| Command | Description |
|---------|-------------|
| `cleo release` | Release management |
| `cleo lifecycle` | Lifecycle operations |
| `cleo promote <id>` | Promote task/stage |
| `cleo upgrade` | Upgrade CLEO |
| `cleo roadmap` | Roadmap planning |
| `cleo plan` | Create plan |
| `cleo phases` | Phase operations |
| `cleo log` | View logs |
| `cleo issue` | Issue management |
| `cleo bug` | Bug tracking |

### Orchestration

| Command | Description |
|---------|-------------|
| `cleo orchestrate` | Orchestration operations |
| `cleo ops` | Operations dashboard |
| `cleo consensus` | Consensus workflow |
| `cleo contribution` | Track contribution |
| `cleo decomposition` | Decompose tasks |
| `cleo implementation` | Implementation guide |
| `cleo sequence` | Task sequencing |
| `cleo dash` | Dashboard |

### Nexus & Sync

| Command | Description |
|---------|-------------|
| `cleo nexus` | Nexus operations |
| `cleo init` | Initialize project |
| `cleo remote` | Remote management |
| `cleo push` | Push to remote |
| `cleo pull` | Pull from remote |
| `cleo snapshot` | Create snapshot |
| `cleo export` | Export data |
| `cleo import` | Import data |

### Administration

| Command | Description |
|---------|-------------|
| `cleo config` | Configuration |
| `cleo backup` | Backup data |
| `cleo backup export` | Pack a portable `.cleobundle.tar.gz` |
| `cleo backup import` | Restore from a portable bundle |
| `cleo backup inspect` | Print bundle manifest |
| `cleo restore finalize` | Apply resolved conflicts |
| `cleo skills` | Skills management |
| `cleo self-update` | Update CLEO |
| `cleo grade` | Grade session |
| `cleo migrate` | Run migrations |
| `cleo adr` | ADR management |
| `cleo map` | Codebase map |
| `cleo commands` | List all commands |
| `cleo otel` | OpenTelemetry |
| `cleo token` | Token management |

### Cross-machine Backup (v2026.4.13+)

```bash
cleo backup export <name> [--scope project|global|all] [--encrypt]
cleo backup import <bundle> [--force]
cleo backup inspect <bundle>
cleo restore finalize
```

See [ADR-038](../../.cleo/adrs/ADR-038-backup-portability.md) for the full specification.

## Global Options

```bash
# Output format
cleo --json <command>      # JSON output
cleo --human <command>     # Human-readable output (default)
cleo --quiet <command>     # Minimal output

# Field extraction
cleo --field <name> <command>     # Extract single field
cleo --fields <names> <command>   # Extract multiple fields

# Minimum viable information
cleo --mvi <level> <command>      # Control detail level
```

## Configuration

### Environment Variables

```bash
export CLEO_LOG_LEVEL=debug
export CLEO_PROJECT_ROOT=/path/to/project   # Override cwd-based project detection
export CLEO_ROOT=/path/to/project           # Alias for CLEO_PROJECT_ROOT
```

### Configuration File

```json
// .cleo/config.json
{
  "logging": { "level": "info" },
  "session": { "enforcement": { "requiredForMutate": true } },
  "lifecycle": { "mode": "advisory" },
  "enforcement": {
    "acceptance": { "mode": "block", "minimumCriteria": 3 }
  }
}
```

### CLI Config Commands

```bash
cleo config set logging.level debug
cleo config get logging.level
cleo config list
```

## Programmatic Usage

While the CLI is the primary interface, you can use the core SDK directly:

```typescript
import { Cleo } from '@cleocode/core';

const cleo = await Cleo.init('./my-project');

// Task operations
await cleo.tasks.add({ title: 'New task' });

// Cleanup
await cleo.destroy();
```

## Architecture

```
┌─────────────────────────────────────┐
│        @cleocode/cleo               │
│  ┌──────────────────────────────┐   │
│  │          CLI Layer           │   │
│  │  89 commands (commander.js)  │   │
│  └──────────────┬───────────────┘   │
│                 │                    │
│  ┌──────────────┴───────────────┐   │
│  │       Dispatch Layer         │   │
│  │  CQRS query/mutate routing   │   │
│  │  12 domain handlers          │   │
│  │  19 engine wrappers          │   │
│  │  Middleware pipeline          │   │
│  └──────────────┬───────────────┘   │
│                 │                    │
│  ┌──────────────┴───────────────┐   │
│  │       @cleocode/core         │   │
│  │  Tasks • Sessions • Memory   │   │
│  │  Orchestration • Lifecycle   │   │
│  └──────────────────────────────┘   │
└─────────────────────────────────────┘
```

## Troubleshooting

### Common Issues

**"Project not initialized"**
```bash
cleo init
```

**"Storage migration needed"**
```bash
cleo upgrade
```

**"Permission denied"**
```bash
chmod +x $(which cleo)
```

### Debug Mode

```bash
export CLEO_LOG_LEVEL=debug
cleo <command>
```

### Getting Help

```bash
cleo --help
cleo <command> --help
cleo doctor
cleo commands
```

## Dependencies

### Production

- `@cleocode/core` — Business logic SDK
- `@cleocode/contracts` — Shared type definitions
- `@cleocode/caamp` — Provider registry
- `@cleocode/cant` — CANT protocol parser
- `@cleocode/lafs` — Error envelope protocol
- `@cleocode/runtime` — Long-running process layer
- `drizzle-orm` — Database ORM
- `pino` — Logging

### Binaries

- `cleo` — Primary command
- `ct` — Short alias

## License

MIT License - see [LICENSE](../../LICENSE) for details.
