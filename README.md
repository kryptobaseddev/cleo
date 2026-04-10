# CLEO - Contextual Language Engine & Orchestrator

[![npm version](https://img.shields.io/npm/v/@cleocode/cleo.svg)](https://www.npmjs.com/package/@cleocode/cleo)
[![CI](https://github.com/kryptobaseddev/cleo/actions/workflows/ci.yml/badge.svg)](https://github.com/kryptobaseddev/cleo/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js Version](https://img.shields.io/badge/node-%3E%3D24.0.0-brightgreen.svg)](https://nodejs.org/)

[![ko-fi](https://ko-fi.com/img/githubbutton_sm.svg)](https://ko-fi.com/H2H815OTBU)

CLEO is a comprehensive task management and agent orchestration system designed for AI-powered software development workflows. It provides structured task tracking, session management, memory systems, and multi-provider AI integration through a unified CLI.

## What is CLEO?

CLEO stands for **Contextual Language Engine & Orchestrator**. It's built to solve the coordination challenges that arise when working with multiple AI coding assistants across complex software projects.

### Core Capabilities

- **Task Management**: Hierarchical task tracking with dependencies, priorities, and lifecycle states
- **Session Management**: Contextual work sessions with automatic state persistence
- **Agent Orchestration**: Multi-agent coordination with protocol compliance
- **Memory Systems**: Persistent knowledge storage with brain-like retrieval
- **Multi-Provider Support**: Works with Claude Code, OpenCode, Cursor, Gemini, Codex, and more
- **Lifecycle Pipeline**: 9-stage RCASD-IVTR+C lifecycle with verification gates

## Monorepo Structure

This monorepo contains 11 packages organized in a 4-layer architecture:

| Layer | Package | Purpose |
|-------|---------|---------|
| **Foundation** | [`@cleocode/contracts`](packages/contracts) | Domain types, interfaces, and contracts — zero-dependency type SSoT |
| **Foundation** | [`@cleocode/lafs`](packages/lafs) | Language-Agnostic Feedback Schema — canonical error envelope protocol |
| **Protocol** | [`@cleocode/adapters`](packages/adapters) | Provider adapters for Claude Code, OpenCode, Cursor, Gemini, Codex, Kimi |
| **Protocol** | [`@cleocode/agents`](packages/agents) | Subagent templates and LOOM lifecycle protocol definitions |
| **Protocol** | [`@cleocode/skills`](packages/skills) | Pre-built skills and capabilities for development workflows |
| **Protocol** | [`@cleocode/cant`](packages/cant) | CANT protocol parser with napi-rs Rust binding |
| **Feature** | [`@cleocode/caamp`](packages/caamp) | Central AI Agent Managed Packages — unified provider registry and MCP management |
| **Feature** | [`@cleocode/runtime`](packages/runtime) | Long-running process layer (polling, SSE, heartbeat) |
| **Kernel** | [`@cleocode/core`](packages/core) | Business logic SDK — tasks, sessions, memory, orchestration, lifecycle |
| **Product** | [`@cleocode/cleo`](packages/cleo) | Command-line interface — thin wrapper over core |
| **Product** | [`@cleocode/cleo-os`](packages/cleo-os) | Batteries-included distribution with CANT bridge and TUI extensions |

## Quick Start

### Installation

```bash
# Install globally for CLI access
npm install -g @cleocode/cleo

# Or the batteries-included distribution
npm install -g @cleocode/cleo-os
```

### Initialize a Project

```bash
cd my-project
cleo init
```

### Basic Usage

```bash
# Add a task
cleo add "Implement user authentication" --priority high

# Search tasks (agent-optimized, returns readiness info)
cleo find "auth" --status pending

# Start a work session
cleo session start --scope global --name "Auth Feature"

# Show current task context
cleo current

# Complete a task
cleo complete T001
```

## Development Setup

### Prerequisites

- Node.js >= 24.0.0
- pnpm >= 10.30.0 (package manager)

### Clone and Install

```bash
git clone https://github.com/kryptobaseddev/cleo.git
cd cleo

pnpm install
pnpm build
pnpm test
```

### Package Development

```bash
# Type checking (project references)
pnpm typecheck

# Linting and formatting
pnpm biome check --write .

# Run tests
pnpm test
```

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│              @cleocode/cleo  +  @cleocode/cleo-os           │
│                    CLI Product Layer                         │
│    89 commands • dispatch routing • output formatting        │
└────────────────────────────┬────────────────────────────────┘
                             │
┌────────────────────────────┴────────────────────────────────┐
│                      @cleocode/core                         │
│                   Business Logic Kernel                      │
│   Tasks • Sessions • Memory • Orchestration • Lifecycle     │
│   Validation • Intelligence • Nexus • Release • Agents      │
└────────────────────────────┬────────────────────────────────┘
                             │
      ┌──────────────────────┼──────────────────────┐
      │                      │                      │
┌─────┴──────┐  ┌────────────┴────────────┐  ┌─────┴──────┐
│  adapters  │  │  caamp • cant • runtime │  │  agents    │
│ (providers)│  │  (protocols & features) │  │  skills    │
└────────────┘  └─────────────────────────┘  └────────────┘
                             │
┌────────────────────────────┴────────────────────────────────┐
│            @cleocode/contracts  +  @cleocode/lafs           │
│              Types • Interfaces • Error Protocol             │
│                   Zero-dependency foundation                 │
└─────────────────────────────────────────────────────────────┘
```

## Key Features

### Task Management
- Hierarchical tasks with parent-child relationships
- Priority levels and sizing estimates (small/medium/large)
- Dependency tracking with readiness detection
- Automatic sequencing and critical path analysis
- Batch creation via `cleo add-batch`

### Session Management
- Contextual work sessions with epic scope binding
- Session-scoped parent inheritance for task creation
- Briefing generation for context handoff
- Safe stop and checkpoint mechanisms

### Memory Systems
- Brain-like knowledge storage with semantic search
- Sticky notes for ephemeral context
- Memory bridges for cross-session persistence
- 3-layer retrieval: search → timeline → fetch

### Agent Orchestration
- Subagent spawning with protocol compliance
- Wave-based parallel execution
- Consensus workflows for multi-agent decisions
- LOOM (Logical Order of Operations Methodology) lifecycle

### Multi-Provider Support
- Claude Code integration with statusline sync
- OpenCode, Cursor, Gemini, Codex, Kimi adapters
- Extensible adapter architecture via CAAMP

## Commands Overview

CLEO provides 100+ commands organized into domains:

| Domain | Commands |
|--------|----------|
| **Tasks** | add, add-batch, list, show, find, complete, update, delete, archive, start, stop, current, next, deps, tree, labels, blockers, stats, history, reorder, reparent, relates, exists |
| **Session** | session start/end/list/resume, briefing, phase, checkpoint, safestop |
| **Memory** | memory, memory-brain, observe, context, inject, sync, sticky, refresh-memory |
| **Check** | validate, verify, compliance, doctor, analyze |
| **Pipeline** | release, lifecycle, promote, upgrade, roadmap, plan, phases, log, issue, bug |
| **Orchestration** | orchestrate, ops, consensus, contribution, decomposition, implementation, sequence, dash |
| **Nexus** | nexus, init, remote, push, pull, snapshot, export, import |
| **Admin** | config, backup, skills, migrate, grade, map, commands, adr, token, otel |

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

- [Architecture Guide](docs/architecture)
- [Operations Reference](docs/specs/CLEO-OPERATIONS-REFERENCE.md)
- [Skill Development](docs/skills)
- [LAFS Specification](packages/lafs/README.md)

## Support

If CLEO helps your workflow, consider supporting development:

[![ko-fi](https://ko-fi.com/img/githubbutton_sm.svg)](https://ko-fi.com/H2H815OTBU)

## License

MIT License - see [LICENSE](LICENSE) for details.

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=kryptobaseddev/cleo&type=Date)](https://star-history.com/#kryptobaseddev/cleo&Date)
