# T065 — Agent Workflow Telemetry

**Task:** T065
**Epic:** T056 (Task System Hardening)
**Status:** complete
**Date:** 2026-03-21

---

## Summary

Implemented agent workflow telemetry that computes WF-001 through WF-005 compliance
metrics from existing SQLite data. No new tables were added. A new CLI command exposes
the metrics as a compliance dashboard with `--since` filtering support.

---

## What Was Built

### Core Module

**`packages/core/src/stats/workflow-telemetry.ts`**

Exports `getWorkflowComplianceReport(opts)`. Queries two existing tables:

- `tasks` — for AC criteria, verification gates, sessionId binding
- `audit_log` — for completion event session context

Returns a `WorkflowComplianceReport` with:
- `overallScore` (weighted average, 0..1)
- `grade` (A+/A/B/C/D/F)
- `rules[]` — per-rule breakdown (WF-001..WF-005)
- `violationSamples[]` — up to 20 example violations
- `summary` — raw counts for context

### Rule Definitions

| Rule | Level | Description |
|------|-------|-------------|
| WF-001 | MUST | Tasks must have ≥3 acceptance criteria |
| WF-002 | MUST | Task completions must occur within an active session |
| WF-003 | SHOULD | Completed tasks should have verification gates initialized |
| WF-004 | SHOULD | All verification gates should be marked passed before completion |
| WF-005 | MUST | Tasks must be created with active session binding |

MUST rules are weighted 2x vs SHOULD rules in the overall score.

### Dispatch Registration

**`packages/cleo/src/dispatch/registry.ts`**
- Added `check.workflow.compliance` (query, tier 1) with optional `since` param

**`packages/cleo/src/dispatch/domains/check.ts`**
- Added `case 'workflow.compliance'` to query switch
- Imported `getWorkflowComplianceReport` from `@cleocode/core/internal`
- Added `workflow.compliance` to `getSupportedOperations()`

### CLI Commands

Two entry points, both route to `check.workflow.compliance`:

```
cleo stats compliance [--since <date>] [--json]
cleo compliance workflow [--since <date>] [--json]
```

**`packages/cleo/src/cli/commands/stats.ts`** — added `compliance` subcommand
**`packages/cleo/src/cli/commands/compliance.ts`** — added `workflow` subcommand

### Exports

**`packages/core/src/stats/index.ts`** — re-exports `getWorkflowComplianceReport`
**`packages/core/src/internal.ts`** — exports `getWorkflowComplianceReport`, `WorkflowComplianceReport`, `WorkflowRuleMetric`

---

## Sample Output (live project data)

```
overallScore: 0.0357
grade: F
```

| Rule | Total | Violations | Rate |
|------|-------|-----------|------|
| WF-001 (AC ≥3) | 98 | 98 | 0% |
| WF-002 (session completion) | 72 | 63 | 12.5% |
| WF-003 (gates initialized) | 45 | 45 | 0% |
| WF-004 (all gates set) | 0 | 0 | 100% (no data) |
| WF-005 (session binding) | 98 | 98 | 0% |

This confirms that pre-T063 tasks were created without the workflow enforcement
rules — the low compliance scores represent the historical gap that T056 hardening
is designed to close.

---

## Acceptance Criteria Met

- Telemetry queries compute compliance metrics from existing data (audit_log, tasks, sessions)
- CLI command `cleo stats compliance` shows compliance dashboard
- CLI command `cleo compliance workflow` is an equivalent alias
- `--since` param supported for time-window filtering
- JSON output is the default (CLI envelope format, consistent with all other commands)
- No new tables added — all derived from existing schema

---

## Files Changed

- `packages/core/src/stats/workflow-telemetry.ts` — NEW
- `packages/core/src/stats/index.ts` — re-export added
- `packages/core/src/internal.ts` — export added
- `packages/cleo/src/dispatch/registry.ts` — operation registered
- `packages/cleo/src/dispatch/domains/check.ts` — handler case added
- `packages/cleo/src/cli/commands/stats.ts` — `compliance` subcommand added
- `packages/cleo/src/cli/commands/compliance.ts` — `workflow` subcommand added
