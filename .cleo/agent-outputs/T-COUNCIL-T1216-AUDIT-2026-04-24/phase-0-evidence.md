# Phase 0 — Evidence Pack (T1216 Audit Council)

## Restated question

**Is epic T1216 structured to produce trustworthy per-task verdicts for the 12 false-completion suspects, or will it ship confident conclusions on a flawed premise — and is T1222's engine fix the correct backstop?**

Decision shape: APPROVE as-is · APPROVE with amendments · REFACTOR before execution · ABANDON + replace.

## Evidence pack

1. **T1216 spec** — `cleo show T1216`: 15 children, scope = "12 suspect EPICS audited against acceptance criteria", acceptance includes engine fix (T1222), migration/backfill of 176 audit-column-gap tasks, and audit report at `docs/audits/2026-04-22-false-completion-audit.md`. Position=153, priority=critical.

2. **T991 "1 commit HIGHEST RISK" framing is misleading — work shipped under child task IDs.**
   - `git log --all --grep="T991"` = 1 commit (the release chore).
   - `git log --all --grep="T99[4-9]"` = T994: 2, T995: 2, T996: 2, T997: 3, T998: 3, T999: 4 → **16 child-task commits** in v2026.4.98.
   - `18128e3ce chore(release): v2026.4.98 — T991 + T1000 + T1007 Tier 2 + T1013 hygiene` confirms T991 work shipped as a named release.
   - T1227's label "1 commit, HIGHEST RISK" frames risk as commit-sparsity; actual risk is parent-child link gap.

3. **`cleo list --parent T991` returns 0 children** — but git log proves T994–T999 shipped substantive commits. The DB-level parent-child relationship is broken/missing, yet the work is in the codebase. "Zero child tasks" per T1216 description ≠ "no work done" — the audit premise conflates DB-state absence with work absence.

4. **CLEO engine does NOT currently enforce `verification_json` NOT NULL on `tasks.complete`.**
   - `packages/cleo/src/dispatch/engines/task-engine.ts`:831 re-validates `verification.evidence` IF populated, but no path rejects NULL.
   - T1222 is therefore load-bearing: without it, the same false-completion gap could recur while the audit is running. This is the only structural fix in the epic; everything else is forensic.

5. **T990 precedent — UI false-completion is a real pattern but different shape.** T990 was filed 2026-04-19 after T949 merge shipped a "functional but not designed" UI. This is a *quality* false-completion (work done, acceptance criteria partially met), not a *null-gate* false-completion. The audit conflates two failure modes.

6. **BRAIN-integrity reconciliation already merged into v2026.4.133 spine per 2026-04-24 Council** (observation O-dfb7f334, O-5e7540d6). T1107 14-verb wiring → T1258 E1/.126; T1262 memory-doctor detection queued. **T1227 auditing T991 risks re-litigating already-reconciled scope** if agents don't ground in the v2026.4.133 spine decision.

7. **176 audit-column-gap tasks is SYSTEMIC, not suspect-specific.** Per T1216 description, ALL 176 pre-ADR-051 completions have `modified_by=NULL` + `session_id=NULL`. The 12 "full-NULL" suspects additionally lack `verification_json` + audit log + lifecycle history + child tasks. The backfill migration (T1222 acceptance #3) is a distinct workstream from per-epic audit — bundling them risks blocking 12 forensic reviews behind one data-migration task.

## Evidence pack — verification

Item types used: 6× `file:line | commit | symbol | task-id`; 1× `code-search`. All items have one-line rationale. Total: 7 items (within 3–7 range).
