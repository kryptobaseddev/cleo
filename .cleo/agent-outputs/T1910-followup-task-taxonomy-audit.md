# CLEO Task Taxonomy + `cleo bug` Consolidation — Audit Report

**Date**: 2026-05-06
**Author**: deep-research-agent (orchestrator-spawned, sonnet model)
**Trigger**: T1910 epic uncovered `cleo bug` accepting `--severity` but silently dropping `--acceptance`, leading to silent E_VALIDATION failures. Owner asked for deep audit of the bug/add command surface and type/role taxonomy with concrete consolidation proposal.
**Tools used**: `cleo nexus` impact analysis, grep across packages/, schema/validator inspection, `cleo show` for in-flight task survey.

## Executive Summary

- `cleo bug` is a 242-LOC shim that dispatches to `tasks.add` but silently drops acceptance criteria; because `cleo bug` never passes `--acceptance`, any project in `block` mode will fail all bug creations at the enforcement layer unless priority falls outside `requiredForPriorities`. The P0→`critical` mapping makes this worst-case for the most urgent bugs.
- The `--type` / `--role` taxonomy carries `bug` in **both** axes at different layers: the CLI help text for `--type` says `bug` is valid, but the core validator (`validateTaskType`) hard-rejects it — the dispatch registry and `lafs/operation-gates.ts` perpetuate the stale value.
- `bug` in `--role` is semantically sound per the T944 design (intent axis). `bug` as a `--type` is an artifact of incomplete migration that was never cleaned up. There are six distinct declaration sites for the type enum and four for the role enum, all maintained by hand.
- The `--scope` axis (project|feature|unit) is orthogonal-but-parallel to the structural `--type` axis; the T944 comments even document the mapping (`epic→project`, `task→feature`, `subtask→unit`), making both axes carry redundant granularity signal.
- Recommendation B (rename `--role` → `--kind`, drop `bug` from `--type`, surface `--severity` in `cleo add` with automatic attestation) delivers the owner's "composable task --kind" vision cleanly, shrinks the CLI surface by one command (~242 LOC), and eliminates the help/validator drift.

## Findings

### Phase 1 — Surface Map

**Symbol locations (file:line)**

```
contracts/src/task.ts:45          TaskType = 'epic' | 'task' | 'subtask'
contracts/src/task.ts:53          TaskRole = 'work' | 'research' | 'experiment' | 'bug' | 'spike' | 'release'
contracts/src/task.ts:78          TaskSeverity = 'P0' | 'P1' | 'P2' | 'P3'
contracts/src/task.ts:66          TaskScope = 'project' | 'feature' | 'unit'

core/src/store/tasks-schema.ts:84   TASK_TYPES = ['epic','task','subtask'] as const
core/src/store/tasks-schema.ts:96   TASK_ROLES = ['work','research','experiment','bug','spike','release'] as const
core/src/store/tasks-schema.ts:128  TASK_SEVERITIES = ['P0','P1','P2','P3'] as const
core/src/store/tasks-schema.ts:254  DB enum enforced on role column (Drizzle)
core/src/store/tasks-schema.ts:119  DB CHECK: severity IS NULL OR (severity IN (...) AND role='bug')

core/src/tasks/add.ts:272-283      validateTaskType() — valid list: ['epic','task','subtask'] (no 'bug')
core/src/orchestration/classify.ts:209  role==='bug' → +0.15 confidence for project-dev-lead

cleo/src/cli/commands/add.ts:63      --type help: "epic | task | subtask | bug"  ← STALE
cleo/src/cli/commands/add.ts:145     --role help: "work|research|experiment|bug|spike|release"
cleo/src/cli/commands/add.ts:151     --kind: alias for --role (wired at CLI, stripped to wire='role')
cleo/src/cli/commands/update.ts:53   --type help: "task|epic|subtask|bug"  ← STALE
cleo/src/cli/commands/find.ts:39     --role help: all six values
cleo/src/cli/commands/bug.ts:1-242   full shim command

cleo/src/dispatch/registry.ts:1873   enum: ['epic','task','subtask','bug'] ← STALE (4th value never reaches validator)
lafs/src/operation-gates.ts:110      enum: ['epic','task','subtask','bug'] ← STALE
```

**Dependency blast radius for `bug.ts`:**
The shim imports `getCleoIdentity`, `signAuditLine`, `getCleoDirAbsolute`, `getConfigPath` from `@cleocode/core` and `dispatchFromCli` from the dispatch adapter. No other command imports `bug.ts`; it is registered as a top-level command in the citty main command file. Removing it touches: `packages/cleo/src/cli/index.ts` (registration), `packages/cleo/src/cli/generated/command-manifest.ts` (manifest entry).

### Phase 2 — Duplication, Dead Code, Inconsistencies

**2.1 Help/Validator Drift (confirmed)**

| Layer | Declared values | File:line |
|---|---|---|
| CLI help (`add`) | `epic\|task\|subtask\|bug` | `add.ts:63` |
| CLI help (`update`) | `task\|epic\|subtask\|bug` | `update.ts:53` |
| Dispatch registry enum | `['epic','task','subtask','bug']` | `registry.ts:1873` |
| LAFS operation-gates | `['epic','task','subtask','bug']` | `operation-gates.ts:110` |
| Core validator | `['epic','task','subtask']` | `add.ts:273` |
| Contracts type | `'epic' \| 'task' \| 'subtask'` | `task.ts:45` |
| Studio validator | `new Set(['epic','task','subtask'])` | `+server.ts:106` |

`bug` as a `--type` value reaches the dispatch registry but is silently coerced/passed to `addTask()` where `validateTaskType` throws `E_VALIDATION`. The caller sees a crash, not a clean UX error. **Six declaration sites** — four of them stale.

**2.2 `--type` vs `--role` overlap**

`bug` exists in both the stale `--type` help and the live `--role` enum. T944 was supposed to migrate "intent" from the type hierarchy to the role axis. The migration completed for the DB and core validator but not for the CLI help text and dispatch registry. The DB enforces the correct model: `role` column has a Drizzle enum; the `type` column only accepts `epic|task|subtask`.

**2.3 `cleo bug` shim — broken acceptance path**

`cleo bug` never passes `--acceptance` to `tasks.add`. The enforcement layer (`enforcement.ts:39-44`) requires acceptance criteria for all priorities by default (`requiredForPriorities: ['critical','high','medium','low']`, `minimumCriteria: 3`). P0→`critical`, so the most urgent bugs will fail silently when enforcement mode is `block` (the default outside test). P2→`medium` also requires AC. The shim has no path to pass acceptance criteria and provides no `--acceptance` flag.

**2.4 Severity attestation coupling**

The Ed25519 attestation logic (`appendSignedBugSeverity`, `canonicalAttestationJson`, `loadOwnerPubkeys`) lives entirely inside `bug.ts` (~100 LOC). The schema type `BugSeverityAttestation` is a local interface, not in contracts. This logic would need to move to core (or a shared lib) if `--severity` is wired into `cleo add`.

**2.5 Role enum declared at four sites**

```
contracts/src/task.ts:53          (source of truth)
core/src/store/tasks-schema.ts:96  (TASK_ROLES const — used for Drizzle enum)
cleo/src/cli/commands/add.ts:139-145  (inline prose in help description)
cleo/src/cli/commands/find.ts:39   (inline prose)
cleo/src/cli/commands/update.ts:141 (inline prose)
contracts/src/task-record.ts:66    (inline prose in doc comment)
```

The CLI inline prose strings are the highest drift risk. If a role value is added to contracts/schema, all three CLI files need hand-editing.

**2.6 `--scope` vs `--type` redundancy**

The T944 comment explicitly documents the mapping: `epic→project`, `task→feature`, `subtask→unit`. Both axes encode granularity. Scope adds finer cardinality (a subtask could still be `scope=feature` if it spans multiple units) but in practice is never set independently — it defaults to `feature` and the backfill docs map it 1:1 from type. The axes are technically orthogonal but carry redundant signal at creation time.

## Recommendation: Option B (with owner-confirmed deltas)

**Rename `--role` to `--kind`, drop `bug` from `--type`, surface `--severity` in `cleo add`, delete `cleo bug`.**

**Owner decisions integrated (2026-05-06):**

1. **AC required for ALL tasks including bugs** — no exemption.
2. **Hard rename, no backwards compat** — drop `--role` immediately, no alias period; drop `TaskRole` re-export immediately; delete `cleo bug` immediately, no tombstone.
3. **System-wide attestation** — fires for any task with `--severity`, not just bug-shim entries.
4. **Research tasks REQUIRED before W2/W7** — must determine where `TaskRole` is used outside CLI/contracts/schema (R1) AND whether `--scope` is load-bearing (R2).
5. **`cleo issue` STAYS** — different concern (GitHub issue filing for CLEO project repo).

**Rationale over A and C:**

- Option A (collapse role into type) blows up the structural hierarchy. `type` already has architectural meaning (parent/leaf relationship, lifecycle pipeline gating). Mixing `bug` into `type` pollutes the hierarchy lookup in `inferTaskType()`, lifecycle stage resolution, and classify routing.
- Option C (new `cleo task` entrypoint) adds a third surface and defers the cleanup — owner already said 250+ ops is too many.
- Option B is the minimal rename: `--kind` matches the owner's stated mental model, the renaming is already half-done (`--kind` is already an alias for `--role` in `add.ts:151` and `update.ts:147`), and it clears the conceptual confusion.

## Migration plan (4 waves, owner-approved no-backwards-compat)

### Wave 0 — Research (parallel-safe)

- **R1**: Map all `TaskRole` references outside CLI/contracts/schema. Output: complete consumer list + rename impact assessment.
- **R2**: Determine if `--scope` is load-bearing (briefing/plan/classify/lifecycle-stage-resolver) or vestigial. Output: keep + define clearly OR delete with consumer-update list.

### Wave 1 — Independent cleanup

- **W1**: Remove `bug` from 4 stale `--type` declarations (`add.ts:63`, `update.ts:53`, `dispatch/registry.ts:1873`, `lafs/operation-gates.ts:110`).
- **W3**: Extract severity attestation to `core/src/tasks/severity-attestation.ts` as system-wide primitive. Move `BugSeverityAttestation` interface to `@cleocode/contracts`.

### Wave 2 — Depends on Wave 0/1

- **W2**: Hard-rename `--role` → `--kind` everywhere. NO deprecation alias. NO re-exports. Update all 6 declaration sites + every consumer R1 identifies. Depends on R1.
- **W4**: Surface `--severity` in `cleo add` (and `cleo update`). Decouple severity from priority — they remain orthogonal axes. Remove SEVERITY_MAP. Wire to system-wide attestation from W3. Depends on W3.
- **W7**: Resolve `--scope` based on R2 verdict — either delete with consumer call-site updates, OR write the canonical doc that defines its distinct purpose. Depends on R2.

### Wave 3 — Depends on W2+W4

- **W5**: Delete `cleo bug` entirely. `bug.ts` gone, command unregistered, manifest entry removed, audit log path migrated to generic `severity-attestation.jsonl`. NO tombstone. Users use `cleo add --kind bug --severity P1 --acceptance "..."`. AC required (no bug exemption). Depends on W2 + W4.

### Wave 4 — Documentation

- **W6**: Update all docs to reflect new taxonomy — `CLEO-INJECTION.md`, per-package `AGENTS.md`, ADR explaining rename + attestation generalization + AC-everywhere policy + clean-rename rationale. Depends on W1, W2, W4, W5, W7.

## LOC delta estimate (with no-backwards-compat deltas)

| Action | Delta |
|---|---|
| Remove `bug.ts` shim entirely (single wave, no tombstone) | −242 |
| Extract attestation to core helper | +80 |
| `--severity` + `--kind` in `add.ts`/`update.ts` | +15 |
| Fix 4 stale enum declarations | −4 |
| Drop `--role` alias (clean rename) | ~0 |
| Drop `TaskRole` re-export (no compat) | −2 |
| **Net** | **−153** |

## Risks & Rollback

**Risk 1 — TaskRole consumers break (HIGH, mitigated by R1)**
Hard-rename without compat layer means any consumer importing `TaskRole` breaks at compile time. R1 must produce complete list before W2 dispatches. After R1, W2 updates ALL consumers in same wave.

**Risk 2 — DB column rename (LOW, deferred)**
DB column stays `role` — renaming requires migration. The CHECK constraint references `role`. Defer to separate task; update `severity-attestation.jsonl` migration to acknowledge column name.

**Risk 3 — classify.ts structural boost** (LOW)
`classify.ts:209` reads `task.role === 'bug'`. After DB column rename (deferred), this line updates. Until then unaffected.

**Rollback**: All waves are atomic via worktree branches. Each can revert independently. Wave 5 deletion is the only irreversible step but is delivered after all dependent work integrates.

## Adjacent Opportunities

- **`--priority` vs `--severity` — NOT redundant.** Different signals (scheduler vs impact). Keep both. SEVERITY_MAP that conflates them is the actual bug; W4 removes the coupling.
- **`--size` vs `--scope` — partially redundant.** Different cleanup; defer.
- **`cleo issue` STAYS** (owner directive — GitHub issue filing for CLEO project repo, distinct concern).
- **Help/validator drift** — checked: no other instances of help advertising more values than validator accepts.
- **Low-usage command audit** — separate audit task, not bundled.

## Open Questions Resolved by Owner (2026-05-06)

1. ✅ AC required for ALL tasks — no bug exemption. Operators must pass `--acceptance`.
2. ✅ Hard rename — no backwards compat, no tombstones, no deprecated re-exports.
3. ✅ System-wide attestation — fires for any task with `--severity`.
4. ✅ Research required for `TaskRole` consumer mapping (R1) and `--scope` load-bearing analysis (R2).
5. ✅ Clean DRY code — no compat shims.

## Verdict

**Ready for filing.** Epic with 9 children (2 research + 6 implementation + 1 docs), 4-wave decomposition, sequential deps wired to research outputs.
