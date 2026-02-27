---
description: Get intelligent next task suggestion
allowed_tools:
  - Bash(cleo:*)
argument_hint: "[--auto-focus]"
---

# CLEO Next Task Suggestion

Get intelligent task recommendations based on priority, dependencies, and project phase.

## Usage Modes

### Mode 1: Show Suggestion Only (default)

Display next recommended task with reasoning:

```bash
cleo next --explain
```

This shows:
- Recommended task ID and title
- Reasoning for the suggestion
- Priority and dependency information
- Phase context

### Mode 2: Auto-Focus (with --auto-focus flag)

When user wants to automatically focus the suggested task:

```bash
cleo next --auto-focus
```

This will:
1. Analyze tasks
2. Suggest next task
3. Automatically set focus to that task
4. Display task details

## Step-by-Step Execution

1. **Get current project state:**
```bash
cleo dash --compact
```

2. **Get next task suggestion:**
```bash
cleo next --explain
```

3. **Parse the suggestion** and display it clearly to user

4. **If --auto-focus flag provided:**
```bash
cleo next --auto-focus
```

5. **Show focused task details:**
```bash
FOCUSED=$(cleo current -q)
cleo show $FOCUSED
```

## Intelligent Suggestions

The `next` command considers:
- **Priority**: Critical/High tasks first
- **Dependencies**: Only suggests unblocked tasks
- **Phase context**: Tasks in current project phase
- **Status**: Pending or active tasks only
- **Leverage scoring**: From `analyze` command

## Success Criteria

Next task suggestion is successful when:
- Valid unblocked task is suggested
- Reasoning is clear and actionable
- Dependencies are understood
- User can immediately start work

## Tips

- Run `/ct-dash` first to understand project context
- Use `cleo analyze` for deeper task triage
- Check `cleo blockers` if many tasks blocked
- Use `cleo phases` to see phase-specific tasks
