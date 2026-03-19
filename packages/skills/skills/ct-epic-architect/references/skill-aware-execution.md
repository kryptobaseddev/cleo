# Skill-Aware Epic Execution Patterns

This reference documents how to integrate the ct-epic-architect skill with orchestrators, subagents, and CLEO research commands.

---

## Orchestrator Workflow

### When to Invoke ct-epic-architect

Use the ct-epic-architect skill when the user's request involves:

| Trigger | Example Request | Action |
|---------|-----------------|--------|
| Epic creation | "Create an epic for user authentication" | Invoke `/ct-epic-architect` |
| Task decomposition | "Break down this project into tasks" | Invoke `/ct-epic-architect` |
| Dependency planning | "Plan the dependency order for this feature" | Invoke `/ct-epic-architect` |
| Wave analysis | "What can run in parallel?" | Invoke `/ct-epic-architect` |
| Sprint planning | "Plan the sprint backlog" | Invoke `/ct-epic-architect` |

### How to Invoke

```
# Via Skill tool
Skill(skill="ct-epic-architect")

# Via slash command
/ct-epic-architect
```

**What Loads:**
1. SKILL.md body (480 lines of core instructions)
2. Access to references/ files (loaded on-demand when Claude reads them)

### Decision Tree

```
User Request
    │
    ▼
┌───────────────────────────────┐
│ Is this about epic/task       │
│ planning and decomposition?   │
└───────────────────────────────┘
    │
    ├── YES ─► Invoke /ct-epic-architect
    │
    └── NO ─► Handle directly or use other skill
```

---

## Subagent Skill Specification

### Why Subagents Don't Inherit Skills

Per the skill system architecture:
- **Skills are session-scoped** - They load into the CURRENT context
- **Subagents are NEW contexts** - They don't automatically get parent skills
- **This is intentional** - Prevents context bloat and skill pollution

### When Subagents SHOULD Have ct-epic-architect

| Scenario | Should Have Skill? | Rationale |
|----------|-------------------|-----------|
| Coder implementing a task | No | Coders execute, not plan |
| Researcher gathering info | No | Researchers investigate, not plan |
| Nested orchestrator | Yes | Needs planning capability |
| Epic architect subagent | Yes | Primary function requires it |

### Declaring Skills for Subagents

When spawning a subagent that needs ct-epic-architect:

```markdown
# In subagent prompt frontmatter (if using template)
---
name: nested-orchestrator
skills:
  - ct-epic-architect
  - orchestrator
---
```

Or via Task tool:

```
Task(
  subagent_type="general-purpose",
  prompt="""
  You have access to the ct-epic-architect skill.
  Use /ct-epic-architect when you need to create epics.

  [Task description]
  """
)
```

---

## CLEO Research Integration

### Epic-Architect Uses Research Commands

Before creating epics, ct-epic-architect SHOULD check existing research:

```bash
# Check for related research before planning
{{TASK_RESEARCH_LIST_CMD}} --status complete --topic {{DOMAIN}}
{{TASK_RESEARCH_SHOW_CMD}} {{RESEARCH_ID}}

# Link epic to research after creation
{{TASK_LINK_CMD}} {{EPIC_ID}} {{RESEARCH_ID}}
```

### Research Output Protocol for Epic Creation

When ct-epic-architect creates an epic, it follows the subagent protocol:

1. **Write output file**: `{{OUTPUT_DIR}}/{{DATE}}_epic-{{FEATURE_SLUG}}.md`
2. **Append manifest entry**: Single line JSON to `{{MANIFEST_PATH}}`
3. **Return summary only**: "Epic created. See MANIFEST.jsonl for summary."

### Querying Prior Research

Epic-architect can leverage prior research for informed planning:

```bash
# Find research related to the epic domain
{{TASK_RESEARCH_LIST_CMD}} --topic "authentication"

# Get key findings from specific research
{{TASK_RESEARCH_SHOW_CMD}} research-auth-options-2026-01-15

# The key_findings array informs epic structure without loading full content
```

---

## Integration with Orchestrator Skill

### Orchestrator → Epic-Architect Flow

```
Orchestrator receives "plan authentication feature"
    │
    ▼
Orchestrator spawns ct-epic-architect subagent
    │
    ▼
Epic-architect creates epic and tasks in CLEO
    │
    ▼
Epic-architect writes to manifest
    │
    ▼
Orchestrator reads manifest key_findings
    │
    ▼
Orchestrator proceeds with task execution
```

### Context Protection

The orchestrator skill enforces context budget (ORC-005). When spawning ct-epic-architect:

1. **Pass minimal context** - Epic-architect reads full task details itself
2. **Receive minimal response** - Only manifest summary returned
3. **Query manifest for details** - Don't ask ct-epic-architect for full breakdown

```bash
# Orchestrator queries manifest for epic details
tail -1 {{MANIFEST_PATH}} | jq '.key_findings'
```

---

## Anti-Patterns

| Anti-Pattern | Problem | Solution |
|--------------|---------|----------|
| Giving all subagents ct-epic-architect skill | Context bloat | Only nested orchestrators need it |
| Returning full epic details | Bloats orchestrator context | Return "Epic created. See MANIFEST." |
| Skipping research check | Duplicate work | Always query research first |
| Loading all references | Wasted tokens | Load only needed references |
| Parallel epic creation | Task conflicts | Create epics sequentially |

---

## Cross-References

- **Orchestrator Skill**: skills/ct-orchestrator/SKILL.md
- **Subagent Protocol**: skills/_shared/subagent-protocol-base.md
- **Task System Integration**: skills/_shared/task-system-integration.md
- **Research Commands**: docs/commands/research.md
