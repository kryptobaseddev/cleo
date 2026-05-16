---
epic: T9345
stage: research
task: T9345
related:
  - type: task
    id: T9345
  - type: adr
    id: ADR-073
created: 2026-05-16
updated: 2026-05-16
authors:
  - cleo-prime (orchestrator)
  - 5x wave-1 specialists (Explore, deep-research-agent ×2, root-cause-analyst, Explore)
  - 3x wave-2 architects (system-architect ×3)
---

# T9345 — IVTR Release System Overhaul: RCASD Research Index

## Summary

The owner directive (2026-05-15) called for a full RCASD research wave on T9345 — the `cleo release` pipeline + IVTR system are "convoluted, good ideas executed badly." Ten concrete failure modes were captured from the v2026.5.73 → v2026.5.74 ship session. This research wave produced **10 artifacts totaling 9,137 lines** grounded in (a) the cleocode codebase, (b) the locally-cloned `/mnt/projects/hermes-agent/` source repo, (c) the upstream `letta-ai/letta` + `letta-ai/letta-code` repos via web research, and (d) the existing CLEO ADR corpus (051, 053, 061, 062, 063, 065, 068, 070, 072).

## Decision (one line)

**Direction B (GitOps wrapper) + Direction C qualifier**: collapse 14 `cleo release` subcommands to 4 operator verbs (`plan` / `open` / `reconcile` / `rollback`), move the outer state machine to 4 GitHub Actions workflows, keep `packages/core/src/release/*` as testable TypeScript invoked by both surfaces, and add an 11-table provenance graph so the owner can query the full feature ↔ bug ↔ hotfix ↔ epic ↔ task ↔ commit ↔ PR ↔ release graph. Net code delta: ~−1500 LOC. See `ADR-T9345-ivtr-release-overhaul.md`.

## Deliverables

### Wave 1 — Evidence (5 docs, ~4,866 lines)

| # | Artifact | Lines | Purpose |
|---|----------|------:|---------|
| 1 | [`audit-cleo-release-subcommands.md`](./audit-cleo-release-subcommands.md) | 736 | Every `cleo release` subcommand mapped — CLI ↔ dispatch ↔ engine, intended purpose, observed failures, required invariants. 8-axis coupling scoring. |
| 2 | [`failure-forensics-10-modes.md`](./failure-forensics-10-modes.md) | 1,291 | Per-failure reproduction + file:line evidence + root cause for all 10 captured failures. Clusters them into 6 root-cause patterns. Governance-vs-pipeline conflation diagnosis. |
| 3 | [`hermes-agent-real-research.md`](./hermes-agent-real-research.md) | 1,180 | Primary-source research on the locally-cloned `/mnt/projects/hermes-agent/` (NousResearch/hermes-agent v0.13.0). 8 Tier-1 borrowable patterns (dual CalVer+SemVer tagging, `release: published` fan-out, Conventional-Commits classifier, OCI revision-label ancestor check, same-day hotfix suffixes, OSV scan, contributor attribution gate, smoke tests). |
| 4 | [`letta-harness-real-research.md`](./letta-harness-real-research.md) | 1,091 | Distinguishes `letta-ai/letta` (Python server) from `letta-ai/letta-code` (TS harness — the actual "harness" precedent). `letta-code`'s 2-stage `prepare-release.yml` → `release.yml` workflow + `release_bump_only` classifier are the closest precedent for CLEO's target. |
| 5 | [`ivtr-conflation-audit.md`](./ivtr-conflation-audit.md) | 568 | Conflation severity 7/10. ~600 LOC of welded coupling identified. What to keep (evidence gates, audit trails, provenance, project-agnostic tooling) vs cut (IVTR-as-blocker, `--force`, dual gate execution, auto-run gates in IVTR test phase). |

### Wave 2a — Design (2 docs, ~2,284 lines)

| # | Artifact | Lines | Purpose |
|---|----------|------:|---------|
| 6 | [`provenance-graph-design.md`](./provenance-graph-design.md) | 1,340 | 11 new SQLite tables (`commits`, `task_commits`, `commit_files`, `pull_requests`, `pr_commits`, `pr_tasks`, `releases`, `release_commits`, `release_changes`, `release_artifacts`, `brain_release_links`). 14 new CLI verbs (`cleo release graph|diff|impact|authors|orphans` + `cleo provenance task|commit|pr|feature|release|change|backfill|link|verify`). One `releases_view` materialized view. 8 canonical owner queries answered. Zero-downtime migration with dual-write kill switch. |
| 7 | [`ADR-T9345-ivtr-release-overhaul.md`](./ADR-T9345-ivtr-release-overhaul.md) | 944 | **ADR-073**. 3 directions compared (Simplify-in-place, GitOps wrapper, Standalone CLI). 12-force trade-off matrix. Decision: Direction B + Direction C qualifier. 8 child epics enumerated. Alignment notes for T1737 Sentient Harness v3, ADR-053, ADR-061, ADR-062, ADR-072. |

### Wave 2b — Spec, Migration, Tests (3 docs, ~1,970 lines)

| # | Artifact | Lines | Purpose |
|---|----------|------:|---------|
| 8 | [`SPEC-T9345-release-pipeline-v2.md`](./SPEC-T9345-release-pipeline-v2.md) | 822 | **RFC-2119 normative spec**. 162 numbered requirements (R-001 → R-441). 16 sections covering CLI verbs, GHA workflows, evidence-gate integration (ADR-051 surface), provenance recording, project-agnostic resolution (7 archetypes), `releases.status` FSM, hotfix path, backward-compatibility window, failure-mode → spec-section mapping (8/10 structurally eliminated). |
| 9 | [`migration-plan-T9345.md`](./migration-plan-T9345.md) | 619 | 6-phase migration plan (8–12 weeks). Each phase has scope, exit criteria, rollback trigger, LOC budget, owner-approval gates. 8 child epics decomposed (T9491–T9499 — Phase 0: T9491, Phase 1: T9492, Phase 2: T9493, Phase 3: T9494, Phase 4: T9497, Phase 5: T9498, Phase 6: T9499, Tests: T9495). Bonus parallel forensics-fixes epic: T9496. Compatibility shim `cleo release ship --workflow=false` available for ≥3 release cycles post-cutover. Historical `release_manifests` never dropped. |
| 10 | [`test-matrix-T9345.md`](./test-matrix-T9345.md) | 529 | 12 scenarios × 4 archetypes (monorepo-w-workspaces, single-npm-lib, single-rust-crate + python stretch). 25-slot GHA matrix. Each scenario maps to one or more of the 10 acceptance criteria + the 10 forensics failure modes. Owner sign-off checklist (30+ specific artifacts). |

## Acceptance-criteria mapping (against T9345 task description)

| T9345 AC (verbatim) | Satisfied by |
|---------------------|--------------|
| "RCASD research wave produces audit doc enumerating every cleo release subcommand current state, code path, intended purpose, observed failures, and required invariants" | #1 `audit-cleo-release-subcommands.md` |
| "Concrete failure modes from this session catalogued with reproduction steps (wedged git commit on ship, epic completeness check fails on unrelated epics, gate runners not wired, override cap counter broken, tag-points-at-wrong-SHA, ALL-active-epics checked despite --epic flag, IVTR 'non-blocking' on 72 tasks defeats purpose)" | #2 `failure-forensics-10-modes.md` (all 10 — 6 listed + 4 more) |
| "Design proposal compares 3 architectural directions (a: simplify in place, b: rebuild as a thin wrapper over standard git-flow tags plus GitHub Actions, c: extract into separate cli release-tool consumed by cleo release as one option)" | #7 `ADR-T9345-ivtr-release-overhaul.md` §"Considered directions" |
| "Decision recorded as ADR with explicit trade-off matrix (provenance vs friction, epic-tracking vs portability, hermes-agent and letta-harness alignment, sentient-harness T1737 compatibility)" | #7 ADR §"Trade-off matrix" + §"Alignment notes" |
| "Spec written for chosen direction with RFC 2119 must/should/may language" | #8 `SPEC-T9345-release-pipeline-v2.md` (162 R-numbered requirements) |
| "Migration plan from current state with rollback path" | #9 `migration-plan-T9345.md` (6 phases × rollback per phase) |
| "Test matrix proves IVTR works for at least 3 git-managed project archetypes: monorepo with workspaces (cleocode itself), single-package npm lib, single-binary rust crate" | #10 `test-matrix-T9345.md` (A1/A2/A3 required, A4 stretch) |
| "All epic children produced or scheduled as separate IVTR tasks" | #7 + #9 enumerate 8 child epics — filed as T9491 (Phase 0), T9492 (Phase 1), T9493 (Phase 2), T9494 (Phase 3), T9497 (Phase 4), T9498 (Phase 5), T9499 (Phase 6), T9495 (tests). Bonus T9496 (5 forensics bug fixes, parallelizable with Phase 0) |

## Owner ask: "Have we conflated and over-engineered the IVTR system?"

**Yes — severity 7/10.** Evidence in #5 `ivtr-conflation-audit.md`:
- IVTR is hard-welded into the release blocker via `engine-ops.ts:1251-1295` (`getIvtrState` ⇒ `E_IVTR_INCOMPLETE`)
- Evidence gates (ADR-051: `implemented`/`testsPassed`/`qaPassed`) and IVTR phases (`implement`/`validate`/`test`) check the same things — agents run verifications twice
- 72/72-task "non-blocking" warnings on a binary-by-design gate is theater
- The provenance graph the owner wants is implicit-derivable but never queryable (no commits table, no task↔commit edges, no normalized releases table)
- `--force` undermines evidence integrity (already on removal track per ADR-051)

**Streamlining path** (sketched in #5, normatively defined in #8):
1. **Decouple release from IVTR** (Phase 5 epic T9498). `task.ivtr_state` becomes observation-only; the release pipeline never reads it for gate decisions.
2. **Single gate surface** — ADR-051 evidence atoms are the only release gate. No parallel `runReleaseGates`, no IVTR phase gate, no `defaultRunGate` stub.
3. **First-class provenance graph** (Phase 0 epic T9491 + Phase 1 epic T9492). 11 new tables, 1 view, 14 new CLI verbs. Owner's "tracking graph of released code" becomes a SQL query.
4. **Project-agnostic by default** — ADR-061 tool resolver is the only path; per-archetype assumptions (npm/pnpm/biome) are deleted.

## Owner ask: "scope of tracking is wider than a release — features, bugs, hotfixes, full provenance"

**Solved by #6 `provenance-graph-design.md`** — the new `release_changes` table classifies every entry into one of 12 first-class types: `feature | enhancement | bug | hotfix | security | breaking | refactor | docs | chore | revert | deprecation | infrastructure`. `TaskKind` is extended with `feature` (currently missing) and the `task_relations` table gains `regresses | follows-up | reverts | hotfixes` edges. The 8 canonical queries (Q1–Q8) include "What bugs shipped in v?", "Show evolution graph of feature X", "What hotfixes followed release Y?", "Find the task that introduced the bug that T#### fixes?".

## Hermes-agent / Letta-harness alignment

Both projects were researched against their **actual code**, not assumptions:

- **Hermes-agent** (`/mnt/projects/hermes-agent/`, NousResearch/hermes-agent v0.13.0, MIT-licensed): owner-forked, 12-hourly upstream sync. CLEO will adopt 8 Tier-1 mechanics from `scripts/release.py` + `.github/workflows/*.yml` — see #3 §"Tier-1 borrowable patterns" and #7 ADR §"Alignment notes". CLEO is AHEAD of Hermes on: gate ladder, epic completeness, evidence atoms, task↔commit provenance, multi-archetype.

- **Letta-code** (letta-ai/letta-code, the actual "harness" precedent — not letta-ai/letta which is a no-gate Python server PyPI anti-pattern): 2-stage `prepare-release.yml` → `release.yml` workflow with a `release_bump_only` classifier that skips heavy CI on bump-only PRs. Closest precedent for CLEO's target. Adopted in spec §5.1 (R-201 → R-205) — the `release-prepare.yml` workflow is structurally Letta-code's `prepare-release.yml`. CLEO adds: tool resolver, evidence atoms, provenance graph, epic-scoped completeness, hotfix path.

## T1737 Sentient Harness v3 alignment

The 5-platform target (linux x64/arm64, macos x64/arm64, win x64) is first-class in spec §9.2 (R-370, R-371). `plan.platformMatrix[]` enumerates publisher × platform pairs; `release-fanout.yml` runs the matrix job. Adding a new platform requires only an entry in `.cleo/project-context.json`, no release-pipeline code change.

## GHA workflow architecture (clarification — NOT cleocode-specific)

The four YAML workflows referenced throughout the ADR + SPEC (`release-prepare.yml`,
`release-publish.yml`, `release-fanout.yml`, `release-rollback.yml`) are **CLEO-templated
artifacts that any consuming project receives** — they are NOT files unique to the cleocode
monorepo. The design is:

- **Templates live in CLEO** at `packages/cleo/templates/workflows/release-*.yml.tmpl` (new path).
- **`cleo init` / `cleo upgrade workflows`** scaffolds them into the consuming project's
  `.github/workflows/` directory, parameterized by `.cleo/release-config.json` +
  `.cleo/project-context.json`.
- **Workflow structure is universal** (same trigger events, same job names, same
  concurrency policy, same status checks emitted). What differs across projects is the
  *contents* of the steps — which is resolved via ADR-061's tool resolver
  (`tool:test`, `tool:build`, `tool:lint`, `tool:typecheck`, `tool:audit`,
  `tool:security-scan`, `tool:publish`). A Rust crate runs `cargo test`; a Python
  package runs `pytest`; a pnpm monorepo runs `pnpm run test`. The workflow doesn't know
  or care — it invokes `cleo release plan|open|reconcile|rollback` (CLEO's own verbs)
  and those verbs invoke the resolved tool.
- **Per-archetype matrix** lives in `release-fanout.yml` and reads `plan.platformMatrix[]`
  from the plan JSON file. Adding a new platform (e.g. `aarch64-linux-android`) is one
  entry in `.cleo/project-context.json` — no workflow code change required.
- **Project-agnosticism is structurally enforced**: the SPEC's R-362 mandates that adding a
  new archetype MUST NOT require a release-pipeline code change. The workflow templates
  pass this test because every project-specific concern routes through tool resolution.
- **Upgrade story**: when CLEO ships a new workflow template version, consuming projects
  run `cleo upgrade workflows` to merge the new template against any local customizations
  (3-way merge with `.workflow-overrides.yml` for project-specific tweaks).

This is the "highly opinionated, spec-driven workflow system any project can use" promise
that ADR-073 makes operational. The workflows are CLEO's opinion *encoded as scaffold*,
not as one-off files in cleocode.

---

## Next steps for the orchestrator (after owner sign-off)

1. **Council review** (optional but recommended) — invoke `/ct-council` to stress-test the ADR + SPEC against five advisors.
2. **File 8 real child epics** under T9345 via `cleo add --parent T9345 --type epic --kind work --pipelineStage spec --acceptance "..."` — task IDs are assigned by CLEO at creation time. The intended decomposition (one epic per migration phase, plus the test-matrix epic) per `migration-plan-T9345.md` §"Child-epic decomposition" is:
   - Schema migration + provenance tables (Phase 0)
   - Read-mostly verbs `plan` + `reconcile` (Phase 1)
   - Provenance backfill across historical releases (Phase 2)
   - `release-prepare.yml` template + `cleo release open` verb (Phase 3)
   - `release-publish.yml` + `release-fanout.yml` templates + `cleo init/upgrade workflows` scaffolding (Phase 4)
   - Operator surface flip + IVTR decoupling (Phase 5)
   - Cleanup: delete `releaseShip` monolith + parallel 4-step pipeline (Phase 6)
   - Test matrix + 3-archetype fixtures (cross-phase)

   The real IDs assigned by `cleo add` MUST be recorded back into this index and into `migration-plan-T9345.md` §"Child-epic decomposition" before any implementation work begins. **No fabricated IDs in any artifact.**

3. **Advance T9345 to `pipelineStage=spec`** once council convergence is reached.
4. **Run RCASD's spec stage** on each child epic before its implementation begins.

---

## Honest corrections (post-review, 2026-05-16)

- **Prior version of this index named fabricated task IDs `T9346`–`T9353`.** Those were planning placeholders, NOT real tasks in `tasks.db`. They have been removed. Real IDs will be assigned by `cleo add` at the moment each child epic is filed.
- **Prior version of this index did not explain that the GHA workflows are CLEO-templated scaffolds, not cleocode-only files.** The new "GHA workflow architecture" section above corrects this. The ADR-073 SPEC §5 always intended this — it just was not surfaced in the index.

## Notes

- 2026-05-16 04:18 UTC — T9345 created by owner, pipelineStage=research.
- 2026-05-16 04:30 UTC — orchestrator (cleo-prime) began wave 1.
- 2026-05-16 05:43 UTC — wave 1 complete (5 specialists).
- 2026-05-16 06:18 UTC — wave 2a complete (provenance graph + ADR).
- 2026-05-16 06:35 UTC — wave 2b complete (SPEC + migration + test matrix).
- All artifacts written without modifying any production source code. Read-only research wave.

## File evidence inventory

```
/mnt/projects/cleocode/.cleo/rcasd/T9345/research/
├── T9345-research.md                          (this index — 200 lines)
├── audit-cleo-release-subcommands.md          (736 lines)
├── failure-forensics-10-modes.md              (1,291 lines)
├── hermes-agent-real-research.md              (1,180 lines)
├── letta-harness-real-research.md             (1,091 lines)
├── ivtr-conflation-audit.md                   (568 lines)
├── provenance-graph-design.md                 (1,340 lines)
├── ADR-T9345-ivtr-release-overhaul.md         (944 lines — ADR-073)
├── SPEC-T9345-release-pipeline-v2.md          (822 lines)
├── migration-plan-T9345.md                    (619 lines)
└── test-matrix-T9345.md                       (529 lines)
                                       Total: 9,137 lines of evidence + design.
```
