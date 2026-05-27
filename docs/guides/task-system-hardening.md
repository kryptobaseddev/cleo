# Task System Hardening Guide

**Epic:** T056 — Task System Hardening
**Status:** Complete (all features live as of v2026.3.57)

This guide covers the hardened task system introduced by Epic T056. It explains what changed, why it matters, and how to use every new feature — with CLI examples throughout.

---

## Table of Contents

1. [Overview](#overview)
2. [Strictness Presets](#strictness-presets)
3. [Mandatory Workflow (WF-001 through WF-005)](#mandatory-workflow)
4. [Acceptance Criteria Requirements](#acceptance-criteria-requirements)
5. [Verification Gates](#verification-gates)
6. [Pipeline Stages (RCASD-IVTR+C)](#pipeline-stages)
7. [Session Requirements](#session-requirements)
8. [Compliance Monitoring](#compliance-monitoring)
9. [Migration Guide (Backfill)](#migration-guide)

---

## Overview

Before T056, CLEO's task system was permissive: tasks could be created without acceptance criteria, completed outside of sessions, and moved through any lifecycle stage in any order. This worked for exploration but created real problems at scale — agents completed tasks that were never properly defined, verification was inconsistently applied, and there was no reliable signal for whether work actually met requirements.

The T056 hardening initiative addressed this through eight coordinated changes:

| Task | What Was Added |
|------|----------------|
| T057 (config schema) | Strict defaults baked into `config.schema.json` |
| T058 (AC enforcement) | Minimum acceptance criteria check at task creation/completion |
| T059 (session binding) | Session must be active to complete a task |
| T060 (pipeline stages) | RCASD-IVTR+C stage auto-assignment and forward-only transitions |
| T061 (verification gates) | Auto-initialized gates on every new task |
| T063 (skills update) | All ct-* skills updated to enforce WF-001 through WF-005 |
| T064 (ct-validator) | New skill focused on gate enforcement and pre-flight checks |
| T065 (telemetry) | `cleo compliance workflow` command for WF rule dashboards |
| T066 (backfill) | `cleo backfill` to retroactively apply AC and gates to old tasks |
| T067 (presets) | `cleo config set-preset` for one-command strictness changes |

The rest of this guide covers each area in detail.

---

## Strictness Presets

CLEO ships three preset profiles that control how strictly the system enforces workflow rules. Applying a preset is the fastest way to configure a project.

### Available presets

```
cleo config presets
```

| Preset | AC Required | Session Notes | Lifecycle Mode | Multi-Session |
|--------|-------------|---------------|----------------|---------------|
| `strict` | Yes (blocks) | Required | `strict` (enforced) | No |
| `standard` | No (warns) | Optional | `advisory` (warns) | Yes |
| `minimal` | No | No | `off` | Yes |

### Apply a preset

```bash
# Use strict enforcement for AI-agent-driven projects
cleo config set-preset strict

# Use standard mode for human-led projects with agent assistance
cleo config set-preset standard

# Use minimal mode to disable all enforcement during onboarding
cleo config set-preset minimal
```

Presets are idempotent — running the same preset twice produces the same result and does not overwrite unrelated config keys (such as `output.*` or `backup.*`).

### Inspect the current value of a specific key

```bash
cleo config get lifecycle.mode
cleo config list
```

### Manually set individual keys

You can set any config key directly if you want a mix that does not match a preset exactly:

```bash
cleo config set lifecycle.mode strict
cleo config set session.requireNotes true
```

---

## Mandatory Workflow

The mandatory workflow is a set of five rules (WF-001 through WF-005) that define the minimum acceptable behavior for agents and humans working with CLEO tasks. These rules are enforced by `cleo compliance workflow` and referenced by all ct-* skills.

The canonical source of truth for these rules lives in `packages/skills/skills/_shared/task-system-integration.md`.

### The five rules

| Rule | Level | Requirement |
|------|-------|-------------|
| WF-001 | MUST | Tasks must have at minimum 3 acceptance criteria |
| WF-002 | MUST | Task completions must occur within an active session |
| WF-003 | SHOULD | Completed tasks should have verification gates initialized |
| WF-004 | SHOULD | All verification gates should be marked passed before completion |
| WF-005 | MUST | Tasks must be created while an active session is running |

MUST rules are weighted twice as heavily as SHOULD rules in the overall compliance score.

### Canonical 7-step workflow

Every task should follow this sequence:

```
1. Start a session           → cleo session start --scope epic:T001 --name "working on T001"
2. Show the task             → cleo show T042
3. Verify ≥3 ACs exist       → (check acceptance[] array in show output)
4. Do the work
5. Set implemented gate      → cleo verify T042 --gate implemented --value true
6. Set testsPassed gate      → cleo verify T042 --gate testsPassed --value true
7. Set qaPassed gate         → cleo verify T042 --gate qaPassed --value true
8. Complete the task         → cleo complete T042
9. End the session           → cleo session end
```

### Check compliance for an agent session

Use the `ct-validator` skill or run directly:

```bash
# Full WF-001..WF-005 compliance dashboard
cleo compliance workflow

# Filter to a specific time window
cleo compliance workflow --since 2026-03-01
```

---

## Acceptance Criteria Requirements

Every task must have at least 3 acceptance criteria before it can be considered ready to work on. Epics require at least 5.

### Add AC when creating a task

```bash
cleo add "Implement login endpoint" \
  --acceptance "Returns 200 with JWT on valid credentials" \
  --acceptance "Returns 401 on invalid credentials" \
  --acceptance "Rate limiting applied after 5 failed attempts"
```

### Add AC to an existing task

```bash
cleo update T042 \
  --acceptance "Returns 200 with JWT on valid credentials" \
  --acceptance "Returns 401 on invalid credentials" \
  --acceptance "Rate limiting applied after 5 failed attempts"
```

### Check AC count for a task

```bash
cleo show T042
# Look for the "acceptance" array in the output
```

### What happens when AC is missing

In `strict` mode, tasks without sufficient AC are blocked from completion. In `standard` mode, a warning is shown. In `minimal` mode, no check is performed.

The WF-001 compliance rule tracks this across all tasks:

```bash
cleo compliance workflow
# Shows WF-001: complianceRate for "Tasks must have ≥3 acceptance criteria"
```

---

## Verification Gates

Verification gates track whether the three key quality checkpoints have been met for a task. They are auto-initialized on every new task when verification is configured.

### The three gates

| Gate | Meaning |
|------|---------|
| `implemented` | The code or change was written and exists |
| `testsPassed` | Tests covering the change pass |
| `qaPassed` | The outcome meets the acceptance criteria |

### View gate status for a task

```bash
cleo show T042
# Look for the "verification" object in the output
```

### Set a gate

```bash
cleo verify T042 --gate implemented --value true
cleo verify T042 --gate testsPassed --value true
cleo verify T042 --gate qaPassed --value true
```

### Set all gates at once (use with care)

```bash
cleo verify T042 --all
```

### Reset gates (for re-verification)

```bash
cleo verify T042 --reset
```

### Gate enforcement behavior

In `strict` lifecycle mode, CLEO will warn or block completion if required gates are not set. The WF-004 rule tracks this across the project:

```bash
cleo compliance workflow
# Shows WF-004: "Verification gates should all be marked passed before completion"
```

---

## Pipeline Stages (RCASD-IVTR+C)

Every task is automatically assigned a pipeline stage when created. Stages represent where in the development lifecycle the task sits.

### The ten stages in order

```
research → consensus → architecture_decision → specification →
decomposition → implementation → validation → testing →
release → contribution
```

The stage name is `RCASD-IVTR+C` as a mnemonic (Research, Consensus, Architecture-decision, Specification, Decomposition, Implementation, Validation, Testing, Release, Contribution).

### Auto-assignment rules

When a task is created without an explicit `--pipeline-stage`, CLEO assigns a stage automatically:

1. If `--pipeline-stage` is provided and valid, use it.
2. If the task has a parent, inherit the parent's stage.
3. If the task type is `epic`, assign `research`.
4. Otherwise, assign `implementation`.

### View a task's current stage

```bash
cleo show T042
# Look for "pipelineStage" in the output
```

### Move a task to the next stage

```bash
cleo update T042 --pipeline-stage validation
```

Transitions are **forward-only**. Attempting to move a task backward (e.g., from `testing` back to `implementation`) will be rejected with an error.

### View lifecycle state for an epic

```bash
cleo lifecycle show T056
```

### Advance an epic through lifecycle stages

```bash
cleo lifecycle start T056 specification
cleo lifecycle complete T056 specification --notes "Spec approved in PR #44"
```

### Skip a stage (when not applicable)

```bash
cleo lifecycle skip T056 consensus --notes "Single author, consensus not needed"
```

### Check a lifecycle gate

```bash
cleo lifecycle gate T056 implementation
```

---

## Session Requirements

Sessions bind work to a defined scope and provide audit trail context. In `strict` mode, completing a task outside of an active session will be blocked.

### Start a session

Every session requires a `--scope` (the epic or domain you are working within) and a `--name`.

```bash
# Scope to a specific epic
cleo session start --scope epic:T056 --name "Hardening docs"

# Global scope (not tied to a specific epic)
cleo session start --scope global --name "Miscellaneous fixes"
```

### Check if a session is active

```bash
cleo session status
```

### End a session

```bash
cleo session end
```

### Resume a previous session

```bash
cleo session list
cleo session resume <session-id>
```

### Why sessions matter

WF-002 and WF-005 both depend on sessions:
- **WF-002**: A task completion event is only considered compliant if it occurs while a session is active.
- **WF-005**: A task creation event is only compliant if it occurs during a session.

Without session binding, the audit trail has gaps that make it impossible to reconstruct who worked on what and when.

### Session notes

In `strict` mode, `session.requireNotes` is `true`. This means session handoff notes are expected before ending a session:

```bash
cleo session end
# In strict mode, you will be prompted or warned about missing notes
```

---

## Compliance Monitoring

The `cleo compliance workflow` command gives you a full WF-001 through WF-005 dashboard derived from your tasks database. No new tables are required — everything is computed from `tasks` and `audit_log`.

### View the compliance dashboard

```bash
cleo compliance workflow
```

Output includes:
- `overallScore` (0..1, weighted average)
- `grade` (A+, A, B, C, D, or F)
- Per-rule breakdown with total tasks, violation count, and compliance rate
- Up to 20 violation samples showing which task IDs failed which rule

### Filter to a time window

```bash
cleo compliance workflow --since 2026-03-01
```

### View per-skill reliability stats

```bash
cleo compliance skills
```

### View compliance violations

```bash
cleo compliance violations
```

### Understanding the score

| Grade | Score Range | Interpretation |
|-------|-------------|----------------|
| A+ | 0.95–1.0 | Excellent — all MUST rules near perfect |
| A | 0.85–0.95 | Strong compliance |
| B | 0.70–0.85 | Good, minor gaps |
| C | 0.55–0.70 | Moderate gaps, WF-002 or WF-005 likely failing |
| D | 0.40–0.55 | Significant gaps |
| F | 0–0.40 | Pre-T056 baseline — most tasks predate the hardening |

A project starting from before T056 will typically show grade F initially. Use `cleo backfill` to close the structural gaps, then improve session compliance over time.

---

## Migration Guide

If your project has existing tasks that predate T056, they will be missing acceptance criteria and verification gates. The `cleo backfill` command handles this retroactively.

### What backfill does

For every active task missing AC or verification metadata:
1. Generates 3 acceptance criteria using verb-pattern matching against the task title.
2. Initializes verification gates (`implemented`, `testsPassed`, `qaPassed`) all set to `false`.
3. Adds a timestamped note to the task: `[T066-backfill] auto-backfilled at <timestamp>: ac, verification`.

Archived and cancelled tasks are skipped.

### Step 1: Preview what will change

Always run with `--dry-run` first:

```bash
cleo backfill --dry-run
```

This shows every task that would be modified and the AC that would be generated — without writing anything.

### Step 2: Apply the backfill

```bash
cleo backfill
```

### Step 3: Verify the result

```bash
cleo compliance workflow
# WF-001 and WF-003 compliance rates should now be much higher
```

### Backfill specific tasks only

```bash
cleo backfill --tasks T001,T002,T010
```

### Roll back a backfill

If you want to undo the backfill (remove auto-generated AC and verification metadata):

```bash
# Preview rollback first
cleo backfill --rollback --dry-run

# Apply rollback
cleo backfill --rollback
```

Rollback identifies backfilled tasks by their `[T066-backfill]` marker note, so it only reverses tasks that were modified by the backfill command.

### Recommended migration sequence for existing projects

1. Run `cleo config set-preset minimal` to disable enforcement during migration.
2. Run `cleo backfill --dry-run` to review what will be generated.
3. Run `cleo backfill` to apply AC and gates.
4. Review generated AC on high-priority tasks and replace with task-specific criteria where needed.
5. Run `cleo compliance workflow` to confirm WF-001 and WF-003 are now green.
6. Run `cleo config set-preset standard` to enable advisory enforcement.
7. Over the next few sessions, work toward WF-002 and WF-005 compliance by always starting sessions before creating or completing tasks.
8. When session compliance is consistently above 80%, switch to `cleo config set-preset strict`.

---

## Reference: Config Keys Affected by T056

| Key | Type | Preset: strict | Preset: standard | Preset: minimal |
|-----|------|---------------|-----------------|----------------|
| `session.requireNotes` | boolean | `true` | `false` | `false` |
| `session.multiSession` | boolean | `false` | `true` | `true` |
| `lifecycle.mode` | string | `strict` | `advisory` | `off` |

All presets set `session.autoStart: false`.

---

## Reference: CLI Commands Summary

| Command | Purpose |
|---------|---------|
| `cleo config set-preset strict\|standard\|minimal` | Apply a strictness preset |
| `cleo config presets` | List all presets with their values |
| `cleo config get <key>` | Read a single config value |
| `cleo config set <key> <value>` | Set a config key directly |
| `cleo config list` | Show all resolved configuration |
| `cleo verify <TASK-ID> --gate <name> --value true` | Set a verification gate |
| `cleo verify <TASK-ID> --all` | Mark all gates passed |
| `cleo verify <TASK-ID> --reset` | Reset gates to initial state |
| `cleo compliance workflow` | WF-001..WF-005 dashboard |
| `cleo compliance workflow --since <date>` | Time-filtered compliance |
| `cleo compliance violations` | List compliance violations |
| `cleo compliance skills` | Per-skill reliability stats |
| `cleo backfill` | Apply AC and gates to old tasks |
| `cleo backfill --dry-run` | Preview backfill changes |
| `cleo backfill --rollback` | Undo a previous backfill |
| `cleo backfill --tasks T001,T002` | Restrict backfill to specific tasks |
| `cleo lifecycle show <EPIC-ID>` | View epic lifecycle state |
| `cleo lifecycle start <EPIC-ID> <STAGE>` | Start a lifecycle stage |
| `cleo lifecycle complete <EPIC-ID> <STAGE>` | Complete a lifecycle stage |
| `cleo lifecycle skip <EPIC-ID> <STAGE>` | Skip a lifecycle stage |
| `cleo lifecycle gate <EPIC-ID> <STAGE>` | Check a lifecycle gate |
| `cleo update <TASK-ID> --pipeline-stage <stage>` | Move task to a new stage |
| `cleo session start --scope <scope> --name <name>` | Start a session |
| `cleo session status` | Check if a session is active |
| `cleo session end` | End the current session |
