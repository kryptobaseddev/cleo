# Research: machine-wide worktree, node_modules and branch census in `cleo doctor` and `cleo dash`

Research for T14440 (epic T14437, machine hygiene). Sources are cited inline with absolute paths, commits or file:line. This document gathers evidence and proposes a shape; it implements nothing.

## Key Findings

- **A machine-wide worktree census already exists in-tree** — `packages/core/src/hygiene/census.ts` (T14275), exposed as `cleo hygiene census [--report|--apply]` (`packages/cleo/src/cli/commands/hygiene.ts`). It walks every hash dir under the worktrees root, classifies worktrees by the T14274 disposal proof (`active`/`redundant`/`keep`/`unknown`), treats hash dirs no registered project owns as `unknown` report-only (exactly the `cleo-nexus`/`pr2364` case), measures apparent bytes, writes one record per run under `<cleoHome>/hygiene/census/`, and holds a heartbeat lock. **The T14440 delta is visibility, not discovery**: AC1's task status, age, dirty state, lock, node_modules kind/size, merged branches and pnpm store size are all absent from its `CensusRow` (fields at `packages/core/src/hygiene/census.ts:57-77`).
- **The registered-project SSoT for any machine-wide scan is the nexus `project_registry`.** `packages/core/src/system/project-health.ts:815-880` (`checkAllRegisteredProjects`) loads it and probes each project; the census derives orphan hash dirs as `readdir(worktreesRoot) − registry hashes`. Reuse this; do not invent a second registry read.
- **AC2's threshold-warning home is `cleo doctor system`** (`packages/cleo/src/cli/commands/doctor-system.ts` → `packages/core/src/doctor/system-health.ts`). It already emits ranked findings with exact remedies for memory-pressure, swap ratio and Spotlight indexing of node_modules (`system-health.ts:451-495, 938-950`) — but has **no fseventsd process check and no worktree-count/bytes findings**. The VidaPeps incident's first correct signal was the spawn guard's fseventsd RSS check (`memory is critical: fseventsd pid 107 62.0 GiB`, canary 2026.11.1-canary.8); that check lives in the admission path, not doctor, and doctor never surfaces it.
- **AC3's "never open another project's store with an unreleased build" has existing machinery to copy**: `probeDb` in `project-health.ts` reads `PRAGMA user_version` and `__drizzle_migrations` and compares against `DB_EXPECTED_VERSIONS` **before** trusting a store, flagging `behind`. By contrast, the census's `loadTaskEvidence` (`packages/core/src/worktree/prune.ts:210-225`) opens a *foreign* project's task store via `getTaskAccessor(projectRoot)` with only a fail-soft `catch → []` — no migration-floor preflight. A census that reports per-worktree task status must either preflight the foreign store's migration floor (probeDb pattern) or stay store-free and derive status from the T14274 disposal proof (`owningTaskStatus` is already on the napi worktree info, `packages/contracts/src/operations/worktree.ts:875-877`).
- **Per-worktree pnpm stores make node_modules bytes undercount.** `packages/worktree/src/worktree-pnpm.ts` writes `.npmrc` with `store-dir=<worktree>/.pnpm-store` (T9938 serialization + isolation), so each worktree carries its own store beside `node_modules`. Whole-worktree `apparentBytes` (already in the census) is the honest number; a machine-wide pnpm-store figure additionally needs `du` over the global store (`pnpm store path`, typically `~/Library/pnpm/store`) — no existing code measures it.
- **Merged-branch classification already exists as advisory SDK output**: `buildGitAwarePrunePlan(gitRoot, integrationTarget)` (`packages/worktree/src/worktree-prune.ts:295-330`) wraps napi `pruneWorktrees` and classifies merged worktrees/branches against a target branch. The lead's census measured 1,363 local branches in cleocode, 1,250 already merged into origin/main, 284 remote. T14441 owns any *removal*; T14440 only reports.
- **Integration points are settled**: new doctor capability = a `doctor-*.ts` subcommand module with lazy `await import('@cleocode/core/…')` (gate 39 CLI-startup budget; pattern in `doctor-system.ts`); dash = the `dash` handler in `packages/cleo/src/dispatch/domains/admin.ts:660-698` plus the human-note pattern already used in `packages/cleo/src/cli/commands/dash.ts` (T1636 hygiene note). The reclaim command warnings should name is `cleo hygiene census --report` (see) / `--apply` (reclaim this project's proven-redundant worktrees), with T14446's runbook as the manual backstop.

## Current-state map (code, verified in worktree at branch `task/T14440`)

| Concern | Where today | Gap vs AC |
| --- | --- | --- |
| Machine-wide worktree walk + classification | `packages/core/src/hygiene/census.ts` (`runWorktreeCensus`), CLI `cleo hygiene census` | No task status, age, dirty, lock, node_modules kind/size, branches, pnpm store |
| Orphan folders (no registered project) | Same census, `unknown` report-only rows | Needs to be *named* as orphans in doctor/dash output, not buried in `unknown` |
| Registered projects | nexus `project_registry` via `packages/core/src/system/project-health.ts` | — |
| Foreign-store read guard | `probeDb` + `DB_EXPECTED_VERSIONS` (`project-health.ts`); `loadTaskEvidence` has none | AC3: preflight or store-free status |
| Threshold warnings | `packages/core/src/doctor/system-health.ts` findings (memory, swap, Spotlight) | Add worktree-count, worktree-bytes, fseventsd findings with remedy lines |
| fseventsd signal | admission/spawn guard only (memory-guard path; cited in VidaPeps doc) | Not surfaced by doctor |
| Merged branches | `buildGitAwarePrunePlan` (`packages/worktree/src/worktree-prune.ts`) | Report-only rollup per project |
| node_modules install lifecycle | `worktree-pnpm.ts` (serialized install, per-worktree `.pnpm-store`), `worktree-preflight.ts` | No accounting/cleanup anywhere (T14439 owns shared install) |
| Lock state | `readWorktreeTaskLock` (`packages/worktree/src/worktree-lock.ts:357`) | Census rows lack it |
| dash surface | `packages/cleo/src/dispatch/domains/admin.ts` `dash` handler + `dash.ts` human note | Add a machine-hygiene section |
| Reclaim path | `cleo hygiene census --apply` (own project only), `disposeWorktree` (T14276, gate 41) | Doctor findings must name it |

## Mapping to acceptance criteria

- **AC1 (read-only census)** — extend the T14275 `CensusRow`/record with: `taskId` (present) → task status (disposal-proof `owningTaskStatus`, optionally store-backed behind an AC3 preflight), age (worktree dir mtime/ctime), dirty state (`git status --porcelain` count or napi equivalent), lock (`readWorktreeTaskLock`), node_modules kind (`absent|symlink|real` via `lstat`) and size, per-project merged local/remote branch counts (`buildGitAwarePrunePlan`), orphan folder names, machine-wide rollups incl. global pnpm store size. All reads are filesystem/git/napi; nothing opens or writes a store unless the AC3 preflight passes.
- **AC2 (doctor warnings)** — add findings to `system-health.ts`: worktree count per project and machine-wide, worktree bytes vs free space, fseventsd RSS (macOS `ps`/proc info — same source the spawn guard reads), Spotlight or swap pressure (swap finding exists; keep it), each naming `cleo hygiene census --report` / `--apply` as the reclaim command. Thresholds are a calibration question (the lead's 50/16/4 caps were explicitly "unapproved calibration hypotheses", mbx 01M59043A15VXGSDGSQP1JJ468) — ship WARN-level defaults, owner-tunable.
- **AC3 (no foreign-store opens on unreleased builds; deletes nothing)** — census stays read-only (T14275 already only deletes under `--apply`, which T14440 does not touch); any store-backed enrichment must run the probeDb migration-floor check first and skip (report `unknown`) when the foreign store is ahead of this build's `DB_EXPECTED_VERSIONS`.

## Measured baseline (cited, not re-measured)

- Lead's census, 2026-11-10 (T14437 description): 403 worktree dirs under the worktrees home across 12 project folders; 201 real + 69 symlinked node_modules; cleocode 187 worktrees / 103 real node_modules / 2.3 GB sample of a 2.6 GB worktree / 1,363 local branches (1,250 merged into origin/main) / 284 remote; VidaPeps 45/43; folders `cleo-nexus` and `pr2364` are not project hashes; 1.4 TiB used of 1.8 TiB.
- VidaPeps findings doc (commit `6cc80cd7e`, `/Users/keatonhoskins/projects/VidaPeps`, `docs/research/cleo-worktree-gc-findings-2026-11-10.md`): ~250 CLEO worktrees and 375 GB at incident time; per-worktree node_modules 1.3–1.7 GB; fseventsd RSS 57–62 GB forced 16–18 GB swap; first visible symptom was flaky timing-sensitive tests; `cleo orchestrate prune` removed 0 across runs; safe-removal predicate and per-creator removal ownership proposed; CLEO team asks #4 = "extend the canary.8 memory guard to disk and make refusals actionable" (this task's AC2) and telemetry ask #2 = dash/doctor worktree/bytes/node_modules counts (this task's AC1).

## Needs Follow-up

- **Threshold calibration** for AC2 (worktree count, bytes, fseventsd RSS): owner decision or a measured-defaults PR note; the lead's 50/16/4 numbers are unapproved hypotheses.
- **Task status via foreign stores vs store-free**: recommend store-free (`owningTaskStatus` from the disposal proof) for v1; store-backed detail only behind the probeDb preflight if the lead wants it.
- **Symlinked node_modules origin** is unverified (no code in `packages/worktree/src` creates them); classify only, do not assume provenance.
- **Global pnpm store path** resolution (`pnpm store path` vs hard-coded default) should follow pnpm's own config chain; pick one in implementation.
- T14275/T14274 read as `pending` in the store despite the census shipping in-tree — reconcile their status before building on them (possible re-open after partial delivery).

## Related work

Epic T14437 children: T14438 reaper, T14439 shared install, T14441 merged-branch reaper, T14442 spawn/disk guards, T14443 CI-runner research, T14444 verify output, T14445 provision retry, T14446 runbook. Earlier cancelled attempts (per epic description): T1466, T1671, T1464, T9207, T9211. Adjacent gates: gate 39 (CLI startup budget → lazy core imports in doctor), gate 41 (no raw worktree removal → census `--apply` must stay on `disposeWorktree`).
