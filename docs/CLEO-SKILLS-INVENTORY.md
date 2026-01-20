# CLEO Skills Ecosystem Inventory

**Generated**: 2026-01-19
**Status**: Active - Validated

---

## Executive Summary

The CLEO skills system has **14 skills** and **3 shared resources**. All skills use the `ct-*` prefix naming convention and are tracked via `manifest.json`.

### Architecture Overview

| Component | Count | Status |
|-----------|-------|--------|
| Skills (ct-*) | 14 | Active |
| Shared Resources | 3 | Active |
| Manifest Tracking | Yes | `skills/manifest.json` |

### Skill Status

| Skill | Version | Tags | Status |
|-------|---------|------|--------|
| **ct-epic-architect** | 2.1.0 | planning, architecture, task-management | Active |
| **ct-orchestrator** | 1.0.0 | workflow, multi-agent, coordination | Active |
| **ct-docs-lookup** | 1.0.0 | documentation, libraries, context7 | Active |
| **ct-docs-write** | 1.0.0 | documentation, writing, style-guide | Active |
| **ct-docs-review** | 1.0.0 | documentation, review, style-guide | Active |
| **ct-documentor** | 2.3.0 | documentation, orchestration, workflow | Active |
| **ct-skill-lookup** | 1.0.0 | skills, discovery, prompts-chat | Active |
| **ct-library-implementer-bash** | 1.0.0 | implementation, bash, library | Active |
| **ct-research-agent** | 1.0.0 | research, investigation, discovery | Active |
| **ct-skill-creator** | 1.0.0 | skills, creation, meta | Active |
| **ct-spec-writer** | 1.0.0 | specification, documentation, rfc | Active |
| **ct-task-executor** | 1.0.0 | execution, implementation, task-management | Active |
| **ct-test-writer-bats** | 1.0.0 | testing, bats, integration | Active |
| **ct-validator** | 1.0.0 | validation, compliance, audit | Active |

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

### 1. ct-epic-architect

**Purpose**: Create comprehensive CLEO epics with full task decomposition, dependency analysis, and wave planning.

**Version**: 2.1.0

**Triggers**: "create epic", "plan epic", "decompose into tasks", "architect the work", "break down this project", "epic planning", "task breakdown", "dependency analysis", "wave planning", "sprint planning"

**Status**: Active - Properly structured with valid frontmatter and progressive disclosure.

**Structure**:
- SKILL.md - Core workflow
- references/ (8 files) - Commands, patterns, output format, orchestrator integration, examples

**Token-Based Commands**: Uses `{{TASK_ADD_CMD}}`, `{{TASK_COMPLETE_CMD}}`, etc. for portable task system integration.

**Invocation**: `/ct-epic-architect` or natural language triggers

---

### 2. ct-orchestrator

**Purpose**: Activate orchestrator mode for managing complex multi-agent workflows with ORC-001 through ORC-005 constraints.

**Version**: 1.0.0

**Triggers**: "orchestrate", "orchestrator mode", "run as orchestrator", "delegate to subagents", "coordinate agents", "spawn subagents", "multi-agent workflow", "context-protected workflow", "agent farm", "HITL orchestration"

**Invocation**: `/ct-orchestrator`

---

### 3. ct-docs-lookup

**Purpose**: Context7 documentation lookup for library/framework questions.

**Version**: 1.0.0

**Triggers**: "how do I configure [library]", "write code using [framework]", "what are the [library] methods", "show me [framework] examples"

**Invocation**: `/ct-docs-lookup`

---

### 4. ct-docs-write

**Purpose**: Documentation writing following CLEO style guidelines.

**Version**: 1.0.0

**Triggers**: "write docs", "create documentation", "edit the README", "improve doc clarity", "follow the style guide"

**Invocation**: `/ct-docs-write`

---

### 5. ct-docs-review

**Purpose**: Documentation review for style guide compliance.

**Version**: 1.0.0

**Triggers**: "review documentation", "check docs style", "review this markdown", "check style guide compliance"

**Invocation**: `/ct-docs-review`

---

### 6. ct-documentor

**Purpose**: Documentation specialist orchestrating ct-docs-lookup, ct-docs-write, and ct-docs-review for end-to-end documentation workflows. Enforces "MAINTAIN, DON'T DUPLICATE" principle.

**Version**: 2.3.0

**Triggers**: "write documentation", "create docs", "update documentation", "document this feature", "full docs workflow", "end-to-end documentation"

**Invocation**: `/ct-documentor`

**Orchestrates**:
- `/ct-docs-lookup` - Discovery phase
- `/ct-docs-write` - Creation phase
- `/ct-docs-review` - Review phase

---

### 7. ct-skill-lookup

**Purpose**: Search and install Agent Skills from prompts.chat.

**Version**: 1.0.0

**Triggers**: "find me a skill", "search for skills", "get skill XYZ", "install a skill"

**Invocation**: `/ct-skill-lookup`

---

### 8. ct-library-implementer-bash

**Purpose**: Bash library implementation skill for creating shared shell functions in `lib/*.sh`.

**Version**: 1.0.0

**Invocation**: `/ct-library-implementer-bash`

---

### 9. ct-research-agent

**Purpose**: Research and investigation agent for gathering information from multiple sources.

**Version**: 1.0.0

**Triggers**: "research", "investigate", "find out about", "explore options", "due diligence"

**Invocation**: `/ct-research-agent`

---

### 10. ct-skill-creator

**Purpose**: Guide for creating effective skills that extend Claude's capabilities.

**Version**: 1.0.0

**Triggers**: "create a skill", "new skill", "write a skill", "skill development"

**Invocation**: `/ct-skill-creator`

---

### 11. ct-spec-writer

**Purpose**: Specification writing agent for creating technical specifications using RFC 2119 language.

**Version**: 1.0.0

**Invocation**: `/ct-spec-writer`

---

### 12. ct-task-executor

**Purpose**: Generic task execution agent for completing implementation work.

**Version**: 1.0.0

**Invocation**: `/ct-task-executor`

---

### 13. ct-test-writer-bats

**Purpose**: Integration test writing agent using BATS framework.

**Version**: 1.0.0

**Invocation**: `/ct-test-writer-bats`

---

### 14. ct-validator

**Purpose**: Compliance validation agent for verifying system, document, and code compliance.

**Version**: 1.0.0

**Invocation**: `/ct-validator`

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
