# Epic Architect Commands Reference

Complete reference of task system commands for epic creation and management.

---

## Core Task Commands

```bash
# Create epic
{{TASK_ADD_CMD}} "Epic Title" --type epic --size large --priority high --phase core \
  --labels "feature,auth" --description "..." --acceptance "..."

# Create tasks under epic
{{TASK_ADD_CMD}} "Task Title" --type task --parent {{EPIC_ID}} --depends {{DEP_IDS}} \
  --priority medium --phase core --description "..." --acceptance "..."
```

---

## Session Lifecycle

```bash
# Start session scoped to epic
{{TASK_SESSION_START_CMD}} --scope epic:{{EPIC_ID}} --name "Epic Development" --agent ct-epic-architect --auto-focus

# Suspend session (waiting for external dependency)
{{TASK_SESSION_SUSPEND_CMD}} --note "Waiting for external dependency"

# Resume session
{{TASK_SESSION_RESUME_CMD}} {{SESSION_ID}}

# End session (work complete for now)
{{TASK_SESSION_END_CMD}} --note "Epic completed"

# Close session permanently (all tasks must be done)
{{TASK_SESSION_CLOSE_CMD}} {{SESSION_ID}}

# List active sessions
{{TASK_SESSION_LIST_CMD}} --status active
```

---

## Focus Lifecycle

```bash
# Set focus on task
{{TASK_FOCUS_CMD}} {{TASK_ID}}

# Show current focus
{{TASK_FOCUS_SHOW_CMD}}

# Add session progress note
{{TASK_FOCUS_NOTE_CMD}} "Progress: ..."

# Clear focus
{{TASK_FOCUS_CLEAR_CMD}}
```

---

## Verification Gates Workflow

After task completion, verification gates track quality:

```bash
# When coder completes implementation
{{TASK_COMPLETE_CMD}} {{TASK_ID}}              # Auto-sets gates.implemented

# After testing passes
{{TASK_VERIFY_CMD}} {{TASK_ID}} --gate testsPassed

# After QA review
{{TASK_VERIFY_CMD}} {{TASK_ID}} --gate qaPassed

# After security scan
{{TASK_VERIFY_CMD}} {{TASK_ID}} --gate securityPassed

# After documentation
{{TASK_VERIFY_CMD}} {{TASK_ID}} --gate documented

# After cleanup/tech debt addressed (optional, excluded from required by default)
{{TASK_VERIFY_CMD}} {{TASK_ID}} --gate cleanupDone

# Set all required gates at once
{{TASK_VERIFY_CMD}} {{TASK_ID}} --all
```

**Verification Gates Reference:**
| Gate | Purpose | Auto-set |
|------|---------|----------|
| `implemented` | Code complete | Yes (on `complete`) |
| `testsPassed` | Tests pass | No |
| `qaPassed` | QA review done | No |
| `securityPassed` | Security scan clear | No |
| `documented` | Documentation complete | No |
| `cleanupDone` | Cleanup/tech debt addressed | No (optional) |

**Epic Lifecycle States** (available in schema 2.6.1+):
- States: `backlog` -> `planning` -> `active` -> `review` -> `released` -> `archived`
- Use `--epic-lifecycle` flag when creating/updating epics with `type: epic`
- Example: `{{TASK_ADD_CMD}} "Epic Title" --type epic --epic-lifecycle planning`

---

## Query Commands

```bash
# Find related work
{{TASK_FIND_CMD}} "{{KEYWORDS}}" --status pending

# Link research to epic
{{TASK_LINK_CMD}} {{EPIC_ID}} {{RESEARCH_ID}}

# Verify existence before operations
{{TASK_EXISTS_CMD}} {{ID}} --quiet

# Check phase context
{{TASK_PHASE_CMD}}

# Task triage and planning
{{TASK_ANALYZE_CMD}}                     # Task triage with leverage scoring
{{TASK_ANALYZE_CMD}} --parent {{EPIC_ID}}  # Analyze specific epic's tasks

# Visualize hierarchy
cleo list --tree --parent {{EPIC_ID}}      # Show epic subtree

# Archive completed work
{{TASK_ARCHIVE_CMD}}                     # Archive all completed tasks (done status)
{{TASK_ARCHIVE_CMD}} --include-epic      # Include completed epics
```

---

## Token Reference

### Task Lifecycle Tokens (CLEO defaults)

| Token | CLEO Default |
|-------|--------------|
| `{{TASK_SHOW_CMD}}` | `cleo show` |
| `{{TASK_FOCUS_CMD}}` | `cleo focus set` |
| `{{TASK_COMPLETE_CMD}}` | `cleo complete` |
| `{{TASK_LINK_CMD}}` | `cleo research link` |
| `{{TASK_LIST_CMD}}` | `cleo list` |
| `{{TASK_FIND_CMD}}` | `cleo find` |
| `{{TASK_ADD_CMD}}` | `cleo add` |

### Epic-Specific Tokens

| Token | CLEO Default |
|-------|--------------|
| `{{TASK_EXISTS_CMD}}` | `cleo exists` |
| `{{TASK_PHASE_CMD}}` | `cleo phase show` |
| `{{TASK_TREE_CMD}}` | `cleo list --tree` |
| `{{TASK_ANALYZE_CMD}}` | `cleo analyze` |
| `{{TASK_ARCHIVE_CMD}}` | `cleo archive` |
| `{{TASK_VALIDATE_CMD}}` | `cleo validate` |

### Session Tokens

| Token | CLEO Default |
|-------|--------------|
| `{{TASK_SESSION_START_CMD}}` | `cleo session start` |
| `{{TASK_SESSION_END_CMD}}` | `cleo session end` |
| `{{TASK_SESSION_SUSPEND_CMD}}` | `cleo session suspend` |
| `{{TASK_SESSION_RESUME_CMD}}` | `cleo session resume` |
| `{{TASK_SESSION_CLOSE_CMD}}` | `cleo session close` |
| `{{TASK_SESSION_LIST_CMD}}` | `cleo session list` |

### Focus Tokens

| Token | CLEO Default |
|-------|--------------|
| `{{TASK_FOCUS_SHOW_CMD}}` | `cleo focus show` |
| `{{TASK_FOCUS_NOTE_CMD}}` | `cleo focus note` |
| `{{TASK_FOCUS_CLEAR_CMD}}` | `cleo focus clear` |

### Verification Tokens

| Token | CLEO Default |
|-------|--------------|
| `{{TASK_VERIFY_CMD}}` | `cleo verify` |

### Research Tokens

| Token | CLEO Default |
|-------|--------------|
| `{{TASK_RESEARCH_INIT_CMD}}` | `cleo research init` |
| `{{TASK_RESEARCH_LIST_CMD}}` | `cleo research list` |
| `{{TASK_RESEARCH_SHOW_CMD}}` | `cleo research show` |
| `{{TASK_RESEARCH_PENDING_CMD}}` | `cleo research pending` |
| `{{TASK_RESEARCH_INJECT_CMD}}` | `cleo research inject` |

### Output Tokens

| Token | Default |
|-------|---------|
| `{{OUTPUT_DIR}}` | `claudedocs/agent-outputs` |
| `{{MANIFEST_PATH}}` | `{{OUTPUT_DIR}}/MANIFEST.jsonl` |
