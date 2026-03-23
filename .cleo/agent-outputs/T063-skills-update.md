# T063: Update All Skills with Mandatory Workflow

**Date**: 2026-03-21
**Task**: T063
**Epic**: T056 (Task System Hardening)
**Status**: complete

## Summary

Updated all CLEO ct-* skills and the `_shared/task-system-integration.md` SSoT to enforce the
opinionated mandatory workflow. All skills now reference `_shared/task-system-integration.md`
for canonical workflow rules, enforce session start before task work, require minimum 3 acceptance
criteria, enforce verification gate setting after implementation, and gate completion on required
gates being set.

## Files Modified

1. `packages/skills/skills/_shared/task-system-integration.md` — SSoT for mandatory workflow
2. `packages/skills/skills/ct-cleo/SKILL.md` — Added Mandatory Workflow section
3. `packages/skills/skills/ct-orchestrator/SKILL.md` — Added Mandatory Workflow Enforcement section
4. `packages/skills/skills/ct-task-executor/SKILL.md` — Updated execution sequence, methodology, checklist, and anti-patterns
5. `packages/skills/skills/ct-memory/SKILL.md` — Added Mandatory Workflow Context section

## Changes by File

### _shared/task-system-integration.md (SSoT)

Added a **Mandatory Workflow Rules** table (WF-001 through WF-005) at the top of the file
as the canonical source of truth for task workflow rules:

- WF-001: MUST have active session before any task work
- WF-002: MUST verify minimum 3 acceptance criteria before starting
- WF-003: MUST set verification gates after implementation
- WF-004: MUST only complete after required gates are set
- WF-005: MUST NOT start without reading full task details

Added a **Mandatory Pre-Work Checklist** with three steps (Session Gate, AC Gate, Start Task),
a **Verification Gate Protocol** section with gate-setting commands, an updated **Completion Protocol**
section, and a **Full Workflow Sequence** reference block showing the canonical 7-step flow.

Updated the **Usage in Skills** and **Usage in Templates** sections to include the mandatory gates.

### ct-cleo/SKILL.md

Added a **Mandatory Workflow (WF-001 through WF-004)** section before the Canonical Decision Tree,
including a quick reference table for all four mandatory gates.

Updated the **Canonical Decision Tree**:
- Session Start entry point annotated with `WF-001`
- AC count check added as a sub-step of `tasks.show`
- New **Completion: Gate Protocol** tree added showing the required gate-setting sequence before `tasks.complete`

Updated the **CLI Reference** to include `cleo verify` commands annotated with `WF-003` and `WF-004`.

### ct-orchestrator/SKILL.md

Added a **Mandatory Workflow Enforcement** section with:
- Pre-Spawn Gates table (Session gate, AC gate, Dependency gate)
- Post-Spawn Verification protocol for checking gate status from manifest entries
- Reference to `_shared/task-system-integration.md`

Orchestrator now explicitly MUST NOT spawn subagents for tasks with fewer than 3 ACs.

### ct-task-executor/SKILL.md

Updated **Execution Sequence** to a 13-step sequence with explicit gate commands at steps 6-9.

Added a **Mandatory Workflow Gates** table showing which WF rule maps to each step.

Updated **Methodology**:
- Pre-Execution: added session gate (WF-001) and AC gate (WF-002) steps
- Post-Execution: added explicit gate-setting steps 2-4 before completion

Updated **Completion Checklist**: added session active check, AC count check, and three gate-setting checkboxes with WF annotations.

Updated **Anti-Patterns**: added three new rows for working without a session, starting with fewer than 3 ACs, and completing without setting `implemented` gate.

### ct-memory/SKILL.md

Added a **Mandatory Workflow Context** section showing how memory operations support each WF gate,
with a reference to `_shared/task-system-integration.md`.

## Acceptance Criteria Verification

| Criterion | Status | Notes |
|-----------|--------|-------|
| All ct-* skills reference mandatory workflow | PASS | ct-cleo, ct-orchestrator, ct-task-executor, ct-memory all updated |
| _shared/task-system-integration.md is the SSoT | PASS | WF-001 through WF-005 defined there; all skills reference it |
| Session start required before task work in all skills | PASS | WF-001 enforced in all four skills |
| AC minimum 3 enforced in skill instructions | PASS | WF-002 enforced with explicit STOP instruction in all skills |
| Gate-setting is part of completion protocol | PASS | WF-003/WF-004 added to ct-cleo, ct-task-executor, ct-orchestrator |

## Implementation Notes

- Mandatory workflow rules were given IDs WF-001 through WF-005 for stable cross-reference
- ct-memory was updated to show how memory operations support (not replace) the workflow gates
- ct-orchestrator was updated to enforce gates at the pre-spawn level, not just in subagents
- All WF rule references use consistent RFC 2119 language (MUST, MUST NOT, SHOULD)
- The `_shared/task-system-integration.md` SSoT includes non-CLEO configuration examples intact
