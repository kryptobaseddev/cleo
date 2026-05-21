/**
 * Provenance graph union types.
 *
 * Canonical home for the 16 string-literal union types that describe edges
 * and FSM states in the CLEO provenance graph (commits, pull requests,
 * releases, release artifacts, and BRAIN↔release links). Promoted from
 * `packages/core/src/store/tasks-schema.ts` in Phase 0c of the
 * SG-ARCH-SOLID Saga so that downstream packages can import these unions
 * without pulling in the Drizzle schema runtime.
 *
 * The const arrays that back each union (`PR_STATES`, `COMMIT_LINK_KINDS`,
 * `RELEASE_STATUSES`, …) remain in `tasks-schema.ts` because Drizzle's
 * `text({ enum: ... })` column declaration narrows the runtime row type
 * directly from those `as const` literals. `tasks-schema.ts` re-exports
 * each union from this module to preserve the existing public surface for
 * every `import * as schema from '../store/tasks-schema.js'` consumer.
 *
 * @see SPEC-T9345 §3 — provenance graph table definitions
 * @see ADR-073 — task hierarchy charter (release provenance scope)
 *
 * Consolidated unions:
 *   - {@link PrState}                   — pull-request lifecycle state
 *   - {@link PrLinkSource}              — how a PR↔task link was discovered
 *   - {@link PrLinkKind}                — semantic PR↔task relationship
 *   - {@link CommitConventionalType}    — Conventional Commits prefix
 *   - {@link CommitLinkKind}            — semantic commit↔task relationship
 *   - {@link CommitLinkSource}          — how a commit↔task link was discovered
 *   - {@link CommitFileChangeType}      — git status letter (A/M/D/R/C)
 *   - {@link ReleaseScheme}             — versioning scheme
 *   - {@link ReleaseChannel}            — npm dist-tag channel
 *   - {@link ReleaseKind}               — release packaging type
 *   - {@link ReleaseStatus}             — unified release FSM state
 *   - {@link ReleaseChangeType}         — 12-value change taxonomy
 *   - {@link ReleaseImpact}             — semver impact level
 *   - {@link ReleaseClassifiedBy}       — change-classification provenance
 *   - {@link ReleaseArtifactType}       — artifact archetype
 *   - {@link BrainReleaseLinkType}      — BRAIN↔release link semantics
 *
 * @since SG-ARCH-SOLID Saga T9831 · E-CONTRACTS-FOUNDATION T9832 · T9955 (Phase 0c)
 */

// ── Pull-request unions (T9507) ─────────────────────────────────────────

/**
 * State of a pull request.
 *
 * Mirrors the GitHub PR state machine:
 *   - `open`   — PR is open and not yet merged
 *   - `closed` — PR was closed without merging
 *   - `merged` — PR was merged into the target branch
 *
 * @task T9507
 */
export type PrState = 'open' | 'closed' | 'merged';

/**
 * How a PR↔task link was discovered.
 *
 *   - `pr-title`       — task ID matched in the PR title
 *   - `pr-body`        — task ID matched in the PR body markdown
 *   - `branch-name`    — parsed from the branch name (e.g. `feat/T9507-...`)
 *   - `commit-trailer` — extracted from a git trailer in a PR commit
 *   - `manual`         — explicitly linked via `cleo provenance link`
 *
 * @task T9507
 */
export type PrLinkSource = 'pr-title' | 'pr-body' | 'branch-name' | 'commit-trailer' | 'manual';

/**
 * Semantic classification of a PR↔task relationship.
 *
 * Extends {@link CommitLinkKind} with `'tracks'` for PRs that observe a
 * task without directly implementing, fixing, or documenting it.
 *
 *   - `implements` — the PR directly implements the task's acceptance criteria
 *   - `fixes`      — the PR fixes a bug or regression in the task's work
 *   - `refactors`  — the PR restructures code introduced by the task
 *   - `tests`      — the PR adds or updates tests for the task
 *   - `docs`       — the PR updates documentation for the task
 *   - `reverts`    — the PR reverts work introduced by the task
 *   - `tracks`     — the PR is related to but does not directly implement the task
 *
 * @task T9507
 */
export type PrLinkKind =
  | 'implements'
  | 'fixes'
  | 'refactors'
  | 'tests'
  | 'docs'
  | 'reverts'
  | 'tracks';

// ── Commit unions (T9506) ───────────────────────────────────────────────

/**
 * Conventional Commits prefix parsed from a commit subject.
 *
 * Adds `'breaking'` to the canonical CC set to flag BREAKING CHANGE
 * footers. The DB column is nullable — a commit that does not follow
 * Conventional Commits format stores NULL rather than one of these values.
 *
 * @task T9506
 */
export type CommitConventionalType =
  | 'feat'
  | 'fix'
  | 'chore'
  | 'docs'
  | 'refactor'
  | 'test'
  | 'build'
  | 'ci'
  | 'perf'
  | 'revert'
  | 'breaking';

/**
 * Semantic classification of a commit↔task relationship.
 *
 *   - `implements` — the commit directly implements the task's acceptance criteria
 *   - `fixes`      — the commit fixes a bug or regression in the task's work
 *   - `refactors`  — the commit restructures code introduced by the task
 *   - `tests`      — the commit adds or updates tests for the task
 *   - `docs`       — the commit updates documentation for the task
 *   - `reverts`    — the commit reverts work introduced by the task
 *
 * @task T9506
 */
export type CommitLinkKind = 'implements' | 'fixes' | 'refactors' | 'tests' | 'docs' | 'reverts';

/**
 * How a commit↔task link was discovered.
 *
 *   - `commit-trailer` — extracted from a `T####:` or `Task-Id:` git trailer
 *   - `commit-subject` — matched `T####` regex in the commit subject line
 *   - `pr-title`       — matched task ID in the PR title
 *   - `pr-body`        — matched task ID in the PR body markdown
 *   - `branch-name`    — parsed from the branch name (e.g., `feat/T9506-...`)
 *   - `manual`         — explicitly linked via `cleo provenance link`
 *
 * @task T9506
 */
export type CommitLinkSource =
  | 'commit-trailer'
  | 'commit-subject'
  | 'pr-title'
  | 'pr-body'
  | 'branch-name'
  | 'manual';

/**
 * Per-file change type from a git diff (status letter codes).
 *
 *   - `A` — added
 *   - `M` — modified
 *   - `D` — deleted
 *   - `R` — renamed
 *   - `C` — copied
 *
 * @task T9506
 */
export type CommitFileChangeType = 'A' | 'M' | 'D' | 'R' | 'C';

// ── Release unions (T9508) ──────────────────────────────────────────────

/**
 * Versioning scheme for a release.
 *
 *   - `calver`        — YYYY.MM.patch (e.g. 2026.5.74) — CLEO default
 *   - `semver`        — MAJOR.MINOR.PATCH (e.g. 1.2.3)
 *   - `calver-suffix` — YYYY.MM.patch.N suffix hotfix (e.g. 2026.5.74.2)
 *
 * @task T9508
 * @remarks
 * The values here MUST stay aligned with `RELEASE_SCHEMES` in
 * `tasks-schema.ts`; that const array drives the Drizzle row type. A
 * compile-time structural assertion in
 * `packages/contracts/src/__tests__/provenance.test.ts` pins both sides.
 */
export type ReleaseScheme = 'calver' | 'semver' | 'calver-suffix';

/**
 * Release channel — controls which npm dist-tag (or equivalent) the
 * artifact is published under.
 *
 *   - `latest` — current stable
 *   - `beta`   — pre-release tested in production-adjacent environments
 *   - `dev`    — internal development snapshots
 *   - `hotfix` — emergency patch outside the regular cadence
 *
 * @task T9508
 * @remarks
 * Distinct from the `ReleaseChannel` exported by
 * `@cleocode/contracts/release/channel` (which carries the npm-level
 * `latest|beta|alpha` set) and from the `ReleaseChannel` in
 * `@cleocode/contracts/release/plan` (which carries the release-plan
 * `latest|beta|alpha|rc` set). Top-level `@cleocode/contracts` re-exports
 * this union under a disambiguating alias.
 */
export type ReleaseChannel = 'latest' | 'beta' | 'dev' | 'hotfix';

/**
 * Release packaging kind, orthogonal to individual change types within
 * the release.
 *
 *   - `regular`    — standard scheduled release
 *   - `hotfix`     — emergency patch outside regular cadence
 *   - `prerelease` — alpha/beta/rc release for early adopters
 *
 * @task T9508
 */
export type ReleaseKind = 'regular' | 'hotfix' | 'prerelease';

/**
 * Unified release FSM state (admits values from BOTH the new T9492
 * pipeline and the legacy T5580 pipeline; the status value itself
 * discriminates which pipeline owns the row).
 *
 * **New T9492 pipeline** — SPEC-T9345 §10.1 FSM:
 *   `planned → pr-opened → pr-merged → published → reconciled`
 *
 * **Legacy T5580 pipeline** — pre-T9492 12-step flow:
 *   `prepared → committed → tagged → pushed`
 *
 * **Shared terminal states**:
 *   `rolled_back | failed | cancelled`
 *
 * State transitions per R-302 MUST be monotonic within each lifecycle;
 * illegal transitions return `E_INVALID_STATE` and MUST NOT mutate any row.
 *
 * @task T9508
 * @task T9686 (unification — legacy + new statuses on one column)
 * @see SPEC-T9345 §10.1
 */
export type ReleaseStatus =
  | 'planned'
  | 'pr-opened'
  | 'pr-merged'
  | 'published'
  | 'reconciled'
  | 'prepared'
  | 'committed'
  | 'tagged'
  | 'pushed'
  | 'rolled_back'
  | 'failed'
  | 'cancelled';

/**
 * 12-value CLEO release change taxonomy (Option B from
 * provenance-graph-design.md §2.2).
 *
 * Lives at the release-changes level (not on `tasks.kind`) so that:
 *   - A single task can produce multiple change rows across releases.
 *   - Hotfix classification is a release-packaging decision, not a task property.
 *   - Auto-classification is agent-writable without touching OWNER-WRITE-ONLY fields.
 *
 * @task T9508
 * @see SPEC-T9345 §2.2
 */
export type ReleaseChangeType =
  | 'feature'
  | 'enhancement'
  | 'bug'
  | 'hotfix'
  | 'security'
  | 'breaking'
  | 'refactor'
  | 'docs'
  | 'chore'
  | 'revert'
  | 'deprecation'
  | 'infrastructure';

/**
 * Impact level for a release change, mapped to semver bump assessment.
 *
 *   - `major` — breaking change (MAJOR bump)
 *   - `minor` — new feature (MINOR bump)
 *   - `patch` — bug fix / chore (PATCH bump)
 *   - `none`  — cosmetic / docs / trivial (no version bump warranted alone)
 *
 * @task T9508
 */
export type ReleaseImpact = 'major' | 'minor' | 'patch' | 'none';

/**
 * Provenance of a release-change classification.
 *
 *   - `auto`     — derived by the classification engine from CC prefix + heuristics
 *   - `manual`   — owner overrode the auto classification via `cleo release classify`
 *   - `approved` — owner approved an agent-proposed classification
 *
 * @task T9508
 */
export type ReleaseClassifiedBy = 'auto' | 'manual' | 'approved';

// ── Release artifact + BRAIN-link unions (T9509) ─────────────────────────

/**
 * Release artifact archetype.
 *
 *   - `npm`            — npm package published to a registry
 *   - `cargo`          — Rust crate published to crates.io
 *   - `docker`         — Container image pushed to an OCI registry
 *   - `pypi`           — Python package published to pypi.org
 *   - `github-release` — GitHub Releases asset attached to a git tag
 *   - `binary`         — Generic compiled binary distributed via direct URL
 *   - `github-tag`     — Lightweight git tag (no attached assets)
 *
 * @task T9509
 * @see SPEC-T9345 §3.9
 */
export type ReleaseArtifactType =
  | 'npm'
  | 'cargo'
  | 'docker'
  | 'pypi'
  | 'github-release'
  | 'binary'
  | 'github-tag';

/**
 * Semantic relationship between a BRAIN entry and a release.
 *
 *   - `approved-by`    — A BRAIN decision approved a change that shipped in this release.
 *   - `documented-in`  — This release is where the BRAIN entry was first formally documented.
 *   - `derived-from`   — The release's failure or outcome produced this BRAIN learning/pattern.
 *   - `observed-in`    — A BRAIN observation was made about this release (e.g. performance note).
 *
 * @task T9509
 * @see SPEC-T9345 §8.1
 */
export type BrainReleaseLinkType = 'approved-by' | 'documented-in' | 'derived-from' | 'observed-in';
