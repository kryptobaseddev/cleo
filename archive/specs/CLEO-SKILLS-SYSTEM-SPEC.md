---
task_id: T2558
status: active
type: spec
created_at: 2026-01-26
updated_at: 2026-01-28
title: "CLEO Skills System Enhancement Specification"
tags: ["specification"]
epic_id: T2550
---

# CLEO Skills System Enhancement Specification

**Version**: 1.0.0
**Status**: DRAFT
**Date**: 2026-01-26
**Epic**: T1074 (CLEO Claude Code Plugin Implementation)

---

## Executive Summary

Transform the CLEO skills ecosystem from a flat, hardcoded dispatch system into a **programmatic, layered skill tree** with true progressive disclosure. The goal is to reduce ct-orchestrator from 995 lines to ~200 lines while enabling automated skill selection via `manifest.json`.

### Current State

| Component | Lines | Context Cost | Issue |
|-----------|-------|--------------|-------|
| ct-orchestrator | 995 | ~25KB | Too large, hardcoded dispatch |
| ct-epic-architect | 524 | ~15KB | Reasonable, needs alignment |
| manifest.json | 236 | N/A | Has data, not used programmatically |
| Injection files | 1,200+ | ~47KB | Always loaded, too heavy |

### Target State

| Component | Lines | Context Cost | Change |
|-----------|-------|--------------|--------|
| ct-orchestrator | ~200 | ~6KB | -80% via progressive disclosure |
| ct-epic-architect | ~300 | ~8KB | Trimmed, aligned |
| manifest.json | ~400 | N/A | Enhanced with tier, references |
| CLEO-INJECTION.md | ~100 | ~3KB | Global, minimal |
| AGENT-INJECTION.md | ~80 | ~2KB | Project, minimal |
| lib/skill-dispatch.sh | ~200 | N/A | NEW: Programmatic dispatch |

---

## Architecture

### Skill Tree Hierarchy

```
Level 0: HITL Entry Point (Always Available)
├── Injection Files (Minimal Awareness)
│   ├── CLEO-INJECTION.md (~100 lines) - Global setup
│   └── AGENT-INJECTION.md (~80 lines) - Project quick ref
│
└── ct-orchestrator (~200 lines) - Master Conductor
    ├── Core constraints (ORC-001-008)
    ├── Session startup protocol
    ├── Skill dispatch via manifest.json → lib/skill-dispatch.sh
    └── @references/ (loaded on-demand)
        ├── orchestrator-spawning.md
        ├── orchestrator-compliance.md
        ├── orchestrator-tokens.md
        └── orchestrator-recovery.md

Level 1: Planning/Architecture Skills (Dispatched by Orchestrator)
└── ct-epic-architect (~300 lines)
    ├── Epic creation
    ├── Task decomposition
    ├── Wave planning
    └── @references/ (loaded on-demand)

Level 2: Execution Skills (Spawned as Subagents)
├── ct-task-executor    - Generic implementation
├── ct-research-agent   - Investigation
├── ct-spec-writer      - Specifications
├── ct-test-writer-bats - BATS testing
├── ct-library-implementer-bash - Bash libraries
├── ct-validator        - Compliance checking
└── ct-dev-workflow     - Commits/releases

Level 3: Domain Skills (Chainable)
├── ct-documentor → chains: ct-docs-lookup → ct-docs-write → ct-docs-review
├── ct-skill-creator
└── ct-skill-lookup
```

### Progressive Disclosure Flow

```
User Request
    │
    ▼
Injection Active (~5KB always loaded)
    │ "Use ct-orchestrator for complex workflows"
    ▼
ct-orchestrator SKILL.md (~6KB loaded on trigger)
    │ Reads manifest.json, selects skill
    ▼
lib/skill-dispatch.sh (programmatic selection)
    │ Returns: { skill, prompt_template, references }
    ▼
Selected Skill SKILL.md (~8KB loaded)
    │ + Subagent Protocol Block
    ▼
Subagent Execution
    │ References loaded ONLY if needed
    ▼
Manifest Entry + Task Completion
```

---

## Components

### 1. Enhanced manifest.json Schema

Add new fields for programmatic dispatch:

```json
{
  "$schema": "https://cleo-dev.com/schemas/v1/skills-manifest.schema.json",
  "_meta": {
    "schemaVersion": "2.0.0",
    "lastUpdated": "2026-01-26",
    "totalSkills": 15
  },
  "skills": [
    {
      "name": "ct-orchestrator",
      "version": "2.0.0",
      "description": "...",
      "path": "skills/ct-orchestrator",
      "tier": 0,
      "token_budget": 6000,
      "model": null,
      "tags": ["workflow", "multi-agent", "coordination"],
      "status": "active",
      "references": [
        "references/orchestrator-spawning.md",
        "references/orchestrator-compliance.md",
        "references/orchestrator-tokens.md",
        "references/orchestrator-recovery.md"
      ],
      "capabilities": {
        "inputs": ["TASK_ID", "SESSION_ID", "EPIC_ID"],
        "outputs": ["workflow-coordination", "subagent-spawns"],
        "dependencies": [],
        "chains_to": ["ct-epic-architect", "ct-research-agent", "ct-task-executor"],
        "dispatch_triggers": ["orchestrate", "orchestrator mode", "delegate to subagents"],
        "dispatch_keywords": {
          "primary": ["orchestrate", "coordinate", "delegate", "spawn"],
          "secondary": ["workflow", "multi-agent", "subagent", "HITL"]
        },
        "compatible_subagent_types": ["orchestrator"]
      },
      "constraints": {
        "max_context_tokens": 10000,
        "requires_session": true,
        "requires_epic": false
      }
    }
  ],
  "dispatch_matrix": {
    "by_task_type": {
      "research": "ct-research-agent",
      "planning": "ct-epic-architect",
      "implementation": "ct-task-executor",
      "testing": "ct-test-writer-bats",
      "documentation": "ct-documentor",
      "specification": "ct-spec-writer",
      "validation": "ct-validator",
      "bash-library": "ct-library-implementer-bash"
    },
    "by_keyword": {
      "research|investigate|explore|discover": "ct-research-agent",
      "epic|plan|decompose|architect": "ct-epic-architect",
      "implement|build|execute|create": "ct-task-executor",
      "test|bats|coverage|integration": "ct-test-writer-bats",
      "doc|document|readme|guide": "ct-documentor",
      "spec|rfc|protocol|contract": "ct-spec-writer",
      "validate|verify|audit|compliance": "ct-validator",
      "lib/|bash|shell|function": "ct-library-implementer-bash"
    }
  }
}
```

### 2. lib/skill-dispatch.sh

New library for programmatic skill selection:

```bash
#!/usr/bin/env bash
# lib/skill-dispatch.sh - Programmatic skill selection from manifest.json

MANIFEST_PATH="${MANIFEST_PATH:-skills/manifest.json}"

# Match task to skill by keywords
# Usage: skill_dispatch_by_keywords "implement auth middleware"
# Returns: skill name or empty if no match
skill_dispatch_by_keywords() {
    local query="$1"
    local query_lower=$(echo "$query" | tr '[:upper:]' '[:lower:]')

    # Read dispatch_matrix.by_keyword patterns
    jq -r '.dispatch_matrix.by_keyword | to_entries[] |
        select(.key | split("|") | any(. as $p | $query | test($p; "i"))) |
        .value' "$MANIFEST_PATH" --arg query "$query_lower" | head -1
}

# Match task to skill by task type/labels
# Usage: skill_dispatch_by_type "research"
skill_dispatch_by_type() {
    local task_type="$1"
    jq -r --arg type "$task_type" \
        '.dispatch_matrix.by_task_type[$type] // empty' "$MANIFEST_PATH"
}

# Get skill metadata from manifest
# Usage: skill_get_metadata "ct-research-agent"
skill_get_metadata() {
    local skill_name="$1"
    jq -r --arg name "$skill_name" \
        '.skills[] | select(.name == $name)' "$MANIFEST_PATH"
}

# Get skill's reference files for progressive loading
# Usage: skill_get_references "ct-orchestrator"
skill_get_references() {
    local skill_name="$1"
    skill_get_metadata "$skill_name" | jq -r '.references[]? // empty'
}

# Check if skill is compatible with subagent type
# Usage: skill_check_compatibility "ct-research-agent" "Explore"
skill_check_compatibility() {
    local skill_name="$1"
    local subagent_type="$2"

    local compatible=$(skill_get_metadata "$skill_name" | \
        jq -r --arg type "$subagent_type" \
        '.capabilities.compatible_subagent_types | contains([$type])')

    [[ "$compatible" == "true" ]]
}

# Get skills in a specific tier
# Usage: skill_list_by_tier 2
skill_list_by_tier() {
    local tier="$1"
    jq -r --argjson tier "$tier" \
        '.skills[] | select(.tier == $tier) | .name' "$MANIFEST_PATH"
}

# Auto-dispatch: determine best skill for a CLEO task
# Usage: skill_auto_dispatch "T1234"
skill_auto_dispatch() {
    local task_id="$1"

    # Get task details
    local task_json=$(cleo show "$task_id" --format json 2>/dev/null)
    if [[ -z "$task_json" ]]; then
        echo "ERROR: Task $task_id not found" >&2
        return 1
    fi

    local title=$(echo "$task_json" | jq -r '.task.title')
    local description=$(echo "$task_json" | jq -r '.task.description // ""')
    local labels=$(echo "$task_json" | jq -r '.task.labels[]? // empty' | tr '\n' ' ')

    # Combine text for matching
    local full_text="$title $description $labels"

    # Try keyword match first
    local skill=$(skill_dispatch_by_keywords "$full_text")

    # Fallback to label-based type match
    if [[ -z "$skill" ]]; then
        for label in $labels; do
            skill=$(skill_dispatch_by_type "$label")
            [[ -n "$skill" ]] && break
        done
    fi

    # Default to ct-task-executor
    echo "${skill:-ct-task-executor}"
}

# Generate spawn context for a skill
# Usage: skill_prepare_spawn "ct-research-agent" "T1234"
skill_prepare_spawn() {
    local skill_name="$1"
    local task_id="$2"

    local metadata=$(skill_get_metadata "$skill_name")
    local skill_path=$(echo "$metadata" | jq -r '.path')
    local token_budget=$(echo "$metadata" | jq -r '.token_budget // 10000')
    local model=$(echo "$metadata" | jq -r '.model // "auto"')

    jq -n \
        --arg skill "$skill_name" \
        --arg path "$skill_path" \
        --arg task "$task_id" \
        --argjson budget "$token_budget" \
        --arg model "$model" \
        '{
            skill: $skill,
            path: $path,
            taskId: $task,
            tokenBudget: $budget,
            model: $model,
            skillFile: ($path + "/SKILL.md")
        }'
}
```

### 3. Slimmed ct-orchestrator SKILL.md (~200 lines)

The new orchestrator focuses on:
1. Core constraints (ORC-001-008)
2. Session startup protocol
3. Skill dispatch via lib/skill-dispatch.sh
4. Pointer to references for detailed workflows

```markdown
---
name: ct-orchestrator
description: |
  Master HITL orchestrator for CLEO-based development workflows.
  Use when: "orchestrate", "orchestrator mode", "delegate to subagents",
  "coordinate agents", "multi-agent workflow", "HITL orchestration".
  Dispatches to specialized skills via manifest.json.
version: 2.0.0
tier: 0
---

# Orchestrator Protocol

> **The Mantra**: *Scope down. Trace to Epic. No orphaned work.*

You are the **Orchestrator** - a conductor, not a musician.
Coordinate workflows by delegating ALL work to subagents.

## Immutable Constraints (ORC)

| ID | Rule | Enforcement |
|----|------|-------------|
| ORC-001 | Stay high-level | NO implementation details |
| ORC-002 | Delegate ALL work | Use Task tool for everything |
| ORC-003 | No full file reads | Manifest summaries ONLY |
| ORC-004 | Dependency order | No overlapping agents |
| ORC-005 | Context budget | Stay under 10K tokens |
| ORC-006 | Max 3 files/agent | Scope limit for reasoning |
| ORC-007 | Traced to Epic | No orphaned work |
| ORC-008 | No arch decisions | MUST be pre-decided by HITL |

## Session Startup

```bash
# All-in-one startup
cleo orchestrator start --epic T1575
```

Or manual:
```bash
cleo session list --status active
cleo focus show
cleo dash --compact
```

| Condition | Action |
|-----------|--------|
| Active session + focus | Resume work |
| Active session, no focus | Query manifest `needs_followup` |
| No session + followup | Create session; spawn next |
| No session + no followup | Ask user for direction |

## Skill Dispatch

Use `lib/skill-dispatch.sh` for programmatic selection:

```bash
source lib/skill-dispatch.sh

# Auto-select skill for task
skill=$(skill_auto_dispatch "T1234")

# Or by keywords
skill=$(skill_dispatch_by_keywords "implement auth middleware")

# Generate spawn context
context=$(skill_prepare_spawn "$skill" "T1234")
```

### Dispatch Matrix (from manifest.json)

| Task Type | Skill |
|-----------|-------|
| Research/investigation | ct-research-agent |
| Epic/project planning | ct-epic-architect |
| Generic implementation | ct-task-executor |
| BATS testing | ct-test-writer-bats |
| Documentation | ct-documentor |
| Specifications | ct-spec-writer |
| Validation/audit | ct-validator |
| Bash libraries | ct-library-implementer-bash |

## Subagent Spawning

```bash
# Quick spawn
cleo orchestrator spawn T1234

# Or with explicit skill
cleo orchestrator spawn T1234 --template ct-research-agent
```

**MUST inject protocol block** - See @references/orchestrator-spawning.md

## Core Workflow

1. **Discovery**: `cleo orchestrator start --epic T1575`
2. **Planning**: `cleo orchestrator analyze T1575`
3. **Execution**: Sequential spawn via skill dispatch
4. **Verification**: Manifest + compliance checks

## References

For detailed workflows, see:
- @references/orchestrator-spawning.md - Complete spawn workflow
- @references/orchestrator-compliance.md - Verification protocol
- @references/orchestrator-tokens.md - Token injection system
- @references/orchestrator-recovery.md - Error handling
```

### 4. Reference Files Structure

Move detailed content from SKILL.md to reference files:

```
skills/ct-orchestrator/
├── SKILL.md                         # ~200 lines (core)
└── references/
    ├── orchestrator-spawning.md     # ~250 lines (spawn workflow)
    ├── orchestrator-compliance.md   # ~150 lines (verification)
    ├── orchestrator-tokens.md       # ~150 lines (token system)
    └── orchestrator-recovery.md     # ~100 lines (error handling)
```

---

## Implementation Phases

### Phase 1: Foundation (Wave 1)

**Goal**: Create the programmatic dispatch infrastructure

| Task | Description | Size |
|------|-------------|------|
| T-NEW-1 | Create lib/skill-dispatch.sh | Medium |
| T-NEW-2 | Enhance manifest.json schema (v2.0.0) | Small |
| T-NEW-3 | Add tier, token_budget, references fields | Small |
| T-NEW-4 | Add dispatch_matrix to manifest.json | Small |

### Phase 2: Orchestrator Optimization (Wave 2)

**Goal**: Slim ct-orchestrator via progressive disclosure

| Task | Description | Size |
|------|-------------|------|
| T-NEW-5 | Create references/orchestrator-spawning.md | Medium |
| T-NEW-6 | Create references/orchestrator-compliance.md | Small |
| T-NEW-7 | Create references/orchestrator-tokens.md | Small |
| T-NEW-8 | Create references/orchestrator-recovery.md | Small |
| T-NEW-9 | Slim ct-orchestrator SKILL.md to ~200 lines | Medium |
| T-NEW-10 | Update orchestrator to use lib/skill-dispatch.sh | Medium |

### Phase 3: Epic Architect Alignment (Wave 3)

**Goal**: Align ct-epic-architect with new system

| Task | Description | Size |
|------|-------------|------|
| T-NEW-11 | Review ct-epic-architect against CLEO v0.69+ | Small |
| T-NEW-12 | Move detailed examples to references/ | Medium |
| T-NEW-13 | Add file attachment and research linking patterns | Small |

### Phase 4: Injection Optimization (Wave 4)

**Goal**: Minimize always-loaded context

| Task | Description | Size |
|------|-------------|------|
| T2295 | Create CLEO-INJECTION.md (global) | Medium |
| T2296 | Optimize AGENT-INJECTION.md (project) | Medium |

### Phase 5: Integration (Wave 5)

**Goal**: Update scripts to use new system

| Task | Description | Size |
|------|-------------|------|
| T2299 | Update init.sh for new injections | Medium |
| T2300 | Update upgrade.sh for injection refresh | Medium |
| T2301 | Update doctor.sh for validation | Small |
| T2344 | Final ct-orchestrator improvements | Medium |

### Phase 6: Testing & Documentation (Wave 6)

| Task | Description | Size |
|------|-------------|------|
| T2303 | BATS tests for injection system | Medium |
| T-NEW-14 | BATS tests for lib/skill-dispatch.sh | Small |
| T2302 | Deprecate TODO_Task_Management.md | Small |
| T-NEW-15 | Update CLEO Skills documentation | Medium |

---

## Success Metrics

| Metric | Current | Target | Validation |
|--------|---------|--------|------------|
| ct-orchestrator lines | 995 | ~200 | `wc -l` |
| Always-loaded context | ~47KB | ~7KB | Injection file sizes |
| Skill dispatch | Hardcoded | manifest.json | Code review |
| Progressive disclosure | None | 3 levels | Reference file count |
| Test coverage | Unknown | 80%+ | BATS tests |

---

## Risk Assessment

| Risk | Mitigation |
|------|------------|
| Breaking existing orchestrator workflows | Gradual migration, backwards compat |
| Skill dispatch mismatches | Comprehensive dispatch_matrix testing |
| Reference files not loaded | Clear @reference syntax, validation |
| Token budget exceeded | token_budget field enforcement |

---

## Open Questions

1. Should lib/skill-dispatch.sh also handle skill chaining (ct-documentor → ct-docs-*)?
2. Should manifest.json support skill versioning for upgrades?
3. Should we add a `cleo skill dispatch "query"` command for HITL debugging?
4. Should tier 3 skills (domain) auto-chain or require explicit orchestration?

---

## Appendix: Current manifest.json Fields

**Existing** (v1.1.0):
- name, version, description, path, model, tags, status
- capabilities: inputs, outputs, dependencies, dispatch_triggers, compatible_subagent_types

**Proposed additions** (v2.0.0):
- tier (0-3)
- token_budget
- references[]
- capabilities.chains_to
- capabilities.dispatch_keywords.primary/secondary
- constraints.max_context_tokens
- constraints.requires_session
- constraints.requires_epic
- dispatch_matrix.by_task_type
- dispatch_matrix.by_keyword
