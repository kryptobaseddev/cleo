# CLEO Documentation Index

> Complete guide to the CLEO system architecture and implementation

## 📚 Documentation Structure

### 🎯 Start Here

| Document | Purpose | When to Read |
|----------|---------|--------------|
| **[README.md](../README.md)** | LLM-Agent-First overview and quick start | First document - the vision |
| **[Design Philosophy](guides/design-philosophy.md)** | Why CLEO works this way | Understanding the design decisions |
| **[QUICK-REFERENCE.md](QUICK-REFERENCE.md)** | Quick reference card | Daily reference during development |

### 💡 Guides

| Document | Purpose | When to Read |
|----------|---------|--------------|
| **[Design Philosophy](guides/design-philosophy.md)** | The contract between developer and agent | Understanding flat IDs, JSON output, exit codes |
| **[Filtering Guide](guides/filtering-guide.md)** | Task filtering and queries | Advanced task filtering |
| **[Archive Guide](guides/archive-guide.md)** | Task lifecycle and retention | Archive strategies, retrieval, configuration |

### 🏗️ Architecture & Design

| Document | Purpose | When to Read |
|----------|---------|--------------|
| **[ARCHITECTURE.md](architecture/ARCHITECTURE.md)** | Complete system architecture | Understanding system design |
| **[DATA-FLOW-DIAGRAMS.md](architecture/DATA-FLOWS.md)** | Visual workflows and data flows | Understanding operations |
| **[ARCHITECTURE.md#executive-summary](architecture/ARCHITECTURE.md#executive-summary)** | Executive overview | High-level understanding |
| **[ARCHITECTURE.md#design-principles](architecture/ARCHITECTURE.md#design-principles)** | Core design principles and patterns | Understanding design decisions |

### 📖 User Guides

| Document | Purpose | When to Read |
|----------|---------|--------------|
| **[installation.md](reference/installation.md)** | Installation guide | Setting up the system |
| **[usage.md](usage.md)** | Usage guide and examples | Learning system operations |
| **[PHASE-3-FEATURES.md](PHASE-3-FEATURES.md)** | Phase 3 features overview (v0.8.2) | Understanding new workflow commands |
| **[TODO_Task_Management.md](TODO_Task_Management.md)** | CLI reference (installed to ~/.cleo/docs/) | Quick CLI command reference |
| **[TASK-COMPLETION-PHILOSOPHY.md](TASK-COMPLETION-PHILOSOPHY.md)** | Task sizing and completion philosophy | Understanding "Always Be Shipping" principles for agents |
| **[cli-output-formats.md](reference/cli-output-formats.md)** | Output formats reference | Understanding output formats (list: text/json/jsonl/markdown/table, export: csv/tsv) |
| **[configuration.md](reference/configuration.md)** | Configuration reference | Customizing system behavior |
| **[sessions-json.md](reference/sessions-json.md)** | sessions.json file structure | Multi-session data format |
| **[schema-reference.md](architecture/SCHEMAS.md)** | Data schema documentation | Understanding data structures |
| **[troubleshooting.md](reference/troubleshooting.md)** | Troubleshooting guide | Resolving issues |
| **[disaster-recovery.md](reference/disaster-recovery.md)** | Disaster recovery procedures | Recovering from data loss and failures |
| **[integration/CLAUDE-CODE.md](integration/CLAUDE-CODE.md)** | Claude Code integration & session workflows | Understanding process flows |
| **[migration-guide.md](reference/migration-guide.md)** | Migration and upgrade guide | Upgrading between versions |
| **[migration/v2.2.0-migration-guide.md](migration/v2.2.0-migration-guide.md)** | v2.2.0 migration guide | Upgrading to project phases (v2.2.0) |
| **[migration/v2.3.0-migration-guide.md](migration/v2.3.0-migration-guide.md)** | v2.3.0 migration guide | Upgrading to task hierarchy (v2.3.0) |

### 🎯 Command Reference

> **Machine Index**: [COMMANDS-INDEX.json](commands/COMMANDS-INDEX.json) (LLM-agent-first, schema-validated)

| Document | Purpose | When to Read |
|----------|---------|--------------|
| **[COMMANDS-INDEX.json](commands/COMMANDS-INDEX.json)** | **Authoritative** command catalog (JSON, 36 commands) | LLM agents: `jq '.commands[] | select(.agentRelevance=="critical")'` |
| **[commands/add.md](commands/add.md)** | Add task command documentation | Creating new tasks with options |
| **[commands/analyze.md](commands/analyze.md)** | Analyze command documentation | Task triage with leverage scoring and bottleneck detection |
| **[commands/archive.md](commands/archive.md)** | Archive command documentation | Archiving completed tasks |
| **[commands/backup.md](commands/backup.md)** | Backup command documentation | Creating and listing backups |
| **[commands/blockers.md](commands/blockers.md)** | Blockers command documentation | Analyzing blocked tasks and chains |
| **[commands/complete.md](commands/complete.md)** | Complete task command documentation | Marking tasks as done |
| **[commands/commands.md](commands/commands.md)** | Commands query and discovery | LLM-first command lookup (JSON default, native filters) |
| **[commands/config.md](commands/config.md)** | Configuration command documentation | Viewing and modifying settings (project and global) |
| **[commands/dash.md](commands/dash.md)** | Dashboard command documentation | Using project overview features |
| **[commands/delete.md](commands/delete.md)** | Delete/cancel task command documentation | Soft-delete tasks with child handling strategies |
| **[commands/deps.md](commands/deps.md)** | Dependency visualization documentation | Understanding task dependencies |
| **[commands/exists.md](commands/exists.md)** | Task existence validation documentation | Validating task IDs in scripts and CI/CD pipelines |
| **[commands/export.md](commands/export.md)** | Export command documentation | Exporting tasks in CSV, TSV, JSON, markdown formats |
| **[commands/focus.md](commands/focus.md)** | Focus command documentation | Managing single-task workflow discipline |
| **[commands/find.md](commands/find.md)** | Find command documentation | Searching tasks by pattern, ID, or fuzzy match |
| **[commands/hierarchy.md](commands/hierarchy.md)** | Hierarchy system documentation | Epic/Task/Subtask organization (v0.17.0+) |
| **[commands/history.md](commands/history.md)** | Completion history and timeline analytics | Reviewing productivity trends and completion metrics |
| **[commands/init.md](commands/init.md)** | Init command documentation | Project initialization and CLAUDE.md updates |
| **[commands/labels.md](commands/labels.md)** | Labels command documentation | Managing and analyzing task labels |
| **[commands/list.md](commands/list.md)** | List tasks command documentation | Viewing and filtering tasks |
| **[commands/log.md](commands/log.md)** | Log command documentation | Viewing and managing audit logs |
| **[commands/migrate.md](commands/migrate.md)** | Schema migration command documentation | Upgrading schema versions |
| **[commands/reorganize-backups.md](commands/reorganize-backups.md)** | Backup migration documentation | Migrating legacy backup structure |
| **[commands/next.md](commands/next.md)** | Next command documentation | Using intelligent task suggestions |
| **[commands/phase.md](commands/phase.md)** | Phase lifecycle command documentation | Managing project-level phase transitions (pending → active → completed) |
| **[commands/phases.md](commands/phases.md)** | Phase management command documentation | Managing project phases and phase-based workflows |
| **[commands/promote.md](commands/promote.md)** | Promote command documentation | Remove parent from task, making it root-level (T339 Phase 2) |
| **[commands/reparent.md](commands/reparent.md)** | Reparent command documentation | Move task to different parent in hierarchy (T339 Phase 2) |
| **[commands/research.md](commands/research.md)** | Research aggregation command documentation | Multi-source web research with MCP servers (Tavily, Context7, Reddit) |
| **[commands/restore.md](commands/restore.md)** | Restore command documentation | Restoring from backups |
| **[commands/session.md](commands/session.md)** | Session command documentation | Managing work sessions |
| **[commands/show.md](commands/show.md)** | Single task detail view documentation | Viewing full task details, dependencies, and history |
| **[commands/sync.md](commands/sync.md)** | TodoWrite synchronization command | Bidirectional sync with Claude Code's TodoWrite |
| **[commands/stats.md](commands/stats.md)** | Statistics command documentation | Generating project statistics |
| **[commands/tab-completion.md](commands/tab-completion.md)** | Tab completion setup and configuration | Setting up bash/zsh shell completions |
| **[commands/uncancel.md](commands/uncancel.md)** | Restore cancelled tasks documentation | Restore cancelled tasks back to pending status |
| **[commands/reopen.md](commands/reopen.md)** | Restore completed tasks documentation | Reopen done tasks (especially auto-completed epics) |
| **[commands/update.md](commands/update.md)** | Update task command documentation | Modifying existing tasks |
| **[commands/validate.md](commands/validate.md)** | Validate command documentation | Checking project integrity |

### 📐 Specifications (Immutable Design Documents)

> **Complete Index**: [SPEC-INDEX.json](specs/SPEC-INDEX.json) (machine) | [SPEC-INDEX.md](specs/SPEC-INDEX.md) (human)

| Document | Purpose | When to Read |
|----------|---------|--------------|
| **[SPEC-INDEX.json](specs/SPEC-INDEX.json)** | **Authoritative** spec catalog (JSON, schema-validated) | LLM agents: `jq '.authorities["domain"]'` |
| **[SPEC-INDEX.md](specs/SPEC-INDEX.md)** | Human-readable view (generated from JSON) | Human navigation, quick reference |
| **[LLM-TASK-ID-SYSTEM-DESIGN-SPEC.md](specs/LLM-TASK-ID-SYSTEM-DESIGN-SPEC.md)** | **IMMUTABLE** Task ID system design bible | Before any ID-related changes; authoritative source |
| **[PHASE-SYSTEM-SPEC.md](specs/PHASE-SYSTEM-SPEC.md)** | **AUTHORITATIVE** Phase lifecycle system specification | Phase commands, history, validation, integration |
| **[HIERARCHY-ENHANCEMENT-SPEC.md](specs/HIERARCHY-ENHANCEMENT-SPEC.md)** | Hierarchy feature specification (v0.17.0+) | Implementing Epic/Task/Subtask hierarchy |
| **[LLM-AGENT-FIRST-SPEC.md](specs/LLM-AGENT-FIRST-SPEC.md)** | LLM-first design principles | Understanding agent-optimized design decisions |
| **[CONFIG-SYSTEM-SPEC.md](specs/CONFIG-SYSTEM-SPEC.md)** | Configuration system specification | Config command, priority resolution, env vars |
| **[FILE-LOCKING-SPEC.md](specs/FILE-LOCKING-SPEC.md)** | File locking & concurrency safety | Atomic writes, race condition prevention |
| **[TODOWRITE-SYNC-SPEC.md](specs/TODOWRITE-SYNC-SPEC.md)** | **ACTIVE** TodoWrite bidirectional sync specification | Session workflows, status mapping, ID round-tripping |
| **[MULTI-SESSION-SPEC.md](specs/MULTI-SESSION-SPEC.md)** | **DRAFT** Multi-session concurrent agent architecture | Parallel LLM agents, scoped sessions, conflict detection |
| **[SPEC-BIBLE-GUIDELINES.md](specs/SPEC-BIBLE-GUIDELINES.md)** | Specification writing standards | Creating and maintaining spec documents |

### 🔬 Technical Reference

| Document | Purpose | When to Read |
|----------|---------|--------------|
| **[jq-helpers.md](reference/jq-helpers.md)** | jq wrapper library reference (14 functions) | Working with task JSON operations in scripts |
| **[PLUGINS.md](PLUGINS.md)** | Plugin architecture and development | Extending the CLI with custom commands |
| **[integration/CLAUDE-CODE.md](integration/CLAUDE-CODE.md)** | TodoWrite integration & session workflows | Understanding Claude Code integration |
| **[ci-cd-integration.md](ci-cd-integration.md)** | CI/CD pipeline integration guide | Integrating with GitHub Actions, GitLab CI, Jenkins, Azure DevOps |
| **[VERSION-MANAGEMENT.md](reference/VERSION-MANAGEMENT.md)** | Version management and release process | Understanding versioning strategy and release workflow |
| **[migration-guide.md](reference/migration-guide.md)** | Schema migration and upgrade guide | Understanding version migrations |
| **[migration/v2.2.0-migration-guide.md](migration/v2.2.0-migration-guide.md)** | v2.2.0 specific migration guide | Detailed guide for upgrading to project phases |
| **[testing.md](testing.md)** | BATS test suite guide | Writing and running tests |

### 🛠️ Development Tools

| Document | Purpose | When to Read |
|----------|---------|--------------|
| **[development/DEV-SCRIPTS-OVERVIEW.md](development/DEV-SCRIPTS-OVERVIEW.md)** | Dev scripts index and reference | Contributing to development tooling |
| **[development/COMPLIANCE-CHECKING.md](development/COMPLIANCE-CHECKING.md)** | LLM-Agent-First compliance system | Understanding and running compliance checks |
| **[development/PERFORMANCE-TESTING.md](development/PERFORMANCE-TESTING.md)** | Benchmarking workflow guide | Running and interpreting performance tests |
| **[DEV-WORKFLOW.md](../dev/DEV-WORKFLOW.md)** | Development contribution guidelines | Before contributing to dev/ scripts |

---

## 📖 Document Details

### README.md
**Purpose**: User-facing overview and quick start guide

**Contents**:
- System overview and key features
- Quick start installation
- Basic usage examples
- Anti-hallucination protection overview
- Configuration basics
- Available scripts
- Extension points
- Troubleshooting

**Best For**: New users, quick reference, installation instructions

---

### ARCHITECTURE.md
**Purpose**: Complete system architecture and design rationale

**Contents**:
- Directory structure (detailed)
- Core data files and relationships
- File interaction matrix
- Data flow diagrams
- Installation sequence
- Operation workflows (all 8 operations)
- Configuration system
- Anti-hallucination mechanisms (4 layers)
- Change log structure
- Error handling and recovery
- Performance considerations
- Security considerations
- Extension points
- Testing strategy
- Maintenance and monitoring
- Migration and versioning

**Best For**: Developers implementing the system, architectural decisions, understanding design rationale

---

### DATA-FLOW-DIAGRAMS.md
**Purpose**: Visual representation of all system workflows and interactions

**Contents**:
- System component relationships
- Complete task lifecycle (visual)
- Archive workflow (detailed)
- Validation pipeline
- File interaction matrix
- Atomic write operation pattern
- Backup rotation strategy
- Configuration override hierarchy
- Error recovery flow
- Multi-file synchronization
- Statistics generation flow

**Best For**: Visual learners, understanding operation flows, debugging workflows

---

### ARCHITECTURE.md#executive-summary
**Purpose**: Executive overview consolidating key architectural concepts

**Contents**:
- Core architecture components
- Data file relationships
- Schema validation architecture
- Anti-hallucination mechanisms (all 4 layers)
- Key operations (create, complete, archive)
- Atomic write pattern
- Installation and initialization
- Configuration hierarchy
- Backup and recovery system
- Change log system
- Statistics and reporting
- Script reference
- Library functions
- Testing strategy
- Performance considerations
- Security considerations
- Extension points
- Version management
- Quick start guide
- Success criteria

**Best For**: Project overview, stakeholder presentations, architectural review

---

### QUICK-REFERENCE.md
**Purpose**: Quick reference card for developers

**Contents**:
- Architecture at a glance
- Essential commands
- Data flow patterns
- Validation pipeline
- Atomic write pattern
- Anti-hallucination checks table
- File interaction matrix
- Configuration hierarchy
- Schema files
- Library functions (quick reference)
- Task/log object structures
- Backup rotation
- Error codes
- Common patterns
- Testing quick reference
- Debugging commands
- Performance targets
- Best practices
- Common error messages
- Recommended aliases
- Directory permissions
- Extension points
- Documentation links
- Health check
- Troubleshooting

**Best For**: Daily development reference, quick lookups, debugging

---

### installation.md
**Purpose**: Complete installation guide and setup instructions

**Contents**:
- Prerequisites and requirements
- Step-by-step installation process
- Configuration setup
- Verification and testing
- Troubleshooting installation issues
- Post-installation tasks

**Best For**: Initial setup, deployment, system administrators

---

### usage.md
**Purpose**: Comprehensive usage guide with examples

**Contents**:
- Basic operations walkthrough
- Task management workflows
- Advanced features usage
- Command reference with examples
- Integration patterns
- Best practices
- Common scenarios

**Best For**: Day-to-day usage, learning system features, operational reference

---

### TASK-COMPLETION-PHILOSOPHY.md
**Purpose**: Task sizing and completion philosophy for agent-driven development

**Contents**:
- "Always Be Shipping" core principles
- Minimum viable task size (1-4 hours sweet spot)
- Epic/Story/Task hierarchy and shippable increments
- Definition of Done vs. Acceptance Criteria
- Work-in-Progress (WIP) limits for agents
- Task:Planning ratio guidelines (80/20)
- Preventing planning paralysis anti-patterns
- Deployment frequency best practices
- Trunk-based development model
- Agent-specific completion rules
- Governance and quality standards

**Best For**: Understanding task sizing, preventing planning paralysis, agent automation workflows, deployment velocity optimization

---

### cli-output-formats.md
**Purpose**: CLI output formats reference guide

**Contents**:
- Output formats overview (text, json, jsonl, csv, tsv, markdown, table)
- Format specifications with examples
- Short flags reference
- Color control (NO_COLOR, FORCE_COLOR)
- Use cases by format
- Format comparison matrix
- Best practices for each format

**Best For**: Understanding output options, API integration, data export workflows

---

### configuration.md
**Purpose**: Configuration system reference guide

**Contents**:
- Configuration file structure
- Available configuration options
- Configuration hierarchy
- Environment variables
- Override mechanisms
- Configuration validation
- Examples and templates

**Best For**: System customization, advanced configuration, deployment tuning

---

### schema-reference.md
**Purpose**: Data schema and structure documentation

**Contents**:
- JSON schema definitions
- Task object structure
- Log entry format
- Archive schema
- Statistics schema
- Validation rules
- Data type definitions
- Field constraints

**Best For**: Understanding data structures, integration development, validation logic

---

### troubleshooting.md
**Purpose**: Troubleshooting guide and common issue resolution

**Contents**:
- Common error messages and solutions
- Diagnostic procedures
- Recovery procedures
- Performance issues
- Validation failures
- Data corruption handling
- Debug techniques
- Support resources

**Best For**: Problem resolution, system maintenance, support operations

---

### integration/CLAUDE-CODE.md
**Purpose**: Claude Code integration and session workflow documentation

**Contents**:
- Anti-hallucination rules (LLM-optimized format)
- Session protocol (start, during, end)
- Task lifecycle and status transitions
- Checksum protocol
- TodoWrite integration and schema mapping
- Quick reference for Claude Code sessions

**Best For**: Understanding system processes, Claude Code integration, operational procedures

---

### ci-cd-integration.md
**Purpose**: CI/CD pipeline integration guide with practical examples

**Contents**:
- GitHub Actions workflows (validation, deployment gates, reports)
- GitLab CI pipeline configuration
- Jenkins declarative and scripted pipelines
- Azure DevOps YAML pipelines
- Common patterns (blocking merges, archival, notifications)
- Troubleshooting CI/CD issues
- Best practices for pipeline integration

**Best For**: DevOps integration, automated validation, deployment workflows, team automation

---

### testing.md
**Purpose**: BATS test suite guide and quick reference

**Contents**:
- Quick start for running tests
- Prerequisites and setup
- Test directory structure
- Test categories overview
- Writing tests guide
- Common assertions reference
- Reusable fixtures
- Debugging techniques

**Best For**: Running tests, writing new tests, understanding test infrastructure

**Detailed Documentation**: [tests/README.md](../tests/README.md)

---

## 🗺️ Navigation Guide

### I want to...

#### ...understand the system
1. Start with [README.md](../README.md) for overview
2. Read [ARCHITECTURE.md#executive-summary](architecture/ARCHITECTURE.md#executive-summary) for architecture
3. Review [DATA-FLOW-DIAGRAMS.md](architecture/DATA-FLOWS.md) for visual understanding

#### ...install and configure the system
1. Read [installation.md](reference/installation.md) for setup
2. Review [configuration.md](reference/configuration.md) for customization
3. Check [troubleshooting.md](reference/troubleshooting.md) if issues arise

#### ...use the system daily
1. Start with [usage.md](usage.md) for operations
2. Keep [QUICK-REFERENCE.md](QUICK-REFERENCE.md) nearby for quick lookups
3. Reference [schema-reference.md](architecture/SCHEMAS.md) for data structures
4. Review [TASK-COMPLETION-PHILOSOPHY.md](TASK-COMPLETION-PHILOSOPHY.md) for task sizing and shipping velocity

#### ...implement the system
1. Read [ARCHITECTURE.md](architecture/ARCHITECTURE.md) thoroughly
2. Review [ARCHITECTURE.md#executive-summary](architecture/ARCHITECTURE.md#executive-summary) for overview
3. Keep [QUICK-REFERENCE.md](QUICK-REFERENCE.md) nearby for reference
4. Check [schema-reference.md](architecture/SCHEMAS.md) for data structures

#### ...contribute to the project
1. Read [README.md](../README.md) for project overview
2. Review [ARCHITECTURE.md](architecture/ARCHITECTURE.md) for design principles
3. Reference [QUICK-REFERENCE.md](QUICK-REFERENCE.md) for standards
4. Check [testing.md](testing.md) for test suite guide
5. Check [usage.md](usage.md) for operational patterns

#### ...debug an issue
1. Check [troubleshooting.md](reference/troubleshooting.md) first
2. Review [QUICK-REFERENCE.md](QUICK-REFERENCE.md) common errors
3. Review [DATA-FLOW-DIAGRAMS.md](architecture/DATA-FLOWS.md) for workflow
4. Consult [ARCHITECTURE.md](architecture/ARCHITECTURE.md) error handling section

#### ...extend the system
1. Read [PLUGINS.md](PLUGINS.md) for plugin development guide
2. Read [ARCHITECTURE.md](architecture/ARCHITECTURE.md) extension points section
3. Review [ARCHITECTURE.md#executive-summary](architecture/ARCHITECTURE.md#executive-summary) extension summary
4. Check [QUICK-REFERENCE.md](QUICK-REFERENCE.md) extension patterns

#### ...understand ID system design
1. Read [LLM-TASK-ID-SYSTEM-DESIGN-SPEC.md](specs/LLM-TASK-ID-SYSTEM-DESIGN-SPEC.md) - **THE AUTHORITATIVE SOURCE**
2. Understand the flat ID + parentId design decision
3. Review anti-hallucination mechanisms for IDs
4. Check multi-agent coordination patterns

#### ...implement hierarchy features (v0.17.0+)
1. Read [HIERARCHY-ENHANCEMENT-SPEC.md](specs/HIERARCHY-ENHANCEMENT-SPEC.md) for full spec
2. Reference [LLM-TASK-ID-SYSTEM-DESIGN-SPEC.md](specs/LLM-TASK-ID-SYSTEM-DESIGN-SPEC.md) for ID contract
3. Follow Epic → Task → Subtask taxonomy (max depth: 3, unlimited siblings by default)
4. Review [commands/add.md](commands/add.md) for `--type`, `--parent`, `--size` flags
5. Review [commands/list.md](commands/list.md) for `--type`, `--parent`, `--children`, `--tree` filters
6. Run `cleo migrate run` to upgrade to schema v2.3.0
7. **T339 Hierarchy Automation**: See [AGENT-3-PHASE.md](../claudedocs/rebrand/AGENT-3-PHASE.md) for reparent/promote implementation

#### ...integrate with CI/CD
1. Read [ci-cd-integration.md](ci-cd-integration.md) for complete integration guide
2. Choose your platform examples (GitHub Actions, GitLab CI, Jenkins, Azure DevOps)
3. Review [reference/cli-output-formats.md](reference/cli-output-formats.md) for JSON output parsing
4. Check [troubleshooting.md](reference/troubleshooting.md) for common CI issues

---

## 📋 Document Cross-References

### Architecture Concepts

| Concept | Primary Source | Also Referenced In |
|---------|---------------|-------------------|
| **Anti-Hallucination** | ARCHITECTURE.md | ARCHITECTURE.md#executive-summary, QUICK-REFERENCE.md |
| **Atomic Writes** | ARCHITECTURE.md | architecture/DATA-FLOWS.md, QUICK-REFERENCE.md |
| **Data Flow** | architecture/DATA-FLOWS.md | ARCHITECTURE.md, ARCHITECTURE.md#executive-summary |
| **Validation Pipeline** | ARCHITECTURE.md | architecture/DATA-FLOWS.md, docs/architecture/SCHEMAS.md |
| **Configuration Hierarchy** | ARCHITECTURE.md | reference/configuration.md, ARCHITECTURE.md#executive-summary |
| **Backup System** | ARCHITECTURE.md | architecture/DATA-FLOWS.md, reference/troubleshooting.md |
| **Extension Points** | ARCHITECTURE.md | ARCHITECTURE.md#executive-summary |

### Implementation Details

| Detail | Primary Source | Also Referenced In |
|--------|---------------|-------------------|
| **Schema Structure** | docs/architecture/SCHEMAS.md | ARCHITECTURE.md, QUICK-REFERENCE.md |
| **Library Functions** | ARCHITECTURE.md | QUICK-REFERENCE.md |
| **Script Operations** | usage.md | ARCHITECTURE.md, ARCHITECTURE.md#executive-summary |
| **Testing Strategy** | ARCHITECTURE.md | ARCHITECTURE.md#executive-summary |
| **Installation Process** | reference/installation.md | ARCHITECTURE.md, ARCHITECTURE.md#executive-summary |

---

## 🎓 Learning Paths

### Path 1: Quick Start (30 minutes)
1. **[README.md](../README.md)** (10 min) - Overview and installation
2. **[QUICK-REFERENCE.md](QUICK-REFERENCE.md)** (20 min) - Commands and patterns

**Outcome**: Can install and use basic features

---

### Path 2: User Proficiency (2 hours)
1. **[README.md](../README.md)** (15 min) - Full read
2. **[installation.md](reference/installation.md)** (20 min) - Setup
3. **[usage.md](usage.md)** (45 min) - Operations
4. **[configuration.md](reference/configuration.md)** (20 min) - Customization
5. **[QUICK-REFERENCE.md](QUICK-REFERENCE.md)** (20 min) - Reference

**Outcome**: Can install, configure, and use all features effectively

---

### Path 3: Developer Mastery (1 day)
1. **[README.md](../README.md)** (30 min) - Complete understanding
2. **[ARCHITECTURE.md](architecture/ARCHITECTURE.md)** (3 hours) - Deep dive into design
3. **[DATA-FLOW-DIAGRAMS.md](architecture/DATA-FLOWS.md)** (1 hour) - All workflows
4. **[ARCHITECTURE.md#executive-summary](architecture/ARCHITECTURE.md#executive-summary)** (1 hour) - Consolidation
5. **[schema-reference.md](architecture/SCHEMAS.md)** (1 hour) - Data structures
6. **[usage.md](usage.md)** (1 hour) - Operation guide
7. **[QUICK-REFERENCE.md](QUICK-REFERENCE.md)** (30 min) - Quick reference mastery

**Outcome**: Can implement, extend, and maintain the system

---

### Path 4: Architect/Reviewer (4 hours)
1. **[ARCHITECTURE.md#executive-summary](architecture/ARCHITECTURE.md#executive-summary)** (1 hour) - Executive overview
2. **[ARCHITECTURE.md](architecture/ARCHITECTURE.md)** (2 hours) - Complete architecture
3. **[DATA-FLOW-DIAGRAMS.md](architecture/DATA-FLOWS.md)** (30 min) - Visual validation
4. **[schema-reference.md](architecture/SCHEMAS.md)** (30 min) - Data structures

**Outcome**: Can review, approve, or critique architectural decisions

---

## 🔍 Document Statistics

| Document | Word Count | Primary Audience | Complexity |
|----------|-----------|------------------|------------|
| README.md | ~2,000 | Users | Low |
| ARCHITECTURE.md | ~6,500 | Developers | High |
| ARCHITECTURE.md#executive-summary | ~5,500 | Technical Leadership | Medium |
| architecture/DATA-FLOWS.md | ~5,000 | Visual Learners | Medium |
| QUICK-REFERENCE.md | ~2,500 | Developers | Low |
| docs/integration/CLAUDE-CODE.md | ~380 | Developers/LLMs | Medium |
| reference/installation.md | ~3,500 | System Administrators | Low |
| usage.md | ~8,000 | Users | Low-Medium |
| reference/configuration.md | ~4,000 | System Administrators | Medium |
| docs/architecture/SCHEMAS.md | ~5,500 | Developers | High |
| reference/troubleshooting.md | ~5,500 | Support/Users | Medium |

**Total Documentation**: ~49,000 words

---

## 📝 Documentation Maintenance

### Version Tracking
- All documents version tracked in git
- Architecture frozen at 1.0.0 (implementation reference)
- Implementation roadmap updated as phases complete
- User guides updated with new features and examples
- Schema reference updated with data structure changes

### Update Triggers
- **README.md**: Feature additions, installation changes
- **ARCHITECTURE.md**: Major design changes (rare)
- **ARCHITECTURE.md#executive-summary**: Architectural updates
- **architecture/DATA-FLOWS.md**: Workflow modifications
- **QUICK-REFERENCE.md**: Command changes, new patterns
- **reference/installation.md**: Setup procedure changes, requirement updates
- **usage.md**: New features, operation changes
- **reference/configuration.md**: New configuration options, schema changes
- **docs/architecture/SCHEMAS.md**: Data structure modifications
- **reference/troubleshooting.md**: New issues, solution updates

---

## 🎯 Success Criteria

You understand the CLEO system when you can:

- [ ] Explain the anti-hallucination mechanisms (4 layers)
- [ ] Describe the atomic write pattern
- [ ] Trace a task through its complete lifecycle
- [ ] Explain the configuration hierarchy
- [ ] Identify all file interaction points
- [ ] Understand the backup rotation strategy
- [ ] Explain the validation pipeline
- [ ] Describe the extension points
- [ ] Navigate the codebase structure
- [ ] Implement a new feature following the architecture
- [ ] Install and configure the system
- [ ] Troubleshoot common issues
- [ ] Understand the data schema structure

---

## 🚀 Quick Links

### Most Important Documents
1. **[ARCHITECTURE.md](architecture/ARCHITECTURE.md)** - The definitive design reference
2. **[usage.md](usage.md)** - How to use it
3. **[QUICK-REFERENCE.md](QUICK-REFERENCE.md)** - Daily development reference
4. **[ARCHITECTURE.md#executive-summary](architecture/ARCHITECTURE.md#executive-summary)** - Executive overview

### By Use Case
- **Installing**: [installation.md](reference/installation.md) → Setup guide
- **Configuring**: [configuration.md](reference/configuration.md) → Configuration options
- **Using**: [usage.md](usage.md) → Operation guide
- **Understanding**: [ARCHITECTURE.md#executive-summary](architecture/ARCHITECTURE.md#executive-summary) → Overview
- **Task Sizing**: [TASK-COMPLETION-PHILOSOPHY.md](TASK-COMPLETION-PHILOSOPHY.md) → Shipping velocity and completion philosophy
- **ID System**: [LLM-TASK-ID-SYSTEM-DESIGN-SPEC.md](specs/LLM-TASK-ID-SYSTEM-DESIGN-SPEC.md) → **IMMUTABLE** ID design bible
- **Phase System**: [PHASE-SYSTEM-SPEC.md](specs/PHASE-SYSTEM-SPEC.md) → **AUTHORITATIVE** phase lifecycle bible
- **Hierarchy**: [HIERARCHY-ENHANCEMENT-SPEC.md](specs/HIERARCHY-ENHANCEMENT-SPEC.md) → Epic/Task/Subtask specification
- **Debugging**: [troubleshooting.md](reference/troubleshooting.md) → Issue resolution
- **Disaster Recovery**: [disaster-recovery.md](reference/disaster-recovery.md) → Data recovery procedures
- **Extending**: [ARCHITECTURE.md](architecture/ARCHITECTURE.md) → Extension points
- **Reviewing**: [ARCHITECTURE.md](architecture/ARCHITECTURE.md) → Complete design
- **Data Structure**: [schema-reference.md](architecture/SCHEMAS.md) → Schema reference
- **CI/CD Integration**: [ci-cd-integration.md](ci-cd-integration.md) → Pipeline automation

---

## 📧 Support

For questions about:
- **Installation**: See [installation.md](reference/installation.md)
- **Usage**: See [usage.md](usage.md) and [QUICK-REFERENCE.md](QUICK-REFERENCE.md)
- **Configuration**: See [configuration.md](reference/configuration.md)
- **Troubleshooting**: See [troubleshooting.md](reference/troubleshooting.md)
- **Architecture**: See [ARCHITECTURE.md](architecture/ARCHITECTURE.md) and [ARCHITECTURE.md#executive-summary](architecture/ARCHITECTURE.md#executive-summary)
- **Data Structures**: See [schema-reference.md](architecture/SCHEMAS.md)
- **Workflows**: See [DATA-FLOW-DIAGRAMS.md](architecture/DATA-FLOWS.md)
- **CI/CD Integration**: See [ci-cd-integration.md](ci-cd-integration.md)

---

**Happy building! Start with [README.md](../README.md) if you're new, [installation.md](reference/installation.md) to install, or [usage.md](usage.md) to learn operations.**
