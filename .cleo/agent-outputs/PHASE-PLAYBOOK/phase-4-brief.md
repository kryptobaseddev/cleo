# PHASE 4 BRIEF — CSL-RESET + Core SDK Foundation

**Phase tracker:** T9235 (parent: T9232 MASTER)
**Team name:** `phase-4-csl-reset`
**You are:** `phase4-lead`
**Goal:** Land T1685 (CSL-RESET), T1768 (Core SDK Tools surface), T1467 (thin-wrapper CLI migration).

## Why this phase

Three foundational defects diagnosed via 5 parallel audits 2026-05-01 (T1685 description):

1. **Two parallel SDK shapes** — public throw-style API vs internal `EngineResult` discriminated union. External consumers can't pick one without surprises.
2. **560 raw `process.stdout.write` calls in 27 CLI commands** — bypass LAFS envelope entirely. Output is unstructured and non-machine-parseable.
3. **128 type names duplicated across packages** — `Task`, `Session`, `Result`, etc. duplicated in `packages/contracts/`, `packages/core/`, `packages/cleo/`.

Plus:
- T1768: Core SDK 'Tools' surface — centralized harness-agnostic utilities. Triggered by T1756 worktree-isolation bug exposing dual-path divergence between PiHarness (correct enforcement) and Claude Code Agent SDK (no enforcement).
- T1467: Complete thin-wrapper CLI migration. T1435 + T948 started; Codex audit 2026-04-27 said NO/NO/PARTIAL on 3 thin-wrapper questions. Make `cleo` CLI a pure thin dispatch over the SDK.

## Sequence

**Wave A — RCASD planning (parallel × 3):**
- T1685 RCASD: read existing audit reports in BRAIN, decompose into waves. Output: ADR + decomposed sub-tasks. (Worker: `phase4-architect`)
- T1768 spec writing: define SDK Tools interface, list utilities. (Worker: `phase4-tools-spec`)
- T1467 audit refresh: identify remaining thin-wrapper gaps post-T9219. (Worker: `phase4-thin-audit`)

**Wave B — Foundation primitives (parallel × 3):**
- Unify EngineResult shape: define canonical type in contracts. Update SDK to return EngineResult uniformly. (Worker: `phase4-engine-result`)
- Define LAFS-safe output adapter for CLI: replace 560 stdout.write calls with envelope-aware cliOutput/cliError helpers. (Worker: `phase4-stdout-purge`)
- Type dedup: identify 128 duplicated names → consolidate into packages/contracts/ canonical exports. (Worker: `phase4-type-dedup`)

**Wave C — Apply foundation across CLI (parallel × N):**
- Sweep each of 27 CLI commands: replace stdout.write, update return path to EngineResult, remove duplicate type imports. Batch by command file. (Workers: `phase4-cli-sweep-a`, `phase4-cli-sweep-b`, etc.)

**Wave D — Core SDK Tools (parallel × 2):**
- Implement T1768 Tools surface in packages/core/src/tools/. (Worker: `phase4-tools-impl`)
- Migrate PiHarness + Claude Code Agent SDK to use unified Tools surface. (Worker: `phase4-tools-migrate`)

**Wave E — Final thin-wrapper sweep:**
- T1467 close-out: convert remaining fat CLI handlers to thin dispatch. (Worker: `phase4-thin-close`)

## Done criteria

- 0 raw `process.stdout.write` calls in `packages/cleo/src/cli/commands/`
- `EngineResult` shape unified: 1 canonical definition in `packages/contracts/`
- 128 → near-0 duplicate type names (verify with TS compiler tool or quick script)
- T1768 Tools surface exported from `@cleocode/core/internal`
- T1467 acceptance criteria all met
- Phase tracker T9235 complete (all 3 deps done)
- `cleo deps validate VALID`, `cleo check coherence passed`
- BRAIN observation + `phase-4-completion-report.md`
- SendMessage Orchestrator `[Lead] complete: phase-4`

## Risk callouts

- T1685 is the LARGEST phase. Plan for 2x-3x the worker count of other phases.
- Sweeping 27 CLI commands risks merge conflicts. Use one worker per ~5 commands and merge waves serially via `cleo complete`.
- Tests will likely fail mid-sweep. Run quality gates AFTER each wave, not between individual command sweeps.

## Critical rules

- Every changed CLI command must still pass its existing tests.
- LAFS envelope shape MUST remain stable — only the *internals* of stdout writing change.
- DO NOT break the `cleo` CLI's exit codes — automation depends on them (4=E_NOT_FOUND, 6=E_VALIDATION, etc.).
