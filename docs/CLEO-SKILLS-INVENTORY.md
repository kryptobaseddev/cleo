# CLEO Skills Ecosystem Inventory

**Generated**: 2026-01-19
**Status**: Validation Complete - Action Required

---

## Executive Summary

The CLEO skills system has **6 skills** and **2 shared resources**, but requires structural fixes before deployment as a proper Claude Code plugin. Most skills have good content but some need frontmatter fixes and broken file references repaired.

### Critical Issues (Must Fix)

| Issue | Location | Impact |
|-------|----------|--------|
| Missing plugin.json | Project root | Cannot deploy as Claude Code plugin |
| Broken file references | docs-write, docs-review | Skills fail to load shared style guide |
| Wrong product name | docs-write, docs-review | References "Metabase" instead of "CLEO" |
| Non-standard frontmatter | orchestrator | `triggers:` field is deprecated |

### Validation Status

| Skill | Frontmatter | Content | References | Overall |
|-------|-------------|---------|------------|---------|
| **epic-architect** | Good | Good | Good | **Good** |
| orchestrator | Needs fix | Good | Good | Needs Improvement |
| docs-lookup | Good | Good | N/A | Good |
| docs-write | Needs fix | Good | BROKEN | Critical Fix Needed |
| docs-review | Needs fix | Good | BROKEN | Critical Fix Needed |
| skill-lookup | Good | Good | N/A | Good |

---

## Current Structure

```
skills/
├── epic-architect/
│   ├── SKILL.md              # Epic creation and task decomposition (v2.1.0)
│   ├── references/
│   │   ├── commands.md       # CLEO commands reference with tokens
│   │   ├── patterns.md       # Research, Bug, Task naming patterns
│   │   ├── output-format.md  # Epic output file templates
│   │   └── skill-aware-execution.md  # Orchestrator integration
│   └── examples/
│       ├── feature-epic-example.md   # Greenfield feature epic
│       ├── bug-epic-example.md       # Bug fix epic with severity
│       ├── research-epic-example.md  # 3 research patterns
│       └── migration-epic-example.md # Multi-phase migration
├── orchestrator/
│   ├── SKILL.md              # Multi-agent workflow orchestration
│   ├── INSTALL.md            # Installation instructions
│   ├── README.md             # Overview
│   └── references/
│       └── SUBAGENT-PROTOCOL-BLOCK.md
├── docs-lookup/
│   └── SKILL.md              # Context7 documentation lookup
├── docs-write/
│   └── SKILL.md              # Documentation writing (BROKEN ref)
├── docs-review/
│   └── SKILL.md              # Documentation review (BROKEN ref)
├── skill-lookup/
│   └── SKILL.md              # prompts.chat skill discovery
└── _shared/
    ├── cleo-style-guide.md          # Shared writing style guide
    ├── task-system-integration.md   # Portable task commands (tokens)
    └── subagent-protocol-base.md    # RFC 2119 subagent output rules
```

---

## Skill Details

### 1. epic-architect (NEW)

**Purpose**: Create comprehensive CLEO epics with full task decomposition, dependency analysis, and wave planning. Converted from subagent template to skill format with progressive disclosure.

**Version**: 2.1.0

**Triggers**: "create epic", "plan epic", "decompose into tasks", "architect the work", "break down this project", "epic planning", "task breakdown", "dependency analysis", "wave planning", "sprint planning"

**Status**: **Good** - Properly structured with valid frontmatter, progressive disclosure, and 69 passing tests.

**Structure**:
- SKILL.md (490 lines) - Core workflow
- references/ (4 files) - Commands, patterns, output format, orchestrator integration
- examples/ (4 files) - Feature, bug, research, migration epic examples

**Token-Based Commands**: Uses `{{TASK_ADD_CMD}}`, `{{TASK_COMPLETE_CMD}}`, etc. for portable task system integration.

**Frontmatter**:
```yaml
---
name: epic-architect
description: |
  Epic architecture agent for creating comprehensive epics with full task decomposition.
  Use when user says "create epic", "plan epic", "decompose into tasks",
  "architect the work", "break down this project", "epic planning",
  "task breakdown", "dependency analysis", "wave planning", "sprint planning".
version: 2.1.0
model: sonnet
---
```

**Installation**: `./scripts/epic-architect-install.sh [--global]`

---

### 2. orchestrator

**Purpose**: Activate orchestrator mode for managing complex multi-agent workflows with ORC-001 through ORC-005 constraints.

**Triggers**: "orchestrate", "orchestrator mode", "run as orchestrator", "delegate to subagents", "multi-agent workflow"

**Issues**:
1. `triggers:` field in frontmatter is non-standard - remove it
2. Description uses second person - rewrite in third person
3. Duplicate content between SKILL.md and references/ - use progressive disclosure

**Recommended Frontmatter**:
```yaml
---
name: orchestrator
description: |
  This skill should be used when the user asks to "orchestrate", "orchestrator mode",
  "run as orchestrator", "delegate to subagents", "coordinate agents", "spawn subagents",
  "multi-agent workflow", "context-protected workflow", "agent farm", "HITL orchestration",
  or needs to manage complex workflows by delegating work to subagents while protecting
  the main context window. Enforces ORC-001 through ORC-005 constraints: stay high-level,
  delegate ALL work via Task tool, read only manifest summaries, enforce dependency order,
  and maintain context budget under 10K tokens.
version: 1.0.0
---
```

### 2. docs-lookup

**Purpose**: Context7 documentation lookup for library/framework questions.

**Triggers**: "how do I configure [library]", "write code using [framework]", "what are the methods"

**Issues**:
1. Missing specific trigger phrases in description
2. Missing MCP tool call limit warning (3 calls max)

**Recommended Frontmatter**:
```yaml
---
name: docs-lookup
description: This skill should be used when the user asks "how do I configure [library]", "write code using [framework]", "what are the [library] methods", "show me [framework] examples", or mentions libraries like React, Vue, Next.js, Prisma, Supabase, Express, Tailwind, Drizzle, Svelte. Triggers for library setup, configuration, API references, framework code examples, or version-specific docs ("React 19", "Next.js 15").
version: 1.0.0
---
```

### 3. docs-write

**Purpose**: Documentation writing following CLEO style guidelines.

**Triggers**: "write docs", "create documentation", "edit the README", "improve doc clarity"

**Critical Issues**:
1. **BROKEN REFERENCE**: Line 9 references `@~/.cleo/skills/_shared/metabase-style-guide.md` which does not exist
2. Wrong product name: "Metabase's" should be "CLEO's"
3. `allowed-tools` field may not be standard

**Recommended Fix**:
```yaml
---
name: docs-write
description: This skill should be used when creating, editing, or reviewing documentation files (markdown, MDX, README, guides). Use when the user asks to "write docs", "create documentation", "edit the README", "improve doc clarity", "make docs more readable", "follow the style guide", or "write user-facing content". Applies CLEO's conversational, clear, and user-focused writing style.
version: 1.0.0
---
```

**Line 9 Fix**: Change to `@skills/_shared/cleo-style-guide.md` or `@${CLAUDE_PLUGIN_ROOT}/skills/_shared/cleo-style-guide.md`

### 4. docs-review

**Purpose**: Documentation review for style guide compliance.

**Triggers**: "review documentation", "check docs style", "review this markdown", "check style guide compliance"

**Critical Issues**:
1. **BROKEN REFERENCE**: Line 9 references `@~/.cleo/skills/_shared/metabase-style-guide.md` which does not exist
2. Wrong product name: "Metabase writing style guide" should be "CLEO writing style guide"
3. Line 78 quick scan table references Metabase

**Recommended Fix**:
```yaml
---
name: docs-review
version: 1.0.0
description: This skill should be used when the user asks to "review documentation", "check docs style", "review this markdown file", "check style guide compliance", "review PR documentation", or needs documentation reviewed against the CLEO writing style guide. Supports both local file review and GitHub PR review modes with inline comments.
---
```

**Line 9 Fix**: Change to `@skills/_shared/cleo-style-guide.md`

### 5. skill-lookup

**Purpose**: Search and install Agent Skills from prompts.chat.

**Triggers**: "find me a skill", "search for skills", "get skill XYZ", "install a skill"

**Issues**: Minor - could add more trigger phrases

**Status**: Good - no critical issues

---

## Shared Resources

### _shared/cleo-style-guide.md

**Purpose**: Writing style guide for CLEO documentation.

**Content**: Core principles, tone/voice, structure/clarity, formatting guidelines.

**Issues**:
1. Directory uses `_shared` (underscore prefix) - consider renaming to `shared/`
2. Other skills reference wrong file path (`metabase-style-guide.md`)

---

## Installation Architecture Decision

### Option A: Single CLEO Plugin (Recommended)

All skills bundled together in one plugin:

```
.claude-plugin/
├── plugin.json
├── skills/
│   ├── ct-orchestrator/SKILL.md
│   ├── ct-docs-lookup/SKILL.md
│   ├── ct-docs-write/SKILL.md
│   ├── ct-docs-review/SKILL.md
│   ├── ct-skill-lookup/SKILL.md
│   └── _shared/cleo-style-guide.md
├── commands/
│   └── cleo.md
└── README.md
```

**Pros**: Single install, cohesive ecosystem, easier versioning
**Cons**: Larger footprint, all-or-nothing installation

### Option B: Global Skills Installation

Skills installed to `~/.claude/skills/` with `ct-` prefix:

```
~/.claude/skills/
├── ct-orchestrator/SKILL.md
├── ct-docs-lookup/SKILL.md
├── ct-docs-write/SKILL.md
├── ct-docs-review/SKILL.md
└── ct-skill-lookup/SKILL.md
```

**Pros**: Available across all projects, modular installation
**Cons**: Requires manual installation, version drift risk

### Recommendation

**Hybrid Approach**:
1. Create `.claude-plugin/` structure for plugin marketplace distribution
2. Provide `cleo skills install --global` command for `~/.claude/skills/` installation
3. Keep `skills/` in project for development/dogfooding

---

## Naming Convention

All CLEO skills installed to `~/.claude/skills/` MUST use `ct-` prefix:

| Current Name | Installed Name | Invocation |
|--------------|----------------|------------|
| orchestrator | ct-orchestrator | /ct-orchestrator |
| docs-lookup | ct-docs-lookup | /ct-docs-lookup |
| docs-write | ct-docs-write | /ct-docs-write |
| docs-review | ct-docs-review | /ct-docs-review |
| skill-lookup | ct-skill-lookup | /ct-skill-lookup |

---

## Distribution Roadmap

### Phase 1: Fix Critical Issues (Now)
- [ ] Fix broken file references in docs-write and docs-review
- [ ] Update frontmatter for all skills
- [ ] Remove Metabase references

### Phase 2: Create Plugin Structure (This Week)
- [ ] Create `.claude-plugin/plugin.json`
- [ ] Move/copy skills to `.claude-plugin/skills/` with `ct-` prefix
- [ ] Create slash command wrapper

### Phase 3: Marketplace Distribution (This Month)
- [ ] Create `.claude-plugin/marketplace.json`
- [ ] Host on GitHub as public marketplace
- [ ] Submit to official plugin directory (if eligible)

### Phase 4: Agent Skills Standard (Future)
- [ ] Publish to agentskills.io
- [ ] Submit to SkillsMP marketplace
- [ ] Cross-platform compatibility

---

## Subagent Prompts Inventory (MIGRATED)

**MIGRATED**: Subagent prompts have been migrated to `skills/` as proper skills.

| Old Template | New Skill | Status |
|--------------|-----------|--------|
| SPEC-WRITER.md | `skills/spec-writer/SKILL.md` | Migrated |
| EPIC-ARCHITECT.md | `skills/epic-architect/SKILL.md` | Migrated |
| TEST-WRITER-BATS.md | `skills/test-writer-bats/SKILL.md` | Migrated |
| LIBRARY-IMPLEMENTER.md | `skills/library-implementer-bash/SKILL.md` | Migrated |
| RESEARCH-AGENT.md | `skills/research-agent/SKILL.md` | Migrated |
| TASK-EXECUTOR.md | `skills/task-executor/SKILL.md` | Migrated |
| VALIDATOR.md | `skills/validator/SKILL.md` | Migrated |

Shared references in `skills/_shared/`:
- `subagent-protocol-base.md` - Base protocol block
- `task-system-integration.md` - CLEO task system integration

---

## Implementation Priority

1. **CRITICAL**: Fix docs-write and docs-review broken references
2. **HIGH**: Update all skill frontmatter with proper descriptions
3. **MEDIUM**: Create `.claude-plugin/` structure
4. **MEDIUM**: Add `cleo skills install` command
5. **LOW**: Submit to official marketplace

---

## Validation Commands

```bash
# Validate plugin structure
claude plugin validate .

# Test skill loading
/skill orchestrator

# Verify skill triggers
# Ask Claude: "What skills are available for documentation?"
```
