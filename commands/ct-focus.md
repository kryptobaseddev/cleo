---
description: Show or set task focus
allowed_tools:
  - Bash(cleo:*)
argument_hint: "[task-id]"
---

# CLEO Focus Management

Manage single-task workflow discipline with focus commands.

## Usage Modes

### Mode 1: Show Current Focus (no arguments)

Display currently focused task:

```bash
cleo focus show
```

Show full task details:

```bash
FOCUSED=$(cleo focus show -q)
if [[ -n "$FOCUSED" ]]; then
  cleo show $FOCUSED
else
  echo "No task currently focused"
fi
```

### Mode 2: Set Focus (with task ID argument)

When user provides a task ID (e.g., `/ct-focus T042`):

1. **Validate task exists:**
```bash
cleo exists T042 --quiet
```

2. **Set focus:**
```bash
cleo focus set T042
```

3. **Display focused task:**
```bash
cleo show T042
```

4. **Show related context:**
```bash
# Show dependencies
cleo deps T042

# Show parent/children if hierarchical
cleo show T042 --related
```

## Focus Discipline

**One Active Task Rule**: CLEO enforces single-task focus per session scope.
- Setting focus automatically unfocuses other tasks
- Prevents context switching and multitasking
- Aligns with "Always Be Shipping" philosophy

## Success Criteria

Focus is properly set when:
- `cleo focus show` returns the target task ID
- Task details are displayed
- Dependencies are clear
- Next actions are identified

## Tips

- Use `/ct-next` to get smart task suggestions
- Check `cleo analyze` for task prioritization
- Update task progress with `cleo focus note "progress"`
