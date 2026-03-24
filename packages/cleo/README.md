# @cleocode/cleo

CLEO CLI + MCP Server - the assembled product consuming @cleocode/core.

## Overview

This is the main CLEO package that brings together all other packages into a unified command-line interface and Model Context Protocol (MCP) server. It provides:

- **CLI**: 80+ commands for task management, sessions, memory, and more
- **MCP Server**: Full integration with AI assistants via the Model Context Protocol
- **Admin Tools**: Configuration, backup, migration, and system management

## Installation

### Global Installation (Recommended)

```bash
npm install -g @cleocode/cleo
```

```bash
pnpm add -g @cleocode/cleo
```

```bash
yarn global add @cleocode/cleo
```

### Local Installation

```bash
npm install @cleocode/cleo
```

```bash
pnpm add @cleocode/cleo
```

### Using npx (No Installation)

```bash
npx @cleocode/cleo <command>
```

## Quick Start

### Initialize CLEO in Your Project

```bash
# Navigate to your project
cd my-project

# Initialize CLEO
cleo init

# Or with examples
cleo init --with-examples
```

### Basic Commands

```bash
# Add a task
cleo add "Implement user authentication"

# List tasks
cleo list

# Start a work session
cleo session start "Authentication Feature"

# Show current context
cleo current

# Complete a task
cleo complete T1234

# Get help
cleo --help
cleo <command> --help
```

## CLI Commands

CLEO provides 80+ commands organized into domains:

### Task Management

| Command | Description |
|---------|-------------|
| `cleo add <title>` | Create a new task |
| `cleo list` | List all tasks |
| `cleo show <id>` | Show task details |
| `cleo find <query>` | Search tasks |
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
| `cleo tags` | Manage tags |
| `cleo blockers` | Show blockers |
| `cleo stats` | Task statistics |
| `cleo history <id>` | Task history |
| `cleo reorder <id> <position>` | Reorder tasks |
| `cleo reparent <id> <parent>` | Change parent task |
| `cleo relates <id> <target>` | Add relation |
| `cleo exists <id>` | Check if task exists |

### Session Management

| Command | Description |
|---------|-------------|
| `cleo session` | Session management |
| `cleo session start [name]` | Start a new session |
| `cleo session list` | List sessions |
| `cleo session resume <id>` | Resume a session |
| `cleo session end [id]` | End current/session |
| `cleo briefing` | Generate session briefing |
| `cleo phase` | Phase management |
| `cleo checkpoint` | Create checkpoint |
| `cleo safestop` | Safe stop with context |

### Memory & Context

| Command | Description |
|---------|-------------|
| `cleo memory` | Memory operations |
| `cleo memory-brain` | Brain memory search |
| `cleo observe` | Observe and store memory |
| `cleo context` | Show context |
| `cleo inject` | Inject context |
| `cleo sync` | Sync memory |
| `cleo sticky` | Sticky notes |
| `cleo note` | Add session note |
| `cleo refresh-memory` | Refresh memory |

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
| `cleo promote` | Promote task/stage |
| `cleo upgrade` | Upgrade CLEO |
| `cleo specification` | Write specification |
| `cleo detect-drift` | Detect drift |
| `cleo roadmap` | Roadmap planning |
| `cleo plan` | Create plan |
| `cleo phases` | Phase operations |
| `cleo log` | View logs |
| `cleo issue` | Issue management |
| `cleo bug` | Bug tracking |
| `cleo generate-changelog` | Generate changelog |

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

### Research

| Command | Description |
|---------|-------------|
| `cleo research` | Research topics |
| `cleo extract` | Extract information |
| `cleo web` | Web search |
| `cleo docs` | Documentation lookup |

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
| `cleo export-tasks` | Export tasks |
| `cleo import-tasks` | Import tasks |

### Administration

| Command | Description |
|---------|-------------|
| `cleo config` | Configuration |
| `cleo backup` | Backup data |
| `cleo env` | Environment vars |
| `cleo mcp-install` | Install MCP |
| `cleo testing` | Testing setup |
| `cleo skills` | Skills management |
| `cleo self-update` | Update CLEO |
| `cleo install-global` | Global install |
| `cleo grade` | Grade session |
| `cleo migrate` | Run migrations |
| `cleo migrate-claude-mem` | Migrate Claude memories |
| `cleo otel` | OpenTelemetry |
| `cleo token` | Token management |
| `cleo adr` | ADR management |
| `cleo map` | Codebase map |
| `cleo commands` | List all commands |

## MCP Server

CLEO includes a full MCP server for AI assistant integration.

### Starting the MCP Server

```bash
# Start MCP server
cleo mcp

# Or directly
node ./node_modules/@cleocode/cleo/dist/mcp/index.js
```

### Configuring with Claude Desktop

Add to your Claude Desktop configuration (`~/Library/Application Support/Claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "cleo": {
      "command": "cleo",
      "args": ["mcp"]
    }
  }
}
```

### MCP Tools

The MCP server exposes two main tools:

#### `query` - Read Operations

Query operations never modify state. They are cached by default.

```json
{
  "domain": "tasks",
  "operation": "list",
  "params": {
    "status": ["pending", "in_progress"],
    "limit": 10
  }
}
```

Available domains:
- `tasks` - Task queries (list, show, find, deps)
- `session` - Session queries (status, list)
- `memory` - Memory queries (search, observe)
- `orchestrate` - Orchestration queries (status, analyze)
- `admin` - Admin queries (config, health)
- `skills` - Skill queries (list, show)
- `nexus` - Nexus queries (status, remote)
- `check` - Validation queries (compliance, verify)
- And more...

#### `mutate` - Write Operations

Mutate operations modify state and are validated, logged, and atomic.

```json
{
  "domain": "tasks",
  "operation": "add",
  "params": {
    "title": "New task",
    "priority": "high"
  }
}
```

### MCP Resources

Memory resources are exposed for context retrieval:

- `cleo://memory/brain` - Brain memory entries
- `cleo://memory/context` - Current context
- `cleo://memory/sticky` - Sticky notes
- `cleo://session/current` - Current session info

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

CLEO can be configured via:

### Environment Variables

```bash
export CLEO_LOG_LEVEL=debug
export CLEO_CONFIG_PATH=./.cleo/config.yaml
export CLEO_DATA_DIR=./.cleo
```

### Configuration File

```yaml
# .cleo/config.yaml
logging:
  level: info
  format: json

session:
  auto_start: true
  default_scope: feature

lifecycle:
  enforcement: strict
  
output:
  format: human
  
sharing:
  mode: local
```

### CLI Options

```bash
cleo config set logging.level debug
cleo config get logging.level
cleo config list
```

## Programmatic Usage

While the CLI is the primary interface, you can also use CLEO programmatically:

### As a Module

```typescript
import { Cleo } from '@cleocode/core';

const cleo = await Cleo.init('./my-project');

// Task operations
await cleo.tasks.add({ title: 'New task' });

// Cleanup
await cleo.destroy();
```

### MCP Client

```typescript
import { Client } from '@modelcontextprotocol/sdk/client/index.js';

const client = new Client({ name: 'my-client', version: '1.0.0' });
await client.connect(transport);

// Call CLEO tools
const result = await client.callTool('query', {
  domain: 'tasks',
  operation: 'list'
});
```

## API Overview

### Exports

The package exports two main entry points:

```typescript
// CLI entry point (default)
import '@cleocode/cleo';

// MCP server entry point
import '@cleocode/cleo/mcp';
```

### Binaries

Multiple binary names are provided:

- `cleo` - Primary command
- `ct` - Short alias

## Development

### Building

```bash
# Build the package
pnpm build

# Type check
pnpm typecheck
```

### Testing

```bash
# Run tests
pnpm test

# Run specific test
pnpm test -- cleo.test.ts
```

### Database

```bash
# Generate migrations
pnpm db:generate

# Open Drizzle Studio
pnpm db:studio
```

## Architecture

```
┌─────────────────────────────────────┐
│        @cleocode/cleo               │
│  ┌──────────────┬─────────────────┐ │
│  │     CLI      │   MCP Server    │ │
│  │   (citty)    │    (stdio)      │ │
│  └──────────────┴─────────────────┘ │
│           │                         │
│  ┌────────┴─────────────────────┐   │
│  │     Dispatch Layer           │   │
│  │  - Query/Mutate routing      │   │
│  │  - Rate limiting             │   │
│  │  - Caching                   │   │
│  │  - Background jobs           │   │
│  └──────────────────────────────┘   │
│           │                         │
│  ┌────────┴─────────────────────┐   │
│  │     @cleocode/core           │   │
│  │  - Tasks, Sessions, Memory   │   │
│  │  - Orchestration             │   │
│  │  - Compliance                │   │
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
# Fix permissions
chmod +x $(which cleo)
```

**MCP connection issues**
```bash
# Check MCP status
cleo doctor

# Reinstall MCP
cleo mcp-install
```

### Debug Mode

```bash
# Enable debug logging
export CLEO_LOG_LEVEL=debug
cleo <command>

# Or via config
cleo config set logging.level debug
```

### Getting Help

```bash
# General help
cleo --help

# Command help
cleo <command> --help

# System health
cleo doctor

# List all commands
cleo commands
```

## Dependencies

### Production Dependencies

- `@cleocode/core` - Business logic
- `@cleocode/contracts` - Type definitions
- `@cleocode/caamp` - Context-aware memory
- `@cleocode/lafs` - Feedback schema
- `@modelcontextprotocol/sdk` - MCP protocol
- `drizzle-orm` - Database ORM
- `citty` - CLI framework
- `pino` - Logging
- And more...

### Development Dependencies

- `typescript` - Type checking
- `vitest` - Testing

## License

MIT License - see [LICENSE](../LICENSE) for details.

---

For more information, visit [https://cleo.dev](https://cleo.dev)
