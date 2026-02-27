---
description: Start a CLEO work session with auto-focus
allowed_tools:
  - Bash(cleo:*)
  - Read
---

# Start CLEO Session

Execute the following steps to start a new CLEO work session:

## Step 1: Check for Existing Sessions

First, check if there are any existing sessions:

```bash
cleo session list --status active
```

If active sessions exist, consider resuming instead of starting new.

## Step 2: Start New Session

Start a new session with auto-focus on the highest priority task:

```bash
cleo session start --auto-focus
```

**Options:**
- Add `--name "Session Name"` to name your session
- Add `--scope epic:T001` to scope to a specific epic
- Add `--agent opus-1` to identify your agent

## Step 3: Display Current Task

Show what task is now active:

```bash
cleo current
```

Display the active task details:

```bash
cleo show $(cleo current -q)
```

## Step 4: Show Dashboard

Display project overview:

```bash
cleo dash
```

## Success Criteria

You have successfully started a CLEO session when:
- Session is active (shown in `session status`)
- A task is active (shown in `current`)
- You understand current project state (from `dash`)

## Next Steps

- Use `/ct-start <id>` to change focus to a different task
- Use `/ct-next` to get next task suggestions
- Use `/ct-end` when done to end the session
