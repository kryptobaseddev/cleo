---
name: ct-epic-architect
description: Epic planning and task decomposition for breaking down large initiatives into atomic, executable tasks. Provides dependency analysis, wave-based parallel execution planning, hierarchy management, and research linking. Use when creating epics, decomposing initiatives into task trees, planning parallel workflows, or analyzing task dependencies. Triggers on epic creation, task decomposition requests, or planning phase work.
version: 3.0.0
tier: 1
core: false
category: recommended
protocol: decomposition
dependencies: []
sharedResources:
  - subagent-protocol-base
  - task-system-integration
compatibility:
  - claude-code
  - cursor
  - windsurf
  - gemini-cli
license: MIT
---

# Epic Architect Context Injection

**Protocol**: @protocols/decomposition.md
**Type**: Context Injection (cleo-subagent)
**Version**: 3.0.0

---

## Purpose

Context injection for epic planning and task decomposition tasks spawned via cleo-subagent. Provides domain expertise for breaking down large initiatives into atomic, executable tasks.

---

## Capabilities

1. **Epic Creation** - Parent epic with full metadata and file attachments
2. **Task Decomposition** - Atomic tasks with acceptance criteria
3. **Dependency Analysis** - Wave-based parallel execution planning
4. **Research Linking** - Connect research outputs to tasks
5. **HITL Clarification** - Ask when requirements are ambiguous

---

## Task System Integration

@skills/_shared/task-system-integration.md

### Execution Sequence

1. Read task: `cleo show {{TASK_ID}}`
2. Start task: `cleo start {{TASK_ID}}`
3. Check existing work: `cleo find "keyword"`, `cleo list --type epic`
4. Create epic and child tasks
5. Attach files and link research
6. Start session: `cleo session start --scope epic:{{EPIC_ID}} --auto-start`
7. Complete task: `cleo complete {{TASK_ID}}`

---

## Requirements Analysis

**MUST check for related work BEFORE creating:**

```bash
cleo find "auth" --status pending       # Related tasks
cleo list --type epic --status pending  # Existing epics
cleo phase show                         # Current phase
cleo list --tree --parent T001          # Hierarchy view
```

---

## Epic Structure

```
Epic (type: epic, size: large)
├── Task 1 (no deps)           [Wave 0]
├── Task 2 (depends: T1)       [Wave 1]
├── Task 3 (depends: T1)       [Wave 1]  ← Parallel
├── Task 4 (depends: T2,T3)    [Wave 2]  ← Convergence
└── Task 5 (depends: T4)       [Wave 3]
```

### Size Guidelines (NOT Time)

| Type | Size | Scope |
|------|------|-------|
| Epic | large | 8+ files, multiple features |
| Task | medium | 3-7 files, single feature |
| Subtask | small | 1-2 files, single function |

---

## Epic Creation

### Create Epic with File Attachments

```bash
cleo add "Auth System Implementation" \
  --type epic --size large --priority high --phase core \
  --labels "feature,auth,v1.0" \
  --description "Complete authentication with JWT and session management" \
  --acceptance "All child tasks completed" \
  --acceptance "Integration tests pass" \
  --files "docs/auth-spec.md,docs/api-design.md" \
  --notes "Initial planning: JWT chosen for stateless API support"
```

### Create Tasks with Dependencies

```bash
# Wave 0: No dependencies
cleo add "Create auth schema" \
  --type task --size medium --priority high \
  --parent T001 --phase setup \
  --description "Define user, session, and token tables" \
  --acceptance "Schema validates against requirements" \
  --files "src/db/schema.ts"

# Wave 1: Depends on Wave 0
cleo add "Implement JWT middleware" \
  --type task --size medium --priority high \
  --parent T001 --phase core --depends T002 \
  --description "Token generation, validation, refresh" \
  --acceptance "All token operations tested"

# Wave 2: Convergence
cleo add "Integration tests" \
  --type task --size medium --priority high \
  --parent T001 --phase testing --depends T003,T004 \
  --acceptance "E2E auth flow tests pass"
```

### Link Research to Tasks

```bash
# Link existing research output to task
cleo research link T001 research-auth-patterns-20260126

# View linked research
cleo show T001  # Shows .linkedResearch array
```

---

## File Attachment Patterns

### When to Use --files vs Research Link

| Method | Use Case | Storage |
|--------|----------|---------|
| `--files` | Input context (specs, designs, code) | Task `.files` array |
| `research link` | Output artifacts (research findings) | Task `.linkedResearch` array |

### Attach Files During Creation

```bash
cleo add "Implement auth" --files "spec.md,design.md"
```

### Append Files to Existing Task

```bash
cleo update T001 --files "additional-context.md"
```

---

## Hierarchy Constraints

| Constraint | Value | Enforcement |
|------------|-------|-------------|
| Max depth | 3 | epic (0) → task (1) → subtask (2) |
| Max active siblings | 8 (default) | `hierarchy.maxActiveSiblings` |
| Max siblings | unlimited (default) | `hierarchy.maxSiblings=0` |
| Parent must exist | Validated | `cleo exists {{PARENT_ID}}` |

**Validation Before Creation:**

```bash
cleo exists T001 --quiet || echo "ERROR: Parent not found"
cleo list --parent T001 --status pending,active | jq '.tasks | length'
```

---

## Wave Planning

| Wave | Description | Execution |
|------|-------------|-----------|
| Wave 0 | No dependencies | Start immediately |
| Wave 1 | Depends on Wave 0 | Parallel within wave |
| Wave N | Depends on prior waves | Convergence points |

### Dependency Rules

1. No circular dependencies (A→B→C→A invalid)
2. Wave siblings are independent (no cross-dependencies)
3. Convergence depends on ALL branches

---

## Phase Assignment

| Phase | Purpose |
|-------|---------|
| `setup` | Schema, config, structure |
| `core` | Features, components |
| `testing` | Tests, validation |
| `polish` | Docs, optimization |
| `maintenance` | Fixes, updates |

```bash
cleo phase show                              # Current phase
cleo list --phase $(cleo phase show -q)      # Tasks in phase
```

---

## HITL Clarification

**Ask when:**
- Requirements ambiguous
- Multiple valid approaches
- Missing context
- Scope unclear

**Template:**
```
Before proceeding, I need clarification:
1. [Question about scope]
2. [Question about constraints]

Options:
A. [Option with trade-offs]
B. [Option with trade-offs]

Recommendation: [Your recommendation]
```

---

## Subagent Protocol

@skills/_shared/subagent-protocol-base.md

### Output Requirements

1. MUST write decomposition to: `{{OUTPUT_DIR}}/{{DATE}}_{{TOPIC_SLUG}}.md`
2. MUST append ONE line to: `{{MANIFEST_PATH}}`
3. MUST return ONLY: "Decomposition complete. See MANIFEST.jsonl for summary."
4. MUST NOT return full decomposition in response

---

## Extended References

| Reference | Content |
|-----------|---------|
| [patterns.md](references/patterns.md) | Research, Bug, Brownfield, Refactor patterns |
| [commands.md](references/commands.md) | Complete CLEO command reference |
| [shell-escaping.md](references/shell-escaping.md) | Escape `$` as `\$` in notes |
| [feature-epic-example.md](references/feature-epic-example.md) | Greenfield feature |
| [refactor-epic-example.md](references/refactor-epic-example.md) | Brownfield modernization |

---

## Anti-Patterns

| Anti-Pattern | Solution |
|--------------|----------|
| Too large tasks | Atomic (one agent session) |
| Missing Wave 0 | At least one no-dependency task |
| Circular deps | Analyze data flow |
| Depth > 3 | Flatten hierarchy |
| Missing acceptance | Add `--acceptance` |
| Time estimates | Use size only |

---

## Completion Checklist

- [ ] Checked existing work (`cleo find`, `cleo list --type epic`)
- [ ] Phase verified (`cleo phase show`)
- [ ] Epic created with priority, phase, acceptance
- [ ] Tasks with dependencies, no circular deps
- [ ] Wave 0 exists (at least one no-deps task)
- [ ] Hierarchy: depth ≤ 3, siblings ≤ 8 active
- [ ] Files attached where relevant
- [ ] Session started scoped to epic

---

## Error Handling

| Exit | Meaning | Fix |
|------|---------|-----|
| 4 | Not found | `cleo find` to verify |
| 10 | Parent missing | `cleo exists {{ID}}` |
| 11 | Depth exceeded | Flatten (epic→task→subtask max) |
| 12 | Sibling limit | Split to different parent |
| 6 | Validation | Escape `$` as `\$`, check fields |

**Shell Escaping**: Always `\$` in `--notes`/`--description`. See [shell-escaping.md](references/shell-escaping.md).
