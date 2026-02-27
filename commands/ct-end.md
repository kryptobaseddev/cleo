---
description: End current CLEO work session
allowed_tools:
  - Bash(cleo:*)
argument_hint: "[session note]"
---

# End CLEO Session

Properly close your current CLEO work session with cleanup and archiving.

## Step 1: Complete Current Task (if applicable)

If your current task is done, mark it complete:

```bash
# Check current task
cleo current

# Complete if done
cleo complete <task-id>
```

## Step 2: Prompt for Session Note

Ask the user: "Would you like to add a session note summarizing your work?"

Wait for user response.

## Step 3: End Session

If user provided a note:
```bash
cleo session end --note "User provided note here"
```

If no note:
```bash
cleo session end
```

## Step 4: Archive Completed Tasks

Clean up completed tasks:

```bash
cleo archive
```

## Step 5: Show Final Status

Display session summary:

```bash
cleo session status
```

## Success Criteria

Session successfully ended when:
- `session status` shows no active session
- Completed tasks are archived
- Work progress is captured in session note

## Important Notes

- Sessions persist across Claude conversations - you can resume later
- Use `cleo session suspend` instead if you'll resume soon
- Use `cleo session resume <id>` to continue where you left off
