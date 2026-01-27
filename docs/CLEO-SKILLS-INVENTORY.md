# CLEO Skills Ecosystem Inventory

**Generated**: 2026-01-27
**Status**: Active - Validated

---

## Executive Summary

The CLEO skills system has **15 skills** and **3 shared resources**. All skills use the `ct-*` prefix naming convention and are tracked via `manifest.json`.

### Architecture Overview

| Component | Count | Status |
|-----------|-------|--------|
| Skills (ct-*) | 15 | Active |
| Shared Resources | 3 | Active |
| Manifest Tracking | Yes | `skills/manifest.json` |
| Tiers | 4 (0-3) | Hierarchical |

### Tier System

Skills are organized into 4 tiers based on complexity and dependencies:

| Tier | Purpose | Skills |
|------|---------|--------|
| **Tier 0** | Orchestration | ct-orchestrator (workflow coordination) |
| **Tier 1** | High-Level Planning | ct-epic-architect (epic decomposition) |
| **Tier 2** | Core Execution | Research, Implementation, Testing, Specification, Validation (8 skills) |
| **Tier 3** | Specialized/Meta | Documentation suite, Skill management (6 skills) |

### Skills by Category

#### Orchestration & Planning (Tier 0-1)
- **ct-orchestrator** (v2.0.0) - Multi-agent workflow coordination
- **ct-epic-architect** (v2.3.0) - Epic creation and task decomposition

#### Core Execution (Tier 2)
- **ct-task-executor** (v1.0.0) - Generic task execution
- **ct-research-agent** (v1.0.0) - Research and investigation
- **ct-spec-writer** (v1.0.0) - RFC 2119 specification writing
- **ct-test-writer-bats** (v1.0.0) - BATS integration testing
- **ct-library-implementer-bash** (v1.0.0) - Bash library implementation
- **ct-validator** (v1.0.0) - Compliance validation
- **ct-dev-workflow** (v2.0.0) - Task-driven development workflow

#### Documentation Suite (Tier 3)
- **ct-documentor** (v2.3.0) - Documentation orchestrator
- **ct-docs-lookup** (v1.0.0) - Context7 documentation lookup
- **ct-docs-write** (v1.0.0) - Documentation writing
- **ct-docs-review** (v1.0.0) - Documentation review

#### Skill Management (Tier 3)
- **ct-skill-creator** (v1.0.0) - Skill creation guide
- **ct-skill-lookup** (v1.0.0) - prompts.chat skill discovery

### Dispatch Matrix

The manifest includes a `dispatch_matrix` for automatic skill selection:

**By Task Type**:
| Task Type | Skill |
|-----------|-------|
| research | ct-research-agent |
| planning | ct-epic-architect |
| implementation | ct-task-executor |
| testing | ct-test-writer-bats |
| documentation | ct-documentor |
| specification | ct-spec-writer |
| validation | ct-validator |
| bash-library | ct-library-implementer-bash |

**By Keyword Pattern**:
| Pattern | Skill |
|---------|-------|
| research\|investigate\|explore\|discover | ct-research-agent |
| epic\|plan\|decompose\|architect | ct-epic-architect |
| implement\|build\|execute\|create | ct-task-executor |
| test\|bats\|coverage\|integration | ct-test-writer-bats |
| doc\|document\|readme\|guide | ct-documentor |
| spec\|rfc\|protocol\|contract | ct-spec-writer |
| validate\|verify\|audit\|compliance | ct-validator |
| lib/\|bash\|shell\|function | ct-library-implementer-bash |

---

## Current Structure

```
skills/
├── manifest.json                  # Skills registry (tracks all ct-* skills)
├── ct-epic-architect/
│   ├── SKILL.md                   # Epic creation and task decomposition (v2.1.0)
│   └── references/
│       ├── commands.md            # CLEO commands reference with tokens
│       ├── patterns.md            # Research, Bug, Task naming patterns
│       ├── output-format.md       # Epic output file templates
│       ├── skill-aware-execution.md  # Orchestrator integration
│       ├── feature-epic-example.md   # Greenfield feature epic
│       ├── bug-epic-example.md       # Bug fix epic with severity
│       ├── research-epic-example.md  # 3 research patterns
│       └── migration-epic-example.md # Multi-phase migration
├── ct-orchestrator/
│   ├── SKILL.md                   # Multi-agent workflow orchestration
│   ├── INSTALL.md                 # Installation instructions
│   ├── README.md                  # Overview
│   └── references/
│       └── SUBAGENT-PROTOCOL-BLOCK.md
├── ct-docs-lookup/
│   └── SKILL.md                   # Context7 documentation lookup
├── ct-docs-write/
│   └── SKILL.md                   # Documentation writing
├── ct-docs-review/
│   └── SKILL.md                   # Documentation review
├── ct-documentor/
│   └── SKILL.md                   # Documentation orchestrator (uses lookup/write/review)
├── ct-skill-lookup/
│   └── SKILL.md                   # prompts.chat skill discovery
├── ct-skill-creator/
│   ├── SKILL.md                   # Skill creation guide
│   ├── references/
│   │   ├── output-patterns.md
│   │   └── workflows.md
│   └── scripts/                   # Python tooling for skill creation
├── ct-library-implementer-bash/
│   └── SKILL.md                   # Bash library implementation
├── ct-research-agent/
│   └── SKILL.md                   # Research and investigation
├── ct-spec-writer/
│   └── SKILL.md                   # RFC 2119 specification writing
├── ct-task-executor/
│   └── SKILL.md                   # Generic task execution
├── ct-test-writer-bats/
│   └── SKILL.md                   # BATS integration tests
├── ct-validator/
│   └── SKILL.md                   # Compliance validation
└── _shared/
    ├── cleo-style-guide.md        # Shared writing style guide
    ├── task-system-integration.md # Portable task commands (tokens)
    └── subagent-protocol-base.md  # RFC 2119 subagent output rules
```

---

## Manifest Tracking

All skills are tracked in `skills/manifest.json`:

```json
{
  "$schema": "https://cleo-dev.com/schemas/v1/skills-manifest.schema.json",
  "_meta": {
    "schemaVersion": "1.0.0",
    "lastUpdated": "2026-01-19",
    "totalSkills": 13
  },
  "skills": [
    {
      "name": "ct-epic-architect",
      "version": "2.1.0",
      "description": "Epic architecture agent for creating comprehensive epics...",
      "path": "skills/ct-epic-architect",
      "model": "sonnet",
      "tags": ["planning", "architecture", "task-management"],
      "status": "active"
    }
    // ... additional skills
  ]
}
```

The manifest enables:
- **Skill discovery**: Query available skills programmatically
- **Version tracking**: Track versions across all skills
- **Installation**: Install skills from manifest via `./install.sh`
- **Validation**: Verify skill integrity and paths

---

## Skill Details

### Tier 0: Orchestration

#### ct-orchestrator

**Purpose**: Orchestrator protocol for coordinating complex workflows by delegating work to subagents while protecting the main context window.

**Version**: 2.0.0

**Tier**: 0

**Tags**: workflow, multi-agent, coordination

**Triggers**: "orchestrate", "orchestrator mode", "run as orchestrator", "delegate to subagents", "coordinate agents", "spawn subagents", "multi-agent workflow", "context-protected workflow", "agent farm", "HITL orchestration"

**Structure**:
- SKILL.md - Core protocol
- references/ - Spawning, compliance, tokens, recovery guides

**Constraints**: ORC-001 through ORC-008, max context 150k tokens, requires session and epic

**Invocation**: `/ct-orchestrator` or natural language triggers

---

### Tier 1: High-Level Planning

#### ct-epic-architect

**Purpose**: Epic architecture agent for creating comprehensive epics with full task decomposition, file attachments, and research linking.

**Version**: 2.3.0

**Tier**: 1

**Tags**: planning, architecture, task-management

**Triggers**: "create epic", "plan epic", "decompose into tasks", "architect the work", "break down this project", "epic planning", "task breakdown", "dependency analysis", "wave planning", "sprint planning"

**Structure**:
- SKILL.md - Core workflow
- references/ (8 files) - Commands, patterns, output format, orchestrator integration, examples

**Token-Based Commands**: Uses `{{TASK_ADD_CMD}}`, `{{TASK_COMPLETE_CMD}}`, etc. for portable task system integration.

**Dependencies**: Can chain to ct-task-executor, ct-research-agent, ct-spec-writer

**Invocation**: `/ct-epic-architect` or natural language triggers

---

### Tier 2: Core Execution

#### ct-task-executor

**Purpose**: Generic task execution agent for completing implementation work and producing concrete outputs.

**Version**: 1.0.0

**Tier**: 2

**Tags**: execution, implementation, task-management

**Triggers**: "execute task", "implement", "do the work", "complete this task", "carry out", "perform task", "run task", "work on", "implement feature", "build component", "create implementation"

**Dependencies**: Can chain to ct-test-writer-bats, ct-documentor

**Invocation**: `/ct-task-executor`

---

#### ct-research-agent

**Purpose**: Research and investigation agent for gathering information from multiple sources.

**Version**: 1.0.0

**Tier**: 2

**Tags**: research, investigation, discovery

**Triggers**: "research", "investigate", "gather information", "look up", "find out about", "analyze topic", "explore options", "survey alternatives", "collect data on", "background research", "discovery", "fact-finding"

**Dependencies**: Can chain to ct-spec-writer, ct-epic-architect

**Invocation**: `/ct-research-agent`

---

#### ct-spec-writer

**Purpose**: Specification writing agent for creating technical specifications using RFC 2119 language.

**Version**: 1.0.0

**Tier**: 2

**Tags**: specification, documentation, rfc

**Triggers**: "write a spec", "create specification", "define protocol", "document requirements", "RFC-style document", "technical specification", "architecture specification", "API specification", "interface contract"

**Dependencies**: Can chain to ct-task-executor, ct-documentor

**Invocation**: `/ct-spec-writer`

---

#### ct-test-writer-bats

**Purpose**: Integration test writing agent using BATS framework for bash script testing.

**Version**: 1.0.0

**Tier**: 2

**Tags**: testing, bats, integration

**Triggers**: "write tests", "create BATS tests", "add integration tests", "bash tests", "test coverage", "write test cases", "shell script tests", "BATS framework"

**Invocation**: `/ct-test-writer-bats`

---

#### ct-library-implementer-bash

**Purpose**: Bash library implementation skill for creating shared shell functions in `lib/*.sh` with shell best practices.

**Version**: 1.0.0

**Tier**: 2

**Tags**: implementation, bash, library

**Triggers**: "create library", "implement functions", "add to lib/", "shared utilities", "bash library", "helper functions", "lib/*.sh", "shell functions", "bash module"

**Dependencies**: Can chain to ct-test-writer-bats

**Invocation**: `/ct-library-implementer-bash`

---

#### ct-validator

**Purpose**: Compliance validation agent for verifying system, document, and code compliance against requirements, schemas, or standards.

**Version**: 1.0.0

**Tier**: 2

**Tags**: validation, compliance, audit

**Triggers**: "validate", "verify", "check compliance", "audit", "compliance check", "verify conformance", "check requirements", "run validation", "validate schema", "check standards"

**Invocation**: `/ct-validator`

---

#### ct-dev-workflow

**Purpose**: Task-driven development workflow for atomic commits with CLEO task traceability, enforcing WF-001 constraint and GitHub Actions release automation.

**Version**: 2.0.0

**Tier**: 2

**Tags**: workflow, git, commits, release, task-tracking

**Triggers**: "commit", "release", "run the workflow", "prepare release", "atomic commit", "conventional commit", "version bump", "create release", "finalize changes", "ship it", "cut a release"

**Invocation**: `/ct-dev-workflow`

---

### Tier 3: Specialized & Meta

#### ct-documentor

**Purpose**: Documentation specialist orchestrating ct-docs-lookup, ct-docs-write, and ct-docs-review for end-to-end documentation workflows with anti-duplication enforcement.

**Version**: 2.3.0

**Tier**: 3

**Tags**: documentation, orchestration, workflow

**Triggers**: "write documentation", "create docs", "review docs", "update documentation", "document this feature", "fix the docs", "sync docs with code", "full docs workflow"

**Dependencies**: Orchestrates ct-docs-lookup, ct-docs-write, ct-docs-review

**Invocation**: `/ct-documentor`

---

#### ct-docs-lookup

**Purpose**: Library documentation lookup via Context7 for framework setup, API references, and version-specific docs.

**Version**: 1.0.0

**Tier**: 3

**Tags**: documentation, libraries, context7

**Triggers**: "how do I configure", "write code using", "what are the methods", "show me examples", "library docs", "framework setup", "API reference"

**Invocation**: `/ct-docs-lookup`

---

#### ct-docs-write

**Purpose**: Documentation writing skill applying CLEO's conversational, clear, and user-focused writing style.

**Version**: 1.0.0

**Tier**: 3

**Tags**: documentation, writing, style-guide

**Triggers**: "write docs", "create documentation", "edit the README", "improve doc clarity", "make docs more readable", "follow the style guide", "write user-facing content"

**Invocation**: `/ct-docs-write`

---

#### ct-docs-review

**Purpose**: Documentation review skill for checking docs against CLEO writing style guide, supporting local file review and GitHub PR review modes.

**Version**: 1.0.0

**Tier**: 3

**Tags**: documentation, review, style-guide

**Triggers**: "review documentation", "check docs style", "review this markdown file", "check style guide compliance", "review PR documentation"

**Invocation**: `/ct-docs-review`

---

#### ct-skill-creator

**Purpose**: Guide for creating effective skills that extend Claude's capabilities with specialized knowledge, workflows, or tool integrations.

**Version**: 1.0.0

**Tier**: 3

**Tags**: skills, creation, meta

**Triggers**: "create a new skill", "update an existing skill", "skill creation", "extend Claude capabilities", "build a skill"

**Invocation**: `/ct-skill-creator`

---

#### ct-skill-lookup

**Purpose**: Find and retrieve Agent Skills from prompts.chat for searching skills, extending capabilities, or installing reusable AI agent components.

**Version**: 1.0.0

**Tier**: 3

**Tags**: skills, discovery, prompts-chat

**Triggers**: "find me a skill", "search for skills", "what skills are available", "get skill", "install a skill", "extend Claude capabilities with skills"

**Dependencies**: Can chain to ct-skill-creator

**Invocation**: `/ct-skill-lookup`

---

## Shared Resources

### _shared/cleo-style-guide.md

**Purpose**: Writing style guide for CLEO documentation.

**Content**: Core principles, tone/voice, structure/clarity, formatting guidelines.

### _shared/task-system-integration.md

**Purpose**: Portable task commands with token placeholders for cross-system compatibility.

### _shared/subagent-protocol-base.md

**Purpose**: RFC 2119 subagent output rules and protocol definitions.

---

## Installation

All skills are installed via the project's main installer:

```bash
./install.sh
```

This:
1. Reads `skills/manifest.json` for skill definitions
2. Installs skills with proper `ct-*` prefix naming
3. Sets up shared resources
4. Validates skill structure

---

## Naming Convention

All CLEO skills use the `ct-` prefix:

| Directory Name | Invocation |
|----------------|------------|
| ct-epic-architect | /ct-epic-architect |
| ct-orchestrator | /ct-orchestrator |
| ct-docs-lookup | /ct-docs-lookup |
| ct-docs-write | /ct-docs-write |
| ct-docs-review | /ct-docs-review |
| ct-documentor | /ct-documentor |
| ct-skill-lookup | /ct-skill-lookup |
| ct-library-implementer-bash | /ct-library-implementer-bash |
| ct-research-agent | /ct-research-agent |
| ct-skill-creator | /ct-skill-creator |
| ct-spec-writer | /ct-spec-writer |
| ct-task-executor | /ct-task-executor |
| ct-test-writer-bats | /ct-test-writer-bats |
| ct-validator | /ct-validator |

---

## Subagent Prompts Migration Reference

Subagent prompts have been migrated to `skills/` as proper skills with `ct-*` prefix:

| Old Template | New Skill | Status |
|--------------|-----------|--------|
| SPEC-WRITER.md | `skills/ct-spec-writer/SKILL.md` | Migrated |
| EPIC-ARCHITECT.md | `skills/ct-epic-architect/SKILL.md` | Migrated |
| TEST-WRITER-BATS.md | `skills/ct-test-writer-bats/SKILL.md` | Migrated |
| LIBRARY-IMPLEMENTER.md | `skills/ct-library-implementer-bash/SKILL.md` | Migrated |
| RESEARCH-AGENT.md | `skills/ct-research-agent/SKILL.md` | Migrated |
| TASK-EXECUTOR.md | `skills/ct-task-executor/SKILL.md` | Migrated |
| VALIDATOR.md | `skills/ct-validator/SKILL.md` | Migrated |

---

## Validation Commands

```bash
# Validate skill structure
ls skills/ct-*/SKILL.md

# Check manifest integrity
cat skills/manifest.json | jq '.skills | length'

# Test skill loading
/ct-orchestrator

# Verify skill triggers
# Ask Claude: "What skills are available for documentation?"
```
