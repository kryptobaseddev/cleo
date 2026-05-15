# CLEO Prime Sentience — Tier 1 / Tier 2 / Cross-Cutting CI Decomposition

> **Status**: planning-only spec. NO tasks created. Owner-review before any `cleo add`.
> **Source**: `/mnt/projects/cleocode/docs/plans/CLEO-PRIME-SENTIENT-MASTERPLAN.md` (§5 Tier 1, §5 Tier 2, §6, §16.A, §18).
> **Scope**: 3 of N Tier-epics. Tiers 3+ are referenced as `depends-on:` edges only — they are NOT decomposed here.
> **Author**: cleo-prime (planning subagent), 2026-05-15.
> **Task model**: ADR-066 (type/kind/severity/size), ADR-051 (evidence atoms), ADR-070 (orchestration), pipe-separated `--acceptance`, no time estimates.

---

## 0. Cross-epic conventions

- **Parent (all three)**: `E-PRIME-SENTIENCE` (umbrella epic — created separately, out of scope here).
- **Severity inheritance**: Severity bubbles UP from the strictest subtask. Phase severity = strictest subtask. Epic severity = strictest phase.
- **Evidence atom defaults** (every implementation subtask, per ADR-051):
  - `implemented`: `commit:<sha>;files:<absolute-paths-changed>`
  - `testsPassed`: `tool:test`
  - `qaPassed`: `tool:lint;tool:typecheck`
  - `documented`: `files:<doc-paths>` (when subtask creates/updates docs)
  - `cleanupDone`: `note:<one-line>`
- **No `--override` reliance**: ADR-051 — emergency override needs owner sign-off; absent from this spec.
- **Test discipline**: each phase MUST contain at least one subtask whose acceptance is a failing-before-shipping regression test (red→green).
- **Worktree-by-default**: every subtask spawn uses `cleo orchestrate spawn` (ADR-055/062). Implicit; not repeated.

---

# Tier Epic: E-PRIME-T01 — Trust Foundation

## Epic Identity

- **ID**: E-PRIME-T01
- **Title**: Trust Foundation — verifier hardening + BBTT close-out + daemon liveness
- **Type**: epic
- **Kind**: work
- **Severity**: P0 — every tier below is suspect until this lands
- **Size**: large
- **Parent**: E-PRIME-SENTIENCE
- **Depends-on**: none (first wave)
- **Wave**: W0 (schema lock-in) + W1 (trust funnel) — phases split across both
- **References masterplan §**: §5 Tier 1.1–1.3, §16.A (canonical T9245 site), §7 W0/W1, §13 (file refs)

## Vision

Make every "shipped" claim programmatically verifiable so the verifier cannot be lied to. Without this trust foundation, every later tier (BRAIN provenance, persona graph, PSYCHE pipeline) inherits silent corruption. Close the 13 mis-completed BBTT tasks with real evidence atoms; install systemd-managed daemon liveness so the dream loop runs continuously.

## Acceptance Criteria (Epic-level, pipe-separated)

AC-1: T9245 integration test passes — task AC = file A + evidence commit touches only file B → `cleo verify` exits with `E_EVIDENCE_INSUFFICIENT`. | AC-2: `--override` on `implemented` and `testsPassed` gates is REJECTED with `E_EVIDENCE_INVALID_DECISION` unless `CLEO_OWNER_OVERRIDE=1` is set with reason. | AC-3: All 13 mis-completed tasks (T9220, T9222, T9223, T9224, T9227, T1897, T1899, T1906, T9172, T1467, T1693, T9194, T9173) have new evidence rows in `brain_promotion_log` with `tool:test` + `commit:<sha>;files:...` atoms — none used `--override`. | AC-4: `systemctl --user is-active cleo-daemon` returns `active` on operator host; `cleo daemon install` script idempotent on re-run. | AC-5: `cleo memory dream --status` returns `isOverdue:false` continuously for 7 days (post-install soak). | AC-6: `cleo doctor brain --strict` exits 0 on a clean repo. | AC-7: `cleo memory dream --status` non-zero exit when overdue ≥24h (W2-1).

## Milestone Gates (proving improvement — measurable health metrics)

- **M0 (baseline, today 2026-05-15)**:
  - `count(re-verify-with-override-on-13-BBTT-tasks)` = 13
  - `daemon uptime hours per 7-day window` = 0 (daemon not installed on operator host per masterplan §5 Tier 1.3)
  - `% brain_observations with origin column non-null` = 0% (column does not exist yet — see T02 schema migration)
  - `cleo doctor brain --strict` exit code = N/A (flag does not exist)
  - `count(--override-on-implemented-gate-in-last-30-days)` ≥ 13
- **M1 (after Phase 1 — T9245 hardening shipped)**:
  - `validateCommit` rejects empty-intersection cases — assert via test suite `evidence.test.ts::rejects-empty-diff`
  - `--override` on `implemented` REJECTED in unit test → expected `E_EVIDENCE_INVALID_DECISION` count = 100% of attempts in test
- **M2 (after Phase 2 — 13 BBTT re-verify complete)**:
  - `count(re-verify-with-override-on-13-BBTT-tasks)` = 0
  - Each of the 13 task IDs has ≥1 row in `brain_promotion_log` with both atoms (`commit:` and `tool:test`)
- **M3 (after Phase 3 — daemon liveness installed)**:
  - `daemon uptime hours per 7-day window` ≥ 7 × 24 × 0.99 = 166.3 hours
  - `cleo memory dream --status .isOverdue` = false for 7 consecutive days
- **M4 (epic complete)**:
  - All M1/M2/M3 metrics hold for 7 contiguous days
  - `cleo doctor brain --strict` exit code = 0 on three independent runs

## Phase Tasks

### Phase 1: T9245 evidence-validator hardening

- **Task ID**: T-PRIME-T01-P1
- **Type**: task
- **Kind**: work
- **Severity**: P0
- **Size**: medium
- **Files touched**:
  - `/mnt/projects/cleocode/packages/core/src/tasks/evidence.ts` (canonical site — §16.A)
  - `/mnt/projects/cleocode/packages/core/src/tasks/evidence.test.ts` (new test file or extend existing)
  - `/mnt/projects/cleocode/packages/core/src/tasks/verifier-runner.ts`
  - `/mnt/projects/cleocode/packages/contracts/src/evidence.ts` (if AC-file-paths schema needs widening)
- **Depends-on**: none
- **Acceptance**: AC-1 | AC-2
- **Evidence atoms required at complete**: `commit:<sha>;files:packages/core/src/tasks/evidence.ts,packages/core/src/tasks/evidence.test.ts` | `tool:test` | `tool:lint;tool:typecheck`

#### Subtask 1.1: Extract AC file paths from task record

- **ID**: T-PRIME-T01-P1-S1
- **Type**: subtask
- **Kind**: work
- **Size**: small
- **Atomic action**: Add `extractAcFilePaths(taskAcceptance: string): string[]` helper that parses pipe-separated AC strings and pulls out paths matching `[\w/.-]+\.(ts|tsx|js|mjs|md|sql|json|yaml)` plus explicit `files:<list>` hints.
- **Files**: `/mnt/projects/cleocode/packages/core/src/tasks/evidence.ts` (add helper near line 207)
- **Acceptance**: `extractAcFilePaths("AC-1: edit foo.ts | AC-2: tests in bar.test.ts")` returns `["foo.ts","bar.test.ts"]` | covers absolute and relative paths | rejects pure prose ACs with empty array
- **Evidence atom**: `commit:<sha>;files:packages/core/src/tasks/evidence.ts;tool:test`
- **Depends-on**: none

#### Subtask 1.2: Run `git show --name-only` inside validateCommit

- **ID**: T-PRIME-T01-P1-S2
- **Type**: subtask
- **Kind**: work
- **Size**: small
- **Atomic action**: Add `getCommitTouchedFiles(sha, projectRoot): Promise<string[]>` using `execFile('git', ['show', '--name-only', '--pretty=', sha])`; return parsed file list. Cache by sha within a single `cleo verify` invocation.
- **Files**: `/mnt/projects/cleocode/packages/core/src/tasks/evidence.ts` (add near line 427 `validateCommit`)
- **Acceptance**: returns deterministic list | uses execFile not shell-out string | errors when sha unreachable surface as `E_EVIDENCE_STALE`
- **Evidence atom**: `commit:<sha>;files:packages/core/src/tasks/evidence.ts;tool:test`
- **Depends-on**: T-PRIME-T01-P1-S1

#### Subtask 1.3: Intersect commit diff with AC paths; reject empty intersection

- **ID**: T-PRIME-T01-P1-S3
- **Type**: subtask
- **Kind**: work
- **Size**: small
- **Atomic action**: In `validateCommit` (`evidence.ts:427`), after fetching touched files, compute set intersection with AC paths from S1; when intersection is empty AND AC paths is non-empty, return `{ ok:false, code:'E_EVIDENCE_INSUFFICIENT', reason:'commit touched no AC files' }`.
- **Files**: `/mnt/projects/cleocode/packages/core/src/tasks/evidence.ts:427-500`
- **Acceptance**: empty intersection → `E_EVIDENCE_INSUFFICIENT` | non-empty intersection → existing pass-through path unchanged | prose-only AC (no paths) → fallback to current behavior with explicit log line
- **Evidence atom**: `commit:<sha>;files:packages/core/src/tasks/evidence.ts;tool:test`
- **Depends-on**: T-PRIME-T01-P1-S2

#### Subtask 1.4: Reject `--override` on `implemented` and `testsPassed`

- **ID**: T-PRIME-T01-P1-S4
- **Type**: subtask
- **Kind**: work
- **Size**: small
- **Atomic action**: In `validateEvidence`/dispatch path, when atom contains `--override` or `override:true` for gate ∈ {`implemented`, `testsPassed`} and `process.env.CLEO_OWNER_OVERRIDE !== '1'`, return `E_EVIDENCE_INVALID_DECISION` with reason `"override-not-permitted-on-critical-gate"`.
- **Files**: `/mnt/projects/cleocode/packages/core/src/tasks/evidence.ts` (dispatch around lines 200-260 + `revalidateEvidence` at 1112)
- **Acceptance**: `cleo verify --gate implemented --evidence "note:override"` → rejected | env-gated override path still works and writes audit line | `documented`/`cleanupDone`/`securityPassed` gates still accept override
- **Evidence atom**: `commit:<sha>;files:packages/core/src/tasks/evidence.ts;tool:test`
- **Depends-on**: T-PRIME-T01-P1-S3

#### Subtask 1.5: Integration test — AC file A, commit touches file B → fails

- **ID**: T-PRIME-T01-P1-S5
- **Type**: subtask
- **Kind**: work
- **Size**: small
- **Atomic action**: New integration test in `packages/core/src/tasks/evidence.test.ts` (or new `evidence.integration.test.ts`): seed fake task with AC mentioning `foo.ts`, create real commit touching `bar.ts` in a tmp git worktree, run `validateCommit`, assert `code === 'E_EVIDENCE_INSUFFICIENT'`.
- **Files**: `/mnt/projects/cleocode/packages/core/src/tasks/evidence.integration.test.ts` (new)
- **Acceptance**: test runs in vitest | uses tmp git init not real repo | green after S3+S4 land | red if S3 or S4 are reverted (regression-protective)
- **Evidence atom**: `commit:<sha>;files:packages/core/src/tasks/evidence.integration.test.ts;tool:test`
- **Depends-on**: T-PRIME-T01-P1-S4

#### Subtask 1.6: Document hardening in TSDoc + CLEO-INJECTION error table

- **ID**: T-PRIME-T01-P1-S6
- **Type**: subtask
- **Kind**: work
- **Size**: small
- **Atomic action**: Add TSDoc to `validateCommit` describing the AC-intersection check; add row to `~/.cleo/templates/CLEO-INJECTION.md` error-handling table for `E_EVIDENCE_INVALID_DECISION` on critical gates.
- **Files**: `/mnt/projects/cleocode/packages/core/src/tasks/evidence.ts` (TSDoc only) | `/mnt/projects/cleocode/.cleo/templates/CLEO-INJECTION.md` (or canonical injection template path)
- **Acceptance**: TSDoc passes forge-ts coverage | injection error table contains new row
- **Evidence atom**: `commit:<sha>;files:packages/core/src/tasks/evidence.ts;tool:lint;tool:typecheck`
- **Depends-on**: T-PRIME-T01-P1-S5

### Phase 2: BBTT W0/W1/W2/W3 close-out — re-verify 13 mis-completed tasks + ship pending BBTT items

- **Task ID**: T-PRIME-T01-P2
- **Type**: task
- **Kind**: work
- **Severity**: P1
- **Size**: large
- **Files touched**: `/mnt/projects/cleocode/packages/core/src/memory/session-memory.ts` | `/mnt/projects/cleocode/packages/core/src/memory/extraction-gate.ts` | `/mnt/projects/cleocode/packages/contracts/src/brain.ts` | `/mnt/projects/cleocode/packages/cleo/src/cli/commands/memory.ts` | `/mnt/projects/cleocode/packages/cleo/src/cli/commands/doctor.ts` | `/mnt/projects/cleocode/packages/cleo/src/cli/commands/briefing.ts` | `/mnt/projects/cleocode/scripts/freshness-sentinel.ts` (new) | `/mnt/projects/cleocode/.github/workflows/freshness-sentinel.yml` (extend) | `/mnt/projects/cleocode/packages/core/src/tasks/add.ts` (test-fixture gate at write-time)
- **Depends-on**: T-PRIME-T01-P1 (validator must be hardened first — otherwise re-verify would still accept lies)
- **Acceptance**: AC-3 | AC-7 (BBTT W2-1)
- **Evidence atoms required at complete**: `commit:<sha>;files:<aggregate>` | `tool:test` | `tool:lint;tool:typecheck`

#### Subtask 2.1: BBTT W1-1 — verify recency mode wired in searchBrainCompact

- **ID**: T-PRIME-T01-P2-S1
- **Type**: subtask
- **Kind**: bug
- **Size**: small
- **Atomic action**: Audit `searchBrainCompact` and `session-memory.ts:416` to confirm recency-mode branch is reached when scope-query is empty. Add a unit test that seeds 1 fresh + 1 11-day-old obs and asserts fresh wins in default-scope path.
- **Files**: `/mnt/projects/cleocode/packages/core/src/memory/session-memory.ts` | `/mnt/projects/cleocode/packages/core/src/memory/session-memory.test.ts` (extend)
- **Acceptance**: regression test green | red if recency branch is reverted to BM25-default
- **Evidence atom**: `commit:<sha>;files:packages/core/src/memory/session-memory.test.ts;tool:test`
- **Depends-on**: T-PRIME-T01-P1-S5

#### Subtask 2.2: BBTT W1-2 — pattern dedup at consolidation time

- **ID**: T-PRIME-T01-P2-S2
- **Type**: subtask
- **Kind**: work
- **Size**: medium
- **Atomic action**: In `brain-lifecycle.ts`/`runConsolidation`, before inserting a new `brain_patterns` row, compute simhash of pattern body and skip if a row with `simhash` within Hamming-3 already exists. Add `simhash TEXT` column (migration delegated to T02-P1-S6 — depends-on).
- **Files**: `/mnt/projects/cleocode/packages/core/src/memory/brain-lifecycle.ts` | `/mnt/projects/cleocode/packages/core/src/store/memory-schema.ts` (add column) | new migration file
- **Acceptance**: simhash collision counts logged | new test seeds 5 near-duplicate patterns and asserts only 1 row inserted
- **Evidence atom**: `commit:<sha>;files:packages/core/src/memory/brain-lifecycle.ts,packages/core/src/store/memory-schema.ts;tool:test`
- **Depends-on**: T-PRIME-T02-P1-S1 (schema migration runner — T02 owns migration framework)

#### Subtask 2.3: BBTT W1-3 — field-name contract types + runtime assertion

- **ID**: T-PRIME-T01-P2-S3
- **Type**: subtask
- **Kind**: work
- **Size**: small
- **Atomic action**: Centralize the `BrainObservationFields` field-name string union in `packages/contracts/src/brain.ts`. Add runtime `assertBrainFieldName(name)` helper. Use it at every `INSERT INTO brain_*` site.
- **Files**: `/mnt/projects/cleocode/packages/contracts/src/brain.ts` (new union + helper) | `/mnt/projects/cleocode/packages/core/src/memory/auto-extract.ts` | `/mnt/projects/cleocode/packages/core/src/memory/extraction-gate.ts`
- **Acceptance**: unit test passes invalid name → throws `E_VALIDATION` | every brain-writer call site references the contract
- **Evidence atom**: `commit:<sha>;files:packages/contracts/src/brain.ts;tool:test`
- **Depends-on**: T-PRIME-T01-P1-S5

#### Subtask 2.4: BBTT W2-1 — `cleo memory dream --status` returns full schema + non-zero on overdue

- **ID**: T-PRIME-T01-P2-S4
- **Type**: subtask
- **Kind**: work
- **Size**: medium
- **Atomic action**: Extend `cleo memory dream --status` to return `{lastConsolidatedAt, observationsSinceLastConsolidation, idleMinutesSinceLastRetrieval, tickLoopAlive, isOverdue}`. Exit code 2 when `isOverdue` AND `--status` invoked.
- **Files**: `/mnt/projects/cleocode/packages/cleo/src/cli/commands/memory.ts` | `/mnt/projects/cleocode/packages/core/src/memory/dream-cycle.ts` (add `getDreamStatus()` export)
- **Acceptance**: CLI smoke `cleo memory dream --status --json` returns the 5 fields | exit code 0 when fresh, 2 when overdue | tests cover both states
- **Evidence atom**: `commit:<sha>;files:packages/cleo/src/cli/commands/memory.ts,packages/core/src/memory/dream-cycle.ts;tool:test`
- **Depends-on**: T-PRIME-T01-P1-S5

#### Subtask 2.5: BBTT W2-3 — opportunistic dream trigger from `cleo briefing` (5-min cooldown)

- **ID**: T-PRIME-T01-P2-S5
- **Type**: subtask
- **Kind**: work
- **Size**: small
- **Atomic action**: In `briefing` command handler, after assembling output, check `getDreamStatus().idleMinutesSinceLastRetrieval > 0 && (now - lastTriggered > 5min)`. If yes, fire `triggerDreamOpportunistic()` (non-blocking, writes a timestamp to brain.db).
- **Files**: `/mnt/projects/cleocode/packages/cleo/src/cli/commands/briefing.ts` | `/mnt/projects/cleocode/packages/core/src/memory/dream-cycle.ts`
- **Acceptance**: dream not triggered on rapid sequential briefings (<5min) | dream triggered when stale | non-blocking — briefing latency unchanged in benchmark
- **Evidence atom**: `commit:<sha>;files:packages/cleo/src/cli/commands/briefing.ts;tool:test`
- **Depends-on**: T-PRIME-T01-P2-S4

#### Subtask 2.6: BBTT W2-4 — `cleo doctor brain` health dashboard

- **ID**: T-PRIME-T01-P2-S6
- **Type**: subtask
- **Kind**: work
- **Size**: medium
- **Atomic action**: Extend `cleo doctor brain` (`commands/doctor.ts`) to emit the 6 health metrics: `origin coverage %`, `pattern/observation ratio`, `learning/observation ratio`, `dream age hours`, `auto-extract invocation/promoted/rejected`, `daemon liveness`. Plain text + JSON modes.
- **Files**: `/mnt/projects/cleocode/packages/cleo/src/cli/commands/doctor.ts` | `/mnt/projects/cleocode/packages/core/src/memory/brain-doctor.ts`
- **Acceptance**: `cleo doctor brain --json` returns the 6 keys | text mode is single-screen readable
- **Evidence atom**: `commit:<sha>;files:packages/cleo/src/cli/commands/doctor.ts;tool:test`
- **Depends-on**: T-PRIME-T01-P2-S4

#### Subtask 2.7: BBTT W2-5 — freshness-sentinel CI gate (daily, alert when overdue >24h)

- **ID**: T-PRIME-T01-P2-S7
- **Type**: subtask
- **Kind**: work
- **Size**: small
- **Atomic action**: Extend `/mnt/projects/cleocode/.github/workflows/freshness-sentinel.yml` to run `cleo memory dream --status --json | jq '.isOverdue'`; fail workflow when true. Open GitHub issue via `gh` when failed.
- **Files**: `/mnt/projects/cleocode/.github/workflows/freshness-sentinel.yml` | `/mnt/projects/cleocode/scripts/freshness-sentinel.ts` (helper)
- **Acceptance**: workflow exits 1 when overdue | new GH issue opened with `automated:brain-overdue` label
- **Evidence atom**: `commit:<sha>;files:.github/workflows/freshness-sentinel.yml,scripts/freshness-sentinel.ts;tool:test`
- **Depends-on**: T-PRIME-T01-P2-S4

#### Subtask 2.8: BBTT W3-3 — `cleo doctor scan-test-fixtures-in-prod` CLI

- **ID**: T-PRIME-T01-P2-S8
- **Type**: subtask
- **Kind**: work
- **Size**: small
- **Atomic action**: New subcommand `cleo doctor scan-test-fixtures-in-prod` greps brain.db for `origin='test'`, `id LIKE '%E1%' OR id LIKE 'T932EP%'`, agent regex `/^test-/`. Reports counts. Exit 1 if any rows in production scope.
- **Files**: `/mnt/projects/cleocode/packages/cleo/src/cli/commands/doctor.ts` (new subcommand) | `/mnt/projects/cleocode/packages/core/src/memory/brain-noise-detector.ts` (NEW — shared detector, T02 also uses)
- **Acceptance**: clean DB → exit 0 | seed one E1-prefixed row → exit 1 | `--json` returns row count + sample IDs
- **Evidence atom**: `commit:<sha>;files:packages/cleo/src/cli/commands/doctor.ts,packages/core/src/memory/brain-noise-detector.ts;tool:test`
- **Depends-on**: T-PRIME-T02-P2-S1 (origin column must exist)

#### Subtask 2.9: BBTT W3-4 — test-DB isolation via `assertTestEnv()` + CI gate

- **ID**: T-PRIME-T01-P2-S9
- **Type**: subtask
- **Kind**: work
- **Size**: small
- **Atomic action**: Add `assertTestEnv(projectRoot: string)` helper. When `process.env.CLEO_TEST_MODE === '1'` AND `projectRoot` resolves to the live cleocode repo, throw `E_TEST_DB_LEAK`. Wire into test setup files. Add CI step that runs full test suite + asserts `git diff --quiet .cleo/tasks.db .cleo/brain.db`.
- **Files**: `/mnt/projects/cleocode/packages/core/src/test-support/assert-test-env.ts` (new) | `/mnt/projects/cleocode/packages/core/vitest.setup.ts` | `/mnt/projects/cleocode/.github/workflows/ci.yml` (add step)
- **Acceptance**: running tests with `CLEO_TEST_MODE=1` in live repo throws | CI fails if test run mutates `.cleo/tasks.db` working tree
- **Evidence atom**: `commit:<sha>;files:packages/core/src/test-support/assert-test-env.ts,.github/workflows/ci.yml;tool:test`
- **Depends-on**: T-PRIME-T01-P1-S5

#### Subtask 2.10: BBTT W3-5 — auto-extract repair surface metrics + threshold lowering

- **ID**: T-PRIME-T01-P2-S10
- **Type**: subtask
- **Kind**: work
- **Size**: medium
- **Atomic action**: Surface `invocation/candidate/promoted/rejected` counters from `auto-extract.ts` to `brain-doctor.ts`. Lower promotion threshold from current 8 → 5 matching observations. Assert: 5+ matching observations produces a learning row.
- **Files**: `/mnt/projects/cleocode/packages/core/src/memory/auto-extract.ts` | `/mnt/projects/cleocode/packages/core/src/memory/brain-doctor.ts`
- **Acceptance**: counters exposed in `cleo doctor brain --json` | new integration test seeds 5 similar obs → asserts learning row created
- **Evidence atom**: `commit:<sha>;files:packages/core/src/memory/auto-extract.ts;tool:test`
- **Depends-on**: T-PRIME-T01-P2-S6

#### Subtask 2.11: Re-verify T9220 with `tool:test` + `commit:<sha>;files:...`

- **ID**: T-PRIME-T01-P2-S11
- **Type**: subtask
- **Kind**: bug
- **Size**: small
- **Atomic action**: Resolve actual commit SHA for original T9220 work; run `cleo verify T9220 --gate implemented --evidence "commit:<sha>;files:<paths>"` + `cleo verify T9220 --gate testsPassed --evidence "tool:test"`. NO `--override`.
- **Files**: brain.db row update only
- **Acceptance**: `brain_promotion_log` row for T9220 has both atoms, no override flag | `cleo show T9220` displays both gates as `verified`
- **Evidence atom**: `commit:<sha>;files:<verified-paths>;tool:test`
- **Depends-on**: T-PRIME-T01-P1-S5

#### Subtask 2.12: Re-verify T9222

- **ID**: T-PRIME-T01-P2-S12
- **Type**: subtask
- **Kind**: bug
- **Size**: small
- **Atomic action**: Same pattern as S11 for T9222.
- **Files**: brain.db only
- **Acceptance**: T9222 verified with real atoms
- **Evidence atom**: `commit:<sha>;files:<paths>;tool:test`
- **Depends-on**: T-PRIME-T01-P1-S5

#### Subtask 2.13: Re-verify T9223

- **ID**: T-PRIME-T01-P2-S13
- **Type**: subtask
- **Kind**: bug
- **Size**: small
- **Atomic action**: Same pattern as S11 for T9223.
- **Files**: brain.db only
- **Acceptance**: T9223 verified with real atoms
- **Evidence atom**: `commit:<sha>;files:<paths>;tool:test`
- **Depends-on**: T-PRIME-T01-P1-S5

#### Subtask 2.14: Re-verify T9224

- **ID**: T-PRIME-T01-P2-S14
- **Type**: subtask
- **Kind**: bug
- **Size**: small
- **Atomic action**: Same pattern as S11 for T9224.
- **Files**: brain.db only
- **Acceptance**: T9224 verified with real atoms
- **Evidence atom**: `commit:<sha>;files:<paths>;tool:test`
- **Depends-on**: T-PRIME-T01-P1-S5

#### Subtask 2.15: Re-verify T9227

- **ID**: T-PRIME-T01-P2-S15
- **Type**: subtask
- **Kind**: bug
- **Size**: small
- **Atomic action**: Same pattern as S11 for T9227.
- **Files**: brain.db only
- **Acceptance**: T9227 verified with real atoms
- **Evidence atom**: `commit:<sha>;files:<paths>;tool:test`
- **Depends-on**: T-PRIME-T01-P1-S5

#### Subtask 2.16: Re-verify T1897

- **ID**: T-PRIME-T01-P2-S16
- **Type**: subtask
- **Kind**: bug
- **Size**: small
- **Atomic action**: Same pattern as S11 for T1897.
- **Files**: brain.db only
- **Acceptance**: T1897 verified with real atoms
- **Evidence atom**: `commit:<sha>;files:<paths>;tool:test`
- **Depends-on**: T-PRIME-T01-P1-S5

#### Subtask 2.17: Re-verify T1899

- **ID**: T-PRIME-T01-P2-S17
- **Type**: subtask
- **Kind**: bug
- **Size**: small
- **Atomic action**: Same pattern as S11 for T1899.
- **Files**: brain.db only
- **Acceptance**: T1899 verified with real atoms
- **Evidence atom**: `commit:<sha>;files:<paths>;tool:test`
- **Depends-on**: T-PRIME-T01-P1-S5

#### Subtask 2.18: Re-verify T1906

- **ID**: T-PRIME-T01-P2-S18
- **Type**: subtask
- **Kind**: bug
- **Size**: small
- **Atomic action**: Same pattern as S11 for T1906.
- **Files**: brain.db only
- **Acceptance**: T1906 verified with real atoms
- **Evidence atom**: `commit:<sha>;files:<paths>;tool:test`
- **Depends-on**: T-PRIME-T01-P1-S5

#### Subtask 2.19: Re-verify T9172

- **ID**: T-PRIME-T01-P2-S19
- **Type**: subtask
- **Kind**: bug
- **Size**: small
- **Atomic action**: Same pattern as S11 for T9172.
- **Files**: brain.db only
- **Acceptance**: T9172 verified with real atoms
- **Evidence atom**: `commit:<sha>;files:<paths>;tool:test`
- **Depends-on**: T-PRIME-T01-P1-S5

#### Subtask 2.20: Re-verify T1467

- **ID**: T-PRIME-T01-P2-S20
- **Type**: subtask
- **Kind**: bug
- **Size**: small
- **Atomic action**: Same pattern as S11 for T1467.
- **Files**: brain.db only
- **Acceptance**: T1467 verified with real atoms
- **Evidence atom**: `commit:<sha>;files:<paths>;tool:test`
- **Depends-on**: T-PRIME-T01-P1-S5

#### Subtask 2.21: Re-verify T1693

- **ID**: T-PRIME-T01-P2-S21
- **Type**: subtask
- **Kind**: bug
- **Size**: small
- **Atomic action**: Same pattern as S11 for T1693.
- **Files**: brain.db only
- **Acceptance**: T1693 verified with real atoms
- **Evidence atom**: `commit:<sha>;files:<paths>;tool:test`
- **Depends-on**: T-PRIME-T01-P1-S5

#### Subtask 2.22: Re-verify T9194

- **ID**: T-PRIME-T01-P2-S22
- **Type**: subtask
- **Kind**: bug
- **Size**: small
- **Atomic action**: Same pattern as S11 for T9194.
- **Files**: brain.db only
- **Acceptance**: T9194 verified with real atoms
- **Evidence atom**: `commit:<sha>;files:<paths>;tool:test`
- **Depends-on**: T-PRIME-T01-P1-S5

#### Subtask 2.23: Re-verify T9173

- **ID**: T-PRIME-T01-P2-S23
- **Type**: subtask
- **Kind**: bug
- **Size**: small
- **Atomic action**: Same pattern as S11 for T9173.
- **Files**: brain.db only
- **Acceptance**: T9173 verified with real atoms
- **Evidence atom**: `commit:<sha>;files:<paths>;tool:test`
- **Depends-on**: T-PRIME-T01-P1-S5

#### Subtask 2.24: Audit: assert no `--override` used in 13 re-verifies

- **ID**: T-PRIME-T01-P2-S24
- **Type**: subtask
- **Kind**: validator
- **Size**: small
- **Atomic action**: SQL query against brain.db `SELECT task_id, evidence_json FROM brain_promotion_log WHERE task_id IN (<13 IDs>) AND evidence_json LIKE '%override%'` — must return 0 rows. Add this query as a regression check in `cleo doctor brain`.
- **Files**: `/mnt/projects/cleocode/packages/core/src/memory/brain-doctor.ts` (add check) | `/mnt/projects/cleocode/scripts/audit-bbtt-reverify.mjs` (one-shot)
- **Acceptance**: regression check passes | embedded into `cleo doctor brain --strict`
- **Evidence atom**: `commit:<sha>;files:packages/core/src/memory/brain-doctor.ts,scripts/audit-bbtt-reverify.mjs;tool:test`
- **Depends-on**: T-PRIME-T01-P2-S23

### Phase 3: Daemon liveness — install + cwd fix + reverify T1682/T1636

- **Task ID**: T-PRIME-T01-P3
- **Type**: task
- **Kind**: work
- **Severity**: P1
- **Size**: medium
- **Files touched**: `/mnt/projects/cleocode/packages/cleo/src/cli/commands/daemon.ts` | `/mnt/projects/cleocode/packages/cleo/scripts/install-daemon-service.mjs` | systemd unit file (created by install script) | `/mnt/projects/cleocode/packages/core/src/sentient/daemon.ts`
- **Depends-on**: T-PRIME-T01-P1 (validator), T-PRIME-T01-P2-S4 (dream-status schema)
- **Acceptance**: AC-4 | AC-5
- **Evidence atoms required at complete**: `commit:<sha>;files:<aggregate>` | `tool:test` | `tool:lint;tool:typecheck`

#### Subtask 3.1: Replace `process.cwd()` with project-root resolution in daemon command

- **ID**: T-PRIME-T01-P3-S1
- **Type**: subtask
- **Kind**: bug
- **Size**: small
- **Atomic action**: At `daemon.ts:195` (and the 2 other `process.cwd()` sites at 316, 455), replace with `resolveProjectRoot(env.CLEO_PROJECT_ROOT) ?? findFirstAncestorWithCleoDir()`. Add `resolveProjectRoot` helper if not present.
- **Files**: `/mnt/projects/cleocode/packages/cleo/src/cli/commands/daemon.ts:195,316,455`
- **Acceptance**: daemon launched from `/tmp` resolves to repo root when `CLEO_PROJECT_ROOT` set | falls back to ancestor walk when unset
- **Evidence atom**: `commit:<sha>;files:packages/cleo/src/cli/commands/daemon.ts;tool:test`
- **Depends-on**: T-PRIME-T01-P1-S5

#### Subtask 3.2: Install `cleo-daemon.service` via systemd-user template

- **ID**: T-PRIME-T01-P3-S2
- **Type**: subtask
- **Kind**: work
- **Size**: medium
- **Atomic action**: Update `install-daemon-service.mjs` to write `~/.config/systemd/user/cleo-daemon.service` with `WorkingDirectory=<absolute>` (passed via flag), `Restart=on-failure`, `Environment=CLEO_PROJECT_ROOT=<absolute>`. Idempotent: rewrite + `systemctl --user daemon-reload && enable --now`.
- **Files**: `/mnt/projects/cleocode/packages/cleo/scripts/install-daemon-service.mjs`
- **Acceptance**: `cleo daemon install` succeeds on Linux | re-run is idempotent | unit file contains `WorkingDirectory=` and `CLEO_PROJECT_ROOT=`
- **Evidence atom**: `commit:<sha>;files:packages/cleo/scripts/install-daemon-service.mjs;tool:test`
- **Depends-on**: T-PRIME-T01-P3-S1

#### Subtask 3.3: Add `cleo daemon install` command surface + tests

- **ID**: T-PRIME-T01-P3-S3
- **Type**: subtask
- **Kind**: work
- **Size**: small
- **Atomic action**: Add `install` subcommand in `daemon.ts` that invokes `install-daemon-service.mjs` with the resolved project root. Skip on non-Linux with a clear error envelope.
- **Files**: `/mnt/projects/cleocode/packages/cleo/src/cli/commands/daemon.ts`
- **Acceptance**: `cleo daemon install --project-root <path>` runs cleanly | non-Linux returns `E_PLATFORM_UNSUPPORTED`
- **Evidence atom**: `commit:<sha>;files:packages/cleo/src/cli/commands/daemon.ts;tool:test`
- **Depends-on**: T-PRIME-T01-P3-S2

#### Subtask 3.4: Re-verify T1682 with `systemctl is-active = active` evidence

- **ID**: T-PRIME-T01-P3-S4
- **Type**: subtask
- **Kind**: bug
- **Size**: small
- **Atomic action**: Capture `systemctl --user is-active cleo-daemon` output (must be `active`), embed in evidence note. `cleo verify T1682 --gate implemented --evidence "commit:<sha>;files:packages/cleo/src/cli/commands/daemon.ts,packages/cleo/scripts/install-daemon-service.mjs;note:systemctl-active"`.
- **Files**: brain.db only
- **Acceptance**: T1682 verified with daemon-active evidence
- **Evidence atom**: `commit:<sha>;files:<paths>;tool:test;note:systemctl-active`
- **Depends-on**: T-PRIME-T01-P3-S3

#### Subtask 3.5: Re-verify T1636

- **ID**: T-PRIME-T01-P3-S5
- **Type**: subtask
- **Kind**: bug
- **Size**: small
- **Atomic action**: Same pattern as S4 for T1636.
- **Files**: brain.db only
- **Acceptance**: T1636 verified with daemon-active evidence
- **Evidence atom**: `commit:<sha>;files:<paths>;tool:test;note:systemctl-active`
- **Depends-on**: T-PRIME-T01-P3-S3

#### Subtask 3.6: 7-day soak — `isOverdue:false` continuous

- **ID**: T-PRIME-T01-P3-S6
- **Type**: subtask
- **Kind**: validator
- **Size**: small
- **Atomic action**: Cron-style log every hour for 7 days of `cleo memory dream --status --json`. Owner reviews; subtask completes when 168 contiguous samples show `isOverdue:false`.
- **Files**: `/mnt/projects/cleocode/.cleo/audit/daemon-soak.jsonl` (append-log)
- **Acceptance**: 168 contiguous samples logged | zero `isOverdue:true` entries
- **Evidence atom**: `files:.cleo/audit/daemon-soak.jsonl;note:7d-clean-window`
- **Depends-on**: T-PRIME-T01-P3-S5

---

# Tier Epic: E-PRIME-T02 — Provenance & Quarantine

## Epic Identity

- **ID**: E-PRIME-T02
- **Title**: Provenance & Quarantine — origin columns + writer funnel + auto-extract repair
- **Type**: epic
- **Kind**: work
- **Severity**: P0 — corrupts every later tier if origin/lineage absent
- **Size**: large
- **Parent**: E-PRIME-SENTIENCE
- **Depends-on**: E-PRIME-T01 (validator must reject lies before we trust new evidence)
- **Wave**: W0 (schema lock-in) + W1 (writer funnel) + W2 (auto-extract repair)
- **References masterplan §**: §5 Tier 2.1–2.5, §13 (file refs), §16.A (T1900 is verify-only)

## Vision

Make every BRAIN row carry verifiable lineage (origin + provenance_chain + validated_at). Test fixtures never reach production briefing. The four-fix auto-extract pipeline funnels every write through `verifyAndStore` — one chokepoint. T1903 promotion-log idempotency closes the silent-failure window. The already-shipped BM25-recency fix gets a regression test that locks it forward.

## Acceptance Criteria (Epic-level, pipe-separated)

AC-1: `SELECT COUNT(*) FROM brain_observations WHERE origin IS NULL` == 0 in production within 7 days of ship. | AC-2: `pattern_count / observation_count` ≤ 2.0 sustained. | AC-3: `learning_count / observation_count` ≥ 0.05 sustained. | AC-4: Last dream cycle < 24h continuously. | AC-5: `cleo memory find --source-type test` returns rows; `cleo briefing` context never includes them. | AC-6: `cleo doctor scan-test-fixtures-in-prod` returns clean on production. | AC-7: `verify-provenance-writers.mjs` AST-grep allowlist check passes in CI. | AC-8: `brain_promotion_log.fulfilled_at` + `fulfillment_note` are first-class Drizzle schema fields (no try/catch parity). | AC-9: BM25-recency regression test seeds 1 fresh + 1 11-day obs and asserts fresh wins.

## Milestone Gates (proving improvement — measurable health metrics)

- **M0 (baseline, today 2026-05-15)**:
  - `% brain_observations with origin column non-null` = 0% (column missing)
  - `% tasks with origin column non-null` = 0% (column missing)
  - `count(brain_writers bypassing verifyAndStore)` ≥ 4 (auto-extract has 4 direct-write sites per §5 Tier 2.3)
  - `auto-extract promotion ratio (promoted/invoked)` = unknown (not surfaced)
  - `pattern_count / observation_count` = >2.0 (per masterplan §3.2 baseline)
  - `learning_count / observation_count` < 0.05 (auto-extract broken)
  - `T1903 promotion-log try/catch swallow events per week` ≥ 1 (silent failures)
- **M1 (after Phase 1 — schema migration)**:
  - `% brain_observations with origin column non-null` ≥ 95% (new rows + backfill)
  - `% tasks with origin column non-null` = 100% (NOT NULL DEFAULT)
- **M2 (after Phase 2 — writer funnel)**:
  - `count(brain_writers bypassing verifyAndStore)` = 0 (AST-grep CI gate enforces)
  - `verify-provenance-writers.mjs` exits 0 in CI
- **M3 (after Phase 3 — quarantine)**:
  - `cleo briefing` output contains zero `origin='test'` rows on a corrupted-DB fixture
  - `cleo doctor scan-test-fixtures-in-prod` exit code = 0 (clean)
- **M4 (after Phase 4 — auto-extract repair)**:
  - `auto-extract promotion ratio` ≥ 5/5 on a seeded 5-similar-obs test
  - `learning_count / observation_count` ≥ 0.05 over 7 days
- **M5 (after Phase 5 — T1903 + T1900 regression)**:
  - `brain_promotion_log.fulfilled_at IS NULL` rate ≤ 1% (only in-flight rows)
  - BM25-recency regression test green; locks the §16.A already-shipped fix
- **M6 (epic complete)**:
  - All M1–M5 metrics hold for 7 contiguous days
  - `cleo doctor brain --strict` exit 0

## Phase Tasks

### Phase 1: Schema lock-in — origin + validated_at + provenance_chain (W0)

- **Task ID**: T-PRIME-T02-P1
- **Type**: task
- **Kind**: work
- **Severity**: P0
- **Size**: medium
- **Files touched**: `/mnt/projects/cleocode/packages/core/src/store/memory-schema.ts` | `/mnt/projects/cleocode/packages/core/src/store/conduit-schema.ts` | new migration files under `/mnt/projects/cleocode/packages/core/migrations/drizzle-brain/` and `/mnt/projects/cleocode/packages/core/migrations/drizzle-conduit/`
- **Depends-on**: E-PRIME-T01 epic (validator hardened)
- **Acceptance**: AC-1 (schema present; backfill enforced in P2) | AC-8 (T1903 columns first-class)
- **Evidence atoms required at complete**: `commit:<sha>;files:<schema + migrations>` | `tool:test` | `tool:lint;tool:typecheck`

#### Subtask 1.1: Migration runner harness — drizzle-brain auto-apply

- **ID**: T-PRIME-T02-P1-S1
- **Type**: subtask
- **Kind**: work
- **Size**: small
- **Atomic action**: Confirm/extend `packages/core/scripts/run-migrations.mjs` (or equivalent) applies any `migrations/drizzle-brain/<ts>_*/migration.sql` on first DB open. Idempotent on re-run.
- **Files**: `/mnt/projects/cleocode/packages/core/scripts/run-migrations.mjs` (or harness path)
- **Acceptance**: empty DB → applies all migrations | already-migrated → no-op | failed migration → atomic rollback
- **Evidence atom**: `commit:<sha>;files:packages/core/scripts/run-migrations.mjs;tool:test`
- **Depends-on**: none (W0 first wave)

#### Subtask 1.2: Add `origin TEXT NOT NULL DEFAULT 'manual'` to `tasks` (conduit-schema)

- **ID**: T-PRIME-T02-P1-S2
- **Type**: subtask
- **Kind**: work
- **Size**: small
- **Atomic action**: Edit `conduit-schema.ts` to add the column. Create migration `<ts>_tasks_origin_column/migration.sql` with `ALTER TABLE tasks ADD COLUMN origin TEXT NOT NULL DEFAULT 'manual'`. Add enum validator to contracts.
- **Files**: `/mnt/projects/cleocode/packages/core/src/store/conduit-schema.ts` | `/mnt/projects/cleocode/packages/core/migrations/drizzle-conduit/<ts>_tasks_origin_column/migration.sql` (new) | `/mnt/projects/cleocode/packages/contracts/src/tasks.ts`
- **Acceptance**: new task rows have origin populated | enum locked to `production|test-fixture|imported|migrated`
- **Evidence atom**: `commit:<sha>;files:<schema + migration>;tool:test`
- **Depends-on**: T-PRIME-T02-P1-S1

#### Subtask 1.3: Add `origin TEXT NOT NULL` to brain_observations

- **ID**: T-PRIME-T02-P1-S3
- **Type**: subtask
- **Kind**: work
- **Size**: small
- **Atomic action**: Add column to `memory-schema.ts` `brainObservations` table. Migration with two-step: (a) `ADD COLUMN origin TEXT`, (b) backfill existing rows to `'manual'`, (c) recreate table with `NOT NULL` via swap-and-rename (SQLite limitation). Enum: `manual|auto-extract|transcript-ingest|session-debrief|test`.
- **Files**: `/mnt/projects/cleocode/packages/core/src/store/memory-schema.ts` | `/mnt/projects/cleocode/packages/core/migrations/drizzle-brain/<ts>_brain_obs_origin/migration.sql`
- **Acceptance**: existing rows backfilled to `'manual'` | new inserts MUST specify origin | enum validated at runtime
- **Evidence atom**: `commit:<sha>;files:<schema + migration>;tool:test`
- **Depends-on**: T-PRIME-T02-P1-S1

#### Subtask 1.4: Add `validated_at INTEGER` + `provenance_chain TEXT` to brain_observations

- **ID**: T-PRIME-T02-P1-S4
- **Type**: subtask
- **Kind**: work
- **Size**: small
- **Atomic action**: Two more nullable columns on `brain_observations`. `provenance_chain` is JSON array of `{sourceType, sourceId, recordedAt}` validated by zod schema.
- **Files**: `/mnt/projects/cleocode/packages/core/src/store/memory-schema.ts` | migration | `/mnt/projects/cleocode/packages/contracts/src/brain.ts` (zod schema)
- **Acceptance**: insertion with non-JSON provenance_chain → rejected by zod | nullable fields allow gradual backfill
- **Evidence atom**: `commit:<sha>;files:<schema + migration>;tool:test`
- **Depends-on**: T-PRIME-T02-P1-S3

#### Subtask 1.5: Apply same 3-column pattern to brain_learnings, brain_patterns, brain_decisions

- **ID**: T-PRIME-T02-P1-S5
- **Type**: subtask
- **Kind**: work
- **Size**: small
- **Atomic action**: One migration adding `origin`, `validated_at`, `provenance_chain` to the three sibling tables. Same enum + zod schema.
- **Files**: `/mnt/projects/cleocode/packages/core/src/store/memory-schema.ts` | new migration
- **Acceptance**: all 4 typed-brain tables have parity origin schema
- **Evidence atom**: `commit:<sha>;files:<schema + migration>;tool:test`
- **Depends-on**: T-PRIME-T02-P1-S4

#### Subtask 1.6: T1903 — promote runtime-only `fulfilled_at` + `fulfillment_note` to Drizzle schema

- **ID**: T-PRIME-T02-P1-S6
- **Type**: subtask
- **Kind**: bug
- **Size**: small
- **Atomic action**: Add `fulfilled_at TEXT` + `fulfillment_note TEXT` to `brainPromotionLog` in `memory-schema.ts`. Remove the silent try/catch at `memory-sqlite.ts:392-397`. Create migration confirming columns exist (idempotent guard for old DBs). Remove try/catch at `brain-doctor.ts:420-430`.
- **Files**: `/mnt/projects/cleocode/packages/core/src/store/memory-schema.ts` | `/mnt/projects/cleocode/packages/core/src/store/memory-sqlite.ts:386-397` | `/mnt/projects/cleocode/packages/core/src/memory/brain-doctor.ts:420-430` | new migration
- **Acceptance**: Drizzle infers columns | no try/catch swallow in runtime DDL | brain-doctor surfaces fulfilled rows directly
- **Evidence atom**: `commit:<sha>;files:<schema + sites>;tool:test`
- **Depends-on**: T-PRIME-T02-P1-S1

#### Subtask 1.7: Add `simhash TEXT` to brain_patterns (for T01 W1-2 dedup)

- **ID**: T-PRIME-T02-P1-S7
- **Type**: subtask
- **Kind**: work
- **Size**: small
- **Atomic action**: Add nullable `simhash TEXT` column. Migration backfills NULL — population happens on next write.
- **Files**: `/mnt/projects/cleocode/packages/core/src/store/memory-schema.ts` | migration
- **Acceptance**: column added; existing rows NULL; new writes populate
- **Evidence atom**: `commit:<sha>;files:<schema + migration>;tool:test`
- **Depends-on**: T-PRIME-T02-P1-S1

### Phase 2: Writer funnel — `assertOriginIsSet` + AST-grep allowlist CI

- **Task ID**: T-PRIME-T02-P2
- **Type**: task
- **Kind**: work
- **Severity**: P0
- **Size**: medium
- **Files touched**: `/mnt/projects/cleocode/packages/core/src/memory/provenance-gate.ts` (new) | `/mnt/projects/cleocode/packages/core/src/memory/extraction-gate.ts:606` | `/mnt/projects/cleocode/packages/core/scripts/verify-provenance-writers.mjs` (new) | `/mnt/projects/cleocode/.github/workflows/ci.yml` (CI step)
- **Depends-on**: T-PRIME-T02-P1
- **Acceptance**: AC-1 (no NULL origin) | AC-7 (CI gate passes)
- **Evidence atoms required at complete**: `commit:<sha>;files:<aggregate>` | `tool:test` | `tool:lint;tool:typecheck`

#### Subtask 2.1: Create `provenance-gate.ts` with `assertOriginIsSet`

- **ID**: T-PRIME-T02-P2-S1
- **Type**: subtask
- **Kind**: work
- **Size**: small
- **Atomic action**: New module exports `assertOriginIsSet(row, callerName)`. Throws `E_PROVENANCE_MISSING` when `row.origin` falsy. Logs caller for audit.
- **Files**: `/mnt/projects/cleocode/packages/core/src/memory/provenance-gate.ts` (new)
- **Acceptance**: unit test asserts throw on missing origin | passes when set
- **Evidence atom**: `commit:<sha>;files:packages/core/src/memory/provenance-gate.ts;tool:test`
- **Depends-on**: T-PRIME-T02-P1-S5

#### Subtask 2.2: Wire `assertOriginIsSet` into `verifyAndStore` (`extraction-gate.ts:606`)

- **ID**: T-PRIME-T02-P2-S2
- **Type**: subtask
- **Kind**: work
- **Size**: small
- **Atomic action**: At `extraction-gate.ts:606`, call `assertOriginIsSet(candidate, 'verifyAndStore')` before SQL insert.
- **Files**: `/mnt/projects/cleocode/packages/core/src/memory/extraction-gate.ts:606`
- **Acceptance**: missing-origin candidate rejected before DB write
- **Evidence atom**: `commit:<sha>;files:packages/core/src/memory/extraction-gate.ts;tool:test`
- **Depends-on**: T-PRIME-T02-P2-S1

#### Subtask 2.3: AST-grep allowlist CI script — `verify-provenance-writers.mjs`

- **ID**: T-PRIME-T02-P2-S3
- **Type**: subtask
- **Kind**: work
- **Size**: medium
- **Atomic action**: Script greps for `INSERT INTO brain_*` and `db.insert(brainXxx)` patterns; loads allowlist from `.cleo/provenance-writers-allowlist.json`. Fails CI if a non-allowlisted writer found. Initial allowlist: `verifyAndStore`, `verifyAndStoreBatch`, `migrationBackfill`.
- **Files**: `/mnt/projects/cleocode/packages/core/scripts/verify-provenance-writers.mjs` (new) | `/mnt/projects/cleocode/.cleo/provenance-writers-allowlist.json` (new)
- **Acceptance**: script exits 0 on current canon | exits 1 when a new direct-write is added without allowlist edit | clear error message naming offending file:line
- **Evidence atom**: `commit:<sha>;files:packages/core/scripts/verify-provenance-writers.mjs;tool:test`
- **Depends-on**: T-PRIME-T02-P2-S2

#### Subtask 2.4: Wire CI gate into `.github/workflows/ci.yml`

- **ID**: T-PRIME-T02-P2-S4
- **Type**: subtask
- **Kind**: work
- **Size**: small
- **Atomic action**: Add a step `Provenance Writers Allowlist` running the script. Place before existing biome step.
- **Files**: `/mnt/projects/cleocode/.github/workflows/ci.yml`
- **Acceptance**: PR introducing a non-allowlisted brain insert fails CI with that step | passing PR shows green step
- **Evidence atom**: `commit:<sha>;files:.github/workflows/ci.yml;tool:test`
- **Depends-on**: T-PRIME-T02-P2-S3

#### Subtask 2.5: Backfill origin on existing brain_observations rows

- **ID**: T-PRIME-T02-P2-S5
- **Type**: subtask
- **Kind**: work
- **Size**: small
- **Atomic action**: One-shot script: rows whose `agent LIKE 'test-%'` OR `id MATCHES test-prefix regex` → `origin='test'`. All others → `origin='manual'`. Idempotent. Records counts to `.cleo/audit/origin-backfill-<date>.json`.
- **Files**: `/mnt/projects/cleocode/scripts/backfill-brain-origin.mjs` (new) | `/mnt/projects/cleocode/.cleo/audit/origin-backfill-<date>.json` (output)
- **Acceptance**: rerun is no-op | audit file captures counts | post-run `SELECT COUNT(*) WHERE origin IS NULL` = 0
- **Evidence atom**: `commit:<sha>;files:scripts/backfill-brain-origin.mjs;tool:test;note:backfill-audit`
- **Depends-on**: T-PRIME-T02-P2-S4

### Phase 3: Test-fixture quarantine (T1909) — 3-layer block

- **Task ID**: T-PRIME-T02-P3
- **Type**: task
- **Kind**: work
- **Severity**: P0
- **Size**: medium
- **Files touched**: `/mnt/projects/cleocode/packages/core/src/memory/brain-noise-detector.ts` (created in T01-P2-S8 — extended here) | `/mnt/projects/cleocode/packages/core/src/tasks/add.ts` | every brain-query call site (briefing, find, search-brain-compact)
- **Depends-on**: T-PRIME-T02-P2 (writer funnel set), T-PRIME-T01-P2-S8 (scan-test-fixtures CLI)
- **Acceptance**: AC-5 | AC-6
- **Evidence atoms required at complete**: `commit:<sha>;files:<aggregate>` | `tool:test`

#### Subtask 3.1: Heuristic detector — id/text/agent regex tags `origin='test'`

- **ID**: T-PRIME-T02-P3-S1
- **Type**: subtask
- **Kind**: work
- **Size**: small
- **Atomic action**: In `brain-noise-detector.ts`, add `detectTestOrigin(row)` returning bool; rules: id matches `/^(T932EP|E1-|test-)/`, text contains `'FIXTURE'` markers, agent matches `/^test-/`.
- **Files**: `/mnt/projects/cleocode/packages/core/src/memory/brain-noise-detector.ts`
- **Acceptance**: 10 fixture samples → all detected | 10 production samples → none detected
- **Evidence atom**: `commit:<sha>;files:packages/core/src/memory/brain-noise-detector.ts;tool:test`
- **Depends-on**: T-PRIME-T01-P2-S8

#### Subtask 3.2: Tasks gate at `add.ts` — refuse test-fixture writes without env override

- **ID**: T-PRIME-T02-P3-S2
- **Type**: subtask
- **Kind**: work
- **Size**: small
- **Atomic action**: In `tasks/add.ts`, when computed `origin === 'test-fixture'` AND `process.env.CLEO_ALLOW_TEST_FIXTURES !== '1'`, throw `E_TEST_FIXTURE_IN_PROD`.
- **Files**: `/mnt/projects/cleocode/packages/core/src/tasks/add.ts`
- **Acceptance**: `cleo add` with fixture-shaped data → rejected in prod | allowed in test env
- **Evidence atom**: `commit:<sha>;files:packages/core/src/tasks/add.ts;tool:test`
- **Depends-on**: T-PRIME-T02-P3-S1

#### Subtask 3.3: Briefing query — inject `AND COALESCE(origin,'manual') != 'test'`

- **ID**: T-PRIME-T02-P3-S3
- **Type**: subtask
- **Kind**: work
- **Size**: small
- **Atomic action**: Find every brain SELECT site used by `cleo briefing`, `cleo memory find` (production scope), and inject the WHERE clause. Centralize via `applyProductionScopeFilter(qb)` helper.
- **Files**: `/mnt/projects/cleocode/packages/core/src/memory/extraction-gate.ts` | `/mnt/projects/cleocode/packages/core/src/sessions/briefing.ts` | `/mnt/projects/cleocode/packages/core/src/memory/session-memory.ts`
- **Acceptance**: seeded test row visible in `--source-type test` query but absent from default briefing
- **Evidence atom**: `commit:<sha>;files:<sites>;tool:test`
- **Depends-on**: T-PRIME-T02-P3-S2

### Phase 4: Auto-extract end-to-end repair (T729 + T730 + T736 + T737)

- **Task ID**: T-PRIME-T02-P4
- **Type**: task
- **Kind**: work
- **Severity**: P1
- **Size**: large
- **Files touched**: `/mnt/projects/cleocode/packages/core/src/memory/transcript-extractor.ts:151` | `/mnt/projects/cleocode/packages/core/src/memory/llm-extraction.ts:360` | `/mnt/projects/cleocode/packages/core/src/memory/auto-extract.ts` | `/mnt/projects/cleocode/packages/core/src/memory/extraction-gate.ts:286` (hashDedupCheck) | `/mnt/projects/cleocode/packages/core/src/memory/brain-doctor.ts`
- **Depends-on**: T-PRIME-T02-P2 (funnel ready), T-PRIME-T02-P3 (quarantine set)
- **Acceptance**: AC-3 (learning ratio ≥ 0.05) | AC-4 (dream < 24h continuously)
- **Evidence atoms required at complete**: `commit:<sha>;files:<aggregate>` | `tool:test` | `tool:lint;tool:typecheck`

#### Subtask 4.1: T729 — Two-pass transcript reader at `transcript-extractor.ts:151`

- **ID**: T-PRIME-T02-P4-S1
- **Type**: subtask
- **Kind**: bug
- **Size**: medium
- **Atomic action**: Refactor `extractFromTranscript()`: first pass collects `Map<sessionId, parentUuid>`; second pass tags every orphan message with `parentUuid` lookup. Falls back to `unknown` only when no chain exists.
- **Files**: `/mnt/projects/cleocode/packages/core/src/memory/transcript-extractor.ts:151`
- **Acceptance**: existing orphan-rate metric drops by ≥50% on a fixture transcript | unit test seeds 3-deep parent chain
- **Evidence atom**: `commit:<sha>;files:packages/core/src/memory/transcript-extractor.ts;tool:test`
- **Depends-on**: T-PRIME-T02-P3-S3

#### Subtask 4.2: T730 — Tighten LLM JSON contract at `llm-extraction.ts:360`

- **ID**: T-PRIME-T02-P4-S2
- **Type**: subtask
- **Kind**: bug
- **Size**: medium
- **Atomic action**: Use `structured-output.ts` zod schema to constrain LLM output to `{candidates: Array<{kind, content, confidence, suggestedOrigin}>}`. Route through `verifyAndStoreBatch` instead of per-candidate direct writes.
- **Files**: `/mnt/projects/cleocode/packages/core/src/memory/llm-extraction.ts:360` | `/mnt/projects/cleocode/packages/core/src/memory/extraction-gate.ts` (ensure `verifyAndStoreBatch` exists)
- **Acceptance**: malformed LLM JSON → rejected pre-write | every candidate touches `verifyAndStore` path
- **Evidence atom**: `commit:<sha>;files:packages/core/src/memory/llm-extraction.ts;tool:test`
- **Depends-on**: T-PRIME-T02-P4-S1

#### Subtask 4.3: T736 — Funnel all direct-writes in `auto-extract.ts` through `verifyAndStore`

- **ID**: T-PRIME-T02-P4-S3
- **Type**: subtask
- **Kind**: bug
- **Size**: medium
- **Atomic action**: Audit `auto-extract.ts` for `db.insert(brain*)` calls; replace each with `verifyAndStore({...candidate, origin:'auto-extract'})`. Use the AST-grep CI gate from T02-P2-S3 as backstop.
- **Files**: `/mnt/projects/cleocode/packages/core/src/memory/auto-extract.ts`
- **Acceptance**: `verify-provenance-writers.mjs` exits 0 after this lands | no direct inserts remain
- **Evidence atom**: `commit:<sha>;files:packages/core/src/memory/auto-extract.ts;tool:test`
- **Depends-on**: T-PRIME-T02-P4-S2

#### Subtask 4.4: T737 — Extend `hashDedupCheck` (`extraction-gate.ts:286`) across all 4 typed tables

- **ID**: T-PRIME-T02-P4-S4
- **Type**: subtask
- **Kind**: bug
- **Size**: small
- **Atomic action**: Generalize `hashDedupCheck` from observations-only to loop the 4 typed tables (observations, learnings, patterns, decisions). Return `{matched, table, id}` on hit.
- **Files**: `/mnt/projects/cleocode/packages/core/src/memory/extraction-gate.ts:286`
- **Acceptance**: dedup hit on a `brain_learnings` row returns its ID | observations-only callers backward-compatible
- **Evidence atom**: `commit:<sha>;files:packages/core/src/memory/extraction-gate.ts;tool:test`
- **Depends-on**: T-PRIME-T02-P4-S3

#### Subtask 4.5: Diagnostic — emit brain-doctor event on `fulfillment_note='no-narrative'`

- **ID**: T-PRIME-T02-P4-S5
- **Type**: subtask
- **Kind**: work
- **Size**: small
- **Atomic action**: In auto-extract pipeline, when a promoted row writes `fulfillment_note='no-narrative'`, emit a counter to `brain-doctor.ts` (visible in `cleo doctor brain`).
- **Files**: `/mnt/projects/cleocode/packages/core/src/memory/auto-extract.ts` | `/mnt/projects/cleocode/packages/core/src/memory/brain-doctor.ts`
- **Acceptance**: counter visible | non-zero count surfaces in dashboard
- **Evidence atom**: `commit:<sha>;files:<sites>;tool:test`
- **Depends-on**: T-PRIME-T02-P4-S4

#### Subtask 4.6: End-to-end test — 5 similar obs → 1 learning

- **ID**: T-PRIME-T02-P4-S6
- **Type**: subtask
- **Kind**: work
- **Size**: small
- **Atomic action**: Integration test: seed 5 observations with similar content, run consolidation, assert one `brain_learnings` row created with all 5 source IDs in `provenance_chain`.
- **Files**: `/mnt/projects/cleocode/packages/core/src/memory/auto-extract.integration.test.ts` (new)
- **Acceptance**: test green | red if any of S1–S5 reverted
- **Evidence atom**: `commit:<sha>;files:packages/core/src/memory/auto-extract.integration.test.ts;tool:test`
- **Depends-on**: T-PRIME-T02-P4-S5

### Phase 5: T1900 regression test (verify-only — fix already shipped per §16.A)

- **Task ID**: T-PRIME-T02-P5
- **Type**: task
- **Kind**: validator
- **Severity**: P2
- **Size**: small
- **Files touched**: `/mnt/projects/cleocode/packages/core/src/memory/session-memory.test.ts` (extend)
- **Depends-on**: T-PRIME-T02-P1
- **Acceptance**: AC-9
- **Evidence atoms required at complete**: `commit:<sha>;files:packages/core/src/memory/session-memory.test.ts` | `tool:test`

#### Subtask 5.1: Regression test — fresh obs beats 11-day-old obs in default scope

- **ID**: T-PRIME-T02-P5-S1
- **Type**: subtask
- **Kind**: validator
- **Size**: small
- **Atomic action**: Test seeds 1 obs at `now` and 1 obs at `now - 11d`. Calls `searchBrainCompact` with empty/default scope. Asserts `results[0].id === fresh.id` (recency wins, not BM25).
- **Files**: `/mnt/projects/cleocode/packages/core/src/memory/session-memory.test.ts`
- **Acceptance**: test green on current `session-memory.ts:416` | red if regressed
- **Evidence atom**: `commit:<sha>;files:packages/core/src/memory/session-memory.test.ts;tool:test`
- **Depends-on**: T-PRIME-T01-P2-S1 (W1-1 audit already verified recency mode wired)

---

# Tier Epic: E-PRIME-CI — Cross-Cutting CI Trust Gates + Daemon Resilience

## Epic Identity

- **ID**: E-PRIME-CI
- **Title**: CI Trust Gates + Daemon Resilience — strict doctor + workflow gate + watchdog
- **Type**: epic
- **Kind**: work
- **Severity**: P1 — orthogonal to T01/T02; can ship in parallel after schema lands
- **Size**: medium
- **Parent**: E-PRIME-SENTIENCE
- **Depends-on**: E-PRIME-T01-P1 (validator hardened) | E-PRIME-T02-P1 (origin schema present — strict checks need the column)
- **Wave**: W2 (warning gate) → W∞ (blocking gate after 7d green soak)
- **References masterplan §**: §6.1, §6.2, §6.3, §7 (W2/W∞)

## Vision

A CI gate that catches BRAIN regressions automatically. Daemon resilience primitives (PRAGMA busy_timeout, watchdog process-exit, dream-overdue alarm) ensure the sentient daemon survives operator-host churn and crashes loud rather than failing silent.

## Acceptance Criteria (Epic-level, pipe-separated)

AC-1: `cleo doctor brain --strict` exits non-zero on origin coverage failure, pattern bloat, learning starvation, dream staleness — verified by 4 fault-injection env vars. | AC-2: GitHub Actions `brain-doctor` job uploads JSON artifact on every CI run; warning-mode for 7 days, then promoted to blocking. | AC-3: `CLEO_BRAIN_INJECT_FAILURE=origin cleo doctor brain --strict` exits 1. | AC-4: `applyBrainPragmas(nativeDb)` helper sets `busy_timeout=5000` on every brain.db open; `sqlite3 brain.db "PRAGMA busy_timeout"` returns 5000. | AC-5: Daemon watchdog: `kill -STOP` for 2× interval triggers self-exit code 2 + log line `WATCHDOG: cron-stale`. | AC-6: Dream-overdue alarm: `isOverdue:true` emits Tier-3 hygiene event surfaced in `cleo briefing`.

## Milestone Gates (proving improvement — measurable health metrics)

- **M0 (baseline, today 2026-05-15)**:
  - `count(CI runs with brain-doctor gate)` = 0 (job does not exist)
  - `count(brain.db sites with PRAGMA busy_timeout=5000)` = 0 (no helper exists)
  - `daemon stuck-process incidents in last 30 days` ≥ 1 (per masterplan history — daemon-died-21-days experience)
  - `count(strict-mode fault-injection envs)` = 0 (`CLEO_BRAIN_INJECT_FAILURE` does not exist)
- **M1 (after Phase 1 — strict doctor)**:
  - `count(strict-mode fault-injection envs)` = 4 (origin, pattern, learning, dream)
  - `cleo doctor brain --strict` exit-code matrix: 4 injection envs × 4 expected exit codes (1) — all asserted in test
- **M2 (after Phase 2 — CI workflow)**:
  - `count(CI runs with brain-doctor gate)` ≥ 7 (one week of green)
  - GitHub Action artifact `brain-doctor-<sha>.json` uploaded on every run
- **M3 (after Phase 3 — daemon resilience)**:
  - `count(brain.db sites with PRAGMA busy_timeout=5000)` = 100% of open sites
  - watchdog self-exit asserted in integration test (kill -STOP → process gone)
- **M4 (after gate-promotion — W∞)**:
  - `daemon stuck-process incidents in last 30 days` = 0 (after watchdog ships)
  - `brain-doctor` CI job promoted from `continue-on-error: true` → blocking after 7 contiguous green days
- **M5 (epic complete)**:
  - All M1–M4 metrics hold for 14 contiguous days

## Phase Tasks

### Phase 1: Extend `cleo doctor brain --strict`

- **Task ID**: T-PRIME-CI-P1
- **Type**: task
- **Kind**: work
- **Severity**: P1
- **Size**: medium
- **Files touched**: `/mnt/projects/cleocode/packages/core/src/memory/brain-doctor.ts` | `/mnt/projects/cleocode/packages/cleo/src/cli/commands/doctor.ts`
- **Depends-on**: E-PRIME-T02-P1 (origin schema), E-PRIME-T02-P2 (writer funnel landed)
- **Acceptance**: AC-1 | AC-3
- **Evidence atoms required at complete**: `commit:<sha>;files:<aggregate>` | `tool:test` | `tool:lint;tool:typecheck`

#### Subtask 1.1: Origin coverage check — `COUNT(origin IS NULL) == 0`

- **ID**: T-PRIME-CI-P1-S1
- **Type**: subtask
- **Kind**: work
- **Size**: small
- **Atomic action**: In `brain-doctor.ts`, add `checkOriginCoverage()` returning `{ok, nullCount, sampleIds}`. Exit non-zero in `--strict` when nullCount > 0.
- **Files**: `/mnt/projects/cleocode/packages/core/src/memory/brain-doctor.ts`
- **Acceptance**: check green on clean DB | red when 1 NULL row seeded
- **Evidence atom**: `commit:<sha>;files:packages/core/src/memory/brain-doctor.ts;tool:test`
- **Depends-on**: T-PRIME-T02-P1-S3

#### Subtask 1.2: Pattern-bloat check — `pattern_count / observation_count ≤ 2.0`

- **ID**: T-PRIME-CI-P1-S2
- **Type**: subtask
- **Kind**: work
- **Size**: small
- **Atomic action**: Add `checkPatternBloat()` returning ratio. Exit non-zero when ratio > 2.0.
- **Files**: `/mnt/projects/cleocode/packages/core/src/memory/brain-doctor.ts`
- **Acceptance**: ratio under 2.0 → pass | seed 3 patterns + 1 obs → fail with ratio 3.0
- **Evidence atom**: `commit:<sha>;files:packages/core/src/memory/brain-doctor.ts;tool:test`
- **Depends-on**: T-PRIME-CI-P1-S1

#### Subtask 1.3: Learning-liveness check — `learning_count / observation_count ≥ 0.05`

- **ID**: T-PRIME-CI-P1-S3
- **Type**: subtask
- **Kind**: work
- **Size**: small
- **Atomic action**: Add `checkLearningLiveness()`. Exit non-zero when ratio < 0.05.
- **Files**: `/mnt/projects/cleocode/packages/core/src/memory/brain-doctor.ts`
- **Acceptance**: seed 100 obs + 5 learnings → pass | 100 obs + 0 learnings → fail
- **Evidence atom**: `commit:<sha>;files:packages/core/src/memory/brain-doctor.ts;tool:test`
- **Depends-on**: T-PRIME-CI-P1-S2

#### Subtask 1.4: Dream-freshness check — `max(consolidated_at) within 24h`

- **ID**: T-PRIME-CI-P1-S4
- **Type**: subtask
- **Kind**: work
- **Size**: small
- **Atomic action**: Add `checkDreamFreshness()` from `brain_consolidation_events`. Exit non-zero when max > 24h ago.
- **Files**: `/mnt/projects/cleocode/packages/core/src/memory/brain-doctor.ts`
- **Acceptance**: fresh event → pass | stale event → fail
- **Evidence atom**: `commit:<sha>;files:packages/core/src/memory/brain-doctor.ts;tool:test`
- **Depends-on**: T-PRIME-CI-P1-S3

#### Subtask 1.5: `--strict` flag plumbed to exit code aggregation

- **ID**: T-PRIME-CI-P1-S5
- **Type**: subtask
- **Kind**: work
- **Size**: small
- **Atomic action**: In `commands/doctor.ts`, when `--strict`, OR all 4 check booleans → exit 1 if any false. Without `--strict`, always exit 0 and print warnings.
- **Files**: `/mnt/projects/cleocode/packages/cleo/src/cli/commands/doctor.ts`
- **Acceptance**: `--strict` aggregates correctly | `--json` mode emits per-check status
- **Evidence atom**: `commit:<sha>;files:packages/cleo/src/cli/commands/doctor.ts;tool:test`
- **Depends-on**: T-PRIME-CI-P1-S4

#### Subtask 1.6: Fault-injection env var `CLEO_BRAIN_INJECT_FAILURE`

- **ID**: T-PRIME-CI-P1-S6
- **Type**: subtask
- **Kind**: work
- **Size**: small
- **Atomic action**: When env set to `origin|pattern|learning|dream`, the matching check returns `{ok:false}` synthetically. Used by integration tests + CI smoke.
- **Files**: `/mnt/projects/cleocode/packages/core/src/memory/brain-doctor.ts`
- **Acceptance**: `CLEO_BRAIN_INJECT_FAILURE=origin cleo doctor brain --strict` → exit 1 | env unset → no injection
- **Evidence atom**: `commit:<sha>;files:packages/core/src/memory/brain-doctor.ts;tool:test`
- **Depends-on**: T-PRIME-CI-P1-S5

### Phase 2: CI workflow `brain-doctor` job

- **Task ID**: T-PRIME-CI-P2
- **Type**: task
- **Kind**: work
- **Severity**: P1
- **Size**: small
- **Files touched**: `/mnt/projects/cleocode/.github/workflows/ci.yml`
- **Depends-on**: T-PRIME-CI-P1
- **Acceptance**: AC-2
- **Evidence atoms required at complete**: `commit:<sha>;files:.github/workflows/ci.yml` | `tool:test`

#### Subtask 2.1: Add `brain-doctor` job (warning mode, week 1)

- **ID**: T-PRIME-CI-P2-S1
- **Type**: subtask
- **Kind**: work
- **Size**: small
- **Atomic action**: New job in ci.yml: runs `cleo doctor brain --strict --json > brain-doctor.json`; uploads as artifact. `continue-on-error: true` for the first 7 days.
- **Files**: `/mnt/projects/cleocode/.github/workflows/ci.yml`
- **Acceptance**: artifact uploaded on every CI run | failure doesn't block other jobs
- **Evidence atom**: `commit:<sha>;files:.github/workflows/ci.yml;tool:test`
- **Depends-on**: T-PRIME-CI-P1-S6

#### Subtask 2.2: 7-day green soak + trend artifact

- **ID**: T-PRIME-CI-P2-S2
- **Type**: subtask
- **Kind**: validator
- **Size**: small
- **Atomic action**: Daily review for 7 days: download `brain-doctor.json` artifact from each main-branch run; assert all green; record to `.cleo/audit/brain-doctor-soak.jsonl`.
- **Files**: `/mnt/projects/cleocode/.cleo/audit/brain-doctor-soak.jsonl`
- **Acceptance**: 7 consecutive green days | audit log present
- **Evidence atom**: `files:.cleo/audit/brain-doctor-soak.jsonl;note:7d-clean`
- **Depends-on**: T-PRIME-CI-P2-S1

#### Subtask 2.3: Promote `brain-doctor` to blocking

- **ID**: T-PRIME-CI-P2-S3
- **Type**: subtask
- **Kind**: work
- **Size**: small
- **Atomic action**: Remove `continue-on-error: true` in ci.yml. Add `brain-doctor` to branch-protection required-status-checks list.
- **Files**: `/mnt/projects/cleocode/.github/workflows/ci.yml` | branch-protection config in repo settings (note: gh api call documented in AGENTS.md)
- **Acceptance**: PR introducing brain-doctor failure now blocks merge | merged green PRs continue to flow
- **Evidence atom**: `commit:<sha>;files:.github/workflows/ci.yml;tool:test`
- **Depends-on**: T-PRIME-CI-P2-S2

### Phase 3: Daemon resilience — pragmas + watchdog + dream-overdue alarm

- **Task ID**: T-PRIME-CI-P3
- **Type**: task
- **Kind**: work
- **Severity**: P1
- **Size**: medium
- **Files touched**: `/mnt/projects/cleocode/packages/core/src/store/memory-sqlite.ts` | `/mnt/projects/cleocode/packages/core/src/sentient/daemon.ts` | `/mnt/projects/cleocode/packages/cleo/src/cli/commands/briefing.ts`
- **Depends-on**: E-PRIME-T01-P3 (daemon installed)
- **Acceptance**: AC-4 | AC-5 | AC-6
- **Evidence atoms required at complete**: `commit:<sha>;files:<aggregate>` | `tool:test` | `tool:lint;tool:typecheck`

#### Subtask 3.1: `applyBrainPragmas(nativeDb)` helper

- **ID**: T-PRIME-CI-P3-S1
- **Type**: subtask
- **Kind**: work
- **Size**: small
- **Atomic action**: Add `applyBrainPragmas(nativeDb: Database)` to `memory-sqlite.ts` that sets `PRAGMA busy_timeout=5000`, `PRAGMA journal_mode=WAL` (idempotent), `PRAGMA synchronous=NORMAL`.
- **Files**: `/mnt/projects/cleocode/packages/core/src/store/memory-sqlite.ts`
- **Acceptance**: post-call `sqlite3 brain.db "PRAGMA busy_timeout"` = 5000 | helper exported
- **Evidence atom**: `commit:<sha>;files:packages/core/src/store/memory-sqlite.ts;tool:test`
- **Depends-on**: none

#### Subtask 3.2: Call `applyBrainPragmas` at every brain.db open site

- **ID**: T-PRIME-CI-P3-S2
- **Type**: subtask
- **Kind**: work
- **Size**: small
- **Atomic action**: Audit all sites that call `new Database(brainDbPath)`. Inject `applyBrainPragmas(db)` after open. Add an AST-grep CI guard parallel to provenance-writers (or reuse).
- **Files**: every brain-db consumer (memory-sqlite.ts as singleton-style or per-caller) | `/mnt/projects/cleocode/packages/core/scripts/verify-brain-pragmas.mjs` (new)
- **Acceptance**: AST-grep finds 0 unwrapped opens | CI step enforces
- **Evidence atom**: `commit:<sha>;files:<aggregate>;tool:test`
- **Depends-on**: T-PRIME-CI-P3-S1

#### Subtask 3.3: Daemon watchdog — process exits if cron stale > 2× interval

- **ID**: T-PRIME-CI-P3-S3
- **Type**: subtask
- **Kind**: work
- **Size**: small
- **Atomic action**: At top of `sentient/daemon.ts` cron callback, store `lastCronFiredAt = Date.now()`. Add a `setInterval(checkWatchdog, intervalMs/2)` separately that calls `process.exit(2)` + logs `WATCHDOG: cron-stale (last=<ts>)` when `Date.now() - lastCronFiredAt > 2 * intervalMs`.
- **Files**: `/mnt/projects/cleocode/packages/core/src/sentient/daemon.ts`
- **Acceptance**: integration test sends SIGSTOP → after 2× interval → process gone with exit 2 | log line present
- **Evidence atom**: `commit:<sha>;files:packages/core/src/sentient/daemon.ts;tool:test`
- **Depends-on**: T-PRIME-T01-P3-S5

#### Subtask 3.4: Dream-overdue alarm — Tier-3 hygiene event in `cleo briefing`

- **ID**: T-PRIME-CI-P3-S4
- **Type**: subtask
- **Kind**: work
- **Size**: small
- **Atomic action**: In `briefing.ts`, when `getDreamStatus().isOverdue === true`, prepend a `## ⚠ HYGIENE` section listing dream-overdue with the staleness duration.
- **Files**: `/mnt/projects/cleocode/packages/cleo/src/cli/commands/briefing.ts`
- **Acceptance**: stale state shows the section | fresh state hides it | section labeled with emoji-free CLEO style allowed since this is operator-facing CLI (per project rule "operator-facing CLI may use single warning glyph")
- **Evidence atom**: `commit:<sha>;files:packages/cleo/src/cli/commands/briefing.ts;tool:test`
- **Depends-on**: T-PRIME-T01-P2-S4

---

## Cross-epic coverage check

Mapping every masterplan bullet under §5 Tier 1 / §5 Tier 2 / §6 to ≥1 phase task:

| Masterplan bullet | Maps to |
|---|---|
| §5 Tier 1.1 — validateCommit AC intersection | T-PRIME-T01-P1-S1..S5 |
| §5 Tier 1.1 — reject `--override` on critical gates | T-PRIME-T01-P1-S4 |
| §5 Tier 1.1 — integration test (AC=A, commit=B → fail) | T-PRIME-T01-P1-S5 |
| §5 Tier 1.1 — re-verify 13 BBTT tasks | T-PRIME-T01-P2-S11..S23 (T9220/T9222/T9223/T9224/T9227/T1897/T1899/T1906/T9172/T1467/T1693/T9194/T9173) |
| §5 Tier 1.2 W0-1/W0-2 (already shipped) | Not re-implemented (verified shipped); audit covered by T-PRIME-T01-P2-S24 |
| §5 Tier 1.2 W1-1 (recency mode) | T-PRIME-T01-P2-S1 + T-PRIME-T02-P5-S1 (regression test) |
| §5 Tier 1.2 W1-2 (pattern dedup) | T-PRIME-T01-P2-S2 + T-PRIME-T02-P1-S7 (simhash column) |
| §5 Tier 1.2 W1-3 (field-name contracts) | T-PRIME-T01-P2-S3 |
| §5 Tier 1.2 W2-1 (`dream --status`) | T-PRIME-T01-P2-S4 |
| §5 Tier 1.2 W2-3 (opportunistic dream from briefing) | T-PRIME-T01-P2-S5 |
| §5 Tier 1.2 W2-4 (`doctor brain` dashboard) | T-PRIME-T01-P2-S6 |
| §5 Tier 1.2 W2-5 (freshness sentinel CI) | T-PRIME-T01-P2-S7 |
| §5 Tier 1.2 W3-1 (`origin` on tasks) | T-PRIME-T02-P1-S2 |
| §5 Tier 1.2 W3-2 (origin+validated_at+chain on brain_*) | T-PRIME-T02-P1-S3..S5 |
| §5 Tier 1.2 W3-3 (`doctor scan-test-fixtures`) | T-PRIME-T01-P2-S8 |
| §5 Tier 1.2 W3-4 (`assertTestEnv` CI gate) | T-PRIME-T01-P2-S9 |
| §5 Tier 1.2 W3-5 (auto-extract repair metrics) | T-PRIME-T01-P2-S10 |
| §5 Tier 1.3 — daemon install | T-PRIME-T01-P3-S2/S3 |
| §5 Tier 1.3 — daemon cwd fix | T-PRIME-T01-P3-S1 |
| §5 Tier 1.3 — reverify T1682+T1636 | T-PRIME-T01-P3-S4/S5 |
| §5 Tier 2.1 origin columns | T-PRIME-T02-P1-S2..S5 |
| §5 Tier 2.1 provenance-gate.ts + writer funnel | T-PRIME-T02-P2-S1/S2 |
| §5 Tier 2.1 verify-provenance-writers.mjs | T-PRIME-T02-P2-S3/S4 |
| §5 Tier 2.2 test-fixture quarantine (3 layers) | T-PRIME-T02-P3-S1/S2/S3 |
| §5 Tier 2.3 T729 two-pass transcript | T-PRIME-T02-P4-S1 |
| §5 Tier 2.3 T730 LLM JSON contract | T-PRIME-T02-P4-S2 |
| §5 Tier 2.3 T736 funnel auto-extract | T-PRIME-T02-P4-S3 |
| §5 Tier 2.3 T737 hashDedupCheck 4-table | T-PRIME-T02-P4-S4 |
| §5 Tier 2.3 brain-doctor diag event | T-PRIME-T02-P4-S5 |
| §5 Tier 2.4 T1903 promotion-log columns | T-PRIME-T02-P1-S6 |
| §5 Tier 2.5 BM25-recency regression | T-PRIME-T02-P5-S1 |
| §6.1 `doctor brain --strict` 4 checks | T-PRIME-CI-P1-S1..S5 |
| §6.2 CI workflow brain-doctor (warn→block) | T-PRIME-CI-P2-S1/S2/S3 |
| §6.3 PRAGMA busy_timeout=5000 helper | T-PRIME-CI-P3-S1/S2 |
| §6.3 watchdog process-exit | T-PRIME-CI-P3-S3 |
| §6.3 dream-overdue alarm in briefing | T-PRIME-CI-P3-S4 |
| §6 Acceptance — `CLEO_BRAIN_INJECT_FAILURE=origin` exits 1 | T-PRIME-CI-P1-S6 |

Coverage: 100%. Every bullet maps to ≥1 subtask.

---

## Subtask count summary

| Epic | Phases | Subtasks |
|---|---|---|
| E-PRIME-T01 | 3 | 6 (P1) + 24 (P2) + 6 (P3) = 36 |
| E-PRIME-T02 | 5 | 7 (P1) + 5 (P2) + 3 (P3) + 6 (P4) + 1 (P5) = 22 |
| E-PRIME-CI | 3 | 6 (P1) + 3 (P2) + 4 (P3) = 13 |
| **Total** | **11** | **71 atomic subtasks** |

Hits the 60-120 target.

---

## Risks + open questions for owner

1. **BBTT re-verify SHAs** (T-PRIME-T01-P2-S11..S23): the 13 mis-completed tasks need their original commit SHAs resolved. If the original commits are unreachable (e.g., force-pushed), we need an owner ruling — either re-attest via owner-override-audit-trail OR mark each as `superseded_by:<new task>`. Recommend running `cleo show <id> --include-commits` per ID before starting Phase 2 of T01.

2. **Migration ordering across DBs** (T-PRIME-T02-P1): conduit-schema (tasks table) and memory-schema (brain_*) migrate independently. If a session is in flight when migrations run, partial state is possible. Phase 1 should run inside a maintenance window OR add a `cleo migrate --pre-flight-lock` mode.

3. **Backfill of `origin='manual'` may be wrong for old auto-extract rows** (T-PRIME-T02-P2-S5): rows older than the auto-extract feature should be `'manual'`, but rows from the broken auto-extract pipeline (Phase 4) should arguably be `'auto-extract'`. Heuristic in the backfill script: rows created by agent `auto-extract*` → `'auto-extract'`. Owner sign-off on heuristic before running.

4. **Daemon install on non-Linux hosts** (T-PRIME-T01-P3-S2/S3): macOS-launchd path is out of scope. Document as a deferred follow-up if operator runs cleo on macOS.

5. **`--strict` CI gate flake risk** (T-PRIME-CI-P2-S1): pattern-bloat and learning-liveness ratios on a freshly-cloned CI sandbox DB may be undefined (0/0). Add a min-row threshold (e.g., skip ratio checks when `observation_count < 10`).

6. **Watchdog interaction with systemd `Restart=on-failure`** (T-PRIME-CI-P3-S3): exit code 2 should trigger systemd restart. Verify `Restart=on-failure` semantics — exit 2 is "failure" but only if explicitly listed in `SuccessExitStatus`/`RestartPreventExitStatus`. Test before declaring P3 complete.

7. **Pattern simhash backfill** (T-PRIME-T01-P2-S2 + T-PRIME-T02-P1-S7): existing patterns have NULL simhash. The dedup check should skip NULL-simhash neighbors initially. A one-shot backfill script (out of scope for this decomposition — defer to a T01 follow-up) populates simhash for all historical patterns.

---

## Deferred follow-ups (out of scope, captured for traceability)

- DF-1: macOS-launchd daemon install (parallel to T01-P3)
- DF-2: Pattern simhash backfill on historical rows
- DF-3: brain-doctor min-row-threshold tuning under low-data CI sandboxes
- DF-4: `CLEO_OWNER_OVERRIDE_REASON` enforced enum for the few legitimate override paths

---

## Naming convention note

This spec uses `T-PRIME-T0X-PY-SZ` ID format for planning clarity. Actual `cleo add` invocations should mint real `T####` IDs and use this spec's IDs as `--external-ref` annotations OR rename for human readability. The decomposition tree structure is the load-bearing claim, not the synthetic IDs.

---

END OF SPEC.
