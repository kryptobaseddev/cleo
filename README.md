# CLEO - Contextual Language Engine & Orchestrator

[![npm version](https://img.shields.io/npm/v/@cleocode/cleo.svg)](https://www.npmjs.com/package/@cleocode/cleo)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js Version](https://img.shields.io/badge/node-%3E%3D24.0.0-brightgreen.svg)](https://nodejs.org/)

CLEO is a comprehensive task management and agent orchestration system designed for AI-powered software development workflows. It provides structured task tracking, session management, memory systems, and multi-provider AI integration through a unified interface.

## What is CLEO?

CLEO stands for **Contextual Language Engine & Orchestrator**. It's built to solve the coordination challenges that arise when working with multiple AI coding assistants across complex software projects.

### Core Capabilities

- **Task Management**: Hierarchical task tracking with dependencies, priorities, and lifecycle states
- **Session Management**: Contextual work sessions with automatic state persistence
- **Agent Orchestration**: Multi-agent coordination with protocol compliance
- **Memory Systems**: Persistent knowledge storage with brain-like retrieval
- **Multi-Provider Support**: Works with Claude Code, OpenCode, Cursor, and more
- **MCP Server**: Full Model Context Protocol integration for AI assistants

## Monorepo Structure

This monorepo contains 6 packages that work together to provide the complete CLEO ecosystem:

| Package | Purpose | Description |
|---------|---------|-------------|
| [`@cleocode/contracts`](packages/contracts) | Type Definitions | Domain types, interfaces, and contracts - the foundation of the type system |
| [`@cleocode/core`](packages/core) | Business Logic | Task management, sessions, memory, orchestration, and lifecycle management |
| [`@cleocode/adapters`](packages/adapters) | Provider Integration | Unified adapters for Claude Code, OpenCode, Cursor, and other AI providers |
| [`@cleocode/agents`](packages/agents) | Agent Protocols | Subagent templates and protocol definitions for autonomous execution |
| [`@cleocode/skills`](packages/skills) | Skill Definitions | Pre-built skills and capabilities for common development workflows |
| [`@cleocode/cleo`](packages/cleo) | CLI & MCP Server | Command-line interface and Model Context Protocol server |

## Quick Start

### Installation

```bash
# Install globally for CLI access
npm install -g @cleocode/cleo

# Or use with npx (no installation required)
npx @cleocode/cleo init
```

### Initialize a Project

```bash
# Navigate to your project
cd my-project

# Initialize CLEO
cleo init

# Or use the shorthand
cleo init --with-examples
```

### Basic Usage

```bash
# Add a task
cleo add "Implement user authentication" --priority high

# List tasks
cleo list

# Start a work session
cleo session start "Authentication Feature"

# Show current task context
cleo current

# Complete a task
cleo complete T1234
```

### Using the MCP Server

CLEO includes a full MCP (Model Context Protocol) server for AI assistants:

```bash
# Start the MCP server
cleo mcp

# Or configure in your MCP settings (Claude Desktop, etc.)
{
  "mcpServers": {
    "cleo": {
      "command": "cleo",
      "args": ["mcp"]
    }
  }
}
```

## Development Setup

### Prerequisites

- Node.js >= 24.0.0
- pnpm >= 10.30.0 (package manager)

### Clone and Install

```bash
# Clone the repository
git clone https://github.com/cleocode/cleo.git
cd cleo

# Install dependencies
pnpm install

# Build all packages
pnpm build

# Run tests
pnpm test
```

### Package Development

```bash
# Build a specific package
pnpm build:contracts
pnpm build:core
pnpm build:cleo

# Type checking
pnpm typecheck

# Linting
pnpm lint
pnpm lint:fix
```

### Database Operations

```bash
# Generate migrations
pnpm db:generate

# Open Drizzle Studio
pnpm db:studio
```

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                    @cleocode/cleo                           │
│              CLI + MCP Server Entry Point                   │
└─────────────────────────────────────────────────────────────┘
                              │
┌─────────────────────────────────────────────────────────────┐
│                    @cleocode/core                           │
│     Tasks • Sessions • Memory • Orchestration • Lifecycle   │
└─────────────────────────────────────────────────────────────┘
                              │
        ┌─────────────────────┼─────────────────────┐
        │                     │                     │
┌───────▼───────┐   ┌────────▼────────┐   ┌────────▼────────┐
│   adapters    │   │     memory      │   │   orchestration │
│   sessions    │   │     brain       │   │   phases        │
│   tasks       │   │     sticky      │   │   lifecycle     │
│   compliance  │   │     inject      │   │   release       │
└───────────────┘   └─────────────────┘   └─────────────────┘
                              │
┌─────────────────────────────────────────────────────────────┐
│                  @cleocode/contracts                        │
│            Types • Interfaces • Contracts                   │
└─────────────────────────────────────────────────────────────┘
                              │
        ┌─────────────────────┼─────────────────────┐
        │                     │                     │
┌───────▼───────┐   ┌────────▼────────┐   ┌────────▼────────┐
│   adapters    │   │     agents      │   │     skills      │
│  (providers)  │   │  (protocols)    │   │ (definitions)   │
└───────────────┘   └─────────────────┘   └─────────────────┘
```

## Key Features

### Task Management
- Hierarchical tasks with parent-child relationships
- Priority levels and sizing estimates
- Dependency tracking and blocker identification
- Automatic sequencing and critical path analysis
- Archive and restore functionality

### Session Management
- Contextual work sessions with automatic persistence
- Session notes and progress tracking
- Safe stop and checkpoint mechanisms
- Briefing generation for context handoff

### Memory Systems
- Brain-like knowledge storage with semantic search
- Sticky notes for ephemeral context
- Memory bridges for cross-session persistence
- Context injection for AI assistants

### Agent Orchestration
- Subagent spawning with protocol compliance
- Wave-based parallel execution
- Consensus workflows for multi-agent decisions
- LOOM (Logical Order of Operations Methodology) lifecycle

### Multi-Provider Support
- Claude Code integration with statusline sync
- OpenCode adapter with spawn hooks
- Cursor support
- Extensible adapter architecture

## Commands Overview

CLEO provides 80+ commands organized into domains:

| Domain | Commands |
|--------|----------|
| **Tasks** | add, list, show, find, complete, update, delete, archive, start, stop, current, next |
| **Session** | session, briefing, phase, checkpoint, safestop |
| **Memory** | memory, memory-brain, observe, context, inject, sync, sticky, note |
| **Check** | validate, verify, compliance, doctor, analyze |
| **Pipeline** | release, lifecycle, promote, upgrade, specification, roadmap, plan |
| **Orchestration** | orchestrate, ops, consensus, contribution, decomposition, implementation |
| **Research** | research, extract, web, docs |
| **Nexus** | nexus, init, remote, push, pull, snapshot, export, import |
| **Admin** | config, backup, skills, migrate, grade, map, commands |

## Contributing

We welcome contributions! Please see our [Contributing Guide](CONTRIBUTING.md) for details.

### Development Workflow

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Make your changes
4. Run tests (`pnpm test`)
5. Commit with conventional commits (`feat:`, `fix:`, `docs:`, etc.)
6. Push to your fork
7. Open a Pull Request

### Code Style

- TypeScript with strict mode enabled
- Biome for linting and formatting
- Conventional commit messages
- Comprehensive test coverage with Vitest

## Documentation

- [API Documentation](docs/api)
- [Architecture Guide](docs/architecture)
- [Skill Development](docs/skills)
- [MCP Specification](docs/mcp)

## Community

- [GitHub Discussions](https://github.com/cleocode/cleo/discussions)
- [Discord Server](https://discord.gg/cleocode)
- [Twitter/X @cleocode](https://twitter.com/cleocode)

## License

MIT License - see [LICENSE](LICENSE) for details.

---

Built with ❤️ by the CLEO team and contributors.
