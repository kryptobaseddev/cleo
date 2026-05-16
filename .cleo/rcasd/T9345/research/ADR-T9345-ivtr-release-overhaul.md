# ADR-073: IVTR/Release System Overhaul — Project-Agnostic Provenance-Graph Pipeline

**Status**: Proposed
**Date**: 2026-05-15
**Epic**: T9345 (IVTR Release System Overhaul)
**Authors**: cleo-prime (system architect, RCASD wave-2)
**Supersedes (partial)**: ADR-053 (project-agnostic release pipeline — extended), ADR-065 (PR-required flow — extended, not replaced)
**Related**: ADR-051 (evidence-based gates), ADR-061 (project-agnostic verify tools), ADR-062 (worktree merge), ADR-063 (4-step pipeline), ADR-068 (database charter), ADR-070 (three-tier orchestration), ADR-072 (Hermes LLM port precedent)
**Forward-references**: T1737 (Sentient Harness v3)

---

## Status

`Proposed` — awaiting RCASD wave-2 council review + owner sign-off. Once accepted, the orchestrator MUST file the child epics enumerated in *Open questions* before the spec-writer (T9345 wave-3) begins the RFC-2119 spec deliverable.

---

## Context

### 1. Symptom catalog (10 failures, anchored to forensics)

The T9345 incident catalog, derived verbatim from `.cleo/rcasd/T9345/research/failure-forensics-10-modes.md` and the v2026.5.73 → v2026.5.74 ship session (anchor commit `e1b3b414d`), contains ten distinct production failures of `cleo release ship`:

1. **Wedged git commit, no child-process timeout** — `git commit` hung indefinitely (PID 4011255), `.git/index.lock` was orphaned, parent process exited silently. Cited at `packages/core/src/release/engine-ops.ts:1497` (`gitCwd` omits `timeout`) and `engine-ops.ts:1524-1533` (the actual wedged commit call). Compare to `engine-ops.ts:1484` and `engine-ops.ts:1688` which DO set timeouts on biome and gh-merge — the omission on git is unintentional. (forensics §Failure #1)

2. **Epic completeness scope leak** — `--epic T9261` was supplied but completeness check failed on T9220 (unrelated, SUPERSEDED weeks prior by T9337). Cited at `engine-ops.ts:1339-1378` (call site passes no `epicId` to `checkEpicCompleteness`), `guards.ts:31-46` (`findEpicAncestor` walks UP the parent chain across epic boundaries), `guards.ts:82-122` (only checks `t.status === 'done'`, ignores `superseded`/`pipelineStage`). (forensics §Failure #2)

3. **Gate runners not wired** — `cleo release verify` reports all 5 canonical gates (test, lint, typecheck, audit, security-scan) as `runner not configured (inject via opts.runGate)`. Cited at `pipeline.ts:249-262` (`defaultRunGate` is a no-op stub returning `passed:false`), `release.ts:317-323` (CLI calls `releaseVerify(handle)` with no `opts.runGate`), `engine-ops.ts:1236` (`releaseShip` calls a DIFFERENT gate registry, `runReleaseGates` from `release-manifest.ts`). Two parallel gate systems, neither wired to ADR-061's tool resolver. (forensics §Failure #3, audit §3.2)

4. **IVTR non-blocking gate** — "IVTR gate: 72 task(s) have no IVTR state (non-blocking)". When 72/72 tasks are in the `unchecked` bucket, the gate is reduced to a printed warning. Cited at `engine-ops.ts:190-212` (`checkIvtrGates` returns three-state `{blocked, unchecked}`), `engine-ops.ts:1285-1289` (`unchecked` → warn-only). If the gate cannot block under any input configuration, it is not a gate. (forensics §Failure #4)

5. **Override cap counter broken** — "Per-session CLEO_OWNER_OVERRIDE cap exceeded: 823 of 10 overrides used. Counter never resets." Cited at `override-cap.ts:147-161` (only write path increments), `session/engine-ops.ts:574-690` (`sessionEnd` never deletes the counter file), `validation/engine-ops.ts:382-388` (`sessionId ?? 'global'` fallback collapses orphan invocations into one perpetual counter). (forensics §Failure #5)

6. **Tag points at wrong SHA** — after `gh pr merge --auto`, the pipeline immediately `git pull && git rev-parse HEAD && git tag` without polling merge completion. Tag landed at pre-merge SHA `1226c5dae` instead of merge commit `e1b3b414d`. Cited at `engine-ops.ts:1682-1717` (merge step is fire-and-forget with `--auto`), `engine-ops.ts:1721-1767` (Step 10 does not poll `gh pr view --json state,mergeCommit`). (forensics §Failure #6)

7. **Worker direct-push to main** — worker-T9317 merged its task branch directly to local main without opening a PR. Cited at `packages/git-shim/src/shim.ts:232-244` (no-role fast path — env-var-only enforcement), `git-shim/src/denylist.ts:184-200` (only force-push variants of `push` denied; `git push origin task/T:main` not blocked), `git-shim/src/boundary.ts:239-262` (`validateMergeAllowed` only fires when shim is active). Single-layer enforcement. (forensics §Failure #7)

8. **Release start no-op** — `cleo release start` writes `.cleo/release/handle.json`; `releaseShip` never reads it. Cited at `pipeline.ts:91` (handle path), `engine-ops.ts:1105-1233` (`releaseShip` signature takes raw params, never imports `loadActiveReleaseHandle`/`writeHandle`/`releaseStart`). Two parallel release systems with overlapping CLI surfaces, neither aware of the other. (forensics §Failure #8, audit §1)

9. **Esbuild externals not auto-detected** — T9317 Bedrock SDK addition required manual `build.mjs` edit for `@aws-sdk/*` + `@smithy/*` externals. Cited at `build.mjs:179-266` (hand-maintained array), `version-bump.ts` (no externals scanner), `engine-ops.ts:1478-1495` (only the biome lint step runs; no `pnpm run build` pre-ship gate). (forensics §Failure #9)

10. **CHANGELOG fragile** — auto-generated entries include verbose RCASD task descriptions instead of human-readable summaries; no semver impact assessment. Cited at `release-manifest.ts:330-368` (heuristic-driven description inclusion; 150-char hardcoded truncation), `release-manifest.ts:305-409` (categorizer dispatches by `task.type`, has no `breaking`/`major`/`minor`/`patch` impact tag), `changelog-writer.ts:43-63` (flat section output, no upgrade-impact callout). (forensics §Failure #10)

### 2. Root-cause clusters (six, distilled from forensics)

The 10 failures collapse into 6 root-cause clusters (forensics §Cross-Failure Synthesis):

- **C1 — No child-process supervision** (Failures #1, #6): `execFileSync`/`spawnSync` invocations against `git`/`gh`/`npx biome`/`npm` lack consistent timeout discipline; `gh pr merge --auto` is treated synchronously when it is asynchronous; no SIGKILL-on-timeout fallback.
- **C2 — Gate logic confused with pipeline logic** (Failures #3, #4): three independent gate systems (`pipeline.ts:VERIFY_GATES`, `release-manifest.ts:runReleaseGates`, `engine-ops.ts:checkIvtrGates`) do not talk to each other; the canonical pipeline's `verify` is a no-op stub; the IVTR gate's `unchecked` bucket lets the entire gate degrade to a printed warning.
- **C3 — No state-machine resume** (Failures #1, #6, #8): `releaseShip` is a 761-line monolith (engine-ops.ts:1105-1866) with no intermediate checkpoints; the handle written by `releaseStart` is ignored; no `cleo release ship --resume` exists.
- **C4 — Enforcement is env-var-only, not defense-in-depth** (Failure #7): the git-shim's authority depends entirely on `CLEO_AGENT_ROLE` being set in subprocess env; the denylist misses `git push <remote> <local>:<protected-branch>`; no on-disk worktree policy artifact.
- **C5 — Hand-maintained registries with no sync test** (Failures #9, #10): `build.mjs` externals list, CHANGELOG heuristics, AUTHOR_MAP-equivalent attribution metadata — all are hand-maintained data with no programmatic validator that fails CI when source-of-truth and registry drift.
- **C6 — Sessions don't bound their own state** (Failure #5): `sessionEnd` does not delete the override-counter file; the `'global'` sessionId fallback gives orphan invocations a perpetual append-only counter.

### 3. Conflation diagnosis — IVTR ↔ Release tight-coupling

`.cleo/rcasd/T9345/research/ivtr-conflation-audit.md` scores IVTR↔Release conflation at **7/10** (significant over-engineering with tight release coupling). Key findings:

- **Bidirectional hard-welding at engine level**: `engine-ops.ts:1262-1280` calls `releaseGateCheck()` which queries `task.ivtr_state`; `engine-ops.ts:475-556` auto-suggests `cleo release ship` after IVTR completion. (audit Q1, Leaks #1-#4)
- **Gate duplication**: IVTR phases `implement/validate/test/released` are semantically equivalent to ADR-051 evidence gates `implemented/qaPassed/testsPassed/<meta>`. Agents run both, recording the same evidence twice. (audit §Phase 3, table "Gate Duplication")
- **Missing provenance graph**: no `commits` table, no `release_manifest.commits → tasks` FK, no `releases` table — the owner-required "feature → bug → hotfix → epic → task → commit → release" graph is **derivable but not queryable** (audit Q4). `tasks.verification` and `task_relations` exist but lack `(release_id, commit_sha, task_id)` triples.
- **~600 LOC of coupling to remove**: 17 IVTR gate references in `engine-ops.ts` lines 1251-1295 alone; plus 7 files directly integrating IVTR into release paths (audit §Phase 1).

The audit's Priority 1 action is unambiguous: **decouple release from IVTR; evidence gates (ADR-051) become the sole release blocker** (audit §Recommendations, T9350).

### 4. External precedents (wave-1 research)

**Hermes-agent** (`.cleo/rcasd/T9345/research/hermes-agent-real-research.md`): the canonical NousResearch project at `github.com/NousResearch/hermes-agent`, currently `v0.13.0` / `v2026.5.7`. Already cited by `docs/specs/hermes-agent-llm-provider-architecture.md` as the CLEO Phase 4 LLM-stack precedent (ADR-072). **For release governance, Hermes is orthogonal to CLEO**: no IVTR ladder, no epic-completeness, no task→commit→release graph, no worker-direct-push protection. But Hermes offers **8 Tier-1 borrowable mechanics**: dual CalVer+SemVer tagging, `next_available_tag` same-day suffixing, annotated tags with structured messages, release-as-event GitHub fan-out, OCI revision-label ancestor check, pinned-deps + lockfile-drift CI, supply-chain audit on PR diffs, print-exact-recovery-command on failure (research §6 Tier 1). Critically: Hermes's release pipeline is a **single Python script** (`scripts/release.py`) run from a maintainer's laptop, not a GHA workflow — the maintainer trusts `main` is green at publish time.

**Letta** (`.cleo/rcasd/T9345/research/letta-harness-real-research.md`): two repos with opposite postures. `letta-ai/letta` (Python server) has **zero release gates** — `poetry-publish.yml` fires on `release:published` and runs `uv build && uv publish` with no lint/typecheck/test (research §3.3, "anti-pattern observation"). `letta-ai/letta-code` (TypeScript harness) is the **closer precedent** to CLEO — a two-stage workflow: `prepare-release.yml` opens a `chore: bump version to X` PR after running lint+typecheck+build+update-chain-smoke; `release.yml` triggers on push-to-main filtered to `[package.json, package-lock.json]`, re-runs lint+typecheck+build+CLI smoke+**integration smoke against the real API** (`./letta.js --prompt "ping" --tools "" --permission-mode plan` using `LETTA_API_KEY`), then publishes to npm with OIDC, tags from the merged main commit, and creates a GitHub Release with `generate_release_notes: true` (research §3.4). The **`release_bump_only` classifier** (research §3.4 sub-section "CI on the bump-PR itself") is 40 lines of bash that short-circuits heavy CI when the PR only touches `package.json|package-lock.json` — directly portable. Letta also provides the **`LET-XXXX (#PR)` cross-citation** convention as the closest precedent for CLEO's `T#### (#PR)` provenance edges.

### 5. T1737 Sentient Harness v3 alignment requirement

T1737 (Sentient Harness v3) is the planned multi-platform harness layer above the current `cleo-os` / Pi adapter stack. Required surfaces:

- **linux x64 / arm64** (Pi, Raspberry Pi 5, Linux servers)
- **macos x64 / arm64** (Apple Silicon, Intel)
- **win x64** (PowerShell, WSL2 host)

Any new release pipeline MUST emit installable artifacts for all five platform tuples — not just `npm install -g @cleocode/cleo` on a TypeScript stack. The current `cleo release ship` 12-step assumes a single npm package and falls back to `engine-ops.ts:1480` (`npm`-CLI invocation hardcoded) for the publish step. T1737 forces this assumption open.

### 6. Project-agnosticism gap (ADR-053 promise vs current reality)

ADR-053 (T820) explicitly promised: "the release pipeline MUST be portable across **at least three project archetypes**: (a) npm monorepo with pnpm workspaces, (b) single npm library, (c) single Rust crate published to crates.io." The RELEASE-06 fixture asserts this. **Today's `releaseShip` partially regresses ADR-053**:

- Hardcoded `gh` CLI requirement (`engine-ops.ts:1182-1189`) — ADR-065's PR-required flow added this without making it pluggable.
- Hardcoded `npm`-CLI publish path (`engine-ops.ts:1480`) — Rust/Python projects need `cargo publish` / `twine upload`.
- Workspace discovery hardcodes `pnpm-workspace.yaml` + `packages/` layout (`version-bump.ts:243-288`). Cargo workspace discovery is patched in but parallel, not unified.
- `defaultRunGate` (`pipeline.ts:249-262`) does not call ADR-061's tool resolver — so even the gate runner regresses the ADR-061 promise.

ADR-061 (project-agnostic evidence tools + cross-process result cache) already solved gate-runner portability at the `cleo verify` layer with canonical tool names (`test`, `build`, `lint`, `typecheck`, `audit`, `security-scan`) resolved via `.cleo/project-context.json` with per-`primaryType` fallbacks (cargo, pytest, go, bun). The release pipeline must adopt this resolver instead of maintaining a parallel gate registry.

### 7. ADR-065 (current 12-step PR-required flow) — what it got right and what it didn't

ADR-065 is the canonical statement of today's pipeline. It says: "all releases flow through a PR-gated pipeline. Direct pushes to `main` are prohibited." This is the single best architectural invariant CLEO inherited — it prevents the entire class of "worker direct-push" failures at the policy level even when the git-shim layer fails (forensics §F7). This ADR-073 PRESERVES that invariant unconditionally.

ADR-065's 12-step also defines the auto-flow: prepare → gates → IVTR check → epic-completeness → double-listing guard → CHANGELOG → biome lint → cut release branch → commit → push branch → open PR → wait CI green → merge → tag → cleanup. This list IS the failure surface enumerated in §1. The 12-step is correct AS A LIST OF THINGS THAT NEED TO HAPPEN; it is wrong as A SINGLE FUNCTION THAT DOES THEM ALL SEQUENTIALLY WITHOUT CHECKPOINTS. The decomposition this ADR proposes preserves the list — every one of the 12 steps still happens; they happen in a different topology.

### 8. Why a 4th direction was rejected at scoping

A "fully external" direction — adopt `release-please`, `semantic-release`, or `changesets` wholesale and delete the entire `packages/core/src/release/` tree — was considered at the council scoping phase and rejected. Reasons documented for the audit trail:

- `release-please` (Google) is npm-monorepo-focused and lacks first-class Rust + Python support; CLEO would replicate its decision matrix to ship Cargo crates.
- `semantic-release` requires Conventional Commits to drive the version bump. CLEO's CalVer is calendar-position-driven, not commit-driven; the impedance mismatch is high.
- `changesets` (Atlassian) is the closest fit for npm monorepos but assumes contributors run `pnpm changeset` per PR. CLEO's agent-authored workflow does not produce changeset files; back-filling them is more work than ADR-073 Direction B.
- None of the three give CLEO the provenance graph (audit Q4) for free. The graph schema would still be CLEO-owned.

The scoping decision was: "borrow patterns from these tools (especially changesets' `release-please-manifest`-style summary commit), but do not host the entire pipeline inside one of them." This ADR-073 implements that decision.

---

## Forces / constraints

Twelve forces drive this decision. Each is mapped to the failure modes and conflation evidence above.

| # | Force | Rationale (cite) |
|---|-------|------------------|
| F1 | **Hotfix throughput — MTTR < 1 hour from "P0 detected" to "fix shipped"** | T9344 Anthropic OAuth hotfix forced a release on `v2026.5.74` mid-Phase-5; v2026.5.73→v2026.5.74 took >2h because of Failures #1, #6, #8 (forensics §Closing observations). Hermes ships same-day patches as `v<base>.<N>` suffix in ~10 minutes (research §5.4). |
| F2 | **Provenance integrity — zero orphan commits in releases** | Failure #6 (tag at wrong SHA) corrupted the release_manifest. Operator had to manually `git tag -d && git push origin :refs/tags/<tag>` and retag. Audit Q4: provenance graph is "derivable but not queryable". |
| F3 | **Project-agnostic — works for npm monorepo, single npm lib, single Rust crate, single Python pkg, Bun pkg** | ADR-053 RELEASE-06 fixture demanded 3 archetypes; ADR-065 regressed to npm+`gh` hard requirement. T1737 adds 5 platform tuples (Linux/macOS/Win, x64/arm64). |
| F4 | **Resumable mid-flight failures** | Failure #8: `releaseShip` is a 761-line monolith with no checkpoints. Failure #1: wedged git commit leaves indeterminate state with no resume path. Forensics §Cluster 3. |
| F5 | **Real evidence gates — no theater** | Failure #3: `defaultRunGate` is a no-op stub. Failure #4: IVTR gate's `unchecked` bucket reduces gate to a print statement. ADR-051 already says evidence MUST be programmatic; release must honor that. |
| F6 | **Tag points at canonical merge commit, never pre-merge SHA** | Failure #6: `gh pr merge --auto` is async; Step 10 polls nothing. Hermes's OCI-revision-label ancestor check (research §3.4) is the gold standard. |
| F7 | **Child-process supervision — every spawn has a timeout + SIGKILL grace** | Failure #1: `gitCwd` (engine-ops.ts:1497) has no `timeout`; `runGitWithLockRetry` retries only on the stale-lock signature. Forensics §Cluster 1. |
| F8 | **Governance / pipeline separation — gates BLOCK; pipeline state MUST be unblockable for hotfixes with audited override** | Forensics §"Conflation hypothesis": IVTR mixes governance ("don't ship") with pipeline ("warn and continue"). Same function does both. Audit §Phase 5 Q2: "Both (conflated). Should be observation-only." |
| F9 | **Operator surface ≤ 4 steps — operator memory budget** | Current CLI has 14 release subcommands (audit §1). Forensics §Failure #8: `release start` is a no-op the operator must still remember. Letta's harness path is exactly 2 operator actions: trigger `prepare-release` workflow → merge the PR. (research §3.4) |
| F10 | **BRAIN / Task DB SSoT preserved** | ADR-068 (CLEO Database Charter) names 9 DBs with `openCleoDb` as the single chokepoint. Any new tables (release_manifest_commits, releases) MUST flow through the charter (audit §Phase 4). |
| F11 | **GitOps-compatible — audit trail = git log + DB, never just DB** | Owner-stated invariant: every release MUST be reconstructable from git alone if DB is lost. Hermes commits `RELEASE_v0.13.0.md` to repo root (research §3.7); CLEO currently commits CHANGELOG.md but not per-release artifacts. |
| F12 | **Backward compatibility with existing `release_manifests` data** | `release_manifests` table has shipped 70+ releases since v2026.4.0. Any schema change MUST migrate forward without losing historical rows. |

Two non-force constraints (out of scope for this ADR but binding on the spec):

- **Constraint N1**: ADR-051 evidence-gate semantics MUST NOT be weakened. The release pipeline consumes evidence; it does not redefine it.
- **Constraint N2**: ADR-070 three-tier orchestration (Orchestrator → Lead → Worker) MUST remain the only spawn topology. The release pipeline is one of many flows the Orchestrator dispatches; it must compose with `cleo orchestrate spawn` and ADR-062 worktree merge.

---

## Considered directions

This ADR evaluates **exactly three** directions, named for what they do to the current implementation. A fourth direction (fully external — adopt release-please or semantic-release wholesale) was rejected at the council scoping phase and is not evaluated here.

---

### Direction A — Simplify-in-place (harden the 12-step)

**What changes**: keep `releaseShip` as the single canonical release function; surgically fix each cluster without architectural reshape.

- **C1 (process supervision)**: add `timeout: 30_000` to `gitCwd` (engine-ops.ts:1497); wrap `runGitWithLockRetry` in a SIGKILL-on-timeout wrapper; replace `gh pr merge --auto` with poll loop on `gh pr view --json state,mergeCommit` (forensics §F1, F6 suggested invariants).
- **C2 (gate confusion)**: wire `defaultRunGate` (pipeline.ts:249-262) to the ADR-061 tool resolver; delete `release-manifest.ts:runReleaseGates` in favor of the canonical 5-gate set; make IVTR gate policy explicit (`release.ivtr.policy: "strict"|"opt-in"|"off"` in `.cleo/config.json` — forensics §F4 suggested invariant).
- **C3 (no resume)**: extend `.cleo/release/handle.json` schema with `{lastCompletedStep, lastError, stepCheckpoints[]}`; add `cleo release ship --resume <version>` reading the handle and dispatching from `lastCompletedStep + 1`.
- **C4 (env-only enforcement)**: add `.cleo/worktree-policy.json` on-disk artifact the git-shim reads independent of `CLEO_AGENT_ROLE`; extend denylist to include `git push <remote> <local>:<protected-branch>` (forensics §F7).
- **C5 (hand-maintained registries)**: convert `build.mjs` externals to `.cleo/build-externals.json` + a CI gate (`cleo verify --evidence "tool:externals-sync"`); add `userFacingSummary` + `impact` to task contract (forensics §F9, F10 suggested invariants).
- **C6 (session counter)**: wire `sessionEnd` to delete `.cleo/audit/session-override-count.<sid>.json`; ban `'global'` sessionId fallback in validation (forensics §F5).
- **IVTR decoupling**: scope the IVTR check to `--epic <id>` only (audit Priority 1, partial); add explicit `non-blocking` opt-out per task; do NOT remove `task.ivtr_state` column.
- **Project-agnosticism**: route the publish step through `publish.command` in `.cleo/project-context.json` (already partially in `releasePublish` — pipeline.ts:376-424). Make `gh` requirement gated behind `release.requirePR=true` config.

**Architecture sketch**:

```
                   ┌──────────────────────────────────┐
                   │  cleo release ship <version>     │
                   │  --epic <id> [--resume]          │
                   └────────────┬─────────────────────┘
                                │
                                ▼
                   ┌──────────────────────────────────┐
                   │  releaseShip()  (engine-ops.ts)  │
                   │  HARDENED 12-step monolith        │
                   │                                  │
                   │  + step-by-step handle writes    │
                   │  + child-process timeouts        │
                   │  + ADR-061 gate-runner injection │
                   │  + gh pr poll-to-merged          │
                   │  + on-disk worktree policy       │
                   └────────────┬─────────────────────┘
                                │
            ┌───────────────────┼─────────────────────┐
            ▼                   ▼                     ▼
   ┌───────────────┐  ┌──────────────────┐  ┌──────────────────┐
   │ pipeline.ts   │  │ release-manifest │  │ guards.ts        │
   │ (4-step)      │  │ (DB)             │  │ (scope-leak fix) │
   │ STILL parallel│  │ unchanged schema │  │ patched          │
   └───────────────┘  └──────────────────┘  └──────────────────┘
```

**LOC delta**: ±100 lines net (defensive depth — ~+400 LOC of new wrappers / config-readers / poll loops; ~-300 LOC of dead branches consolidated). Net: slightly larger.

**Risk**: **★★ (low)** — small surface, every change is localized, no module boundaries shift, no DB schema migration required.

**Operator UX**: **identical** — 14 release subcommands stay, `cleo release ship` still the canonical happy path. `--resume` is the only new flag.

**Provenance**: **minimal upgrade** — handle gains `stepCheckpoints[]` but the deep gap (no `commits` table, no `(task, commit, release)` triples) remains. Audit Q4 still answers "derivable but not queryable".

**What survives from current code**: **~90%**. `releaseShip` body is patched in place; `pipeline.ts`, `guards.ts`, `release-manifest.ts`, `version-bump.ts`, `github-pr.ts`, `engine-ops.ts` all stay. Only `defaultRunGate` (pipeline.ts:249-262) gets a real implementation.

**Migration cost**: ~**1.5 operator-weeks** (one architect-week of patches + half-week of regression testing; no data migration; existing release_manifests rows untouched).

**Hermes-agent alignment**: **2/5** — adopts the timeout discipline (research §3.2 has `timeout: 30_000` per subprocess), the recovery-command-print pattern (§5.1), the same-day suffix idea is *adoptable* (§5.4) — but the monolith stays and `release: published` decoupling is not introduced.

**Letta-code alignment**: **2/5** — does NOT adopt the two-stage prepare-PR-then-release pattern (research §3.4). No `release_bump_only` classifier. No integration smoke test before npm publish.

**T1737 alignment**: **2/5** — `releaseShip` still hardcodes the npm publish path (engine-ops.ts:1480). Adding cargo/twine/bun-publish would require a switch statement inside the monolith; not a clean extension point. Linux arm64 / macOS / Win artifacts would need extra steps grafted on.

**Project-agnostic score**: **3/5** — better than today (ADR-061 wiring closes one gap, `publish.command` works for cargo/twine) but the monolith's structure assumes one publish target. 22 npm packages in CLEO works; adding a Rust crate side-by-side does not.

**Failure-mode coverage**: **9/10** — every failure mode has a patch except Failure #10 partial (CHANGELOG entries get `userFacingSummary` but the architecture still hand-maintains the heuristic).

**Per-failure mapping (Direction A)**:

| Failure | A's remediation | Residual risk |
|---|---|---|
| #1 wedged commit | `timeout: 30_000` on every `execFileSync('git', …)` invocation; SIGKILL grace wrapper around `runGitWithLockRetry` | Fixed locally. New invocations added later might still forget the timeout (no enforcement). |
| #2 epic scope leak | `checkEpicCompleteness` gains an `epicId` arg; results filtered to that epic only | Fixed. `findEpicAncestor` cross-epic walk remains but is now non-load-bearing. |
| #3 gate runners not wired | `defaultRunGate` calls ADR-061's `resolveToolForProject` resolver | Fixed. `runReleaseGates` parallel registry remains, can drift again. |
| #4 IVTR non-blocking | `release.ivtr.policy` config; under `strict`, `unchecked` counts as `blocked` | Mitigated, not removed. Default config still `opt-in`; gate is still on the release path. |
| #5 override cap | `sessionEnd` hook deletes counter file; `'global'` fallback banned | Fixed at session lifecycle layer; behavior change non-load-bearing on release. |
| #6 tag at wrong SHA | Poll `gh pr view --json state,mergeCommit` after `--auto`; bounded 15-min timeout | Mitigated; race window narrows from minutes to seconds but doesn't disappear. |
| #7 worker direct-push | `.cleo/worktree-policy.json` on-disk artifact; denylist gains protected-branch push patterns | Mitigated by defense-in-depth, but env-only enforcement remains the primary fence. |
| #8 release start no-op | Handle gains `lastCompletedStep` field; `releaseShip` reads handle on entry; `--resume` flag added | Mitigated; the two parallel pipelines still exist, just coupled. |
| #9 esbuild externals | `.cleo/build-externals.json` schema + CI gate diffing it against `package.json` | Fixed. Hand-maintenance moves from `build.mjs` to JSON; sync gate catches drift. |
| #10 CHANGELOG fragile | Tasks gain `userFacingSummary` + `impact` fields; categorizer respects them | Mitigated. Heuristic-based fallback remains for tasks without the new fields. |

---

### Direction B — Git-flow + GHA wrapper (rebuild as orchestrator over standard tooling)

**What changes**: `cleo release` becomes a **thin opinionated wrapper** that produces a *plan* and pushes the work into standard tooling — `gh`, `git`, `gh actions`, plus optional bridges to `semantic-release` / `release-please` / `changesets`. GitHub Actions does the heavy lifting (gates, build, smoke, publish, tag). CLEO stores the **provenance graph** and serves the **decision surface**.

- **CLI surface collapses from 14 to 4 verbs**:
  - `cleo release plan <version> --epic <id>` — assembles version, gathers tasks, computes changelog, validates evidence atoms against ADR-051, writes plan to `.cleo/release/<version>.plan.json`. Read-only on git + remote.
  - `cleo release open <version>` — opens the bump-PR (the Letta `prepare-release.yml` analog) with the plan as PR body. Idempotent.
  - `cleo release reconcile <version>` — post-merge, post-tag: walks the release-events stream, writes provenance edges to `release_manifest_commits` + `releases`, archives the plan, auto-completes tasks listed in plan.
  - `cleo release rollback <version> [--full]` — unchanged surface, but implementation now drives the workflow via `gh workflow run rollback.yml`.

- **GHA workflows become the pipeline**:
  - `release-prepare.yml` (Letta `prepare-release.yml` analog): runs full preflight (`pnpm run check && pnpm run build && pnpm run test`), bumps versions via CLEO's `resolveVersionBumpTargets`, opens the bump-PR. Triggered by `workflow_dispatch` or by `cleo release open`.
  - `release-ci.yml`: re-runs all gates against the bump-commit. Includes the `release_bump_only` classifier (Letta research §3.4) to skip heavy paths when the PR touches only manifests + CHANGELOG.
  - `release-publish.yml` (Letta `release.yml` analog): triggers on push to main with subject matching `^release: ship v`. Re-runs lint+typecheck+build+integration smoke; tags from `${{ github.sha }}` (the merged main commit — fixes Failure #6 by construction); calls `cleo release reconcile <version>` over `gh api` to write provenance; publishes to npm / cargo / pypi / bun via the **per-platform publisher matrix**.
  - `release-rollback.yml`: implements `rollback-full` server-side.

- **Hermes mechanics adopted directly**: dual CalVer + SemVer (research §3.1), annotated tag with structured message (§3.3), `release: published` fan-out for downstream (§3.3), OCI-revision-label ancestor check for floating tags (§3.4), same-day `.N` suffix (§5.4), supply-chain audit on PR diffs (§3.10).

- **Letta mechanics adopted directly**: two-stage prepare-PR-then-release (research §3.4), `release_bump_only` classifier (§3.4 sub-section), integration smoke test using a real API key from `secrets.CLEO_RELEASE_TEST_KEY` (§3.4 step 4), `environment: cleo-publish` GitHub Environments with required reviewers (§3.4 step 7), `softprops/action-gh-release@v2` with `generate_release_notes: true` and artifact attachment.

- **IVTR decoupled per audit Priority 1**: release gates are evidence-only (ADR-051 atoms re-validated on `reconcile`); `task.ivtr_state` becomes a read-only derived view over the evidence atoms (audit §Phase 6 streamlining sketch).

- **Provenance graph implemented (audit Priority 3)**: new tables `releases` + `release_manifest_commits` + view `release_provenance` (audit §Recommendations). Edges written by `reconcile` from git log + plan.json + evidence atoms.

- **Process supervision**: locally, the only spawned subprocesses are `git status`, `git log`, `gh pr view --json`, `gh workflow run`. Each gets `timeout: 30_000` and SIGKILL grace. The heavy work (build, test, publish) runs in GHA — which has its own per-step timeouts and is observable via `gh run watch`.

- **T1737 platform matrix**: `release-publish.yml` becomes a build matrix (`strategy.matrix.platform: [linux-x64, linux-arm64, macos-x64, macos-arm64, windows-x64]`). Each matrix slot produces a platform-tagged artifact attached to the GitHub Release.

**Architecture sketch**:

```
                    ┌──────────────────────────────────────┐
                    │  cleo release plan / open / reconcile│
                    │  (≤ 4 verbs · read-mostly local)     │
                    └────────────┬─────────────────────────┘
                                 │ writes .cleo/release/<v>.plan.json
                                 │ + reads ADR-061 tool resolver
                                 │ + reads ADR-051 evidence atoms
                                 ▼
                    ┌──────────────────────────────────────┐
                    │  release-prepare.yml (GHA)           │  ←─ cleo release open
                    │  preflight gates · bump-PR open      │
                    └────────────┬─────────────────────────┘
                                 │
                                 ▼  (human review + merge)
                    ┌──────────────────────────────────────┐
                    │  release-publish.yml (GHA)           │  ←─ trigger: push main
                    │  matrix [linux/mac/win × x64/arm64]  │       commit subject regex
                    │  re-gates · build · smoke · publish  │
                    │  tag from $GITHUB_SHA · gh release   │
                    └────────────┬─────────────────────────┘
                                 │ release: published event
                                 ▼
                    ┌──────────────────────────────────────┐
                    │  cleo release reconcile (called via  │  ←─ called via gh api
                    │  gh api dispatch from publish job)   │
                    │  writes provenance graph rows        │
                    │  auto-completes tasks                 │
                    └────────────┬─────────────────────────┘
                                 │
                                 ▼
                    ┌──────────────────────────────────────┐
                    │  release-fanout.yml (GHA)            │  ←─ release: published
                    │  docs deploy · sentinel notify       │
                    │  (decoupled · async · best-effort)   │
                    └──────────────────────────────────────┘

DB:    releases    release_manifest_commits    task_relations    release_provenance (view)
       (new)       (new)                       (existing)        (new)
```

**LOC delta**: **-1500 / +400 net = -1100 lines**. Deletions: `engine-ops.ts:releaseShip` (~760 LOC), `release-manifest.ts:runReleaseGates` + the duplicated gate plumbing (~300 LOC), `pipeline.ts:defaultRunGate` + child-audit stubs (~80 LOC), IVTR auto-suggest + release-side IVTR gate (~150 LOC, audit Leaks #1, #2, #4). Additions: 4-verb CLI handlers (~150 LOC), provenance-graph writer in `reconcile` (~120 LOC), 4 GHA workflow files (~600 lines of YAML, not LOC). Net code reduction is the largest of any direction.

**Risk**: **★★★ (medium)** — moves logic to GHA, which is a different operational surface; the team must own workflow YAML alongside TypeScript. Mitigated by Hermes/Letta both running this pattern in production; not novel territory.

**Operator UX**: **3-step happy path** — `cleo release plan v2026.X.Y --epic T####`, `cleo release open v2026.X.Y` (which is a single `gh workflow run release-prepare.yml`), `gh pr merge` once review is complete. **No `release ship` invocation**. Hotfix: same 3 steps; the suffix mechanism (`v2026.X.Y.2`) is computed in `plan`. Resume: re-run the workflow with `workflow_dispatch` — GHA handles idempotency.

**Provenance**: **rich** — `release_provenance` SQL view (audit §Recommendations) answers "which bugs shipped in v2026.X.Y" with one query. Every release commit carries `T#### (#PR)` trailers (Letta convention). Git log + DB are dual sources of truth.

**What survives from current code**: **~30%**. `version-bump.ts` (`resolveVersionBumpTargets`), `changelog-writer.ts`, `release-manifest.ts:listManifestReleases` + `showManifestRelease`, `invariants/registry.ts`, `release-config.ts`, the validators, the test suite for guards. Most of `engine-ops.ts:releaseShip` is deleted; some helpers (`detectBranch`, `runGitWithLockRetry`) survive in a much smaller surface.

**Migration cost**: ~**4 operator-weeks** (one architect-week of design + 1.5 weeks of workflow authoring + 0.5 week of CLI rewrite + 1 week of regression testing + dogfooding on a non-critical release).

**Hermes-agent alignment**: **5/5** — adopts all 8 Tier-1 mechanics (research §6). The release-as-script (Hermes) → release-as-workflow (CLEO via GHA) is a one-step generalization.

**Letta-code alignment**: **5/5** — verbatim adoption of the two-stage prepare-PR-then-release pattern + `release_bump_only` classifier + integration smoke + Environments gate (research §3.4).

**T1737 alignment**: **5/5** — GHA matrix gives multi-platform builds for free. Each platform slot produces a tagged artifact; `release-publish.yml` attaches all five to the GitHub Release. Pi adapter consumes the linux-arm64 artifact.

**Project-agnostic score**: **5/5** — CLI surface speaks `plan/open/reconcile/rollback` in any language. Per-platform publisher matrix swaps `npm publish` for `cargo publish` / `twine upload` / `bun publish` per target. ADR-053 RELEASE-06 fixture passes by construction. ADR-061 tool resolver is the only gate runner.

**Failure-mode coverage**: **10/10** — every failure is structurally prevented:
- #1 wedged commit → gone (`git commit` happens once in `release-prepare.yml` with built-in workflow timeout).
- #2 epic scope leak → gone (`plan` carries explicit `--epic` and writes the scope to plan.json; `reconcile` reads from plan).
- #3 gate runners not wired → gone (ADR-061 resolver is the only path).
- #4 IVTR non-blocking → gone (IVTR removed from release path; audit Priority 1).
- #5 override cap → gone (no `--force` on `plan`/`open`/`reconcile`; overrides only at the evidence-atom layer where ADR-051 already audits them).
- #6 tag at wrong SHA → gone (tag created in workflow from `$GITHUB_SHA` after merge).
- #7 worker direct-push → mitigated by GitHub branch protection + the on-disk worktree policy added as a side-quest.
- #8 release start no-op → gone (no `start`; `plan` is explicit and idempotent).
- #9 esbuild externals → caught by `release-prepare.yml` preflight running `pnpm run build` BEFORE opening the PR.
- #10 CHANGELOG → uses `softprops/action-gh-release@v2` `generate_release_notes` + `cleo release plan` emits a human-curated summary into PR body (no more 150-char-truncated RCASD wall-of-text).

**Per-failure mapping (Direction B)**:

| Failure | B's remediation | Why structural (not patch) |
|---|---|---|
| #1 wedged commit | `git commit` is a single step inside `release-prepare.yml` with GHA-native step timeout (`timeout-minutes`) | The CLEO process never spawns the long-running git commit. The workflow runner enforces timeouts; CLEO cannot forget. |
| #2 epic scope leak | `plan` writes `epicId` into the plan file; `reconcile` reads from the plan. `checkEpicCompleteness` consumes plan.json, not derived ancestors | Scope is explicit data, not implicit graph traversal. The bug class disappears. |
| #3 gate runners not wired | `cleo verify --gate X --evidence tool:Y` (ADR-061) is the only gate path. The release-side `runReleaseGates` parallel registry is deleted. | One gate runner can't disagree with itself. |
| #4 IVTR non-blocking | IVTR removed from release path. Evidence atoms re-validate at reconcile time. | If a force isn't on the path, it can't be skipped. |
| #5 override cap | No `--force` on any of the 4 verbs. Overrides happen at `cleo verify` evidence-atom layer where ADR-051 already audits to `force-bypass.jsonl`. | The override surface contracts to one well-audited place. |
| #6 tag at wrong SHA | Tag is `git tag $TAG $GITHUB_SHA` in `release-publish.yml`, gated on `gh pr view --json state == MERGED`. | GitHub Actions runs after the merge is observable on remote. No race. |
| #7 worker direct-push | Server-side: GitHub branch protection. Client-side: ADR-073 retains the worktree-policy file as T9345-CHILD-7. | Defense in depth; both layers must fail simultaneously. |
| #8 release start no-op | No `start`. `plan` writes `.cleo/release/<version>.plan.json` and that file IS the resumable state. | One state file, one canonical source. |
| #9 esbuild externals | `release-prepare.yml` preflight runs `pnpm run build` before opening the PR; failure blocks the PR. | The bundling failure is caught BEFORE the version bump exists in main. |
| #10 CHANGELOG fragile | `softprops/action-gh-release@v2` `generate_release_notes: true` + plan-file's `userFacingSummary` (authored by `plan` from task `kind` + `impact`) | Auto-generation works on commit subjects (which CLEO controls via T#### conventional commits); RCASD-task verbose descriptions are not the source. |

**Implementation detail — the four CLI verbs in pseudocode**:

```
# plan: idempotent, read-mostly, writes plan file
$ cleo release plan v2026.6.0 --epic T9999
  → resolveVersion(scheme=calver, candidate=v2026.6.0) → 'v2026.6.0' or 'v2026.6.0.2'
  → gather ADR-051 evidence atoms for all tasks under T9999
  → check epic completeness scoped to T9999 (no cross-epic walk)
  → assemble CHANGELOG draft from `git log <prevTag>..HEAD` + task data
  → write .cleo/release/v2026.6.0.plan.json
  → emit summary table to stdout

# open: side-effectful, calls gh workflow run
$ cleo release open v2026.6.0
  → reads .cleo/release/v2026.6.0.plan.json
  → gh workflow run release-prepare.yml --field version=v2026.6.0 --field plan=<plan-blob>
  → prints workflow run URL
  → polls run status until "In progress" or "Completed"

# reconcile: invoked from release-publish.yml; writes provenance graph
$ cleo release reconcile v2026.6.0
  → reads .cleo/release/v2026.6.0.plan.json
  → reads `gh release view v2026.6.0 --json tagName,publishedAt,body,assets`
  → INSERT INTO releases (...) VALUES (...)
  → for each commit in `git log <prevTag>..v2026.6.0`:
      INSERT INTO release_manifest_commits (release_id, commit_sha, task_id, ...)
  → for each task in plan.tasks:
      mark task.releasedIn = 'v2026.6.0'
      cleo memory observe --title "Released v2026.6.0" --type decision
  → archive plan file to .cleo/release/archive/

# rollback: thin wrapper over release-rollback.yml
$ cleo release rollback v2026.6.0 [--full]
  → gh workflow run release-rollback.yml --field version=v2026.6.0 --field mode=full
  → emit reconciled rollback marker into provenance graph
```

**GHA workflow contract detail**:

- `release-prepare.yml`: triggers on `workflow_dispatch` with `version` input. Runs preflight (lint+typecheck+build+test) on `main`, applies version bump via `cleo version-bump --version $VERSION`, commits as `release: prepare v$VERSION`, opens PR with body = plan.json content. Output: PR URL.
- `release-publish.yml`: triggers on `push: main, paths: [package.json, packages/*/package.json, Cargo.toml, packages/*/Cargo.toml]`. Detects subject `^release: prepare v` via `git log --format=%s "${{ github.event.before }}..${{ github.sha }}"` (Letta pattern). If matched, runs platform matrix; each matrix slot runs gates + smoke + publishes. After all matrix slots succeed, single `tag` job tags from `$GITHUB_SHA`, creates GitHub Release, invokes `cleo release reconcile`.
- `release-fanout.yml`: triggers on `release: published`. Decoupled from publish. Handles docs deploy, sentinel notify, Docker image retag.
- `release-rollback.yml`: triggers on `workflow_dispatch`. Implements rollback-full server-side: delete remote tag, revert merge commit, deprecate npm package, write rollback marker to provenance graph.

---

### Direction C — Extract to standalone CLI (`@cleocode/release-tool`)

**What changes**: pull `packages/core/src/release/*` into a new top-level package `packages/release-tool/` (later promotable to `@cleocode/release-tool` as its own npm binary). Expose a CLI binary `release` independent of `cleo`. Make `cleo release` a thin consumer that imports `@cleocode/release-tool` and adapts CLEO's BRAIN/Task DB into the tool's storage adapter.

- **Package boundary**: new package per AGENTS.md Package-Boundary Check.
  - `packages/release-tool/src/` — pure release logic, no `@cleocode/core` import.
  - `packages/release-tool/src/adapters/` — storage adapter interface (read tasks, write manifests). CLEO ships `packages/release-tool/adapters/cleo.ts` that wraps `getTaskAccessor`, `openCleoDb`, `releaseManifests`. A reference `adapters/filesystem.ts` writes to `.release/manifests/*.json` for projects without CLEO.
  - `packages/release-tool/src/gates/` — gate-runner interface. CLEO ships `gates/cleo-evidence.ts` that calls `cleo verify --gate X --evidence Y`. Reference `gates/exec.ts` runs raw subprocesses.
  - `packages/cleo/src/cli/commands/release.ts` — collapses to ~50 lines, mostly arg parsing + delegation.

- **Two binaries on user PATH**: `cleo` (task + orchestration) and `release` (shipping). Owner runs `release ship v2026.X.Y --epic T####` directly when in a CLEO project; `cleo release ship` still works as an alias that auto-fills the adapter.

- **Same 12-step lifecycle inside `release-tool`**, but each step is a named exported function + can be invoked individually (`release step gate-check`, `release step open-pr`, …). Resume is built-in because each step writes its own state into the adapter.

- **IVTR decoupling**: `release-tool` has no concept of IVTR. The CLEO adapter optionally surfaces "task has non-empty `ivtr_state` and currentPhase != 'released'" as a *blocker reason* for the gate-check step, but the tool itself is IVTR-blind.

- **Provenance graph**: `release-tool` defines a portable schema (`releases`, `release_manifest_commits`, `release_task_links`); the CLEO adapter materializes these as SQLite tables via `openCleoDb` (ADR-068 chokepoint). Non-CLEO consumers get JSON files.

- **GHA bindings optional**: `release-tool` can run as a local CLI (the Hermes-style script) OR as the engine inside GHA workflows. Each surface is supported.

**Architecture sketch**:

```
                     ┌─────────────────────────────────────┐
                     │  release  (new top-level binary)    │
                     │  release  ship/plan/open/reconcile  │
                     │  release  step <name>               │
                     │  release  rollback                   │
                     └──────────────────┬──────────────────┘
                                        │
                                        ▼
                     ┌─────────────────────────────────────┐
                     │  @cleocode/release-tool             │
                     │  (new package; no @cleocode/core    │
                     │   import; tested in isolation)      │
                     │                                     │
                     │  ┌────────────┐    ┌─────────────┐  │
                     │  │ pipeline   │    │ gates iface │  │
                     │  │ (12 steps  │◄───┤             │  │
                     │  │  each      │    │             │  │
                     │  │  exported) │    │             │  │
                     │  └─────┬──────┘    └─────────────┘  │
                     │        │                            │
                     │        ▼                            │
                     │  ┌────────────────┐                 │
                     │  │ storage iface  │                 │
                     │  └────────┬───────┘                 │
                     └───────────┼─────────────────────────┘
                                 │
                       ┌─────────┴─────────┐
                       ▼                   ▼
              ┌─────────────────┐  ┌─────────────────┐
              │ cleo adapter    │  │ fs adapter      │
              │ (BRAIN+tasks.db)│  │ (.release/*.json)│
              └─────────┬───────┘  └─────────────────┘
                        │
                        ▼
              ┌──────────────────┐
              │ cleo CLI         │
              │ (cleo release X  │
              │  is now alias)   │
              └──────────────────┘
```

**LOC delta**: **+200 net**. Mostly boilerplate: package skeleton, adapter interfaces, storage abstraction, dual binary entrypoints. Underlying logic is preserved (~85% of `releaseShip` body moves wholesale into `packages/release-tool/src/pipeline.ts`). The 12-step monolith is *decomposed* into 12 functions but stays inside the new package.

**Risk**: **★★★★ (higher)** — introduces a new package boundary with its own publish surface (`@cleocode/release-tool` on npm), CI matrix, versioning, and docs. The "two binaries on PATH" UX has known sharp edges (which one wins when both are installed?). Adapter contract must be stable from v1; breaking it cascades to all consumers.

**Operator UX**: **two binaries** — `cleo` and `release`. Inside a CLEO project, `cleo release ship` and `release ship` are equivalent. Outside a CLEO project, only `release ship --adapter filesystem` works. Doubles the surface area to teach.

**Provenance**: **partial** — `release-tool` defines a portable schema, but CLEO's richer "task → epic → feature → bug → hotfix" graph lives in `tasks.db`. The adapter must replicate the relevant subset into the tool's schema OR proxy queries back. Either way, **double-bookkeeping** is the steady state. Audit Q4's "queryable provenance" goal is reached for `release-tool`'s own tables but bridging back to BRAIN/Tasks requires writing dedicated joins.

**What survives from current code**: **~85%** — every function in `packages/core/src/release/*` moves (largely unchanged) into `packages/release-tool/src/*`. Behavior at runtime is preserved; structure changes.

**Migration cost**: ~**6 operator-weeks** (one week of package extraction + 1.5 weeks of adapter design + 1.5 weeks of CLI dual-binary engineering + 1 week of cleo→release-tool integration + 1 week of regression and dogfood). Higher than Direction B despite less behavior change because the package boundary is load-bearing.

**Hermes-agent alignment**: **3/5** — the standalone `release` binary IS the "release.py" pattern (research §3.2). But CLEO's two-binary topology is heavier than Hermes's single script.

**Letta-code alignment**: **2/5** — does NOT structurally adopt the two-stage prepare-then-release. Could be layered on, but the package boundary is the wrong abstraction for that pattern.

**T1737 alignment**: **3/5** — multi-platform is achievable by making the publisher pluggable in `release-tool`, but the package itself needs to ship platform-specific build artifacts. Going through GHA (Direction B) is still required for the matrix; this direction adds a layer rather than solving the problem.

**Project-agnostic score**: **5/5** — by design. The filesystem adapter proves portability; the CLEO adapter is just one consumer. ADR-053 RELEASE-06 passes by construction.

**Failure-mode coverage**: **7/10** — Failures #1, #6, #7, #8 are addressed by decomposition + resume; Failures #3, #4 (gates) are addressed only IF the adapter wires ADR-061 (a contract that can be violated by future adapters); Failures #2, #5, #9, #10 are addressed at the same level as Direction A — by patches inside the tool.

**Per-failure mapping (Direction C)**:

| Failure | C's remediation | Coverage class |
|---|---|---|
| #1 wedged commit | Decomposed step (`release step commit`) gets explicit timeout | Fixed locally |
| #2 epic scope leak | Adapter passes explicit `epicId`; tool itself is scope-aware | Fixed by interface contract |
| #3 gate runners not wired | Tool's gate interface is the contract; CLEO adapter wires ADR-061 | Adapter-dependent (future adapter can regress) |
| #4 IVTR non-blocking | Tool has no IVTR; CLEO adapter optionally surfaces it as a "blocker reason" | Adapter-dependent |
| #5 override cap | Tool has no `--force`; overrides happen at evidence-atom layer | Fixed by interface contract |
| #6 tag at wrong SHA | Same local poll-loop as Direction A | Mitigated, not eliminated |
| #7 worker direct-push | Tool-agnostic; CLEO's worktree shim is unchanged | No change from today |
| #8 release start no-op | Each step has its own state file in the tool's storage | Fixed by decomposition |
| #9 esbuild externals | Tool calls adapter's `prebuild` hook; CLEO adapter runs `pnpm run build` | Adapter-dependent |
| #10 CHANGELOG fragile | Same heuristic-based fallback as Direction A | Mitigated |

---

## Trade-off matrix

| Force | A — Simplify-in-place | B — Git-flow + GHA wrapper | C — Standalone `@cleocode/release-tool` |
|---|---|---|---|
| **F1 — Hotfix MTTR < 1h** | ⚠️ (resumable monolith helps but `--force` cap still binary) | ✅ (same-day suffix + workflow rerun ≤ 10 min) | ⚠️ (decomposed steps help but operator must learn 2 binaries) |
| **F2 — Provenance integrity** | ⚠️ (handle gains checkpoints; no `commits` table) | ✅ (`releases` + `release_manifest_commits` view + git trailers) | ⚠️ (queryable in tool; double-bookkeeping vs BRAIN) |
| **F3 — Project-agnostic (3+ archetypes)** | ⚠️ (publish via `publish.command`; gh hardcode lingers) | ✅ (per-platform matrix; ADR-061 sole gate path) | ✅ (filesystem adapter by design) |
| **F4 — Resumable mid-flight** | ✅ (`--resume <version>` via handle) | ✅ (workflow rerun; idempotent step flags per Letta §3.4) | ✅ (`release step <name>` decomposition) |
| **F5 — Real evidence gates** | ✅ (wires `defaultRunGate` to ADR-061) | ✅ (ADR-061 is the only path; no parallel registries) | ⚠️ (depends on adapter; future adapters can regress) |
| **F6 — Tag at canonical merge commit** | ⚠️ (poll loop after `gh pr merge --auto`; race window narrowed not eliminated) | ✅ (tag created from `$GITHUB_SHA` in workflow; race gone by construction) | ⚠️ (same as A; tag step still local) |
| **F7 — Child-process supervision** | ✅ (`timeout` on every `execFileSync`) | ✅ (locally minimal subprocesses; workflow timeouts handle the rest) | ✅ (helpers preserved + timeouts added) |
| **F8 — Governance / pipeline separation** | ⚠️ (IVTR partial-decouple; conflation softened not removed) | ✅ (IVTR removed from release path per audit Priority 1) | ⚠️ (release-tool is IVTR-blind; cleo adapter still embeds IVTR check optionally) |
| **F9 — Operator surface ≤ 4 steps** | ❌ (14 release subcommands stay) | ✅ (4 verbs: plan / open / reconcile / rollback) | ❌ (two binaries doubles the surface) |
| **F10 — BRAIN/Task DB SSoT** | ✅ (no schema migration) | ✅ (new tables flow through `openCleoDb` chokepoint per ADR-068) | ⚠️ (tool defines its own tables; adapter syncs back) |
| **F11 — GitOps-compatible** | ⚠️ (still DB-primary; no per-release artifact committed) | ✅ (`generate_release_notes` writes to git; Hermes-style `RELEASE_v*.md` adoptable as side-quest) | ⚠️ (depends on adapter) |
| **F12 — Backcompat `release_manifests`** | ✅ (no schema change) | ✅ (new tables additive; existing rows preserved) | ⚠️ (data lives in two places during migration) |
| **Subtotal — ✅** | 4 | **10** | 4 |
| **Subtotal — ⚠️** | 7 | 2 | 7 |
| **Subtotal — ❌** | 1 | 0 | 1 |

**Direction B is the clear winner on the forces matrix — 10 forces fully satisfied versus 4 each for A and C.**

### Matrix interpretation notes

The matrix is not naive vote-counting. A few cells deserve explicit discussion because they encode trade-offs that voting hides:

- **F9 (operator surface ≤ 4 steps) is the only force where A and C both fail.** This is the operator-experience axis. Direction A keeps 14 subcommands because patching in-place preserves backward compatibility — which is itself a kind of operator-experience win in the short term. The matrix scores A as ❌ on F9 because the *long-term* operator load is the metric; today's operators have already memorized 14 subcommands but every new operator (and every agent that has to learn the surface) pays the full cost. The owner explicitly flagged this in the T9345 charter as a blocker.

- **F1 (hotfix MTTR) shows ⚠️ for A and C and ✅ for B.** A's resumable monolith narrows the MTTR window (no rollback-full needed mid-pipeline) but the binary `--force` is still the only escape hatch when gates fail in a P0 hotfix. B's workflow rerun + `release_bump_only` classifier + same-day suffix gives a tight ≤10-minute hotfix path. C's decomposition helps but the operator must still pick the right `release step <name>` and chain them — slower than a single `gh workflow run release-prepare.yml --field version=...`.

- **F6 (tag canonical merge commit) is the most dramatic axis.** This is the failure that bit production (v2026.5.74 anchor session). A and C both narrow the race window via polling but cannot eliminate it because the local clock and the remote clock are still independent. B eliminates the race by construction — `git tag $GITHUB_SHA` inside the workflow runs *after* GitHub has applied the merge; `$GITHUB_SHA` is the merge commit by definition.

- **F10 (BRAIN/Task DB SSoT) flips from ✅ to ⚠️ for C.** This is the "package boundary tax" — once `@cleocode/release-tool` becomes its own package with its own storage adapter interface, the BRAIN data and the tool's data live in two places by definition. Even when the CLEO adapter is the only adapter in use, the in-memory model has two representations: the BRAIN-shaped one (`tasks`, `task_relations`, `brain_decisions`) and the tool-shaped one (`releases`, `release_manifest_commits`, `release_task_links`). Drift becomes a maintenance burden.

- **F11 (GitOps-compatible) shows ⚠️ for both A and C.** Neither direction inherently commits per-release artifacts to git. Direction B's adoption of `generate_release_notes` writes notes to the GitHub Release object; if CLEO additionally adopts Hermes's `RELEASE_v0.13.0.md`-into-repo pattern (research §3.7), the git log becomes self-documenting and survives DB loss. This is a side-quest under T9345-CHILD-6 but is structurally easier under B because the GHA workflow can `gh release download` and commit the notes.

### Why the failure-mode coverage scores differ

Failure coverage scores (Direction A: 9/10, B: 10/10, C: 7/10) are NOT identical to force-satisfaction scores. A direction can fix all the failures and still fail forces (e.g., A fixes 9 failures but fails F8 because IVTR is still on the release path). A direction can leave failures partially mitigated and still excel on forces (B has trivial residual risk on F7 by relying on GitHub branch protection, but the structural prevention of #1, #6, #8 makes the residual acceptable).

The two scores are complementary: failure coverage shows "did we kill the bugs that bit us?", forces show "did we kill the architectural disease that produced the bugs?". A direction can score high on the former and low on the latter (whack-a-mole patching); the matrix shows B leads on both.

---

## Decision

**This ADR adopts Direction B (Git-flow + GHA wrapper) with one major qualifier borrowed from Direction C: the release pipeline's *core algorithmic logic* (gate sequencing, version bumping, changelog assembly, manifest writing, provenance edge construction) MUST live in a single, in-process, importable module within `packages/core/src/release/` — explicitly NOT a separate npm package — so that BOTH the CLI (`cleo release plan/open/reconcile`) AND the GHA workflows (`release-prepare.yml`, `release-publish.yml`) call into the same TypeScript code via `cleo release <verb> --json`. The GHA workflows orchestrate the *outer state machine*; CLEO owns the *inner decisions*.**

The chosen direction implements RFC 2119 normative behavior as follows:

1. The release pipeline MUST expose exactly **four operator verbs** at the CLEO CLI surface: `plan`, `open`, `reconcile`, `rollback`. All other current subcommands (`start`, `verify`, `publish`, `ship`, `list`, `show`, `cancel`, `changelog`, `pr-status`, `rollback-full`, `channel`) MUST be deprecated, mapped to compatibility shims that forward to the four canonical verbs, and removed in a subsequent major version.
2. The 12-step ship monolith (`packages/core/src/release/engine-ops.ts:releaseShip`) MUST be deleted. Its surviving algorithmic content MUST be redistributed across: `plan.ts` (steps 0-4, read-only), `open.ts` (steps 5-7, opens the bump-PR), and `reconcile.ts` (steps 10-12, runs after `release-publish.yml` merges main and tags). Steps 8-9 (CI wait, merge) MUST move entirely into `release-publish.yml`.
3. The parallel 4-step pipeline (`packages/core/src/release/pipeline.ts:releaseStart/Verify/Publish/Reconcile`) MUST be deleted. Its handle (`.cleo/release/handle.json`) MUST be replaced by `.cleo/release/<version>.plan.json`, which is the single resumable state file written by `plan` and consumed by `open`/`reconcile`.
4. The IVTR gate (`engine-ops.ts:1252-1295`, `engine-ops.ts:475-556`) MUST be removed from the release path. Release validation MUST consult only ADR-051 evidence atoms via the ADR-061 tool resolver. `task.ivtr_state` SHALL persist as a read-only derived view over evidence atoms for backward compatibility but MUST NOT block any release operation.
5. Tag creation MUST occur exclusively inside `release-publish.yml` at `$GITHUB_SHA` after the bump-PR merge has been confirmed via `gh pr view --json state,mergeCommit`. Local `cleo` MUST NOT create or push tags.
6. The provenance graph (audit §Recommendations P3) MUST be implemented as three new entities flowing through the ADR-068 `openCleoDb` chokepoint: a `releases` table, a `release_manifest_commits` table, and a `release_provenance` SQL view. `reconcile` MUST write these rows; failure to write them MUST fail reconciliation.

### Justification (≤ 500 words)

The trade-off matrix is unambiguous: Direction B satisfies 10 of 12 forces fully and 0 fails. The three strongest forces that drove the choice are:

**F3 (project-agnostic) is the foundational promise of ADR-053 that the current implementation has regressed.** Direction A patches the regression but does not architect away the next regression — the next time someone adds a npm-specific assumption, the monolith absorbs it. Direction B routes every project-specific concern (build, test, lint, typecheck, publish) through the ADR-061 tool resolver and the GHA matrix, making the regression structurally impossible. Direction C achieves the same portability score by extraction, but at the cost of doubling the operator surface (F9).

**F8 (governance/pipeline separation) is the conflation diagnosis the wave-1 audit scored at 7/10.** The forensics doc demonstrates that IVTR's `unchecked` bucket reduces a "gate" to a warning (Failure #4), that two parallel gate systems disagree (Failure #3), and that the override cap is bypassed routinely (Failure #5). These are not patchable in place — they are symptoms of one function (`releaseShip`) doing both governance and pipeline. Direction B separates them at the architectural level: `cleo release plan` is governance (read evidence, decide if shippable); `release-prepare.yml` and `release-publish.yml` are pipeline (do the work, idempotently, with workflow-native timeouts). Direction A softens the conflation; Direction C relocates it.

**F9 (operator surface ≤ 4 steps) is the unforced loss of the current system.** 14 release subcommands is more than the operator can hold; ADR-065's 12-step ship pipeline plus 4-step canonical pipeline is the apex symptom (Failure #8 — operator never knows which to run). Direction B collapses to 4 verbs that map 1:1 to operator intent: "decide what to ship" / "open the gate" / "record what shipped" / "undo". Direction A keeps 14. Direction C splits 14 across two binaries, making it 14+ effectively.

**What we give up by NOT picking the others:**

- *Not picking A*: we forgo the 1.5-operator-week ship time. Direction B's 4-week migration is 2.7× more expensive. We also give up the "no DB schema migration" comfort. The cost is justified by the 10-vs-4 force coverage; the alternative is shipping fixes today and re-doing the architecture in 6 months.

- *Not picking C*: we forgo full standalone reusability. `@cleocode/release-tool` would be valuable as a community asset, but the marginal portability win above Direction B (which is already 5/5 project-agnostic via adapters in `.cleo/project-context.json`) does not justify the operator-UX tax of dual binaries (F9) or the BRAIN/Tool double-bookkeeping (F10). If standalone extraction becomes desirable later, Direction B's in-process module is the natural source.

The qualifier ("core algorithmic logic stays in-process; GHA owns the outer state machine") explicitly hybridizes B with the strongest Direction-C idea — a clean module boundary — without paying Direction C's package-boundary tax.

### The qualifier in concrete terms

The qualifier exists because pure-Direction-B has a subtle risk: if all release logic moves into GHA YAML, the codebase loses the type-safe, unit-testable layer that today's `packages/core/src/release/*` provides. YAML is not TypeScript; YAML errors fail at runtime, not at `pnpm run typecheck`. The qualifier addresses this by mandating that the **decisions** (what version, what tasks, what changelog, what gates, what provenance edges) stay in TypeScript and are invoked from the workflows as `cleo release plan --json`, `cleo release reconcile --json`. The workflows only know how to: spawn `cleo release …`, parse JSON output, gate next-step on success, run the platform-matrix build, attach artifacts, fan out events. This separates *what to ship* (TypeScript, testable) from *how to deliver the act of shipping* (YAML, GHA-native).

In effect, the qualifier turns `packages/core/src/release/` into a CLI-callable library that has TWO consumers:
1. Operators running `cleo release plan/open/reconcile` from a terminal.
2. GHA workflows invoking `cleo release …` as a step.

Both consumers see identical behavior because they call the same code through the same envelope. The workflow YAML stays minimal (≈100-150 lines per file); the TypeScript stays testable.

### How the decision interacts with the rest of CLEO

ADR-073 changes only the release pipeline. It does NOT change:
- ADR-051 (evidence gates) — preserved as the sole gate runner.
- ADR-061 (verify-tool resolution) — preserved as the sole tool resolver.
- ADR-062 (worktree merge) — preserved; bump-PRs follow the same `merge --no-ff` provenance.
- ADR-065 (PR-required flow) — preserved; reinforced (no direct push possible because no `cleo` verb pushes).
- ADR-068 (database charter) — extended (3 new entities through chokepoint).
- ADR-070 (three-tier orchestration) — preserved; release is one of many flows the Orchestrator dispatches.
- BRAIN integration — preserved; `cleo memory observe` calls migrate verbatim.

It DOES change:
- ADR-053 — fulfills the original promise (project-agnostic across 3+ archetypes).
- ADR-063 — supersedes the 4-step canonical pipeline (the four new verbs are richer).
- The release CLI surface — collapses 14 → 4 verbs.
- The IVTR system — removed from the release path per audit Priority 1; remains as a read-only derived view.

### Concrete decision: what gets built

In RFC 2119 terms (the only place this ADR uses normative MUST/SHALL language):

The CLEO project MUST adopt Direction B + qualifier as the canonical release architecture starting with the T9345 spec-deliverable phase (wave-3 RCASD). The implementation MUST proceed in the four phases enumerated under *Consequences → Migration* below. The implementation team MUST NOT introduce additional release-related CLI verbs beyond the four canonical ones (`plan`, `open`, `reconcile`, `rollback`) without an ADR amendment. The release pipeline MUST treat ADR-051 evidence atoms as the only gate-execution surface; any release-time gate that wishes to block MUST express itself as an evidence-atom requirement, not as a parallel registry. Provenance MUST be recorded via the three new database entities, written by `reconcile`, on every successful release; partial writes MUST fail reconciliation. The GHA workflows MUST be the only artifact-mutation surface (tag creation, npm publish, cargo publish, etc.); local `cleo` MUST NOT perform these mutations except through `gh workflow run` dispatch.

---

## Consequences

### Positive

1. **Failure #1 (wedged git commit) eliminated** — `git commit` happens inside `release-prepare.yml` exactly once with GHA's per-step timeout enforcement; local CLEO never runs an unbounded `git commit` (forensics §C1).
2. **Failure #6 (tag at wrong SHA) eliminated by construction** — tag is `git tag $TAG $GITHUB_SHA` inside `release-publish.yml` AFTER `gh pr view --json state,mergeCommit` confirms `state == MERGED`, mirroring the Letta pattern at research §3.4 step 5.
3. **Failure #3 (gate runners not wired) eliminated** — `defaultRunGate` and `runReleaseGates` both deleted; the only gate path is `cleo verify --gate X --evidence tool:Y` via ADR-061.
4. **Failure #4 (IVTR non-blocking) eliminated** — IVTR removed from release path entirely (audit §Recommendations P1).
5. **Failure #8 (release start no-op) eliminated** — `plan` is the only state-initialization verb; the plan file IS the resume state; no parallel handle exists.
6. **Provenance graph implemented** — Audit Q4's "derivable but not queryable" gap closes. `SELECT b.id, b.title FROM releases r JOIN release_manifest_commits rmc ON rmc.release_id = r.id JOIN tasks t ON rmc.task_id = t.id JOIN task_relations tr ON t.id = tr.task_id AND tr.relation_type = 'fixes' JOIN tasks b ON tr.related_to = b.id WHERE r.version = '2026.X.Y' AND b.kind = 'bug';` becomes a one-line answer to "what bugs shipped".
7. **T1737 multi-platform achieved** — `release-publish.yml` matrix produces all 5 platform tuples (linux-x64, linux-arm64, macos-x64, macos-arm64, windows-x64) and attaches each as a GitHub Release artifact in a single workflow run.
8. **CLI surface reduced 14 → 4** (-71% verbs).
9. **Code reduction: -1100 LOC net** — the 761-line `releaseShip` monolith deleted; smaller `plan`/`open`/`reconcile` modules in its place.
10. **Hermes Tier-1 patterns adopted** — dual CalVer+SemVer, annotated tags, release-event fan-out, same-day suffix, supply-chain audit, OCI ancestor check, recovery-command-on-failure, pinned-deps+lockfile-drift (research §6 Tier 1, all 8 items).

### Negative / trade-offs

1. **GHA dependency hardened** — the release pipeline now genuinely cannot run without GitHub Actions. CLEO becomes harder to run against GitLab/Gitea/Bitbucket without writing a parallel CI integration. (Mitigation: keep an emergency `cleo release ship --no-workflow` escape hatch that runs the steps locally; this is the rollback path below.)
2. **Operator must learn a new mental model** — the historical `cleo release ship` invocation no longer exists. Re-teaching ~70 prior releases worth of muscle memory has a real cost during the v2026.6 → v2026.7 transition window.
3. **GHA YAML becomes load-bearing** — 4 workflow files (`release-prepare.yml`, `release-publish.yml`, `release-fanout.yml`, `release-rollback.yml`) are now critical infrastructure. YAML is harder to test than TypeScript; we must add a workflow-syntax CI gate (`actionlint` + `gh workflow view --json`) and dogfood every change on a `release/*` test branch before merging.
4. **Two-stage flow is slower for the trivial case** — a no-content patch release (e.g., a CHANGELOG-typo fix) now requires `plan → open → human approval → merge → publish workflow`. Today's `cleo release ship` does it in one command. The Letta `release_bump_only` classifier mitigates wasted CI on the bump-PR but does not collapse the operator steps.
5. **Multi-platform CI cost grows** — 5 matrix slots × per-slot smoke tests at ~3-5 minutes each + cross-build wait time ≈ 25-40 minutes of CI per release. Compared to today's ~15 minutes. (Mitigation: matrix parallelism + caching; budget impact ≤ $15/month per Anthropic-internal GHA quota estimates.)
6. **Workflow-driven smoke tests need a test API key** — Letta's `release-publish.yml` step "Integration smoke test (real API)" calls a live agent with `LETTA_API_KEY`. The CLEO analog needs `CLEO_RELEASE_TEST_KEY` for whichever LLM the smoke spawns. Key rotation and secret-leak posture become new operational concerns.

### Migration

**Phased rollout — 4 phases over 6 operator-weeks:**

- **Phase M1 (week 1, design-only)**: write the RFC-2119 spec deliverable for T9345 (wave-3 of RCASD). Define the plan-file schema, the four CLI verbs, the GHA workflow contracts, the three new DB tables. No code merged.
- **Phase M2 (weeks 2-3)**: implement `plan` and `open` verbs alongside (not replacing) existing `release ship`. Add `release-prepare.yml` workflow. Use the new verbs on a *test release* (`v2026.6.0-test-1`) cut from a release-test branch. Existing `release ship` remains the canonical happy path during this phase.
- **Phase M3 (weeks 4-5)**: implement `reconcile` + provenance tables + `release-publish.yml`. Migrate the next *real* release (next minor cut) through the new path while keeping `release ship` available as a fallback. Audit the provenance graph for completeness over the post-release week.
- **Phase M4 (week 6)**: deprecate `release ship`, `release start`, `release verify`, `release publish` (canonical-pipeline siblings), `release pr-status`. Convert them to compatibility shims that print a deprecation warning and forward to the new verbs. Delete the 761-line monolith and the IVTR gate integration. Cut v2026.7.0 entirely on the new system.

**Retired**:
- `engine-ops.ts:releaseShip` (761 LOC) — fully replaced.
- `pipeline.ts:releaseStart/Verify/Publish/Reconcile` — superseded; their useful primitives migrate into `plan.ts`/`open.ts`/`reconcile.ts`.
- `engine-ops.ts:releaseGateCheck`, `engine-ops.ts:releaseIvtrAutoSuggest`, `engine-ops.ts:checkIvtrGates` — gone (audit §Phase 2 Leaks #1, #2, #4).
- `release-manifest.ts:runReleaseGates` — replaced by ADR-061 tool resolver.
- `pipeline.ts:defaultRunGate` + `defaultAuditChildren` stubs — gone.
- 8 of 14 CLI subcommands (`start`, `verify`, `publish`, `ship`, `list`, `show`, `cancel`, `channel` — `list`/`show`/`cancel`/`channel` remain accessible via `cleo release plan --list` / `cleo release plan --show` etc., reducing the verb surface).

**Operator-week estimate**: **6 operator-weeks** total spanning design + implementation + dogfooding + cleanup. Two parallel orchestrator agents reduce wall-time to ~4 calendar weeks.

**Rollback path**: if Phase M3 or M4 surfaces a blocking regression in production, the rollback is:
1. Re-enable `release ship` as a non-deprecated alias by reverting the deprecation shim PR. This restores ADR-065's 12-step monolith fully.
2. Keep the `releases` and `release_manifest_commits` tables in place (data is additive and useful even if the new path is paused).
3. Pause the GHA workflows (`release-prepare.yml`, `release-publish.yml`) by renaming them to `.disabled` extensions or by deleting them entirely.
4. The `release_manifests` table never lost backward compat (force F12 satisfied), so resuming the old path is a single revert commit + a redeploy.

This rollback path is testable: as a Phase M2 gate, the orchestrator MUST demonstrate a clean rollback from the test release before proceeding to Phase M3.

### Migration data integrity

`release_manifests` table contains 70+ historical release rows from v2026.4.0 onward. Direction B's new tables (`releases`, `release_manifest_commits`) are additive:
- `releases.id` is a new monotonic key, separate from `release_manifests.id`. A migration SHALL backfill `releases` rows from `release_manifests` rows, one-to-one, preserving `version`, `epic_id`, `shipped_at`, `tag_name`.
- `release_manifest_commits` is populated by scanning `git log --grep "release: ship v"` per backfilled release, attributing each commit's task IDs via regex on `T\d+` patterns in the subject. Where attribution is ambiguous, the row is written with `task_id = NULL` and a `provenance_quality = 'inferred'` flag.
- `release_manifests` is NOT dropped. It becomes read-only after Phase M4. Future queries that need both new and historical data UNION across the two tables; the `release_provenance` view does this transparently.

This backfill is the lowest-risk part of the migration because it touches read-only historical data. The verification query suite (T9345-CHILD-2 deliverable) asserts that the backfilled provenance correctly identifies the 70+ historical releases and their constituent tasks. If the assertion fails for a historical row, the row is marked `provenance_quality = 'manual_review_required'` and surfaced via `cleo release list --filter inferred-provenance`.

### Per-phase exit criteria

Each migration phase has an explicit exit gate. The orchestrator MUST NOT advance to the next phase until the gate is satisfied:

- **M1 → M2**: RFC-2119 spec is signed by the council (T9345 wave-3 deliverable). Acceptance criterion: 5/5 council advisors approve the spec at the wave-3 gate.
- **M2 → M3**: a *test release* (`v2026.6.0-test-1`) is successfully cut on a non-main release-test branch using the new `plan` + `open` verbs. Acceptance: the bump-PR opens, gates pass, the rollback path is exercised, no failure modes #1-#10 reproduce.
- **M3 → M4**: the next *real* minor release (target: `v2026.6.0`) ships entirely through the new path. Acceptance: provenance graph is queryable post-ship; `release_provenance` view returns expected rows; no regression in any of the 10 forensics-documented failure modes; operator survey confirms the 4-verb UX is workable.
- **M4 → done**: 2 consecutive releases ship without invoking the rollback path. Acceptance: the deprecated subcommands return their deprecation warnings on every call; the `releaseShip` monolith is deleted; the IVTR gate code is removed from `engine-ops.ts`.

If any phase exit criterion fails twice in a row, the orchestrator MUST escalate to HITL approval before retrying.

### Spawn cost during migration

Migration is non-trivial agent work. Estimated spawn cost across all four phases:
- M1 (design): 1 orchestrator + 1 spec-writer agent = ~3 agent-days = ~$30 LLM spend at current rates.
- M2 (parallel implementation): 1 orchestrator + 4 worker agents (CLI, GHA workflows, schema migration, regression tests) = ~12 agent-days = ~$120.
- M3 (integration + dogfood): 1 orchestrator + 2 worker agents = ~6 agent-days = ~$60.
- M4 (cleanup): 1 orchestrator + 1 worker agent = ~3 agent-days = ~$30.

Total ~$240 in LLM spend over the 6 operator-weeks, well within the T9345 epic budget. The dominant cost remains owner review time, not agent compute.

---

## Open questions

These follow-up items become **child epics filed under T9345** once this ADR is accepted. Each represents work that is not specified here but is required to land the decision in production:

1. **T9345-CHILD-1 — RFC-2119 spec for the four verbs**: define exact CLI argument shapes, exit codes, error envelopes (LAFS per ADR-039), idempotency contracts, and the `.cleo/release/<version>.plan.json` schema. Output: `docs/specs/CLEO-RELEASE-PIPELINE-SPEC-v2.md` superseding the current `packages/core/src/release/docs/specs/CLEO-RELEASE-PIPELINE-SPEC.md` (audit §Appendix file table).
2. **T9345-CHILD-2 — Provenance graph schema migration**: write the drizzle migration adding `releases`, `release_manifest_commits`, and `release_provenance` (view). Backfill `release_manifest_commits` from existing `release_manifests` rows + `git log --grep "release: ship v"` for the last 12 months. Output: migration file + backfill script + verification query suite.
3. **T9345-CHILD-3 — GHA workflow authoring**: write `release-prepare.yml`, `release-publish.yml`, `release-fanout.yml`, `release-rollback.yml`. Each MUST mirror Letta's structure (research §3.4) with CLEO-specific gates (lint via biome, typecheck via tsc, test via vitest, build via esbuild). Include the `release_bump_only` classifier (Letta research §3.4 sub-section). Output: 4 YAML files + `actionlint` CI gate.
4. **T9345-CHILD-4 — IVTR retirement**: remove all IVTR write paths from `cleo orchestrate ivtr --start/--next/--release`, keep `--status` as a read-only view derived from evidence atoms. Mark `tasks.ivtr_state` column `@deprecated`. Plan its physical removal in a v2027 cleanup epic. (audit §Recommendations P4)
5. **T9345-CHILD-5 — T1737 platform-matrix integration**: define the per-platform build artifact contracts. For each of (linux-x64, linux-arm64, macos-x64, macos-arm64, windows-x64), specify the binary artifact name, the smoke-test entrypoint (`cleo --version`, `cleo briefing`), and the Pi-adapter consumption path. Output: `docs/architecture/t1737-platform-matrix.md`.
6. **T9345-CHILD-6 — Hermes Tier-1 mechanics adoption**: implement the 8 Tier-1 items individually (dual CalVer+SemVer, annotated tag messages, `release: published` fan-out, OCI ancestor check, same-day suffix, lockfile-drift CI, supply-chain audit on PR diffs, recovery-command print). Each can ship as a separate small PR. (research §6 Tier 1)
7. **T9345-CHILD-7 — Worktree-policy on-disk artifact**: extend `git-shim` to read `.cleo/worktree-policy.json` independent of `CLEO_AGENT_ROLE` (forensics §F7). Add `git push <remote> <local>:<protected-branch>` to the denylist unconditionally. This is independent of the release rewrite but blocks force F7 satisfaction.
8. **T9345-CHILD-8 — Override-cap session-lifecycle wiring**: register a cleanup hook in `sessionEnd` that deletes `.cleo/audit/session-override-count.<sid>.json`; ban `'global'` sessionId fallback in `validation/engine-ops.ts:385` (forensics §F5). Independent of release rewrite.

Open questions whose answers belong in the wave-3 spec rather than as separate child epics:

9. *What exactly triggers `release-publish.yml`?* The Letta pattern is `push: main` filtered to `paths: [package.json, package-lock.json]`. For a Cargo workspace member, the trigger needs `[Cargo.toml, Cargo.lock]`. The spec MUST enumerate the per-archetype trigger files.

10. *How does `cleo release reconcile` get invoked from a GHA workflow?* Options: (a) `gh api dispatch` from `release-publish.yml` to an external reconcile workflow that runs locally, (b) the workflow runs `npx @cleocode/cleo release reconcile` directly using a published CLEO version, (c) the workflow writes the reconcile inputs to a `dispatches` queue table that a daemon drains. Spec MUST choose.

11. *What happens to in-flight v2026.5.74-style hotfix releases during M2-M3?* The migration plan says "release ship remains canonical during M2-M3" — but the IVTR gate must still pass for them. The spec MUST clarify whether IVTR removal lands in M3 or M4, and whether mid-migration hotfixes use the old path or get a special compatibility flag.

12. *Is the `same-day-suffix` versioning (`v2026.5.74.2`) compatible with CLEO's CalVer parser?* `validateVersion(version, 'calver')` (pipeline.ts:288-316) currently expects exactly `vYYYY.MM.DD` format. The spec MUST decide whether the suffix is a calver extension (parser change) or an entirely new scheme variant (`'calver-suffix'` enum value alongside `'calver'`).

13. *Does the integration smoke test in `release-publish.yml` need a real Anthropic / OpenAI API key, or can it use a mock?* Letta uses a real `LETTA_API_KEY` against their own API. CLEO has no equivalent "CLEO API" — the smoke would need to spawn a real Claude/Anthropic call. Cost analysis: even at $0.50/release, that's ~$26/year for weekly releases. Likely acceptable but spec MUST decide and document the key-rotation policy.

14. *How do we test the GHA workflows themselves?* The wave-3 spec MUST define a workflow-testing strategy. Options: (a) `actionlint` + dry-run via `act`, (b) a dedicated `workflow-smoke-test.yml` that runs every release workflow with `--dry-run` on every PR, (c) Letta's pattern of running the workflow against a forked test repo. The current `cleo release ship` pipeline is fully TypeScript-testable via vitest; the new pipeline must not regress that.

---

## Alignment notes

- **T1737 Sentient Harness v3** — fully aligned. The GHA matrix in `release-publish.yml` produces all 5 platform tuples (Linux x64/arm64, macOS x64/arm64, Win x64) from one source of truth. Pi-style sleep-time harnesses consume the linux-arm64 artifact via the existing CleoOS Pi adapter (ADR-049). The cleo-os layer is not touched by this ADR — the harness consumes published artifacts; it does not participate in the publish workflow itself.
- **ADR-053 portability promise** — fully fulfilled. The three archetypes (npm monorepo, single npm lib, single Rust crate) plus the two added archetypes (single Python pkg, Bun pkg) all go through the same four verbs. The per-archetype differences live in `.cleo/project-context.json` (`build.command`, `publish.command`, `testing.command`) plus the per-platform workflow matrix. ADR-053 RELEASE-06 fixture passes by construction.
- **ADR-061 verify-tool resolution** — preserved and elevated. The release pipeline's gate check (`plan` verb) is implemented as `cleo verify --gate <X> --evidence tool:<canonical>` calls, identical to the per-task evidence ritual. There is one tool resolver in the codebase; the release path no longer maintains a parallel registry.
- **ADR-062 worktree merge** — preserved. The bump-PR opened by `release-prepare.yml` follows the same `git merge --no-ff task/<id>` provenance model. `completeAgentWorktreeViaMerge` is unchanged. The release-branch model (`release/v<version>`) is retained from ADR-065 — it carries the version-bump commit and survives as the PR branch.
- **ADR-072 Hermes-style provider plugin pattern** — directly applicable. ADR-072 unified the LLM provider stack with a registry pattern. The same architecture applies to "release platforms" (npm, cargo, docker, pypi, bun): each is a plugin under `packages/core/src/release/platforms/`, conforming to a common interface (`bump(version)`, `publish(artifact)`, `verify(version)`). The platform matrix in `release-publish.yml` consumes this registry.
- **ADR-068 CLEO Database Charter** — preserved. The three new entities (`releases`, `release_manifest_commits`, `release_provenance` view) flow through `openCleoDb` per ADR-068 D003. Each gets a charter entry: owner = `release`, readers = `release|memory|orchestrate`, writers = `release`, concurrency = same as `release_manifests`, schema-version = bumped, retention = same as `release_manifests` (forever — audit asset).
- **ADR-070 three-tier orchestration** — composable. `cleo release plan/open/reconcile` is a flow the Orchestrator dispatches. Leads can spawn it via `cleo orchestrate spawn T<release-task-id>` (where the release task is itself a task in the orchestration tree). No constraint added or relaxed.
- **BRAIN integration** — `cleo memory observe` hooks preserved. Each `reconcile` invocation MUST call `memory observe` with `--title "Released v<version>"` + `--type decision` to record the release as a BRAIN node. The existing release-time `memory observe` calls in `engine-ops.ts` migrate verbatim into `reconcile.ts`.
- **ADR-051 evidence atoms** — the release pipeline becomes the SECOND consumer of evidence atoms (after `cleo complete`). At reconcile time, every task in the plan has its evidence atoms re-validated against current git state via the staleness check (ADR-051 D8). A staleness failure on an in-release task fails the reconcile, preserving the invariant that "shipped tasks have valid evidence at ship time".
- **Sentient subsystem (T1008-derived)** — release-time decisions (which tasks shipped, which were deferred, which gates flagged) are observable via the same `cleo sentient observe` hook the rest of CLEO uses. The release pipeline does NOT bypass the sentient observability layer.
- **CAAMP injection (ADR-049, ADR-050)** — the release pipeline is harness-agnostic. Pi-style harnesses, Claude-Code harnesses, and CleoOS harnesses all spawn the same `cleo release …` CLI verbs with identical behavior. The GHA workflows are not harness-specific; they invoke the CLEO CLI as a subprocess and receive JSON envelopes (LAFS per ADR-039).
- **ct-orchestrator skill (ADR-070)** — the orchestrator skill must learn the new 4-verb surface. The skill's release-section documentation (currently referencing `cleo release ship --epic`) MUST be updated as part of T9345-CHILD-1. Until then, orchestrator agents that quote the skill verbatim will fail.

### What this ADR explicitly does NOT decide

- **Does NOT decide release cadence**. CLEO's CalVer pattern (release-on-demand vs Hermes's weekly cadence) is unchanged. The new pipeline supports both — `release plan` is invoked when an operator decides to cut, not on a schedule.
- **Does NOT decide CHANGELOG section taxonomy**. The auto-generation via `generate_release_notes` produces a flat list of PRs; whether to layer the Hermes-style hierarchical sections (Highlights / Breaking / Bug fixes / Infrastructure — research §3.7) is left to T9345-CHILD-1 and the wave-3 spec.
- **Does NOT decide whether to commit per-release notes to the repo**. Hermes commits `RELEASE_v0.13.0.md` to repo root (research §3.7); CLEO could do the same. The ADR keeps this as a side-quest under T9345-CHILD-6.
- **Does NOT decide Docker publishing posture**. CLEO does not currently publish Docker images. If T1737 introduces a container distribution channel, the Hermes `:main` / `:latest` ancestor-check pattern (research §3.4) is the model; that decision is in T9345-CHILD-5 (platform matrix).
- **Does NOT decide whether to adopt changesets for contributor-facing version-bump UX**. Some agents may write PRs that introduce minor user-visible changes worth a changelog entry. Whether to require a `.changeset/*.md` file per PR (changesets pattern) is a separate ergonomic decision deferred to a future ADR.

---

## References

### Wave-1 research (T9345 RCASD)
- `/mnt/projects/cleocode/.cleo/rcasd/T9345/research/audit-cleo-release-subcommands.md` — 14-subcommand audit, 8-axis coupling scores, 12 invariants.
- `/mnt/projects/cleocode/.cleo/rcasd/T9345/research/failure-forensics-10-modes.md` — 10 failure modes, 6 root-cause clusters, conflation and monolith hypotheses.
- `/mnt/projects/cleocode/.cleo/rcasd/T9345/research/hermes-agent-real-research.md` — 8 Tier-1 borrowable patterns, dual-tag scheme, release-event fan-out.
- `/mnt/projects/cleocode/.cleo/rcasd/T9345/research/letta-harness-real-research.md` — letta-code two-stage workflow, `release_bump_only` classifier, integration-smoke pattern.
- `/mnt/projects/cleocode/.cleo/rcasd/T9345/research/ivtr-conflation-audit.md` — IVTR↔Release coupling severity 7/10; ~600 LOC to remove; 4 priority recommendations.

### Prior ADRs
- `/mnt/projects/cleocode/.cleo/adrs/ADR-039-lafs-envelope-error-format.md` — error envelope contract (preserved by this ADR).
- `/mnt/projects/cleocode/.cleo/adrs/ADR-051-evidence-based-gates.md` — evidence atoms (the sole release gate surface in Direction B).
- `/mnt/projects/cleocode/.cleo/adrs/ADR-053-project-agnostic-release-pipeline.md` — original portability promise; this ADR fulfills it.
- `/mnt/projects/cleocode/.cleo/adrs/ADR-061-project-agnostic-verify-tools.md` — canonical tool resolver (the only gate runner under Direction B).
- `/mnt/projects/cleocode/.cleo/adrs/ADR-062-worktree-merge-integration.md` — worktree integration via `git merge --no-ff` (preserved).
- `/mnt/projects/cleocode/.cleo/adrs/ADR-063-4-step-release-pipeline.md` — superseded; useful primitives migrate into `plan`/`open`/`reconcile`.
- `/mnt/projects/cleocode/.cleo/adrs/ADR-065-pr-required-release-flow.md` — extended (release-branch model retained; 12-step monolith replaced).
- `/mnt/projects/cleocode/.cleo/adrs/ADR-068-cleo-database-charter.md` — chokepoint contract for new tables.
- `/mnt/projects/cleocode/.cleo/adrs/ADR-070-three-tier-orchestration.md` — orchestrator/lead/worker topology (preserved).
- `/mnt/projects/cleocode/.cleo/adrs/ADR-072-unified-llm-provider-architecture.md` — provider-plugin pattern reused for release platforms.

### Key files cited
- `/mnt/projects/cleocode/packages/cleo/src/cli/commands/release.ts` — 14-subcommand CLI surface (to be reduced to 4).
- `/mnt/projects/cleocode/packages/cleo/src/dispatch/domains/release.ts` — dispatch handler (rewrite scope).
- `/mnt/projects/cleocode/packages/core/src/release/engine-ops.ts` — 1986-line module containing the 761-line `releaseShip` monolith (deletion target).
- `/mnt/projects/cleocode/packages/core/src/release/pipeline.ts` — parallel 4-step pipeline (deletion target).
- `/mnt/projects/cleocode/packages/core/src/release/guards.ts` — `checkEpicCompleteness` (rewrite scope; epic-scope fix).
- `/mnt/projects/cleocode/packages/core/src/release/version-bump.ts` — `resolveVersionBumpTargets` (preserved; consumed by `plan` and the GHA matrix).
- `/mnt/projects/cleocode/packages/core/src/release/release-manifest.ts` — existing DB layer (extended with `releases` + `release_manifest_commits`).
- `/mnt/projects/cleocode/packages/core/src/release/github-pr.ts` — `createPullRequest` (preserved; consumed by `open`).
- `/mnt/projects/cleocode/packages/core/src/release/changelog-writer.ts` — preserved; consumed by `plan`.
- `/mnt/projects/cleocode/packages/core/src/lifecycle/ivtr-loop.ts` — read-only view post-decoupling.
- `/mnt/projects/cleocode/packages/core/src/security/override-cap.ts` — orphaned by removing `--force` from release verbs; lifecycle fix lands as T9345-CHILD-8.
- `/mnt/projects/cleocode/build.mjs` — externals list moves to `.cleo/build-externals.json` with sync CI gate (T9345-CHILD-1 / T9345-CHILD-2 split TBD by spec).
- `/mnt/projects/cleocode/.cleo/project-context.json` — the project-archetype source of truth consumed by ADR-061 + the platform matrix.

### External references
- Hermes-agent: `https://github.com/NousResearch/hermes-agent` — `scripts/release.py:1400-1564`, `.github/workflows/docker-publish.yml:24-26,290-535`, `.github/workflows/contributor-check.yml:1-73`.
- Letta-code: `https://github.com/letta-ai/letta-code` — `.github/workflows/prepare-release.yml`, `.github/workflows/release.yml`, `.github/workflows/ci.yml` (the `release_bump_only` classifier).
- Letta server (anti-pattern, for contrast only): `https://github.com/letta-ai/letta` — `.github/workflows/poetry-publish.yml`, `.github/workflows/docker-image.yml`.
- gh CLI auto-merge semantics: `https://cli.github.com/manual/gh_pr_merge` (per forensics §F6 root-cause analysis).
- GitHub Environments + required reviewers: documented per the `environment: npm-publish` pattern at Letta research §3.4 step 7.

---

*End of ADR-073 — proposed for council review at T9345 wave-2 gate.*

---

## Appendix A — Illustrative plan-file schema

This appendix sketches the `.cleo/release/<version>.plan.json` schema referenced throughout the Decision. The wave-3 RFC-2119 spec (T9345-CHILD-1) MUST formalize the JSON schema; the appendix is non-normative.

```jsonc
{
  "$schema": "https://cleocode.io/schemas/release-plan/v1.json",
  "version": "v2026.6.0",
  "channel": "latest",
  "scheme": "calver",
  "epicId": "T9999",
  "createdAt": "2026-06-01T12:00:00Z",
  "createdBy": "cleo-prime",
  "previousVersion": "v2026.5.74",
  "previousTag": "v2026.5.74",
  "previousShippedAt": "2026-05-15T08:00:00Z",
  "tasks": [
    {
      "id": "T10001",
      "kind": "feat",
      "impact": "minor",
      "userFacingSummary": "Add cargo-publish platform plugin for Rust release targets",
      "evidenceAtoms": ["commit:abc123", "test-run:vitest-2026-06-01.json", "tool:lint", "tool:typecheck"],
      "ivtrPhaseAtPlan": "released",
      "epicAncestor": "T9999"
    }
  ],
  "changelog": {
    "features": ["..."],
    "fixes": ["..."],
    "chores": ["..."],
    "breaking": []
  },
  "gates": [
    {"name": "test", "atom": "tool:test", "status": "passed", "lastVerifiedAt": "2026-06-01T11:50:00Z"},
    {"name": "lint", "atom": "tool:lint", "status": "passed", "lastVerifiedAt": "2026-06-01T11:50:00Z"},
    {"name": "typecheck", "atom": "tool:typecheck", "status": "passed", "lastVerifiedAt": "2026-06-01T11:50:00Z"},
    {"name": "build", "atom": "tool:build", "status": "passed", "lastVerifiedAt": "2026-06-01T11:50:00Z"},
    {"name": "security-scan", "atom": "tool:security-scan", "status": "passed", "lastVerifiedAt": "2026-06-01T11:51:00Z"}
  ],
  "platformMatrix": [
    {"platform": "linux-x64", "publisher": "npm", "package": "@cleocode/cleo"},
    {"platform": "linux-arm64", "publisher": "npm", "package": "@cleocode/cleo"},
    {"platform": "macos-x64", "publisher": "npm", "package": "@cleocode/cleo"},
    {"platform": "macos-arm64", "publisher": "npm", "package": "@cleocode/cleo"},
    {"platform": "windows-x64", "publisher": "npm", "package": "@cleocode/cleo"}
  ],
  "preflightSummary": {
    "esbuildExternalsDrift": false,
    "lockfileDrift": false,
    "epicCompletenessClean": true,
    "doubleListingClean": true
  },
  "workflowRunUrl": null,
  "prUrl": null,
  "mergeCommitSha": null,
  "status": "planned"
}
```

Key invariants enforced by the schema:
- `previousVersion` / `previousShippedAt` are non-nullable for any plan that is not a first-ever release. The CHANGELOG generator uses `git log $previousTag..HEAD` and the BRAIN ingestion filters `completedAt > previousShippedAt`.
- `evidenceAtoms` per task is required and non-empty. Plans without evidence atoms cannot be opened. This is the ADR-051 surface inside the release pipeline.
- `status` advances `planned` → `pr-opened` → `pr-merged` → `published` → `reconciled`. Each transition is written by the corresponding verb.
- `epicAncestor` is computed at plan time, NOT at reconcile time. The epic-scope-leak failure (#2) is eliminated because the plan locks the epic scope; downstream consumers do not re-derive it.

## Appendix B — Illustrative `release-publish.yml` skeleton

Non-normative pseudo-YAML to make the matrix structure concrete:

```yaml
name: Release publish
on:
  push:
    branches: [main]
    paths:
      - "package.json"
      - "packages/*/package.json"
      - "Cargo.toml"
      - "packages/*/Cargo.toml"
  workflow_dispatch:
    inputs:
      version: { required: true }

jobs:
  detect:
    runs-on: ubuntu-latest
    outputs:
      should_publish: ${{ steps.classify.outputs.should_publish }}
      version: ${{ steps.classify.outputs.version }}
    steps:
      - uses: actions/checkout@v6
        with: { fetch-depth: 0 }
      - id: classify
        run: |
          SUBJECT=$(git log --format=%s "${{ github.event.before }}..${{ github.sha }}" | grep -E '^release: prepare v' | tail -n 1 || true)
          if [ -z "$SUBJECT" ]; then echo "should_publish=false" >> $GITHUB_OUTPUT; exit 0; fi
          VERSION=$(echo "$SUBJECT" | sed 's/^release: prepare //')
          echo "should_publish=true" >> $GITHUB_OUTPUT
          echo "version=$VERSION" >> $GITHUB_OUTPUT

  build-matrix:
    needs: detect
    if: needs.detect.outputs.should_publish == 'true'
    strategy:
      matrix:
        platform:
          - { id: linux-x64,    runs-on: ubuntu-latest }
          - { id: linux-arm64,  runs-on: ubuntu-24.04-arm }
          - { id: macos-x64,    runs-on: macos-13 }
          - { id: macos-arm64,  runs-on: macos-14 }
          - { id: windows-x64,  runs-on: windows-latest }
    runs-on: ${{ matrix.platform.runs-on }}
    steps:
      - uses: actions/checkout@v6
      - run: pnpm install --frozen-lockfile
      - run: pnpm run build
      - run: pnpm run check
      - run: pnpm run test
      - name: Smoke test
        run: ./bin/cleo --version
      - name: Integration smoke (Anthropic)
        env: { ANTHROPIC_API_KEY: ${{ secrets.CLEO_RELEASE_TEST_KEY }} }
        run: ./bin/cleo briefing --json | jq .ok
      - uses: actions/upload-artifact@v4
        with:
          name: cleo-${{ matrix.platform.id }}
          path: dist/cleo-${{ matrix.platform.id }}.tgz

  publish-and-tag:
    needs: build-matrix
    runs-on: ubuntu-latest
    environment: cleo-publish
    permissions:
      contents: write
      id-token: write
    steps:
      - uses: actions/checkout@v6
      - run: pnpm publish --access public
      - run: git tag "${{ needs.detect.outputs.version }}" "${{ github.sha }}"
      - run: git push origin "${{ needs.detect.outputs.version }}"
      - uses: softprops/action-gh-release@v2
        with:
          tag_name: ${{ needs.detect.outputs.version }}
          target_commitish: ${{ github.sha }}
          generate_release_notes: true
          files: |
            cleo-linux-x64.tgz
            cleo-linux-arm64.tgz
            cleo-macos-x64.tgz
            cleo-macos-arm64.tgz
            cleo-windows-x64.tgz
      - run: cleo release reconcile "${{ needs.detect.outputs.version }}"
```

This is roughly 80 lines of YAML; the equivalent logic in today's `engine-ops.ts:releaseShip` is 761 lines of TypeScript. The asymmetry is the central evidence that Direction B's architecture is more compact AND more defensible.
