---
title: "Skill Taxonomy Specification"
description: "Logical grouping taxonomy for CLEO skills based on tier, category, and tags"
icon: "sitemap"
---

# Skill Taxonomy Specification

**Version**: 1.0.0
**Date**: 2026-01-27
**Status**: Proposed
**Task**: T2434
**Epic**: T2431 (Skill System Enhancement & Dynamic Skill Discovery)

---

## Executive Summary

This specification defines a logical grouping taxonomy for CLEO skills based on the cleo-subagent architecture. The taxonomy provides a hierarchical organization by tier (coordination vs execution), functional category (what skills do), and cross-cutting tags (how skills work).

**Key Principle**: All skills are context injection protocols for the universal `cleo-subagent` agent type, NOT separate agent implementations.

---

## 1. Taxonomy Structure

### 1.1 Three-Axis Organization

```
Tier (Hierarchy)
├── Category (Function)
│   └── Skill (Protocol)
└── Tags (Cross-cutting Concerns)
```

**Tier** = Coordination level in multi-agent hierarchy
**Category** = Functional purpose (what the skill does)
**Tags** = Implementation characteristics (how it works)

---

## 2. Tier Hierarchy

| Tier | Purpose | Coordination | Skills |
|------|---------|--------------|--------|
| **Tier 0** | Orchestration | Delegates ALL work to subagents | `ct-orchestrator` |
| **Tier 1** | Strategic | Plans/coordinates work, may spawn subagents | `ct-epic-architect` |
| **Tier 2** | Tactical | Executes work, terminal nodes | Most execution skills |
| **Tier 3** | Specialized | Domain-specific, may be invoked by Tier 2 | `ct-docs-*`, `ct-skill-*` |

### 2.1 Tier Constraints

| Tier | Max Context | Reads Full Files | Spawns Subagents | Decision Authority |
|------|-------------|------------------|------------------|-------------------|
| 0 | 10K tokens | ❌ Manifest only | ✅ Required | ❌ None (HITL only) |
| 1 | 100K tokens | ✅ As needed | ✅ Optional | ⚠️ Limited (tactical) |
| 2 | 60-80K tokens | ✅ Full access | ❌ No | ✅ Full (within scope) |
| 3 | 60-80K tokens | ✅ Full access | ❌ No | ✅ Domain-specific |

### 2.2 Invocation Patterns

```
Tier 0 (Orchestrator)
  ├─→ spawns Tier 1 (Epic Architect) for planning
  ├─→ spawns Tier 2 (Task Executor) for implementation
  └─→ spawns Tier 2 (Research Agent) for discovery

Tier 1 (Epic Architect)
  ├─→ creates task structure
  └─→ may spawn Tier 2 (Research Agent) for context gathering

Tier 2 (Task Executor)
  └─→ terminal execution (no subagent spawning)

Tier 2 (Documentor)
  ├─→ invokes Tier 3 (ct-docs-lookup) for discovery
  ├─→ invokes Tier 3 (ct-docs-write) for content
  └─→ invokes Tier 3 (ct-docs-review) for validation
```

---

## 3. Functional Categories

### 3.1 Category Definitions

| Category | Purpose | Output Type | Example Skills |
|----------|---------|-------------|----------------|
| **coordination** | Multi-agent workflow management | Session state, spawn commands | `ct-orchestrator` |
| **planning** | Strategic decomposition and architecture | Epic structure, task tree | `ct-epic-architect` |
| **discovery** | Information gathering and research | Research reports, findings | `ct-research-agent` |
| **specification** | Formal requirements and protocols | Specs, RFCs, contracts | `ct-spec-writer` |
| **implementation** | Code and system creation | Code, configs, scripts | `ct-task-executor`, `ct-library-implementer-bash` |
| **validation** | Quality and compliance checking | Audit reports, test results | `ct-validator`, `ct-test-writer-bats` |
| **documentation** | User-facing content creation | Docs, guides, references | `ct-documentor`, `ct-docs-*` |
| **workflow** | Process automation and release | Commits, releases, tags | `ct-dev-workflow` |
| **meta** | Skill system self-improvement | Skills, protocols | `ct-skill-creator`, `ct-skill-lookup` |

### 3.2 Category Relationships

```
Graph TD:
  discovery → specification → implementation → validation → documentation
       ↓                            ↓
  planning → coordination → workflow (release)
       ↑                     ↑
       └────── meta ─────────┘
```

**Primary Flow**: Discovery → Spec → Implementation → Validation → Documentation
**Control Flow**: Planning → Coordination → Workflow
**Meta Flow**: Meta skills improve all other skills

---

## 4. Skill-to-Category Mapping

### 4.1 Complete Mapping Table

| Skill Name | Tier | Category | Protocol | Token Budget |
|------------|------|----------|----------|--------------|
| `ct-orchestrator` | 0 | coordination | orchestrator | 8000 |
| `ct-epic-architect` | 1 | planning | decomposition | 8000 |
| `ct-research-agent` | 2 | discovery | research | 8000 |
| `ct-spec-writer` | 2 | specification | specification | 8000 |
| `ct-task-executor` | 2 | implementation | implementation | 8000 |
| `ct-library-implementer-bash` | 2 | implementation | implementation | 8000 |
| `ct-test-writer-bats` | 2 | validation | validation | 8000 |
| `ct-validator` | 2 | validation | validation | 6000 |
| `ct-documentor` | 3 | documentation | implementation | 8000 |
| `ct-docs-lookup` | 3 | documentation | discovery | 6000 |
| `ct-docs-write` | 3 | documentation | implementation | 6000 |
| `ct-docs-review` | 3 | documentation | validation | 6000 |
| `ct-dev-workflow` | 2 | workflow | release | 6000 |
| `ct-skill-creator` | 3 | meta | implementation | 8000 |
| `ct-skill-lookup` | 3 | meta | discovery | 6000 |

---

## 5. Tag Vocabulary

### 5.1 Cross-Cutting Tags

Tags represent implementation characteristics that span multiple categories:

| Tag | Meaning | Skills Using This Tag |
|-----|---------|----------------------|
| `multi-agent` | Spawns/coordinates subagents | `ct-orchestrator` |
| `task-management` | Creates/manages CLEO tasks | `ct-epic-architect`, `ct-task-executor` |
| `research` | Gathers external information | `ct-research-agent` |
| `investigation` | Analyzes existing systems | `ct-research-agent`, `ct-validator` |
| `bash` | Shell scripting focus | `ct-library-implementer-bash` |
| `bats` | BATS testing framework | `ct-test-writer-bats` |
| `git` | Version control operations | `ct-dev-workflow` |
| `context7` | Uses Context7 MCP | `ct-docs-lookup` |
| `style-guide` | Enforces writing standards | `ct-docs-write`, `ct-docs-review` |
| `prompts-chat` | Integrates with prompts.chat | `ct-skill-lookup` |

### 5.2 Tag Usage Patterns

**Orthogonal Tags** (independent):
- `bash` + `implementation` = Shell library creation
- `bats` + `validation` = Shell script testing
- `context7` + `documentation` = Library doc lookup

**Composite Tags** (frequently together):
- `task-management` + `planning` = Epic decomposition
- `git` + `workflow` = Release automation
- `style-guide` + `documentation` = Docs review

---

## 6. Dispatch Matrix Integration

### 6.1 Dispatch Trigger Categories

Dispatch keywords are grouped by intent, mapping user language to skill categories:

| User Intent | Keyword Pattern | Target Category | Primary Skill |
|-------------|----------------|-----------------|---------------|
| **Coordinate** | orchestrate, delegate, multi-agent | coordination | `ct-orchestrator` |
| **Plan** | epic, plan, decompose, architect | planning | `ct-epic-architect` |
| **Discover** | research, investigate, explore | discovery | `ct-research-agent` |
| **Define** | spec, rfc, protocol, contract | specification | `ct-spec-writer` |
| **Build** | implement, build, execute, create | implementation | `ct-task-executor` |
| **Validate** | test, validate, verify, audit | validation | `ct-test-writer-bats`, `ct-validator` |
| **Document** | doc, document, readme, guide | documentation | `ct-documentor` |
| **Release** | commit, release, version, push | workflow | `ct-dev-workflow` |
| **Extend** | skill, create skill, find skill | meta | `ct-skill-creator`, `ct-skill-lookup` |

### 6.2 Enhanced Dispatch Matrix (manifest.json)

Add category-based dispatch:

```json
{
  "dispatch_matrix": {
    "by_category": {
      "coordination": "ct-orchestrator",
      "planning": "ct-epic-architect",
      "discovery": "ct-research-agent",
      "specification": "ct-spec-writer",
      "implementation": "ct-task-executor",
      "validation": "ct-validator",
      "documentation": "ct-documentor",
      "workflow": "ct-dev-workflow",
      "meta": "ct-skill-creator"
    },
    "by_task_type": { ... },
    "by_keyword": { ... }
  }
}
```

### 6.3 Dispatch Priority Order

When multiple dispatch methods match:

1. **Explicit category**: `--category implementation` (highest priority)
2. **Task metadata**: `task.type`, `task.phase`, `task.labels`
3. **Keyword matching**: `by_keyword` patterns
4. **Default fallback**: `ct-task-executor` (generic implementation)

---

## 7. Skill Discovery & Selection

### 7.1 Selection Algorithm

```
Input: Task description, task metadata
Output: Skill name (protocol identifier)

1. Check for explicit category override
   IF --category provided THEN
     RETURN dispatch_matrix.by_category[category]

2. Check task metadata
   IF task.type matches known type THEN
     RETURN dispatch_matrix.by_task_type[task.type]

3. Pattern match keywords
   FOR EACH pattern in dispatch_matrix.by_keyword:
     IF description matches pattern THEN
       RETURN matched skill

4. Default fallback
   RETURN "ct-task-executor"
```

### 7.2 Multi-Skill Tasks

Some tasks require multiple skills in sequence:

**Pattern 1: Orchestrated Workflow**
```
User: "Research and implement auth"
→ Tier 0 (ct-orchestrator)
  ├─→ spawns ct-research-agent for "research auth patterns"
  └─→ spawns ct-task-executor for "implement auth"
```

**Pattern 2: Specialized Pipeline**
```
User: "Write and review docs"
→ Tier 3 (ct-documentor)
  ├─→ invokes ct-docs-write for content creation
  └─→ invokes ct-docs-review for validation
```

---

## 8. Taxonomy Evolution

### 8.1 Adding New Categories

**When to add a new category:**
- ✅ Distinct functional purpose not covered by existing categories
- ✅ Multiple skills would use this category
- ✅ Clear dispatch trigger patterns exist
- ❌ One-off skill (use existing category + unique tags)
- ❌ Minor variation of existing category (refine existing)

**Process:**
1. Update this spec with new category definition
2. Add to `dispatch_matrix.by_category` in manifest.json
3. Update dispatch keywords
4. Add related tags if needed

### 8.2 Adding New Skills

**Taxonomy assignment checklist:**

```
[ ] Determine tier (0-3) based on coordination level
[ ] Assign primary category (coordination, planning, discovery, etc.)
[ ] Add relevant tags (bash, git, context7, etc.)
[ ] Define dispatch keywords (primary + secondary)
[ ] Update dispatch_matrix in manifest.json
[ ] Document protocol relationship in SKILL.md
```

---

## 9. Implementation Roadmap

### Phase 1: Manifest Enhancement (Immediate)
- Add `category` field to each skill in manifest.json
- Add `dispatch_matrix.by_category` section
- Update `tier` field (already exists but verify all skills have it)

### Phase 2: Dispatch Logic (T2436)
- Implement category-based dispatch in `lib/skill-dispatch.sh`
- Add `skill_dispatch_by_category()` function
- Update `skill_auto_dispatch()` to use category logic

### Phase 3: CLI Integration (T2437)
- Add `cleo skills list --category <name>` filter
- Add `cleo skills categories` command (list all categories)
- Add `--category` flag to `cleo orchestrator spawn`

### Phase 4: Documentation (T2438)
- Update skill creation guide with taxonomy reference
- Add category selection guidelines
- Document dispatch priority order

---

## 10. Validation & Testing

### 10.1 Taxonomy Consistency Checks

**Validate manifest.json:**
```bash
# Every skill MUST have tier, category, and tags
jq '.skills[] | select(.tier == null or .category == null or .tags == null)' skills/manifest.json

# Category values must be valid
jq '.skills[].category' skills/manifest.json | sort -u

# Tier must be 0-3
jq '.skills[] | select(.tier < 0 or .tier > 3)' skills/manifest.json
```

### 10.2 Dispatch Testing

**Test category dispatch:**
```bash
# Should return ct-orchestrator
skill_dispatch_by_category "coordination"

# Should return ct-research-agent
skill_auto_dispatch "research auth patterns"

# Should return ct-test-writer-bats
skill_auto_dispatch "write integration tests"
```

---

## 11. Migration Plan

### 11.1 Existing Manifest Updates

Add `category` field to each skill:

```json
{
  "name": "ct-orchestrator",
  "tier": 0,
  "category": "coordination",
  "tags": ["workflow", "multi-agent", "coordination"]
}
```

### 11.2 Backwards Compatibility

- `dispatch_matrix.by_task_type` remains unchanged (existing behavior)
- `dispatch_matrix.by_keyword` remains unchanged (existing behavior)
- New `by_category` dispatch is additive, not breaking

---

## 12. Appendix: Category Deep Dive

### 12.1 Coordination Category

**Purpose**: Orchestrate multi-agent workflows while protecting context

**Skills**: `ct-orchestrator`

**Characteristics**:
- Delegates ALL work to subagents
- Never reads full files (manifest summaries only)
- Enforces ORC-001 through ORC-008 constraints
- Manages session state and context budget

**Dispatch Triggers**: orchestrate, delegate, multi-agent, spawn subagents

---

### 12.2 Planning Category

**Purpose**: Strategic decomposition and architecture

**Skills**: `ct-epic-architect`

**Characteristics**:
- Creates epic and task hierarchies
- Analyzes dependencies and wave planning
- May spawn discovery subagents
- Links research to tasks

**Dispatch Triggers**: epic, plan, decompose, architect, breakdown

---

### 12.3 Discovery Category

**Purpose**: Information gathering and exploration

**Skills**: `ct-research-agent`, `ct-docs-lookup`, `ct-skill-lookup`

**Characteristics**:
- Gathers external information
- No direct system modification
- Outputs: research reports, findings
- May use MCP tools (Context7, web search)

**Dispatch Triggers**: research, investigate, explore, discover, lookup

---

### 12.4 Specification Category

**Purpose**: Formal requirements and protocol definition

**Skills**: `ct-spec-writer`

**Characteristics**:
- RFC 2119 language (MUST, SHOULD, MAY)
- Structured specifications
- Contract-based design
- No implementation

**Dispatch Triggers**: spec, rfc, protocol, contract, requirements

---

### 12.5 Implementation Category

**Purpose**: Code and system creation

**Skills**: `ct-task-executor`, `ct-library-implementer-bash`, `ct-docs-write`, `ct-skill-creator`

**Characteristics**:
- Writes code, configs, scripts, or docs
- Terminal execution (no subagent spawning for Tier 2)
- Concrete deliverables
- May invoke Tier 3 specialized skills

**Dispatch Triggers**: implement, build, execute, create, write

---

### 12.6 Validation Category

**Purpose**: Quality and compliance checking

**Skills**: `ct-validator`, `ct-test-writer-bats`, `ct-docs-review`

**Characteristics**:
- Verifies correctness, compliance, standards
- Outputs: reports, test results, reviews
- No implementation changes (read-only analysis)
- May suggest fixes

**Dispatch Triggers**: validate, verify, test, audit, compliance, review

---

### 12.7 Documentation Category

**Purpose**: User-facing content creation and maintenance

**Skills**: `ct-documentor`, `ct-docs-lookup`, `ct-docs-write`, `ct-docs-review`

**Characteristics**:
- Focus on clarity and user experience
- CLEO writing style guide enforcement
- Anti-duplication (maintain, don't replicate)
- May coordinate multiple doc skills (Tier 3)

**Dispatch Triggers**: doc, document, readme, guide, markdown

---

### 12.8 Workflow Category

**Purpose**: Process automation and release management

**Skills**: `ct-dev-workflow`

**Characteristics**:
- Git operations (commit, tag, push)
- Conventional commits with task traceability
- Release automation (GitHub Actions)
- Version bumping

**Dispatch Triggers**: commit, release, version, push, ship

---

### 12.9 Meta Category

**Purpose**: Skill system self-improvement

**Skills**: `ct-skill-creator`, `ct-skill-lookup`

**Characteristics**:
- Creates or discovers skills
- Extends system capabilities
- Integrates with prompts.chat registry
- Self-referential (improves the skill system itself)

**Dispatch Triggers**: skill, create skill, find skill, extend capabilities

---

## 13. References

- **T2441**: Skills audit findings
- **manifest.json**: Current dispatch matrix and skill metadata
- **cleo-subagent architecture**: Universal agent with protocol injection
- **Orchestrator protocol**: ORC-001 through ORC-008 constraints

---

## 14. Acceptance Criteria

- ✅ Taxonomy defines tier hierarchy (0-3)
- ✅ Taxonomy defines 9 functional categories
- ✅ All 15 current skills mapped to categories
- ✅ Tag vocabulary defined with usage patterns
- ✅ Dispatch matrix integration specified
- ✅ Skill discovery algorithm documented
- ✅ Migration plan for manifest.json updates
- ✅ Validation and testing approach defined
- ✅ Implementation roadmap with task references

---

**Status**: Ready for review and implementation
