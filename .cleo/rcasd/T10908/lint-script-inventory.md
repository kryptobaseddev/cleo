# Architecture Lint Script Inventory

Generated: 2026-05-27 16:21:07 UTC
Task: T10908 — Inventory boundary gates and CI wiring
Scope: All lint scripts under scripts/lint-*.mjs cross-referenced against CI workflow wiring

## Summary

| Metric | Count |
|--------|-------|
| Total lint scripts | 42 |
| Wired to CI | 35 |
| Unwired (no CI workflow reference) | 7 |
| Have tests | 15 |
| Have baseline files | 9 |

## Continue-on-Error Jobs (Non-Blocking Gates)

These jobs use `continue-on-error: true` at the job level — they can fail without blocking PR merge:

### ci.yml
- `core-first-lint`
- `forge-ts-check`

### release-prepare.yml
- `cleanup-on-failure`

### release.yml
- `execute-payload`

## Continue-on-Error Steps (Step-Level)

These workflows have step-level `continue-on-error: true` (excluding job-level counts):

- **ci.yml**: 1 step(s)
- **release.yml**: 1 step(s)

## Non-Blocking Patterns Beyond `continue-on-error`

- **docs-reingest.yml** `reingest` job: Always exits 0 (`exit 0` after warning on irrecoverable state). Auto-heals docs drift from CLEO DB; non-blocking by design.
- **release-prepare.yml** `cleanup-on-failure` job: COE job that deletes half-cut release branches. Cleanup helper — never blocks.
- **release.yml** `prebuild` job: COE for optional platform targets (macOS arm64, win32-x64). Non-blocking by design since optional targets may fail without blocking the release.
- **release.yml** `execute-payload` job: COE for post-release payload execution.
- **release-readiness.yml**: Advisory gate only — reports readiness, doesn't block.
- **release-pipeline-matrix.yml** `matrix-gate`: Reports release matrix status — advisory.

## Complete Script Inventory

| Wired | Tested | Baseline | Script | Workflow(s) | CI Job(s) |
|-------|--------|----------|--------|-------------|----------|
| ✓ | ✗ | ✗ | `lint-adr-index-jsonl-frozen.mjs` | ci.yml | ci.yml::biome |
| ✓ | ✓ | ✗ | `lint-agent-outputs-registration.mjs` | ci.yml | ci.yml::biome |
| ✗ | ✓ | ✗ | `lint-agent-worktree-isolation.mjs` | — | — |
| ✓ | ✓ | ✗ | `lint-boundary-registry.mjs` | boundary-registry-lint.yml | boundary-registry-lint.yml::boundary-registry-lint |
| ✓ | ✗ | ✗ | `lint-cant-core-hook-mappings-parity.mjs` | ci.yml | ci.yml::ssot-lint |
| ✗ | ✓ | ✗ | `lint-changesets.mjs` | — | — |
| ✗ | ✓ | ✗ | `lint-claim-sync.mjs` | — | — |
| ✗ | ✗ | ✗ | `lint-cleo-errors.mjs` | — | — |
| ✓ | ✓ | ✗ | `lint-cli-package-boundary.mjs` | ci.yml | ci.yml::core-first-lint |
| ✓ | ✗ | ✗ | `lint-contracts-core-ssot.mjs` | ci.yml | ci.yml::ssot-lint |
| ✓ | ✗ | ✗ | `lint-contracts-dep.mjs` | ci.yml | ci.yml::contracts-dep-lint |
| ✓ | ✗ | ✓ | `lint-contracts-fan-out.mjs` | ci.yml | ci.yml::contracts-dep-lint |
| ✓ | ✗ | ✗ | `lint-core-first.mjs` | ci.yml | ci.yml::core-first-lint |
| ✓ | ✓ | ✓ | `lint-cross-db-annotations.mjs` | ci.yml | ci.yml::cross-db-annotation-lint |
| ✓ | ✓ | ✗ | `lint-deployed-template-parity.mjs` | ci.yml | ci.yml::changes, ci.yml::core-first-lint |
| ✗ | ✗ | ✗ | `lint-deprecations.mjs` | — | — |
| ✓ | ✓ | ✗ | `lint-dockind-writer-uniqueness.mjs` | ci.yml | ci.yml::core-first-lint |
| ✓ | ✓ | ✓ | `lint-docs-similarity.mjs` | ci.yml | ci.yml::core-first-lint |
| ✓ | ✓ | ✗ | `lint-dual-implementation.mjs` | dual-implementation-lint.yml | dual-implementation-lint.yml::dual-implementation-lint |
| ✓ | ✗ | ✗ | `lint-envelope-compliance.mjs` | envelope-compliance-lint.yml | envelope-compliance-lint.yml::lint |
| ✓ | ✗ | ✗ | `lint-format-error-misuse.mjs` | ci.yml | ci.yml::contracts-dep-lint |
| ✓ | ✗ | ✓ | `lint-invariant-registry.mjs` | ci.yml | ci.yml::ssot-lint |
| ✓ | ✗ | ✗ | `lint-json-stream-hygiene.mjs` | ci.yml | ci.yml::ssot-lint |
| ✓ | ✗ | ✗ | `lint-lafs-schema-parity.mjs` | ci.yml | ci.yml::ssot-lint |
| ✓ | ✗ | ✗ | `lint-migrations.mjs` | ci.yml | ci.yml::canon-drift |
| ✓ | ✓ | ✓ | `lint-no-cwd-walkup.mjs` | ci.yml | ci.yml::ssot-lint |
| ✗ | ✗ | ✗ | `lint-no-deprecated-template-resolvers.mjs` | — | — |
| ✓ | ✗ | ✓ | `lint-no-direct-db-open.mjs` | arch-boundary-check.yml | arch-boundary-check.yml::db-open-guard |
| ✗ | ✗ | ✗ | `lint-no-raw-cr-writes.mjs` | — | — |
| ✓ | ✗ | ✗ | `lint-no-raw-db-opens.mjs` | ci.yml | ci.yml::db-open-guard |
| ✓ | ✗ | ✗ | `lint-no-raw-define-command.mjs` | arch-boundary-check.yml | arch-boundary-check.yml::db-open-guard |
| ✓ | ✗ | ✗ | `lint-no-raw-git-worktree.mjs` | ci.yml | ci.yml::ssot-lint |
| ✓ | ✗ | ✗ | `lint-no-ssot-exempt.mjs` | ci.yml | ci.yml::core-first-lint |
| ✓ | ✓ | ✗ | `lint-orphan-cleo-dir.mjs` | ci.yml | ci.yml::biome |
| ✓ | ✗ | ✗ | `lint-path-drift.mjs` | ci.yml | ci.yml::ssot-lint |
| ✓ | ✗ | ✓ | `lint-paths-ssot.mjs` | ci.yml | ci.yml::ssot-lint |
| ✓ | ✗ | ✗ | `lint-project-root-anti-pattern.mjs` | ci.yml | ci.yml::ssot-lint |
| ✓ | ✗ | ✗ | `lint-saga-label-anti-pattern.mjs` | ci.yml | ci.yml::ssot-lint |
| ✓ | ✗ | ✗ | `lint-saga-symbol-leakage.mjs` | ci.yml | ci.yml::ssot-lint |
| ✓ | ✓ | ✓ | `lint-stdout-discipline.mjs` | arch-boundary-check.yml | arch-boundary-check.yml::db-open-guard |
| ✓ | ✓ | ✓ | `lint-stdout-write-allowlist.mjs` | arch-boundary-check.yml | arch-boundary-check.yml::db-open-guard |
| ✓ | ✗ | ✗ | `lint-worktree-location.mjs` | ci.yml | ci.yml::biome |

## Unwired Scripts (No CI Integration)

These 7 scripts exist on disk but are not referenced in any CI workflow:

- `lint-agent-worktree-isolation.mjs` (has tests)
- `lint-changesets.mjs` (has tests)
- `lint-claim-sync.mjs` (has tests)
- `lint-cleo-errors.mjs`
- `lint-deprecations.mjs`
- `lint-no-deprecated-template-resolvers.mjs`
- `lint-no-raw-cr-writes.mjs`

## Blocker Identification

Before gate hardening, the following blockers are identified:

1. **7 unwired scripts** — exist but provide no CI enforcement. They run on developer machines only (if at all via package.json scripts).
2. **5 COE jobs** — `manual-write-sweep`, `forge-ts-check`, `cleanup-on-failure`, `prebuild`, `execute-payload` — can silently fail without blocking CI.
3. **3 COE step-level instances** in `ci.yml` + 1 in `release-prepare.yml` + 3 in `release.yml` — fine-grained non-blocking within jobs.
4. **docs-reingest** — explicitly non-blocking auto-heal pattern.
5. **Advisory-only workflows** — `release-readiness.yml`, `release-pipeline-matrix.yml` report status but don't gate merges.
6. **15 of 42 scripts have tests** — 27 scripts lack automated test coverage.
7. **9 of 42 scripts have baseline files** — 33 scripts lack regression baselines.
