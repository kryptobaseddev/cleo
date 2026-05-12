---
name: gsd:cleanup
description: Archive accumulated phase directories from completed milestones
allowed-tools:
  - Read
  - Write
  - Bash
  - AskUserQuestion
---
<objective>
Archive phase directories from completed milestones into `.planning/milestones/v{X.Y}-phases/`.

Use when `.planning/phases/` has accumulated directories from past milestones.
</objective>

<execution_context>
@/tmp/pomodoro-bench/gsd/.claude/get-shit-done/workflows/cleanup.md
</execution_context>

<process>
Follow the cleanup workflow at @/tmp/pomodoro-bench/gsd/.claude/get-shit-done/workflows/cleanup.md.
Identify completed milestones, show a dry-run summary, and archive on confirmation.
</process>
