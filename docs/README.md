# Documentation Index

Welcome to the CLAUDE-TODO documentation. This directory contains comprehensive guides for installation, usage, and system architecture.

---

## Getting Started

New to CLAUDE-TODO? Start here:

- **[Installation Guide](reference/installation.md)** - Global installation and per-project setup
  - Prerequisites and dependencies
  - Installation steps and verification
  - Troubleshooting common installation issues

- **[Quick Start](getting-started/quick-start.md)** - First steps guide
  - Basic task creation
  - Essential commands
  - Your first workflow

---

## User Guides

Learn how to use CLAUDE-TODO effectively:

### Core Workflows
- **[Usage Guide](usage.md)** - Main usage documentation
  - Task operations (add, update, complete)
  - Session workflows
  - Export and reporting

- **[Command Reference](reference/command-reference.md)** - Complete command documentation
  - All CLI commands with examples
  - Query commands (list, stats)
  - Maintenance operations (validate, archive, backup)

- **[CLI Reference (TODO_Task_Management.md)](TODO_Task_Management.md)** - Quick reference installed globally
  - Installed to ~/.cleo/docs/ for global access
  - CLI command quick reference
  - Anti-hallucination rules
  - Session protocols and common patterns

### Advanced Usage
- **[Filtering Guide](guides/filtering-guide.md)** - Advanced filtering and search
  - Status, priority, label filters
  - Date-based queries
  - Complex multi-criteria filtering

- **[Configuration Guide](reference/configuration.md)** - System configuration
  - Archive policies
  - Validation settings
  - Session management
  - Display preferences

- **[Workflow Patterns](integration/WORKFLOWS.md)** - Session patterns & workflows
  - Session lifecycle (start/work/end)
  - Sprint planning and tracking
  - Best practices

---

## Technical Reference

Deep-dive into system internals:

- **[ARCHITECTURE.md](architecture/ARCHITECTURE.md)** - Complete system architecture
  - Directory structure and file organization
  - Anti-hallucination mechanisms
  - Operation workflows

- **[DATA-FLOWS.md](architecture/DATA-FLOWS.md)** - Visual data flow diagrams
  - Task lifecycle diagrams
  - Validation pipeline visualization
  - Atomic write pattern

- **[SCHEMAS.md](architecture/SCHEMAS.md)** - JSON schema documentation
  - Task object structure
  - Configuration schema
  - Archive format
  - Log entry format

- **[Claude Code Integration](integration/CLAUDE-CODE.md)** - LLM integration guide
  - Anti-hallucination rules (table format)
  - Session protocol
  - TodoWrite integration

- **[Troubleshooting](reference/troubleshooting.md)** - Common issues and solutions
  - Validation errors
  - File integrity issues
  - Permission problems
  - Recovery procedures

---

## Quick Links

- **[INDEX.md](INDEX.md)** - Comprehensive documentation index with learning paths
- **[Main README](../README.md)** - Project overview and quick start
- **[QUICK-REFERENCE.md](QUICK-REFERENCE.md)** - Developer cheatsheet
- **[PLUGINS.md](PLUGINS.md)** - Plugin development guide

---

## Documentation Structure

```
docs/
├── README.md                    # This file - Documentation hub
├── INDEX.md                     # Comprehensive navigation index
├── QUICK-REFERENCE.md           # Developer cheatsheet
├── PLUGINS.md                   # Plugin development guide
├── TODO_Task_Management.md      # CLI reference (installed to ~/.cleo/)
├── usage.md                     # Main usage guide
├── DOCS-MIGRATION-GUIDE.md      # Migration tracking (temporary)
├── architecture/
│   ├── ARCHITECTURE.md          # System architecture and design
│   ├── DATA-FLOWS.md            # Visual data flow diagrams
│   └── SCHEMAS.md               # JSON schema documentation
├── integration/
│   ├── CLAUDE-CODE.md           # Claude Code integration guide
│   └── WORKFLOWS.md             # Session workflows & patterns
├── getting-started/
│   └── quick-start.md           # First steps guide
├── guides/
│   └── filtering-guide.md       # Advanced filtering guide
└── reference/
    ├── command-reference.md     # Complete command documentation
    ├── configuration.md         # Configuration reference
    ├── installation.md          # Installation and setup guide
    ├── migration-guide.md       # Schema migration guide
    └── troubleshooting.md       # Problem resolution guide
```

---

## Support

- **Issues**: Report bugs and request features on GitHub
- **Documentation Updates**: Submit PRs to improve documentation
- **Questions**: Check troubleshooting guide or open a discussion
