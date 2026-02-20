# Task Tracking Integration for CLAUDE.md
# Copy the section below into your project's CLAUDE.md file

## Task Management

Project tasks are tracked in `todo.json`. Read this file at session start.

### Session Protocol

**Starting a session:**
1. Read `todo.json`
2. Check `focus.currentTask` - if set, resume that task
3. If no current task, find the highest priority actionable pending task
4. Set task `status: "active"` and update `focus.currentTask`

**During work:**
- Add implementation context to `notes` array
- Update `files` array as you create/modify files
- If blocked, immediately set `status: "blocked"` and `blockedBy` reason

**Ending a session:**
- Update `focus.sessionNote` with current progress/state
- Set `focus.nextAction` with specific next step
- If task complete: set `status: "done"` and `completedAt: "YYYY-MM-DD"`
- Update `lastUpdated` in root

### Task Status Values
- `pending` - Ready to start (all dependencies met)
- `active` - Currently being worked on (only ONE at a time)
- `blocked` - Cannot proceed (must set `blockedBy` reason)
- `done` - Completed (must set `completedAt` date)

### Dependency Rules
Before starting a `pending` task:
1. Check its `depends` array
2. All listed task IDs must have `status: "done"`
3. If not, find a different actionable task or report blocker

### Priority Order
When choosing next task: `critical` > `high` > `medium` > `low`

### Key Rules
- **IMPORTANT**: Only ONE task should have `status: "active"` at any time
- **IMPORTANT**: Always update `focus.sessionNote` before ending session
- Never delete notes - only append new entries
- Keep acceptance criteria as your definition of done
- Archive completed tasks periodically to keep file lean

### Quick Reference
```
Actionable task = pending + all depends are done
Complete task   = set status:done, completedAt, clear focus.currentTask
Block task      = set status:blocked, blockedBy reason
Resume task     = check focus.currentTask and sessionNote
```
