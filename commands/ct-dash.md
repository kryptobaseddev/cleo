---
description: Show CLEO project dashboard
allowed_tools:
  - Bash(cleo:*)
---

# CLEO Project Dashboard

Display comprehensive project overview including tasks, phases, and session status.

## Execution Steps

### Step 1: Display Dashboard

Show project overview:

```bash
cleo dash
```

For compact one-line status:
```bash
cleo dash --compact
```

### Step 2: Show Current Session

Display active session info:

```bash
cleo session status
```

### Step 3: Show Current Phase

Display project phase context:

```bash
cleo phase show
```

### Step 4: Show Phase Progress

List all phases with progress bars:

```bash
cleo phases
```

## Dashboard Components

The dashboard shows:
- **Task Summary**: Total, pending, active, blocked, done
- **Priority Breakdown**: Critical, high, medium, low counts
- **Phase Progress**: Current phase and completion percentage
- **Recent Activity**: Latest task updates
- **Blockers**: Count of blocked tasks
- **Focus**: Currently active task

## Extended Analysis

For deeper insights, also show:

```bash
# Blocker analysis
cleo blockers

# Next suggested task
cleo next

# Label distribution
cleo labels
```

## Success Criteria

Dashboard is complete when user understands:
- Total project state (how many tasks, what status)
- Current focus and session context
- Phase progress and next milestone
- Any blockers or issues requiring attention
- Recommended next action

## Use Cases

- **Session start**: Understand project state before work
- **Status check**: Quick progress review
- **Planning**: Identify what needs attention
- **Handoff**: Share project state with team/agents
