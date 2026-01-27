# Skill Loading Mechanism Design

**Task**: T2400
**Epic**: T2392 (CLEO Universal Subagent Architecture)
**Date**: 2026-01-26
**Status**: Complete

---

## 1. Executive Summary

This document defines the skill loading mechanism for cleo-subagent, addressing how skills are discovered, resolved, injected, and managed within context budgets. The design leverages progressive disclosure, orchestrator pre-resolution, and tiered loading strategies to optimize context utilization.

**Key Design Decisions**:
1. Orchestrator resolves ALL references before spawn (subagents cannot resolve @tokens)
2. Three loading strategies: minimal, standard, comprehensive
3. Skills injected via agent frontmatter OR Task prompt (not both)
4. Manifest-based metadata registry enables O(1) skill lookup
5. Token budget enforced at spawn time with priority-based truncation

---

## 2. Architecture Overview

### 2.1 Skill Loading Flow

```
ORCHESTRATOR CONTEXT                    SUBAGENT CONTEXT
┌─────────────────────┐                ┌─────────────────────┐
│ 1. Task Analysis    │                │                     │
│    ↓                │                │                     │
│ 2. Skill Selection  │   Task Tool   │ 4. Skill Content    │
│    ↓                │ ────────────> │    Injected         │
│ 3. Token Resolution │                │    ↓                │
│    ↓                │                │ 5. Execute Work     │
│ (Pre-resolved       │                │    ↓                │
│  payload)           │                │ 6. Return Output    │
└─────────────────────┘                └─────────────────────┘
```

### 2.2 Core Principles

| Principle | Rationale |
|-----------|-----------|
| **Orchestrator resolves** | Subagents cannot parse @ references or read skill files |
| **Pre-computation over runtime** | Minimize subagent bootstrap overhead |
| **Budget-aware selection** | Prevent context overflow at spawn time |
| **Progressive disclosure** | Load detail levels only when needed |

---

## 3. Loading Strategy Selection

### 3.1 Strategy Definitions

| Strategy | Content Loaded | Token Budget | Use When |
|----------|----------------|--------------|----------|
| **Minimal** | Frontmatter + first 50 lines | ~500 tokens | Simple tasks, tight context |
| **Standard** | Full SKILL.md | ~2-5K tokens | Most tasks (default) |
| **Comprehensive** | SKILL.md + references/ | ~5-15K tokens | Complex multi-step tasks |

### 3.2 Strategy Selection Algorithm

```
function select_loading_strategy(task, available_context):
    # Calculate available budget
    remaining = available_context - PROTOCOL_OVERHEAD - TASK_CONTEXT

    # Count required skills
    skill_count = count_required_skills(task)
    budget_per_skill = remaining / skill_count

    if budget_per_skill < 800:
        return MINIMAL
    elif budget_per_skill < 3000:
        return STANDARD
    elif task.complexity == "high" OR task.type == "epic":
        return COMPREHENSIVE
    else:
        return STANDARD
```

### 3.3 Strategy Selection Triggers

| Trigger | Strategy | Rationale |
|---------|----------|-----------|
| `task.labels` contains "simple" | Minimal | User-indicated simplicity |
| `task.size == "small"` | Minimal | Small scope needs less context |
| `task.type == "epic"` | Comprehensive | Epics need full planning context |
| `task.depends.length > 3` | Comprehensive | Multi-dependency tasks are complex |
| Context usage > 70% | Minimal | Preserve remaining context |
| Default | Standard | Balanced approach |

---

## 4. Injection Points

### 4.1 Two Injection Methods

**Method A: Agent Definition (Static)**
```yaml
---
name: cleo-research-subagent
skills:
  - ct-research-agent    # Full content injected at spawn
  - ct-task-executor     # Full content injected at spawn
---
```

**Method B: Task Prompt (Dynamic)**
```markdown
## Skill Context

### ct-research-agent (v1.0.0)
{resolved skill content here}
```

### 4.2 Method Selection Rules

| Scenario | Use Method | Rationale |
|----------|------------|-----------|
| Skill always needed for agent type | A (frontmatter) | Consistent context |
| Skill varies by task | B (prompt) | Dynamic selection |
| Multiple skills with priority | B (prompt) | Order control |
| Skill content exceeds budget | B (prompt) | Allows truncation |

### 4.3 Anti-Pattern: Mixed Injection

**MUST NOT** use both methods for the same skill:
- Causes duplicate content in context
- Wastes token budget
- Creates inconsistent behavior

**Recommended Pattern**:
- Define agent with NO skills in frontmatter
- Inject all skills via Task prompt
- Maintains full orchestrator control

---

## 5. On-Demand Loading Triggers

### 5.1 Trigger Types

Since subagents cannot load @ references dynamically, "on-demand" loading is orchestrator-initiated:

| Trigger | Detection | Action |
|---------|-----------|--------|
| **Explicit request** | Subagent returns "need skill: X" | Orchestrator re-spawns with skill |
| **Task failure** | Exit code indicates missing context | Orchestrator retries with more skills |
| **Reference request** | Output contains unresolved @reference | Orchestrator resolves and provides |

### 5.2 Reference File Access Pattern

When subagents need supporting files (scripts/, references/):

```
1. Subagent uses Read tool to access skill file
2. Path resolved via ${CLAUDE_PLUGIN_ROOT} or absolute path
3. File content loaded into subagent context
4. No orchestrator involvement needed
```

**Path Resolution for Subagents**:
```bash
# Orchestrator injects paths before spawn
SKILL_ROOT="/path/to/skills/ct-research-agent"

# Subagent can then read:
Read("${SKILL_ROOT}/references/REFERENCE.md")
```

### 5.3 Cache Warming Pattern

Orchestrator pre-loads likely-needed skills before spawning:

```python
def warm_cache_for_epic(epic_id: str) -> list[str]:
    """Pre-resolve skills needed for epic's tasks."""
    tasks = cleo_list_children(epic_id)
    skill_names = set()

    for task in tasks:
        skill = skill_select_for_task(task)
        skill_names.add(skill)

    # Pre-read and cache skill contents
    for skill in skill_names:
        skill_cache[skill] = read_skill_content(skill, STANDARD)

    return list(skill_names)
```

---

## 6. Context Budget Management

### 6.1 Token Budget Allocation

| Component | Budget | Notes |
|-----------|--------|-------|
| Protocol injection | 2,000 tokens | Fixed overhead |
| Task context | 2,000 tokens | From orchestrator |
| Skill content | 15,000 tokens | All skills combined |
| Working space | 81,000 tokens | Remaining context |
| **Total** | 100,000 tokens | Subagent limit |

### 6.2 Priority Ordering

When skills exceed budget, truncate in priority order:

| Priority | Category | Action |
|----------|----------|--------|
| 1 (highest) | Protocol base | Never truncate |
| 2 | Primary skill | Truncate to essential sections |
| 3 | Supporting skills | Load metadata only |
| 4 (lowest) | Reference files | Omit entirely |

### 6.3 Truncation Strategies

**Section-Based Truncation** (for SKILL.md):
```
1. Keep: Frontmatter, ## Summary, ## Core Rules
2. Truncate: ## Examples (keep 1), ## References (omit)
3. Remove: ## Appendix, detailed examples
```

**Line-Based Truncation** (fallback):
```python
def truncate_skill(content: str, max_tokens: int) -> str:
    lines = content.split('\n')
    result = []
    tokens = 0

    for line in lines:
        line_tokens = estimate_tokens(line)
        if tokens + line_tokens > max_tokens:
            result.append("... [truncated for context budget]")
            break
        result.append(line)
        tokens += line_tokens

    return '\n'.join(result)
```

### 6.4 Budget Validation at Spawn

```python
def validate_spawn_budget(
    skills: list[str],
    task_context: str,
    protocol: str
) -> tuple[bool, str]:
    """Validate spawn will fit in context budget."""

    total = 0
    total += estimate_tokens(protocol)
    total += estimate_tokens(task_context)

    for skill in skills:
        content = get_skill_content(skill)
        total += estimate_tokens(content)

    if total > SUBAGENT_CONTEXT_LIMIT * 0.7:
        return False, f"Budget exceeded: {total} tokens (limit: {SUBAGENT_CONTEXT_LIMIT * 0.7})"

    return True, f"Budget OK: {total} tokens"
```

---

## 7. Orchestrator Integration

### 7.1 Pre-Spawn Resolution Pipeline

```
1. Task Analysis
   ├── Read task from CLEO
   ├── Extract labels, type, description
   └── Identify required skills

2. Skill Resolution
   ├── Select skills via manifest dispatch
   ├── Validate skill availability
   └── Check compatibility with model

3. Token Resolution
   ├── Read SKILL.md content
   ├── Resolve @ references to inline content
   ├── Substitute {{TOKEN}} placeholders
   └── Resolve !`command` dynamic content

4. Budget Validation
   ├── Calculate total token usage
   ├── Apply truncation if needed
   └── Fail if still over budget

5. Payload Assembly
   ├── Protocol injection
   ├── Resolved skill content
   ├── Task context
   └── Output requirements
```

### 7.2 Token Resolution Types

| Token Type | Resolution | Example |
|------------|------------|---------|
| `@file.md` | Read and inline | `@docs/spec.md` -> file content |
| `@dir/*.md` | Glob, read, concat | `@skills/ct-*/*.md` |
| `{{VAR}}` | Substitute value | `{{TASK_ID}}` -> "T2400" |
| `${ENV}` | Environment variable | `${CLEO_ROOT}` -> ".cleo/" |
| `!`cmd`` | Execute and inline | `!`date`` -> "2026-01-26" |

### 7.3 Error Handling

| Error | Detection | Recovery |
|-------|-----------|----------|
| Skill not found | Manifest lookup fails | Use fallback skill (ct-task-executor) |
| Token unresolved | `{{.*}}` remains in output | Log warning, proceed with literal |
| Budget exceeded | Validation fails | Reduce strategy tier, retry |
| Reference unreadable | File read error | Skip reference, log warning |

### 7.4 Spawn Function Signature

```bash
# orchestrator_spawn_subagent
#
# Arguments:
#   $1 - task_id: CLEO task ID (e.g., "T2400")
#   $2 - skill_names: Comma-separated skill list (e.g., "ct-research-agent,ct-task-executor")
#   $3 - loading_strategy: "minimal" | "standard" | "comprehensive"
#   $4 - output_format: Output requirements for subagent
#
# Returns:
#   0 - Success, prompt written to stdout
#   4 - Task not found
#   6 - Skill validation failed
#   10 - Budget exceeded after truncation
#
# Example:
#   orchestrator_spawn_subagent "T2400" "ct-research-agent" "standard" "manifest+file"

function orchestrator_spawn_subagent() {
    local task_id="$1"
    local skill_names="$2"
    local strategy="${3:-standard}"
    local output_format="${4:-manifest+file}"

    # Resolution pipeline
    local task_json
    task_json=$(cleo show "$task_id" --format json) || return 4

    local resolved_skills=""
    for skill in ${skill_names//,/ }; do
        local content
        content=$(skill_load_content "$skill" "$strategy") || return 6
        resolved_skills+="$content\n\n"
    done

    # Budget validation
    local total_tokens
    total_tokens=$(estimate_tokens "$resolved_skills")
    if [[ $total_tokens -gt $MAX_SKILL_BUDGET ]]; then
        return 10
    fi

    # Assemble and output
    assemble_spawn_payload "$task_json" "$resolved_skills" "$output_format"
}
```

---

## 8. Skill Content Structure

### 8.1 Manifest-Based Metadata Registry

The `skills/manifest.json` provides O(1) lookup for skill metadata:

```json
{
  "skills": [
    {
      "name": "ct-research-agent",
      "version": "1.0.0",
      "description": "Research and investigation agent...",
      "path": "skills/ct-research-agent",
      "token_budget": 8000,
      "tier": 2,
      "references": [
        "skills/ct-research-agent/SKILL.md"
      ],
      "capabilities": {
        "inputs": ["TASK_ID", "TOPIC", ...],
        "outputs": ["research-file", "manifest-entry"],
        "dispatch_triggers": ["research", "investigate", ...]
      }
    }
  ]
}
```

### 8.2 Skill File Organization

```
skills/ct-research-agent/
├── SKILL.md              # Main instructions (L1)
├── references/           # Supporting docs (L2)
│   ├── REFERENCE.md
│   └── examples.md
└── scripts/              # Executable code (L2)
    └── search.sh
```

### 8.3 Progressive Disclosure Levels

| Level | Content | When Loaded | Token Cost |
|-------|---------|-------------|------------|
| L0 | Manifest entry only | Always (orchestrator) | ~100 tokens |
| L1 | Full SKILL.md | On skill selection | ~2-5K tokens |
| L2 | References + scripts | On-demand via Read | Variable |

---

## 9. Implementation Guidance

### 9.1 Minimum Viable Implementation

```bash
# lib/skill-loading.sh

# Load skill content at specified strategy level
function skill_load_content() {
    local skill_name="$1"
    local strategy="${2:-standard}"

    local skill_path
    skill_path=$(skill_get_path "$skill_name") || return 1

    local skill_md="${skill_path}/SKILL.md"
    [[ -f "$skill_md" ]] || return 1

    case "$strategy" in
        minimal)
            # Frontmatter + first 50 lines
            head -n 50 "$skill_md"
            ;;
        standard)
            # Full SKILL.md
            cat "$skill_md"
            ;;
        comprehensive)
            # SKILL.md + all references
            cat "$skill_md"
            for ref in "$skill_path"/references/*.md; do
                [[ -f "$ref" ]] && cat "$ref"
            done
            ;;
    esac
}
```

### 9.2 Integration with Existing Infrastructure

| Component | Integration Point |
|-----------|-------------------|
| `lib/skill-dispatch.sh` | Add `skill_load_content()` |
| `lib/token-inject.sh` | Add strategy-aware loading |
| `lib/orchestrator-spawn.sh` | Use new loading functions |
| `skills/manifest.json` | Add `token_budget` field |

### 9.3 Testing Requirements

| Test | Purpose |
|------|---------|
| Unit: `skill_load_content()` | Verify strategy loading |
| Unit: Token estimation | Verify budget calculations |
| Integration: Spawn pipeline | End-to-end resolution |
| Golden: Output format | Verify payload structure |

---

## 10. References

- T2394: Claude Code Skill Loading Research
- T2397: Skill Caching Patterns Research
- T2398: CLEO Subagent Protocol Specification v1
- Agent Skills Specification: https://agentskills.io
- CLEO Skills Manifest: `skills/manifest.json`

---

## Appendix A: Decision Log

| Decision | Alternative Considered | Rationale |
|----------|----------------------|-----------|
| Orchestrator resolves all | Subagent dynamic loading | Subagents cannot parse @ references |
| Three strategies (min/std/comp) | Binary (full/partial) | Granularity for context optimization |
| Prompt injection preferred | Frontmatter injection | Orchestrator maintains control |
| Manifest for metadata | Parse SKILL.md frontmatter | O(1) lookup, single source of truth |
| Priority-based truncation | FIFO truncation | Preserves most important content |

## Appendix B: Token Estimation Reference

| Content Type | Approximate Tokens |
|--------------|-------------------|
| 100 characters | ~25 tokens |
| 1 KB text | ~250 tokens |
| Average SKILL.md | ~2,000 tokens |
| Manifest entry | ~100 tokens |
| Protocol base | ~2,000 tokens |
