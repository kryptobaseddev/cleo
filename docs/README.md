# Documentation Index

Welcome to the CLAUDE-TODO documentation. This directory contains comprehensive guides for installation, usage, and system architecture.

---

## Getting Started

New to CLAUDE-TODO? Start here:

- **[Installation Guide](getting-started/installation.md)** - Global installation and per-project setup
  - Prerequisites and dependencies
  - Installation steps and verification
  - Troubleshooting common installation issues

---

## User Guides

Learn how to use CLAUDE-TODO effectively:

### Core Workflows
- **[Command Reference](guides/command-reference.md)** - Complete command documentation
  - Task operations (add, update, complete)
  - Query commands (list, stats)
  - Maintenance operations (validate, archive, backup)

- **[Workflow Patterns](guides/workflow-patterns.md)** - Common usage patterns
  - Session lifecycle (start/work/end)
  - Sprint planning and tracking
  - Daily standup reports
  - Release preparation

### Advanced Usage
- **[Filtering Guide](guides/filtering-guide.md)** - Advanced filtering and search
  - Status, priority, label filters
  - Date-based queries
  - Complex multi-criteria filtering

- **[Configuration Guide](guides/configuration.md)** - System configuration
  - Archive policies
  - Validation settings
  - Session management
  - Display preferences

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

- **[Claude Code Integration](integration/CLAUDE-CODE.md)** - LLM integration guide
  - Anti-hallucination rules (table format)
  - Session protocol
  - TodoWrite integration

- **[Schema Reference](reference/schema-reference.md)** - JSON schema documentation
  - Task object structure
  - Configuration schema
  - Archive format
  - Log entry format

- **[Troubleshooting](reference/troubleshooting.md)** - Common issues and solutions
  - Validation errors
  - File integrity issues
  - Permission problems
  - Recovery procedures

---

## Quick Links

- **[Main README](../README.md)** - Project overview and quick start
- **[CLAUDE.md Integration](../CLAUDE.md)** - Claude Code integration instructions
- **[Contributing Guidelines](../CONTRIBUTING.md)** - How to contribute
- **[License](../LICENSE)** - MIT License

---

## Documentation Structure

```
docs/
├── README.md                    # This file - Documentation hub
├── architecture/
│   ├── ARCHITECTURE.md          # System architecture and design
│   └── DATA-FLOWS.md            # Visual data flow diagrams
├── integration/
│   └── CLAUDE-CODE.md           # Claude Code integration guide
├── getting-started/
│   └── installation.md          # Installation and setup guide
├── guides/
│   ├── command-reference.md     # Complete command documentation
│   ├── workflow-patterns.md     # Common usage patterns
│   ├── filtering-guide.md       # Advanced filtering guide
│   └── configuration.md         # Configuration reference
└── reference/
    ├── schema-reference.md      # JSON schema documentation
    └── troubleshooting.md       # Problem resolution guide
```

---

## Support

- **Issues**: Report bugs and request features on GitHub
- **Documentation Updates**: Submit PRs to improve documentation
- **Questions**: Check troubleshooting guide or open a discussion
