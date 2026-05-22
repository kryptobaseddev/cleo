---
slug: sg-worktrunk-own-closure-report
title: SG-WORKTRUNK-OWN · Saga Closure Report
saga: T9977
date: 2026-05-22
status: published
stage: closure
pipeline: RCASD → IVTR
---

# Saga T9977 SG-WORKTRUNK-OWN — Closure Report

## Outcome

10 of 10 E-class member epics done (T9978–T9987), 71+ atomic tasks shipped
across 9 PRs (#483 – #491). The cleocode worktree subsystem is now
Rust-backed end-to-end:

| Epic | ID | PR | Headline |
|---|---|---|---|
| E1-AUDIT | T9978 | (5 parallel audits, no PR) | Consolidated at slug `sg-t9977-crates-and-js-audit` |
| E2-RUST-194 | T9979 | #483 | `rust-toolchain.toml` 1.88 → 1.94 workspace-wide |
| E3-WORKTRUNK-CORE | T9980 | #484 | `crates/worktrunk-core/` vendored ~1 553 LOC, zero attribution |
| E4-WORKTREE-NAPI | T9981 | #485 + #486 | `crates/worktree-napi/` — 6 napi exports, 5-arch CI matrix |
| E5-TS-REWIRE | T9982 | #487 | `packages/worktree` calls into napi exclusively; ~300 LOC of `child_process` git removed |
| E6-INCLUDE-MIGRATION | T9983 | #488 | `.worktreeinclude` canonical, legacy `.cleo/worktree-include` deprecated + auto-migrate; ADR-077 |
| E7-CORE-LAYERING | T9984 | #489 | `packages/core` consumes `@cleocode/worktree` only |
| E8-CLI-LAYERING | T9985 | #490 | `packages/cleo` is dispatch-only |
| E9-RIP-LEGACY | T9986 | #491 | -684 net LOC of legacy worktree code deleted |
| E10-VALIDATION+CLOSE | T9987 | (THIS PR) | benchmarks + 5-agent dogfood + closure report |

Saga member T9515 ("cleo orchestrate spawn hang + full worktree lifecycle
reliability") remains pending — it was the upstream symptom epic that
this saga was spawned from. Its acceptance criteria are now mechanically
satisfied by E2 – E10 but the task itself is left for the orchestrator
to close out separately under T10059's release flow.

## Numbers

| | Value | Source |
|---|---|---|
| LOC vendored (Rust) | ~1 553 | `crates/worktrunk-core/` |
| LOC removed (TypeScript) | ~300 net in T9982 + ~684 in T9986 | PRs #487 / #491 |
| Provisioning p50 (SDK-only, small repo) | 12.9 ms | `provision-bench-small-repo.mjs` |
| Provisioning p50 (cleocode-self, 10 384 files) | 5 292 ms | `provision-bench.mjs` |
| Pre-saga baseline | 30 000 – 60 000 ms | T9515 timeout reports |
| Multi-language smoke | 3 / 3 (Rust, Python, Node) | `smoke-runner.mjs` |
| 5-agent parallel run | 5 / 5 succeeded, 5 / 5 canonical XDG | `five-agent-parallel.mjs` |
| Zero-orphan check (saga-attributable) | 0 anomalies | `cleo doctor --audit-worktree-orphans` |
| IVTR validations | 3 / 3 (T9980, T9981, T9982) | `cleo show` + `gh pr view` |
| npm prebuild matrix | 5 triples | linux-x64-gnu / linux-arm64-gnu / darwin-x64 / darwin-arm64 / win32-x64-msvc |

Detailed bench tables are in the companion doc at slug
`sg-t9977-bench-results`.

## Key correctness fixes (bonus beyond perf)

1. `worktree-include.ts` no longer does `existsSync(literal-pattern)` —
   real `ignore::gitignore` matching is delegated to
   `crates/worktrunk-core::include`, surfaced through
   `@cleocode/worktree-napi::applyInclude`. The legacy bug where
   `target/` matched a literal directory but `*.lock` matched nothing
   is gone.
2. `paths-SSoT` baseline 17 → 16 (T9802) — `branch-lock.ts` migrated
   to `@cleocode/paths.computeProjectHash`.
3. `lint-cli-package-boundary` baseline 28 → 25 (T9985) — SDK leaks
   moved to `packages/core`.
4. `Raw Git Worktree Lint (T9984)` CI gate added — fails on direct
   `git worktree` outside `@cleocode/worktree` + `crates/`.
5. T9982 removed the hardcoded `['node_modules', 'packages/*/dist']`
   bootstrap copy from `createWorktree`. This is THE root-cause fix for
   the 60s `cleo orchestrate spawn` timeout — the global v2026.5.100
   install still has this block (confirmed via grep on the shipped
   `dist/worktree-create.js`); the next `cleo release` ships the fix
   to npm.

## Deferred (out-of-scope follow-ups)

1. WASM-elimination saga — `signaldock-core` carries a dead `wasm.rs`
   that the E1 audit flagged. P1 follow-up.
2. `cleo-llm-native` ship-or-delete decision — orphan crate today.
3. `lafs-napi` `optionalDependencies` wiring completion.
4. `AGENTS.md` Package-Boundary table refresh — 12 of 20 packages are
   missing from the canonical layering table.
5. Phase out unshipped Rust scaffolding (cant-lsp / cant-router /
   cant-runtime / 7 signaldock-* server crates).
6. `cleo` → `worktree` direct dep boundary violation — partially done
   in E8; full SDK funnel refactor remains.
7. Several CLI-side SDK leaks deferred from E8 (`llm-login` OAuth
   flow, `migrate-agents-v2` walker, etc.).
8. Sparse-checkout pre-materialisation: the `spawnScope: packages/cleo`
   path is currently SLOWER than the no-scope path because git checks
   everything out then applies `sparse-checkout set`. Passing
   `--no-checkout` to `git worktree add` and materialising only the
   scope subtree afterwards would cut cleocode-self provisioning to
   well under the saga's 5 s target.

## Saga-system learnings

- "Bundle a saga's atomic tasks into one PR per epic" worked well —
  kept overhead manageable while preserving traceability via
  `Closes T1...Tn` footer + per-task `pr:<num>` evidence.
- The `--shared-evidence` flag (ADR-059) was essential — without it
  the verification batches would have hit the 3-task atom-reuse
  threshold.
- `CLEO_OWNER_OVERRIDE_WAIVER` cap-waiver is necessary for
  research-only tasks where `testsPassed` / `qaPassed` gates don't
  apply naturally.
- 2 pre-existing CI flakes (T9407 Path Drift Lint + T9775 JSON Stream
  Hygiene Lint) blocked merges all saga — they need a separate
  cleanup pass.
- The 60s `cleo orchestrate spawn` budget the saga targeted survives
  in the global v2026.5.100 install today — agents reading this
  closure report on an old install should expect timeouts on the
  cleocode monorepo until the next release ships.

## Acceptance criteria status

The saga's acceptance array, ticked:

- [x] All 10 E-class member epics done (T9978 – T9987; T9515 is the
      external symptom epic, not an E-* epic)
- [x] `crates/worktrunk-core` owned + zero original-author attribution
- [x] `crates/worktree-napi` exposes parallel copy + `.worktreeinclude`
      reader + provision/destroy + list to JS
- [x] `packages/worktree` calls napi exclusively for hot-path ops
- [x] `packages/core` consumes `packages/worktree` (no direct
      `git worktree` calls) — CI-gated by `Raw Git Worktree Lint`
- [x] `packages/cleo` is dispatch-only thin wrapper — CI-gated
- [x] `.worktreeinclude` at project root is canonical (legacy
      `.cleo/worktree-include` reader emits deprecation + can migrate)
- [x] Rust 1.94 toolchain across all crates
- [x] napi-rs CI matrix builds Linux / macOS / Windows prebuilt binaries
- [x] Audit epic E1 catalogs 100 % of crates + JS consumers + napi vs
      WASM leverage
- [~] `cleo orchestrate spawn` provisions a worktree in under 5 s on
      warm pnpm store — **PASSES on small repos (12.9 ms p50);
      bounded by `git worktree add` checkout latency on the cleocode
      monorepo itself (5.3 s p50)**; full pass on cleocode pending the
      sparse-checkout pre-materialisation follow-up
- [x] Zero orphan `.cleo/` directories possible by construction (saga
      code paths verified; pre-existing orphans flagged are unrelated
      legacy fixtures)
- [x] Saga closure report at slug `sg-worktrunk-own-closure-report`
      (this doc)
