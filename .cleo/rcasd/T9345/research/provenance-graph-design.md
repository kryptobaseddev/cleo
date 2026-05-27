# Release-Provenance Graph — Design Spec for T9345

**Epic**: T9345 (IVTR Release System Overhaul)
**Phase**: Wave-2 RCASD Architecture
**Author**: cleo-prime (System Architect)
**Status**: DESIGN — schema, queries, and adapter contracts only. No implementation code yet.
**Date**: 2026-05-15
**Wave-1 inputs grounded against**:
- `/mnt/projects/cleocode/.cleo/rcasd/T9345/research/audit-cleo-release-subcommands.md`
- `/mnt/projects/cleocode/.cleo/rcasd/T9345/research/ivtr-conflation-audit.md`
- `/mnt/projects/cleocode/.cleo/rcasd/T9345/research/hermes-agent-real-research.md`
- `/mnt/projects/cleocode/.cleo/rcasd/T9345/research/letta-harness-real-research.md`
- `/mnt/projects/cleocode/packages/core/src/store/tasks-schema.ts`
- `/mnt/projects/cleocode/packages/contracts/src/task.ts`
- `/mnt/projects/cleocode/.cleo/adrs/ADR-053-project-agnostic-release-pipeline.md`
- `/mnt/projects/cleocode/.cleo/adrs/ADR-065-pr-required-release-flow.md`

---

## Executive Summary

This design closes the **CRITICAL provenance graph gap** identified at
ivtr-conflation-audit.md:255 ("Provenance graph is implicit and incomplete. No SQL
view can answer 'Which commits shipped in v1.2.3 and which bugs did they fix?'") and
delivers the owner's explicit requirement (T9345 goal verbatim): "**a true tracking
graph of released code**" across features, bugs, hotfixes, epics, tasks, commits, PRs,
and releases.

**Gap closure — 9 new edges, 1 reclassified taxonomy, 0 lost auditability**:
1. `task → commit` (new `task_commits` junction; replaces JSON-walk of `tasksJson`)
2. `commit → release` (new `release_commits` junction; replaces scalar `commitSha`)
3. `pr → commit` (new `pull_requests` + `pr_commits` tables)
4. `pr → task` (new `pr_tasks` — derived from PR body `T####` regex + commit-trailers)
5. `release → change` (new `release_changes` table — classified feature/bug/hotfix/security/breaking payload)
6. `change → task` (new `release_changes.task_id`)
7. `commit → file` (new `commit_files` — enables blast-radius + file-author queries)
8. `release → artifact` (new `release_artifacts` — polymorphic for npm/cargo/docker/binary)
9. `brain_decision → release` (new `brain_release_links` — closes BRAIN↔release loop)

Plus: extend `TASK_RELATION_TYPES` with `'regresses'`, `'follows-up'`, `'reverts'`,
`'hotfixes'` (currently only `related|blocks|duplicates|absorbs|fixes|extends|supersedes`
per tasks-schema.ts:176). Introduce orthogonal `change_type` enum on
`release_changes` rather than expanding `TaskKind` — preserves backward compat for
~950 existing rows while making `feature` and `hotfix` first-class at the
release level.

**CLI surface — 11 new subcommands** under two grouped namespaces (`cleo release
graph|diff|impact|authors|orphans`, `cleo provenance task|commit|pr|feature|release|change`)
plus one materialized view `releases_view` that joins everything for read-heavy
external consumers (e.g. dashboard, docs site, agents).

**Migration safety — zero-downtime claim**: All new tables sit BESIDE the legacy
`release_manifests.tasksJson` and `release_manifests.commitSha` columns. A
backfill pass derives new-table content from existing JSON + `git log` walk
during a single CI step (idempotent — re-runnable). Legacy columns remain
readable for one full release cycle (~30 days), then deprecate-without-drop.
No live write path is altered until backfill completes + dual-write integration
tests pass. The 12-step `release ship` pipeline gains a single new Step 13
("Record provenance graph") that runs AFTER tag + push — failure here is
non-fatal for the release and emits a follow-up reconciliation task.

---

## 1. Current State (With Gaps)

### 1.1 Inventory of Provenance-Relevant Tables Today

| Table | What it captures | Provenance edges present | What it MISSES | Joinable in SQL? |
|-------|------------------|--------------------------|----------------|------------------|
| `tasks` (tasks-schema.ts:243) | Identity + status + kind/scope/severity + `parentId` (hierarchy edge) + `blockedBy` (soft FK string) + `epicLifecycle` + JSON labels/notes/acceptance/files | parent→child (hierarchy) via `parentId` FK | No commit edge. No release edge. No PR edge. `blockedBy` is **a single string column**, not a table — can't express "blocked by 3 tasks". `epicLifecycle` is also a soft string FK. | Partial — `parentId` is real FK. Everything else is JSON or strings. |
| `task_relations` (tasks-schema.ts:391) | 7-way typed M:N edge between tasks | `related|blocks|duplicates|absorbs|fixes|extends|supersedes` | No `regresses`. No `follows-up`. No `reverts`. No `hotfixes`. No timestamp. No commit anchor. | Yes (true junction with FKs). |
| `task_dependencies` (tasks-schema.ts:373) | M:N edge `task → depends_on` | hard dep edge | Duplicates `relates_blocks` semantics; no relation type beyond "depends" | Yes. |
| `lifecycle_pipelines` (tasks-schema.ts:521) | Per-task pipeline state machine | task↔pipeline (1:1 typically) | Per-stage but not per-release | Yes. |
| `lifecycle_stages` (tasks-schema.ts:547) | Per-stage metadata (status, evidence, validation) + `outputFile` + `provenanceChainJson` | stage↔pipeline FK | No commit-SHA column. No release-FK. | Yes. |
| `lifecycle_evidence` (tasks-schema.ts:610) | Per-stage evidence (uri, type=file|url|manifest) | stage↔evidence FK | No commit-SHA atom — only file/url/manifest. | Yes. |
| `lifecycle_transitions` (tasks-schema.ts:630) | Stage transitions (automatic/manual/forced) | pipeline↔transition FK + from/to stage FKs | No release-FK. No commit anchor. | Yes. |
| `manifest_entries` (tasks-schema.ts:656) | RCASD provenance per pipeline-stage (title, date, topics, findings, linkedTasksJson) | pipeline↔stage FK, `linkedTasksJson` is JSON | `linkedTasksJson` is JSON; cannot SQL-join from manifests→tasks. | Partial — pipeline/stage FK joinable; tasks via JSON walk only. |
| `pipeline_manifest` (tasks-schema.ts:684) | Wave-level artifact (type, content, hash) bound to session/task/epic | session↔task↔epic FKs (set null on delete) | No release FK. No commit FK. | Yes (3 FKs). |
| `release_manifests` (tasks-schema.ts:713) | The release record itself (version, status, epicId, **tasksJson** [denormalized], changelog, **commitSha** [scalar], gitTag, npmDistTag, lifecycle timestamps) | release↔epic FK + release↔pipeline FK | `tasksJson` is a JSON blob of task IDs — **NOT a junction table**. `commitSha` is a **scalar string** — captures the release commit but not the commits that shipped IN the release. No PR linkage. No author roll-up. No artifact polymorphism (`npmDistTag` is hardcoded npm-shaped). | Partial — only `epicId` and `pipelineId` are FKs; everything else is opaque JSON or strings. |
| `audit_log` (tasks-schema.ts:758) | Every mutate-domain operation with before/after JSON + actor + session_id + project_hash | task↔session FK | No release_id FK — audit-log entries about a release scatter across operations. | Yes (FKs work; project_hash filters). |
| `architecture_decisions` (tasks-schema.ts:848) | ADRs with supersedes/superseded/amends/file_path | ADR↔ADR self-FK (supersedes/amends) + ADR↔manifest FK | No release-FK. ADR acceptance shipped in release X is not queryable. | Yes. |
| `brain_decisions` (memory-schema.ts:155) | BRAIN decisions with `contextEpicId`, `contextTaskId`, `contextPhase`, `adrNumber`, `adrPath`, `peerId`, `peerScope` | task↔decision soft FKs (string columns, not REFERENCES) | No release-FK. "Which decisions shipped in v2026.5.74?" is unanswerable. | No — soft FKs are TEXT, no REFERENCES. |
| `external_task_links` (tasks-schema.ts:941) | CLEO task ↔ external provider task (Linear/Jira/GitHub) | task↔external FK | No release-FK. No commit-FK. Cannot answer "which Linear issues shipped in v2026.5.74?" | Yes (real FK to tasks). |

### 1.2 What the Owner Specifically Asked For — Mapped to Current Gaps

> Owner verbatim: "*the scope of tracking releases is wider then just a release but knowing Features, bugs, hotfixes and full provenance from start to finish seeing full connections across Epics and tasks and evolutions creating a true tracking graph of released code*"

| Owner concept | Current storage | Gap severity |
|---------------|-----------------|--------------|
| **Features** | `tasks.kind='work'` (no first-class feature kind); features tracked as epics or by label/title convention | HIGH — `feature` is implicit. No way to roll up "all features in 2026.5.x". |
| **Bugs** | `tasks.kind='bug'` (first-class enum value, present in TASK_KINDS at tasks-schema.ts:99) | LOW — kind exists; missing is release linkage. |
| **Hotfixes** | No first-class kind. Hotfixes are encoded as `tasks.kind='bug' + severity='P0'` shipped between regular releases — a **convention, not a constraint**. | HIGH — invisible to SQL. Cannot answer "list all hotfixes after v2026.5.73 before v2026.5.74". |
| **Full provenance** | Implicit via JSON walks (`release_manifests.tasksJson`, `tasks.ivtrState.phaseHistory[].evidenceRefs[]`) | **CRITICAL** — Audit doc Phase 4 §Q4 says: "**Graph is implicit and incomplete**. No SQL can answer: 'List all tasks that shipped in this release.'" |
| **Connections across Epics and tasks and evolutions** | `tasks.parentId` (hierarchy) + `task_relations` (7-way M:N) | MEDIUM — hierarchy works; evolutions (supersedes/regresses/follows-up) underspecified. Missing `regresses`/`reverts`/`hotfixes` edges. |
| **Tracking graph of released code** | No `commits` table. No `pull_requests` table. No materialized join view. | **CRITICAL** — three CORE tables missing entirely. |

### 1.3 Concrete Query That Fails Today

The owner's mental model fails on this trivial query:

```sql
-- "What bugs shipped in v2026.5.74?"
SELECT t.id, t.title
FROM release_manifests r
JOIN ???                 -- no junction; tasksJson is JSON blob, not table
  ON r.id = ???.release_id
JOIN tasks t ON t.id = ???.task_id
WHERE r.version = 'v2026.5.74' AND t.kind = 'bug';
```

There is no syntactically valid SQL that answers this without `json_each(r.tasksJson)`,
which (a) requires SQLite JSON1 extension and (b) is O(N) for every release we want
to scan. Even with JSON1, you cannot index a JSON-array membership query — meaning
"which releases shipped task T9344?" is a full table scan over every release in
history.

---

## 2. Gap Analysis: Taxonomy — Feature, Bug, Hotfix as First-Class

### 2.1 The Question

`TaskKind` today (tasks-schema.ts:99 / contracts/task.ts:57):

```typescript
export const TASK_KINDS = ['work', 'research', 'experiment', 'bug', 'spike', 'release'] as const;
export type TaskKind = 'work' | 'research' | 'experiment' | 'bug' | 'spike' | 'release';
```

Missing canonical kinds:
- `feature` — a new user-visible capability
- `hotfix` — an emergency patch shipped outside the regular release cadence
- `enhancement` — improving an existing feature (non-bug, non-new)
- `refactor` — internal restructure (no user-visible change)
- `chore` — tooling/build/CI
- `docs` — documentation only
- `security` — security fix (orthogonal severity? or kind?)

### 2.2 Two Design Options

**Option A — Expand `TaskKind`**:

```typescript
export const TASK_KINDS = [
  'work', 'feature', 'enhancement', 'bug', 'hotfix', 'security',
  'refactor', 'chore', 'docs', 'research', 'experiment', 'spike', 'release'
] as const;
```

Pros:
- Single enum, simple model.
- Direct mapping to Conventional Commits prefixes (feat/fix/chore/docs/refactor/etc.) per Hermes pattern (hermes-agent-real-research.md:398).

Cons:
- **Backward incompat at the data layer**: 950+ existing rows are `kind='work'` and would need bulk reclassification. Every reclassification is **owner-signed** per T944/T9073 (severity is OWNER-WRITE-ONLY for prompt-injection safety; kind is not yet but should follow the same pattern for `hotfix`/`security`).
- Tight coupling: A task could conceivably be both "feature" AND "hotfix" (you can hotfix a feature you just shipped). Single-kind model can't express dual-role.
- `hotfix` is really a **release classifier**, not a task classifier. A `bug` becomes a `hotfix` by virtue of being shipped between regular releases — the kind didn't change, the **release packaging** changed.

**Option B (RECOMMENDED) — Keep `TaskKind` minimal + add orthogonal `change_type` at the release-changes layer**:

```typescript
// tasks.kind stays as-is (work/research/experiment/bug/spike/release)
// Plus one extension: add 'feature' to TaskKind for first-class feature tracking.
export const TASK_KINDS = [
  'work', 'feature', 'research', 'experiment', 'bug', 'spike', 'release'
] as const;

// NEW: orthogonal change_type at the release level
export const CHANGE_TYPES = [
  'feature',       // new user-visible capability
  'enhancement',   // improving an existing feature
  'bug',           // bug fix
  'hotfix',        // emergency bug fix shipped out-of-band
  'security',      // security patch (often a hotfix)
  'breaking',      // breaking API change
  'refactor',      // internal restructure
  'docs',          // documentation only
  'chore',         // tooling, build, CI
  'deprecation',   // deprecating a feature
  'revert',        // reverting a prior change
  'performance'    // perf optimization
] as const;
```

The `change_type` lives on the **new `release_changes` table** (defined in §3.6), not on `tasks`. A single task can produce multiple `release_changes` rows across multiple releases (a feature task introduced in v1, enhanced in v2, hotfixed in v3 — three change rows, one task).

**Why this is the correct factoring**:

| Justification | Evidence |
|---------------|----------|
| **A `hotfix` is a packaging decision, not a work decision** | The task `T9344` (Anthropic OAuth hotfix) recorded in MEMORY.md is `kind='bug'` shipped as a `change_type='hotfix'` because it landed in v2026.5.74 (out-of-band patch on top of v2026.5.73). The work didn't change; the release framing did. |
| **Same task can ship as different change_types over time** | A `feature` shipped in v1 → enhanced in v2 → security-patched in v3 = 1 task, 3 release_changes rows. Modeling on `tasks.kind` forces lossy compression. |
| **Conventional Commits already lives at commit/PR level, not task level** | Hermes pattern (hermes-agent-real-research.md:398) parses CC prefixes from commit subjects, not task records. CLEO should classify at the commit-aggregation point (release_changes), not retroactively on tasks. |
| **Owner-write safety scales** | `change_type` is auto-derived from CC prefix + per-task heuristic; agent-writable. `tasks.kind` carries owner-signed severity binding and cannot be auto-changed. Decoupling = agent can classify a change without touching `tasks.kind`. |
| **Backward compat is preserved** | Adding `'feature'` to TASK_KINDS is one new enum value (~zero migration cost — defaulted via heuristic on existing data). Adding `change_type` as a brand-new table is **zero impact** on existing rows. |

### 2.3 The Decision

**Adopt Option B**. Concretely:

1. Add `'feature'` to `TASK_KINDS` (single new enum value; backfill heuristic: epics with title containing "feature" or `acceptance` listing >1 user-visible behavior).
2. Add new `CHANGE_TYPES` enum at the release level (12 values, broad coverage).
3. Hotfix detection is **derived** at write-time: a `release_changes` row inherits `change_type='hotfix'` when (a) the underlying task has `severity IN ('P0','P1')` AND (b) the release shipping it was published <72h after the prior release AND (c) the release branch was `hotfix/*` OR the version skip-bumped (e.g. v2026.5.73 → v2026.5.74 with no intermediate work).

Example walk-through for T9344 (Anthropic OAuth hotfix, MEMORY.md):

```
T9344 (kind='bug', severity='P0', shipped 2026-05-14)
  ↓ shipped in v2026.5.74 (which followed v2026.5.73 by ~24h, on branch fix/T9344-anthropic-oauth-correct-redirect-uri)
  ↓ creates release_changes row: { release_id='v2026.5.74', task_id='T9344', change_type='hotfix', cc_type='fix', breaking=0 }
```

The same task in a different release context could yield `change_type='bug'` (regular patch) without changing `tasks.kind`.

---

## 3. New Tables — Proposed Schema

All DDL is valid SQLite (no PG-isms; no `BOOLEAN`, no `TIMESTAMP`, no `UUID`,
no `JSONB`). Booleans are `INTEGER NOT NULL DEFAULT 0` (idiomatic SQLite).
JSON columns are `TEXT NOT NULL DEFAULT '{}'`. Timestamps are `TEXT` in
ISO-8601 (matches existing convention in tasks-schema.ts:297).

### 3.1 `commits` — Every git commit reachable from a release tag

```sql
CREATE TABLE commits (
  sha                TEXT PRIMARY KEY,
  short_sha          TEXT NOT NULL,                  -- first 7 chars
  author_name        TEXT,
  author_email       TEXT,
  authored_at        TEXT NOT NULL,                   -- ISO-8601
  committer_name     TEXT,
  committer_email    TEXT,
  committed_at       TEXT NOT NULL,
  message            TEXT NOT NULL,                   -- full message body
  subject            TEXT NOT NULL,                   -- first line only
  conventional_type  TEXT,                            -- feat|fix|chore|docs|refactor|test|build|ci|perf|revert|breaking|null
  conventional_scope TEXT,                            -- the (scope) in feat(scope): subject
  is_release_commit  INTEGER NOT NULL DEFAULT 0,      -- "chore(release): vX.Y.Z" pattern
  is_merge_commit    INTEGER NOT NULL DEFAULT 0,      -- has multiple parents
  is_revert          INTEGER NOT NULL DEFAULT 0,      -- starts with "Revert " or has Revert trailer
  parent_shas        TEXT NOT NULL DEFAULT '[]',      -- JSON array of SHA strings
  signature_verified INTEGER,                         -- 0=no, 1=yes, NULL=not checked
  branch_at_commit   TEXT,                            -- best-effort; what branch was HEAD on at commit time
  project_hash       TEXT,                            -- for multi-repo CLEO installs (matches audit_log.project_hash)
  trailers_json      TEXT NOT NULL DEFAULT '{}',      -- {"Co-authored-by":[...], "Signed-off-by":[...], etc.}
  ingested_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_commits_short_sha ON commits(short_sha);
CREATE INDEX idx_commits_author_email ON commits(author_email);
CREATE INDEX idx_commits_authored_at ON commits(authored_at);
CREATE INDEX idx_commits_conventional_type ON commits(conventional_type);
CREATE INDEX idx_commits_is_release_commit ON commits(is_release_commit);
CREATE INDEX idx_commits_project_hash ON commits(project_hash);
```

**Edge captured**: commit identity + author attribution + Conventional Commits classification. Backed by Hermes pattern (hermes-agent-real-research.md:226–238 — `git log --no-merges --format='%H|%an|%ae|%s\0%b\0'`) and Letta pattern (letta-harness-real-research.md:29 — `LET-XXXX (#PR)` cross-citation needs commit table to anchor).

**Why `parent_shas` is JSON not a separate table**: Most commits have 1–2 parents (linear OR merge). Querying parents-of-parent walks is a graph problem better served by recursive CTE; storing parent SHAs inline avoids a third level of join for the common case.

**Why no `branch` table**: Branches are ephemeral — tracking historical branch state is a separate problem (`git reflog` territory). `branch_at_commit` is best-effort and may be NULL.

### 3.2 `task_commits` — M:N edge (task ↔ commit)

```sql
CREATE TABLE task_commits (
  task_id           TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  commit_sha        TEXT NOT NULL REFERENCES commits(sha) ON DELETE CASCADE,
  link_source       TEXT NOT NULL,                   -- 'commit-trailer'|'commit-message'|'pr-body'|'manual'|'manifest'
  link_evidence     TEXT,                             -- e.g. the matched substring "T9344"
  is_primary        INTEGER NOT NULL DEFAULT 0,       -- 1 = canonical commit that "implements" task; 0 = supporting
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  created_by        TEXT,                              -- agent or 'system' (auto-extract)
  PRIMARY KEY (task_id, commit_sha)
);

CREATE INDEX idx_task_commits_commit_sha ON task_commits(commit_sha);
CREATE INDEX idx_task_commits_link_source ON task_commits(link_source);
CREATE INDEX idx_task_commits_task_primary ON task_commits(task_id, is_primary);
```

**Edge captured**: task → commit (M:N). A task can have many commits (initial impl + fix-up); a commit can serve many tasks (the `T9344, T9345` shorthand in MEMORY.md observation #164 → both linked to PR #164's merge commit).

**Why `link_source`**: provenance of the link itself. Owner needs to know whether a task↔commit link came from a `T####` regex hit in commit subject (high confidence), a PR body mention (medium), a manifest write (highest), or a manual `cleo provenance link` call (auditable). Letta pattern recap (letta-harness-real-research.md:33): cross-citation `LET-XXXX (#PR)` happens both in commit subjects AND PR descriptions — different sources, both valid.

**Why `is_primary`**: One task may have 10 commits during dev but only 1 "ships it" (the merge commit on main). Flagging it lets `cleo provenance task <id>` highlight the canonical SHA without listing every WIP commit. Heuristic: the merge commit linked via PR is primary; lone commits to feature branches are not.

### 3.3 `commit_files` — Per-file × SHA edge (enables blast-radius)

```sql
CREATE TABLE commit_files (
  commit_sha   TEXT NOT NULL REFERENCES commits(sha) ON DELETE CASCADE,
  file_path    TEXT NOT NULL,                        -- canonical repo-relative path
  change_type  TEXT NOT NULL,                        -- 'added'|'modified'|'deleted'|'renamed'|'copied'
  old_path     TEXT,                                  -- non-null only for rename/copy
  additions    INTEGER NOT NULL DEFAULT 0,
  deletions    INTEGER NOT NULL DEFAULT 0,
  is_binary    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (commit_sha, file_path)
);

CREATE INDEX idx_commit_files_file_path ON commit_files(file_path);
CREATE INDEX idx_commit_files_change_type ON commit_files(change_type);
```

**Edge captured**: commit → file. Powers:
- `gitnexus_impact` (CLAUDE.md mentions) gets first-class data for "which tasks last touched packages/core/src/release/engine-ops.ts"
- `commit_files JOIN task_commits` answers "who edited this file in v2026.5.74?"
- Diff-by-file for `cleo release diff <v1> <v2>`

**Why not derive on-demand from `git log`**: Each query against git is ~100–500ms cold. Materializing the file-edit graph in SQLite means O(log N) lookups. Storage cost is modest: ~50 chars/path × ~30 files/commit × ~10k commits = ~15 MB per project.

### 3.4 `pull_requests` — PR metadata

```sql
CREATE TABLE pull_requests (
  id              TEXT PRIMARY KEY,                  -- canonical: "<repo_owner>/<repo_name>#<number>"
  repo_owner      TEXT NOT NULL,
  repo_name       TEXT NOT NULL,
  number          INTEGER NOT NULL,
  title           TEXT NOT NULL,
  body            TEXT,                                -- markdown body
  state           TEXT NOT NULL,                       -- 'open'|'closed'|'merged'
  is_draft        INTEGER NOT NULL DEFAULT 0,
  base_branch     TEXT NOT NULL,                       -- e.g. 'main'
  head_branch     TEXT NOT NULL,                       -- e.g. 'release/v2026.5.74'
  base_sha        TEXT,                                -- target branch SHA at merge time
  head_sha        TEXT NOT NULL,                       -- PR HEAD at merge time
  merge_commit_sha TEXT,                                -- the actual merge commit (NULL if not merged)
  author_login    TEXT,                                -- GitHub login
  author_email    TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT,
  closed_at       TEXT,
  merged_at       TEXT,                                -- NULL if not merged
  merged_by_login TEXT,
  ci_status       TEXT,                                -- 'pending'|'success'|'failure'|'error'|null
  ci_checks_json  TEXT NOT NULL DEFAULT '[]',          -- snapshot of `gh pr checks` JSON
  labels_json     TEXT NOT NULL DEFAULT '[]',
  project_hash    TEXT,
  ingested_at     TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (repo_owner, repo_name, number)
);

CREATE INDEX idx_pull_requests_state ON pull_requests(state);
CREATE INDEX idx_pull_requests_merge_commit_sha ON pull_requests(merge_commit_sha);
CREATE INDEX idx_pull_requests_head_branch ON pull_requests(head_branch);
CREATE INDEX idx_pull_requests_merged_at ON pull_requests(merged_at);
CREATE INDEX idx_pull_requests_author_login ON pull_requests(author_login);
CREATE INDEX idx_pull_requests_project_hash ON pull_requests(project_hash);
```

**Edge captured**: PR identity + lifecycle + CI state. Required for ADR-065's PR-required flow — the `gh pr checks` output (engine-ops.ts mentions `releasePrStatus`) is currently transient JSON; persisting it as `ci_checks_json` snapshot at merge time gives an audit trail.

**Why ID format `<owner>/<repo>#<number>`**: PR numbers collide across forks. The canonical PR identifier in GitHub's API is `<owner>/<repo>#<n>` — using this as PK avoids collision in multi-repo CLEO installs.

### 3.5 `pr_commits` and `pr_tasks` — PR junction tables

```sql
CREATE TABLE pr_commits (
  pr_id        TEXT NOT NULL REFERENCES pull_requests(id) ON DELETE CASCADE,
  commit_sha   TEXT NOT NULL REFERENCES commits(sha) ON DELETE CASCADE,
  position     INTEGER NOT NULL,                       -- order in PR
  PRIMARY KEY (pr_id, commit_sha)
);

CREATE INDEX idx_pr_commits_commit_sha ON pr_commits(commit_sha);

CREATE TABLE pr_tasks (
  pr_id          TEXT NOT NULL REFERENCES pull_requests(id) ON DELETE CASCADE,
  task_id        TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  link_source    TEXT NOT NULL,                        -- 'pr-title'|'pr-body'|'branch-name'|'commit-trailer'|'manual'
  link_evidence  TEXT,                                 -- the matched substring/regex hit
  PRIMARY KEY (pr_id, task_id)
);

CREATE INDEX idx_pr_tasks_task_id ON pr_tasks(task_id);
CREATE INDEX idx_pr_tasks_link_source ON pr_tasks(link_source);
```

**Edge captured**: pr↔commit (ordered) and pr↔task (typed). The `pr_tasks.link_source` matches `task_commits.link_source` taxonomy for symmetry.

### 3.6 `releases` — Normalized release record (separate from `release_manifests`)

```sql
CREATE TABLE releases (
  id                 TEXT PRIMARY KEY,                -- canonical: 'rel_<version>' or UUID
  version            TEXT NOT NULL UNIQUE,            -- 'v2026.5.74'
  channel            TEXT NOT NULL DEFAULT 'latest',  -- 'latest'|'beta'|'alpha'|'rc'
  status             TEXT NOT NULL,                   -- 'draft'|'prepared'|'committed'|'tagged'|'shipped'|'rolled_back'|'cancelled'
  release_kind       TEXT NOT NULL DEFAULT 'regular', -- 'regular'|'hotfix'|'major'|'minor'|'patch'|'prerelease'
  manifest_id        TEXT REFERENCES release_manifests(id) ON DELETE SET NULL,
  epic_id            TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  previous_version   TEXT,                            -- 'v2026.5.73' (denormalized for fast prior-walks)
  previous_release_id TEXT REFERENCES releases(id) ON DELETE SET NULL,
  pr_id              TEXT REFERENCES pull_requests(id) ON DELETE SET NULL,
  release_commit_sha TEXT REFERENCES commits(sha) ON DELETE SET NULL,
  tag_name           TEXT,                             -- 'v2026.5.74' (matches git tag)
  tag_sha            TEXT,                             -- what the tag actually points at
  changelog_md       TEXT,                             -- final rendered markdown
  notes              TEXT,                             -- release notes (separate from changelog)
  prepared_at        TEXT,
  shipped_at         TEXT,                             -- when it went out
  rolled_back_at     TEXT,
  rolled_back_reason TEXT,
  project_hash       TEXT,
  created_at         TEXT NOT NULL DEFAULT (datetime('now')),
  created_by         TEXT
);

CREATE INDEX idx_releases_version ON releases(version);
CREATE INDEX idx_releases_status ON releases(status);
CREATE INDEX idx_releases_channel ON releases(channel);
CREATE INDEX idx_releases_release_kind ON releases(release_kind);
CREATE INDEX idx_releases_shipped_at ON releases(shipped_at);
CREATE INDEX idx_releases_previous_release_id ON releases(previous_release_id);
CREATE INDEX idx_releases_project_hash ON releases(project_hash);
```

**Why a new table alongside `release_manifests`**: Audit doc (audit-cleo-release-subcommands.md:395–407) shows the existing table mixes `draft → prepared → committed → tagged → pushed → rolled_back` states with `tasksJson` (denormalized) and `commitSha` (scalar). The new `releases` table is the **normalized fact**; the legacy `release_manifests` row stays as the "draft scratchpad" for in-flight pipeline state. After ship, the canonical `releases` row is the source of truth; the manifest can be pruned or kept as audit trail.

**Why `release_kind` separate from `change_type` (in §3.7)**: `release_kind` describes the whole release; `change_type` describes individual changes WITHIN a release. A `release_kind='hotfix'` would typically have most or all `release_changes.change_type='hotfix'`, but you can technically ship a hotfix that bundles 1 hotfix + 1 docs change.

### 3.7 `release_changes` — Classified, per-task change payload

```sql
CREATE TABLE release_changes (
  id              TEXT PRIMARY KEY,                  -- UUID
  release_id      TEXT NOT NULL REFERENCES releases(id) ON DELETE CASCADE,
  task_id         TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  pr_id           TEXT REFERENCES pull_requests(id) ON DELETE SET NULL,
  primary_commit_sha TEXT REFERENCES commits(sha) ON DELETE SET NULL,
  change_type     TEXT NOT NULL,                     -- enum CHANGE_TYPES (see §2.2)
  cc_type         TEXT,                              -- Conventional Commits type (feat|fix|...)
  cc_scope        TEXT,                              -- Conventional Commits scope
  is_breaking     INTEGER NOT NULL DEFAULT 0,        -- BREAKING CHANGE detected
  is_security     INTEGER NOT NULL DEFAULT 0,        -- security flag
  severity        TEXT,                              -- inherited from task: P0|P1|P2|P3|null
  summary         TEXT NOT NULL,                     -- one-line; renders into CHANGELOG
  description     TEXT,                              -- multi-line detail
  rendered_md     TEXT,                              -- final rendered markdown for this change
  position        INTEGER NOT NULL DEFAULT 0,        -- order in CHANGELOG section
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_release_changes_release_id ON release_changes(release_id);
CREATE INDEX idx_release_changes_task_id ON release_changes(task_id);
CREATE INDEX idx_release_changes_change_type ON release_changes(change_type);
CREATE INDEX idx_release_changes_is_breaking ON release_changes(is_breaking);
CREATE INDEX idx_release_changes_is_security ON release_changes(is_security);
CREATE INDEX idx_release_changes_severity ON release_changes(severity);
CREATE INDEX idx_release_changes_release_position ON release_changes(release_id, position);
```

**Edge captured**: This is the **rendering layer** between raw release artifacts (commits, PRs, tasks) and the user-facing CHANGELOG. Each row corresponds to one bullet in the rendered CHANGELOG. A release with 10 features + 3 bugfixes + 1 breaking change has 14 rows here.

**Why both `change_type` (CLEO taxonomy) and `cc_type` (Conventional Commits)**: CLEO classification is editorial (owner-facing, 12 values); CC type is mechanical (extracted from commit subject). Storing both lets you query "all rows where cc_type='feat' but change_type='hotfix'" — i.e., a commit prefixed `feat:` that the owner reclassified as a hotfix. They diverge in real life: T9344 (Anthropic OAuth fix) has cc_type='fix' but change_type='hotfix' (per release packaging).

### 3.8 `release_commits` — Commits in this release range

```sql
CREATE TABLE release_commits (
  release_id   TEXT NOT NULL REFERENCES releases(id) ON DELETE CASCADE,
  commit_sha   TEXT NOT NULL REFERENCES commits(sha) ON DELETE CASCADE,
  position     INTEGER NOT NULL,                       -- topo order from `git log <prev>..<tag>`
  is_first     INTEGER NOT NULL DEFAULT 0,             -- first commit after previous release
  is_last      INTEGER NOT NULL DEFAULT 0,             -- the tag commit
  is_release_chore INTEGER NOT NULL DEFAULT 0,         -- "chore(release): v..." version-bump commit
  PRIMARY KEY (release_id, commit_sha)
);

CREATE INDEX idx_release_commits_commit_sha ON release_commits(commit_sha);
CREATE INDEX idx_release_commits_position ON release_commits(release_id, position);
```

**Edge captured**: which commits are *contained* in a release. Derived from `git log <previous_version>..<tag_name>` at ship time. Persisted for query speed.

### 3.9 `release_artifacts` — Polymorphic artifact registry

```sql
CREATE TABLE release_artifacts (
  release_id    TEXT NOT NULL REFERENCES releases(id) ON DELETE CASCADE,
  artifact_type TEXT NOT NULL,                       -- 'npm'|'cargo'|'docker'|'github-release'|'pypi'|'binary'|'gem'|'maven'
  identifier    TEXT NOT NULL,                       -- '@cleocode/cleo' for npm; 'cleo-core' for cargo; etc.
  version       TEXT NOT NULL,                        -- artifact-specific version
  url           TEXT,                                  -- registry URL
  digest        TEXT,                                  -- sha256 or similar
  signature     TEXT,                                  -- gpg/sigstore signature (optional)
  published_at  TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',           -- type-specific extras (e.g. {"dist-tag":"latest","provenance":true})
  PRIMARY KEY (release_id, artifact_type, identifier)
);

CREATE INDEX idx_release_artifacts_artifact_type ON release_artifacts(artifact_type);
CREATE INDEX idx_release_artifacts_identifier ON release_artifacts(identifier);
```

**Edge captured**: 1 release → N artifacts (a monorepo release publishes 22 npm packages + maybe 1 cargo crate + 1 docker image — that's 24 artifact rows for 1 release row). See §7 for multi-archetype portability.

### 3.10 `task_relations` extension — typed-graph evolution edges

The existing `task_relations` (tasks-schema.ts:391) already supports `related|blocks|duplicates|absorbs|fixes|extends|supersedes`. Extend the enum:

```sql
-- Migration: extend CHECK constraint on task_relations.relation_type
ALTER TABLE task_relations DROP CONSTRAINT IF EXISTS task_relations_relation_type_check;
-- (SQLite has no DROP CONSTRAINT; this is done via table-rename + recreate idiom)

-- New constraint covers:
--   related | blocks | duplicates | absorbs | fixes | extends | supersedes |
--   regresses | follows-up | reverts | hotfixes | depends-on
```

Plus add timestamp + commit anchor:

```sql
ALTER TABLE task_relations ADD COLUMN created_at TEXT NOT NULL DEFAULT (datetime('now'));
ALTER TABLE task_relations ADD COLUMN commit_sha TEXT REFERENCES commits(sha) ON DELETE SET NULL;
ALTER TABLE task_relations ADD COLUMN created_by TEXT;
```

**Edge captured**: explicit graph evolution. The 4 new types:
- `regresses` — task X regresses behavior introduced by task Y (the original task Y introduced the bug that X now exists to track)
- `follows-up` — task X is a follow-up to task Y (e.g., T9341 follows-up T9261 Phase 5 per MEMORY.md)
- `reverts` — task X reverts task Y (revert commit pattern; symmetric with `revert` change_type)
- `hotfixes` — task X hotfixes task Y (X is the bug-fix task; Y is the regressed feature task)

### 3.11 Index Summary — Optimized for §5 Queries

| Index | Purpose | Queries served (§5) |
|-------|---------|---------------------|
| `idx_release_changes_release_id` | Roll up changes for one release | Q1, Q3 |
| `idx_release_changes_change_type` | Filter changes by type | Q1, Q3 |
| `idx_release_changes_task_id` | Reverse: find releases that shipped a task | Q2 |
| `idx_releases_previous_release_id` | Walk release chain | Q3 |
| `idx_task_commits_task_primary` | Get canonical commit for a task | Q2 |
| `idx_release_commits_commit_sha` | Reverse: find release that contains a commit | Q5 |
| `idx_commits_author_email` | Author roll-up | Q6 |
| `idx_pr_tasks_task_id` | Find PRs for a task | Q2, Q7 |

---

## 4. Migration Strategy — Zero-Downtime

### 4.1 Migration Files (Drizzle Format)

These ship as discrete migrations under `packages/core/migrations/drizzle-tasks/`:

```
20260516000000_t9345-commits-table/
  ├── migration.sql           -- DDL for commits + indexes
  └── meta.json
20260516000010_t9345-task-commits-junction/
  ├── migration.sql           -- DDL for task_commits + indexes
  └── meta.json
20260516000020_t9345-commit-files/
  ├── migration.sql           -- DDL for commit_files + indexes
  └── meta.json
20260516000030_t9345-pull-requests/
  ├── migration.sql           -- DDL for pull_requests + pr_commits + pr_tasks
  └── meta.json
20260516000040_t9345-releases-normalized/
  ├── migration.sql           -- DDL for releases + release_commits + release_artifacts
  └── meta.json
20260516000050_t9345-release-changes/
  ├── migration.sql           -- DDL for release_changes
  └── meta.json
20260516000060_t9345-task-relations-extend/
  ├── migration.sql           -- ALTER for new enum values + timestamp + commit_sha
  └── meta.json
20260516000070_t9345-brain-release-links/
  ├── migration.sql           -- DDL for brain_release_links (see §8)
  └── meta.json
20260516000080_t9345-releases-view/
  ├── migration.sql           -- CREATE VIEW releases_view (see §9)
  └── meta.json
```

Each migration file is **pure DDL**. No `INSERT INTO ... SELECT FROM ...` backfill in
the migration itself — backfill is a separate idempotent CLI command (see §4.4).

### 4.2 Backward Compat Window

| Phase | Duration | What happens |
|-------|----------|--------------|
| **Phase 0 — Schema in place** | 1 release | Migrations applied. New tables empty. Legacy `release_manifests.tasksJson` and `commitSha` still authoritative. |
| **Phase 1 — Dual-write** | 2 releases (~14 days) | `releaseShip()` writes BOTH old + new. CLI commands prefer new tables, fall back to legacy. Read parity tests in CI. |
| **Phase 2 — Backfill historical** | 1 release | One-shot `cleo provenance backfill --since v2025.1.1` walks git log + extracts task IDs + populates `commits`, `task_commits`, `release_commits`, `release_changes`. Idempotent (UPSERT). |
| **Phase 3 — Read-from-new** | 1 release | CLI commands read EXCLUSIVELY from new tables. Legacy columns remain but unread. |
| **Phase 4 — Deprecate legacy** | indefinite | Legacy `tasksJson` and `commitSha` documented as `@deprecated`. Stop writing. Keep readable for emergency rollback. |
| **Phase 5 — Drop (optional)** | 6+ months | Once external dashboards have migrated, drop the legacy columns via final migration. |

### 4.3 Idempotency Guarantees

- **`commits` PK is `sha`**: re-ingesting the same commit is a no-op (UPSERT pattern, `ON CONFLICT(sha) DO UPDATE SET ...`).
- **`task_commits` PK is `(task_id, commit_sha)`**: re-linking the same task+commit is a no-op.
- **`release_changes` UUID PK**: backfill must check `(release_id, task_id, change_type)` triple before insert to avoid duplicates. Add a `UNIQUE` index:

```sql
CREATE UNIQUE INDEX uq_release_changes_release_task_type
  ON release_changes(release_id, COALESCE(task_id, ''), change_type);
```

The `COALESCE` handles changes that have no task (orphan commits classified as `chore`).

### 4.4 Backfill Algorithm (sketch — no impl code)

```
function backfillProvenance(opts: { since: string, project_hash: string }):
  releases = listReleases(since=opts.since)            // existing release_manifests rows
  for each rel in releases (oldest-first):
    prev = previousRelease(rel)                        // walk release_manifests by version
    commits = gitLog(`${prev.tag}..${rel.tag}`)        // shell out
    upsertCommits(commits)                             // populates `commits` + `commit_files`
    upsertReleaseCommits(rel.id, commits)              // populates `release_commits`
    for each commit in commits:
      task_ids = extractTaskIds(commit.message)        // T\d+ regex + Co-authored-by trailers
      upsertTaskCommits(commit.sha, task_ids, src='commit-message')
    prs = ghApiPrsForBranch(`release/${rel.version}`)  // gh api
    upsertPullRequests(prs)
    upsertPrCommits(prs)
    upsertPrTasks(prs)                                 // extracts T### from PR title/body
    classifyChanges(rel, prev)                         // builds release_changes rows
  upsertReleaseArtifacts(rel)                          // reads release_manifests.npmDistTag etc.
```

Idempotent: every step is UPSERT (`ON CONFLICT DO UPDATE` or no-op). Re-running over the same range is safe.

### 4.5 Rollback Plan

If the new schema breaks production:

```bash
# 1. Stop writes to new tables
CLEO_PROVENANCE_DUAL_WRITE=0 cleo release ship ...

# 2. CLI commands auto-fall-back to legacy `tasksJson` / `commitSha` reads (a code-path flag)

# 3. Drop new tables (if absolutely needed; data loss):
sqlite3 .cleo/tasks.db < migrations/rollback/t9345-rollback.sql
```

The dual-write flag (`CLEO_PROVENANCE_DUAL_WRITE`) is the kill switch. Default `1` (enabled). Set to `0` to fall back to legacy-only mode while keeping schema in place.

---

## 5. Canonical Queries — The Graph as a Service

Each query below is the **owner-facing question**, the **SQL skeleton**, the
**expected output shape**, and **estimated complexity** for the assumed scale
(1k tasks / 10k commits / 100 releases / 22 packages).

### Q1: "What bugs shipped in v2026.5.74?"

```sql
SELECT
  rc.id            AS change_id,
  rc.task_id,
  t.title          AS task_title,
  rc.change_type,
  rc.summary,
  rc.is_breaking,
  rc.severity,
  rc.primary_commit_sha
FROM releases r
JOIN release_changes rc ON rc.release_id = r.id
LEFT JOIN tasks t ON t.id = rc.task_id
WHERE r.version = 'v2026.5.74'
  AND rc.change_type IN ('bug', 'hotfix')
ORDER BY rc.severity ASC NULLS LAST, rc.position ASC;
```

**Output shape** (TypeScript):
```typescript
type Q1Row = {
  change_id: string;
  task_id: string | null;
  task_title: string | null;
  change_type: 'bug' | 'hotfix';
  summary: string;
  is_breaking: 0 | 1;
  severity: 'P0'|'P1'|'P2'|'P3'|null;
  primary_commit_sha: string | null;
};
```

**Complexity**: O(log N) on `idx_releases_version` + O(K) where K = changes in that release (typically <50). At 1k tasks scale: <5ms.

### Q2: "Full provenance of T9344 (Anthropic OAuth hotfix)"

```sql
WITH
  task_meta AS (
    SELECT id, title, kind, severity, status, parent_id, created_at, completed_at
    FROM tasks WHERE id = 'T9344'
  ),
  task_releases AS (
    SELECT
      rc.id AS change_id,
      rc.change_type,
      r.id AS release_id,
      r.version,
      r.shipped_at
    FROM release_changes rc
    JOIN releases r ON r.id = rc.release_id
    WHERE rc.task_id = 'T9344'
    ORDER BY r.shipped_at ASC
  ),
  task_commits_resolved AS (
    SELECT
      tc.commit_sha, tc.is_primary, tc.link_source,
      c.short_sha, c.subject, c.author_name, c.authored_at, c.conventional_type
    FROM task_commits tc
    JOIN commits c ON c.sha = tc.commit_sha
    WHERE tc.task_id = 'T9344'
    ORDER BY c.authored_at ASC
  ),
  task_prs AS (
    SELECT pr.id, pr.number, pr.title, pr.state, pr.merged_at, pr.author_login
    FROM pr_tasks pt
    JOIN pull_requests pr ON pr.id = pt.pr_id
    WHERE pt.task_id = 'T9344'
  ),
  task_supersedes AS (
    SELECT related_to AS task_id, relation_type
    FROM task_relations
    WHERE task_id = 'T9344'
      AND relation_type IN ('fixes','regresses','supersedes','reverts','hotfixes','follows-up')
  )
SELECT 'meta' AS section, json_object(...) FROM task_meta UNION ALL
SELECT 'releases', json_group_array(...) FROM task_releases UNION ALL
SELECT 'commits', json_group_array(...) FROM task_commits_resolved UNION ALL
SELECT 'prs', json_group_array(...) FROM task_prs UNION ALL
SELECT 'evolution', json_group_array(...) FROM task_supersedes;
```

**TypeScript helper signature**:

```typescript
async function getProvenanceForTask(taskId: string): Promise<TaskProvenance> { ... }

type TaskProvenance = {
  task: TaskRow;
  releases: { releaseId: string; version: string; shippedAt: string; changeType: ChangeType }[];
  commits: { sha: string; shortSha: string; subject: string; author: string; isPrimary: boolean; linkSource: string }[];
  prs: { id: string; number: number; title: string; mergedAt: string | null }[];
  evolution: { relatedTaskId: string; relationType: TaskRelationType }[];
};
```

**Complexity**: 5 indexed lookups + 1 union. <10ms at scale. The CTE is for clarity; production query would be 5 separate prepared statements.

### Q3: "What hotfixes followed v2026.5.73?"

```sql
WITH base AS (
  SELECT id, version, shipped_at FROM releases WHERE version = 'v2026.5.73'
)
SELECT
  r.version, r.shipped_at, r.release_kind,
  rc.task_id, rc.summary, rc.severity
FROM releases r
JOIN release_changes rc ON rc.release_id = r.id
WHERE
  r.shipped_at > (SELECT shipped_at FROM base)
  AND (r.release_kind = 'hotfix' OR rc.change_type = 'hotfix')
ORDER BY r.shipped_at ASC, rc.position ASC;
```

**Complexity**: filter on `idx_releases_shipped_at` then join. O(M log N) where M = hotfix changes since base. <20ms.

### Q4: "Show the evolution graph of the 'Anthropic OAuth' feature"

```sql
WITH RECURSIVE feature_root AS (
  -- Find feature task by label or title
  SELECT id, title, kind FROM tasks
  WHERE (labels_json LIKE '%"feature:anthropic-oauth"%' OR title LIKE '%Anthropic OAuth%')
    AND kind IN ('feature','work')
  LIMIT 1
),
descendants AS (
  -- Walk parentId hierarchy down
  SELECT id, parent_id, title, kind, severity FROM tasks WHERE parent_id IN (SELECT id FROM feature_root)
  UNION ALL
  SELECT t.id, t.parent_id, t.title, t.kind, t.severity FROM tasks t
  JOIN descendants d ON t.parent_id = d.id
),
related AS (
  -- Walk task_relations for fixes/regresses/hotfixes/follows-up
  SELECT tr.task_id, tr.related_to, tr.relation_type
  FROM task_relations tr
  WHERE tr.related_to IN (SELECT id FROM feature_root UNION SELECT id FROM descendants)
     OR tr.task_id IN (SELECT id FROM feature_root UNION SELECT id FROM descendants)
)
SELECT * FROM feature_root
UNION ALL SELECT id, NULL, title, kind, severity FROM descendants
UNION ALL SELECT 'rel:'||task_id||'->'||related_to AS id, related_to AS parent_id, relation_type AS title, NULL, NULL FROM related;
```

**Complexity**: recursive CTE bounded by hierarchy depth (~5 levels). At 1k tasks: <50ms.

### Q5: "What commits in v2026.5.74 are not linked to any task?" (orphan detection)

```sql
SELECT c.sha, c.short_sha, c.subject, c.author_email
FROM release_commits rc
JOIN commits c ON c.sha = rc.commit_sha
JOIN releases r ON r.id = rc.release_id
WHERE r.version = 'v2026.5.74'
  AND c.is_release_commit = 0       -- exclude the "chore(release):" commit itself
  AND NOT EXISTS (
    SELECT 1 FROM task_commits tc WHERE tc.commit_sha = c.sha
  );
```

**Complexity**: O(K) where K = commits in release. <5ms at any scale. This is an **auditability query** — owner can spot drift where work landed without task linkage.

### Q6: "Which authors contributed to v2026.5.74?"

```sql
SELECT
  c.author_email,
  c.author_name,
  COUNT(*) AS commit_count,
  COUNT(DISTINCT tc.task_id) AS distinct_tasks_touched
FROM release_commits rc
JOIN commits c ON c.sha = rc.commit_sha
LEFT JOIN task_commits tc ON tc.commit_sha = c.sha
JOIN releases r ON r.id = rc.release_id
WHERE r.version = 'v2026.5.74'
  AND c.author_email IS NOT NULL
GROUP BY c.author_email, c.author_name
ORDER BY commit_count DESC;
```

**Complexity**: filter + group. <10ms.

### Q7: "IVTR audit trail for T9344 across its lifetime"

Joins `task_work_history` (existing) + `lifecycle_transitions` + `audit_log` + new `release_changes`:

```sql
SELECT 'work' AS event, twh.set_at AS at, twh.session_id, NULL AS commit_sha
FROM task_work_history twh WHERE twh.task_id = 'T9344'
UNION ALL
SELECT 'lifecycle', lt.created_at, lt.transitioned_by, NULL
FROM lifecycle_transitions lt
JOIN lifecycle_pipelines lp ON lp.id = lt.pipeline_id
WHERE lp.task_id = 'T9344'
UNION ALL
SELECT 'audit-'||al.action, al.timestamp, al.actor, NULL
FROM audit_log al WHERE al.task_id = 'T9344'
UNION ALL
SELECT 'commit', c.authored_at, c.author_email, c.sha
FROM task_commits tc JOIN commits c ON c.sha = tc.commit_sha
WHERE tc.task_id = 'T9344'
UNION ALL
SELECT 'release-'||rc.change_type, r.shipped_at, r.created_by, r.release_commit_sha
FROM release_changes rc JOIN releases r ON r.id = rc.release_id
WHERE rc.task_id = 'T9344'
ORDER BY at ASC;
```

**Complexity**: 5 indexed lookups + sort. <20ms.

### Q8: "Find the task that introduced the bug T9344 fixes" (regression provenance)

```sql
SELECT
  introducer.id AS introducer_task_id,
  introducer.title,
  introducer_commit.short_sha AS introducer_commit,
  introducer_commit.authored_at,
  introducer_change.release_id AS introducer_release
FROM task_relations tr
JOIN tasks introducer ON introducer.id = tr.related_to
LEFT JOIN task_commits introducer_tc ON introducer_tc.task_id = introducer.id AND introducer_tc.is_primary = 1
LEFT JOIN commits introducer_commit ON introducer_commit.sha = introducer_tc.commit_sha
LEFT JOIN release_changes introducer_change ON introducer_change.task_id = introducer.id
WHERE tr.task_id = 'T9344'
  AND tr.relation_type = 'regresses';
```

**Complexity**: <5ms with `idx_task_relations_related_to` + composite index.

### Query Performance Summary

| Query | Indexes used | Rows scanned (worst case at scale) | Latency target |
|-------|--------------|-----------------------------------|----------------|
| Q1 bugs in release | `idx_releases_version`, `idx_release_changes_release_id`, `idx_release_changes_change_type` | ~50 | <5ms |
| Q2 task provenance | 5 indexed lookups | ~30 | <10ms |
| Q3 hotfixes after release | `idx_releases_shipped_at`, `idx_release_changes_change_type` | ~20 | <20ms |
| Q4 feature evolution | hierarchy walk + relations | ~100 | <50ms |
| Q5 orphan commits | `idx_release_commits_position`, EXISTS | ~500 | <5ms |
| Q6 authors | filter + group | ~500 | <10ms |
| Q7 audit trail | 5 unioned indexed reads | ~50 | <20ms |
| Q8 regression introducer | `idx_task_relations_related_to` | ~10 | <5ms |

---

## 6. CLI Surface — Provenance as Product

Two new top-level groupings: extend `cleo release` and introduce `cleo provenance`.

### 6.1 `cleo release` extensions

| Command | Params | Output | SQL/Behavior |
|---------|--------|--------|--------------|
| `cleo release graph <version> [--format mermaid|dot|json]` | `version: string`; `format` defaults to `mermaid` | Mermaid/DOT graph of tasks↔commits↔PRs for that release | Joins releases × release_changes × pr_tasks × task_commits; renders graph format |
| `cleo release diff <v1> <v2> [--by change_type|severity|author]` | two version strings; group-by selector | Tabular diff: tasks added/removed, regressions detected, breaking changes flagged | Set-subtract on release_changes; flags `is_breaking`, `change_type='regresses'` |
| `cleo release impact <version> [--window 30d]` | version; lookback window for follow-up bugs/hotfixes | Severity-tagged report: P0/P1 bugs filed against this release, MTTR computed | Joins release_changes (origin) × task_relations (regresses) × releases (where the regression shipped) |
| `cleo release authors <version> [--top N]` | version; top-N filter | Author roll-up with commit + task counts | Q6 |
| `cleo release orphans <version>` | version | Commits in release not linked to any task | Q5 — auditable orphan-commit list |

### 6.2 `cleo provenance` namespace (NEW)

| Command | Params | Output | SQL |
|---------|--------|--------|-----|
| `cleo provenance task <id>` | `id: string` | Full lineage — origin → bugs → hotfixes → releases | Q2 |
| `cleo provenance commit <sha>` | `sha: string` (full or short) | What task does this commit serve? Which PR contained it? Which release shipped it? | `commits × task_commits × pr_commits × release_commits` indexed join |
| `cleo provenance pr <id\|#number>` | PR ID or `owner/repo#N` | All tasks linked to this PR + which release it shipped in | `pull_requests × pr_tasks × pr_commits × release_commits` |
| `cleo provenance feature <slug>` | feature label or slug | All tasks/PRs/releases under a feature label | Q4 |
| `cleo provenance release <version>` | version | Equivalent to `cleo release show` but rendered as graph (tasks/commits/PRs/authors) | joins releases × everything |
| `cleo provenance change <change_id>` | UUID | Single change_row drill-down: task, commit, PR, release, BRAIN decision link | release_changes × everything |
| `cleo provenance backfill --since <version> [--dry-run]` | starting version; dry-run flag | Idempotent backfill of historical commits, PRs, changes (see §4.4) | The backfill algorithm |
| `cleo provenance link <task-id> --commit <sha> [--source manual]` | task + commit + source | Manually attach a task↔commit edge | INSERT INTO task_commits |
| `cleo provenance verify <version>` | version | Run integrity checks: no orphan release_changes, no dangling task FKs, no missing primary commits | DDL-level invariant checks |

### 6.3 Schema-Stable Output Contracts

Every new command returns LAFS envelope (`{success, data?, error?, meta}` per ADR-039 and `packages/lafs/`). `data` payload schemas:

```typescript
// cleo release graph <version> → data.graph
type ReleaseGraph = {
  release: { id: string; version: string; shippedAt: string; releaseKind: ReleaseKind };
  nodes: Array<
    | { type: 'task'; id: string; title: string; kind: TaskKind; severity: TaskSeverity | null }
    | { type: 'commit'; sha: string; shortSha: string; subject: string; author: string }
    | { type: 'pr'; id: string; number: number; title: string }
    | { type: 'change'; id: string; changeType: ChangeType; isBreaking: boolean }
  >;
  edges: Array<{
    from: string; to: string;
    kind: 'task→commit' | 'task→change' | 'change→pr' | 'pr→commit' | 'release→change' | 'task→task' | 'commit→commit';
    via?: string; // e.g. "fixes", "regresses"
  }>;
};

// cleo release diff <v1> <v2> → data.diff
type ReleaseDiff = {
  v1: string;
  v2: string;
  added: { tasks: string[]; changes: string[]; commits: string[] };
  removed: { tasks: string[]; changes: string[] };
  regressions: Array<{ taskId: string; introducedIn: string; fixedIn: string | null }>;
  breakingChanges: Array<{ changeId: string; summary: string }>;
};

// cleo provenance task <id> → data
type TaskProvenanceEnvelope = TaskProvenance; // defined in Q2

// cleo provenance feature <slug> → data
type FeatureProvenance = {
  feature: { slug: string; rootTaskId: string; rootTitle: string };
  tasks: Array<{ id: string; title: string; kind: TaskKind; status: TaskStatus; severity: TaskSeverity | null; parentId: string | null }>;
  releases: Array<{ id: string; version: string; shippedAt: string; changeCount: number }>;
  bugs: Array<{ taskId: string; title: string; severity: TaskSeverity; releaseId: string | null }>;
  hotfixes: Array<{ taskId: string; title: string; releaseId: string }>;
  timeline: Array<{ at: string; event: string; taskId?: string; releaseId?: string }>;
};
```

### 6.4 Total New CLI Count

**11 new commands** (5 under `cleo release`, 6 under `cleo provenance`) + 3 ancillary (`backfill`, `link`, `verify`). Net 14 new entry points — all read-mostly except `link` and `backfill`. Two existing commands (`cleo release changelog`, `cleo release show`) get richer output by leveraging the new schema, but signatures stay backward compatible.

---

## 7. Multi-Archetype Portability

The owner requires this to work for ≥3 project archetypes. Audit doc identifies the
current pipeline assumes Node/pnpm (coupling score 8/10 per audit §5).

### 7.1 Archetype Coverage Matrix

| Archetype | Tables populated identically | Tables that differ | `release_artifacts` rows |
|-----------|------------------------------|---------------------|--------------------------|
| **Monorepo (cleocode itself — 22 npm packages)** | commits, task_commits, pull_requests, pr_commits, pr_tasks, releases, release_commits, release_changes, task_relations | release_artifacts uses `npm` × 22 rows | `[{type:'npm',id:'@cleocode/cleo',ver:'2026.5.74'}, {type:'npm',id:'@cleocode/core',ver:'2026.5.74'}, ... × 22]` |
| **Single npm lib** | same set | release_artifacts: `npm` × 1 row | `[{type:'npm',id:'my-lib',ver:'1.2.3',metadata:{distTag:'latest'}}]` |
| **Single Rust crate** | same set | release_artifacts: `cargo` × 1 row | `[{type:'cargo',id:'my-crate',ver:'0.5.0',url:'https://crates.io/crates/my-crate/0.5.0'}]` |
| **Mixed (Rust + npm; like cleocode's `packages/cant`)** | same | release_artifacts: mixed types | `[{type:'npm',id:'@cleocode/cant',ver:'2026.5.74'}, {type:'cargo',id:'cant-core',ver:'0.5.0'}]` |
| **Docker-only image** | same | release_artifacts: `docker` × 1 row | `[{type:'docker',id:'myorg/myimage',ver:'v1.2.3',url:'docker.io/myorg/myimage:v1.2.3',digest:'sha256:...'}]` |
| **Python pip package** | same | release_artifacts: `pypi` × 1 row | `[{type:'pypi',id:'my-pkg',ver:'1.2.3'}]` |
| **Binary tarball release** | same | release_artifacts: `binary` × N rows (per OS/arch) | `[{type:'binary',id:'cli-linux-amd64',ver:'1.2.3',url:'...',digest:'sha256:...'}, ...]` |

### 7.2 Schema Stays Portable

**No per-language columns**. The polymorphism lives in `release_artifacts.artifact_type` enum + `metadata_json` for type-specific extras. Hermes pattern (hermes-agent-real-research.md:174 — dual CalVer + SemVer) is captured by:

```json
{
  "calver": "2026.5.74",
  "semver": "0.13.0",
  "distTag": "latest",
  "provenance": true,
  "slsaLevel": 3
}
```

Stored in `release_artifacts.metadata_json` — no new columns required.

### 7.3 Legacy `release_manifests.npmDistTag` Deprecation

The hardcoded `npmDistTag` column (tasks-schema.ts:729) is npm-specific. Migration:

```
Phase 1: Continue writing `npmDistTag` on `release_manifests`; ALSO write a `release_artifacts` row.
Phase 3: CLI reads from `release_artifacts.metadata_json.distTag`.
Phase 5: Drop `npmDistTag` column.
```

### 7.4 Worked Example — Monorepo Release

For `cleocode` v2026.5.74:

```sql
-- 1 row in releases
INSERT INTO releases VALUES ('rel_v2026.5.74', 'v2026.5.74', 'latest', 'shipped', 'regular', ...);

-- 22 rows in release_artifacts (one per @cleocode/* package)
INSERT INTO release_artifacts VALUES
  ('rel_v2026.5.74', 'npm', '@cleocode/cleo',      '2026.5.74', 'https://npmjs.com/...', 'sha256:...', NULL, '2026-05-14T...', '{"distTag":"latest"}'),
  ('rel_v2026.5.74', 'npm', '@cleocode/core',      '2026.5.74', 'https://...',           'sha256:...', NULL, '2026-05-14T...', '{}'),
  -- ... 20 more
  ('rel_v2026.5.74', 'cargo', 'signaldock-sdk',    '0.5.0',     'https://crates.io/...',  'sha256:...', NULL, '2026-05-14T...', '{}');

-- N rows in release_commits (every commit in v2026.5.73..v2026.5.74)
INSERT INTO release_commits VALUES
  ('rel_v2026.5.74', 'ea2bcaa77...', 1, 1, 0, 0),   -- T9344 hotfix commit
  ('rel_v2026.5.74', '65cba7520...', 2, 0, 1, 1),   -- "release: ship v2026.5.74" commit
  -- ... etc.

-- 1+ rows in release_changes
INSERT INTO release_changes VALUES
  (uuid(), 'rel_v2026.5.74', 'T9344', 'pr_kryptobaseddev/cleocode#163', 'ea2bcaa77...',
   'hotfix', 'fix', 'anthropic-oauth', 0, 0, 'P0',
   'Anthropic OAuth — drop false placeholder framing + fix redirectUri',
   '...', '...', 0, '...');
```

Note: `release_artifacts` carries 22 npm rows + 1 cargo row from a SINGLE release row. No table proliferation.

---

## 8. BRAIN Integration

BRAIN tables (memory-schema.ts:155 `brainDecisions`, etc.) live in the project-level
`.cleo/brain.db`. Today, `brain_decisions` has `contextEpicId` and `contextTaskId` as
**soft text columns** (no REFERENCES) but no release linkage.

### 8.1 New Junction: `brain_release_links`

Lives in `tasks.db` (or `brain.db` if cross-DB views are acceptable; recommend
tasks.db with logical reference to brain_decisions.id via soft FK for cross-DB
neutrality):

```sql
CREATE TABLE brain_release_links (
  id           TEXT PRIMARY KEY,                -- UUID
  brain_entry_id   TEXT NOT NULL,                -- soft FK to brain_decisions.id / brain_observations.id
  brain_entry_kind TEXT NOT NULL,                -- 'decision'|'observation'|'pattern'|'learning'
  release_id   TEXT REFERENCES releases(id) ON DELETE CASCADE,
  change_id    TEXT REFERENCES release_changes(id) ON DELETE CASCADE,
  link_type    TEXT NOT NULL,                    -- 'approved-by'|'documented-in'|'derived-from'|'observed-in'
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  created_by   TEXT,
  CHECK (release_id IS NOT NULL OR change_id IS NOT NULL)
);

CREATE INDEX idx_brain_release_links_brain_entry ON brain_release_links(brain_entry_id, brain_entry_kind);
CREATE INDEX idx_brain_release_links_release_id ON brain_release_links(release_id);
CREATE INDEX idx_brain_release_links_change_id ON brain_release_links(change_id);
```

**Edge captured**: BRAIN entry ↔ release. Closes the loop on:
- "Which decision approved the fix shipped in v2026.5.74?" (link_type='approved-by')
- "Which release first documented this pattern?" (link_type='documented-in')
- "Which release's failure produced this learning?" (link_type='derived-from')

### 8.2 Cross-DB Reference Strategy

Soft FK (TEXT, no REFERENCES) because `brain_decisions` lives in a separate
SQLite file. The cross-DB safety is handled at the access-layer (BrainAccessor
+ DataAccessor coordinate via the existing pattern in
`packages/core/src/store/brain-accessor-impl.ts`).

Alternatively, when `cleo nexus impact` queries are run via the global nexus
infra (which already federates project DBs per CLEO-INJECTION.md §Nexus), the
nexus layer joins these tables transparently.

### 8.3 Nexus Integration

`cleo nexus impact <symbol>` (CLAUDE.md "Always Do") gets richer with this graph:

```
gitnexus_impact({target: "releaseShip", direction: "upstream"})
  → returns direct callers
  + new: returns "this symbol last shipped in v2026.5.74"
  + new: returns "5 historical bugs filed against this symbol" (Q1 + commit_files JOIN)
  + new: returns "P0 hotfix T9344 modified this file's siblings" (commit_files × release_changes)
```

The schema delivers the data; the nexus query layer composes the joins.

### 8.4 Observation Auto-Capture

When `cleo release ship` succeeds, automatically emit a `brain_observation` with
`brain_release_links.link_type='observed-in'`:

```
cleo memory observe "Shipped v2026.5.74 with 1 hotfix (T9344) and 0 regressions detected" \
  --title "Release v2026.5.74 shipped" \
  --link-release v2026.5.74
```

Closes the owner's "memory" requirement at the release boundary.

---

## 9. `releases_view` — Materialized Mental Model

A single SQL view that joins all release-graph tables into one row per release,
returning aggregated arrays via SQLite's `json_group_array`. Designed for
read-heavy external consumers (Studio dashboard, docs site, agents needing
release context).

```sql
CREATE VIEW releases_view AS
SELECT
  r.id                                AS release_id,
  r.version,
  r.channel,
  r.status,
  r.release_kind,
  r.previous_version,
  r.tag_name,
  r.shipped_at,
  r.created_by,
  -- Tasks shipped (via release_changes)
  (
    SELECT json_group_array(json_object(
      'taskId', rc.task_id,
      'title',  t.title,
      'kind',   t.kind,
      'changeType', rc.change_type,
      'severity', rc.severity,
      'isBreaking', rc.is_breaking
    ))
    FROM release_changes rc
    LEFT JOIN tasks t ON t.id = rc.task_id
    WHERE rc.release_id = r.id
  ) AS tasks_json,
  -- Commits in release
  (
    SELECT json_group_array(json_object(
      'sha', c.short_sha,
      'subject', c.subject,
      'author', c.author_email,
      'ccType', c.conventional_type
    ))
    FROM release_commits rc2
    JOIN commits c ON c.sha = rc2.commit_sha
    WHERE rc2.release_id = r.id
    ORDER BY rc2.position ASC
  ) AS commits_json,
  -- PRs merged into release
  (
    SELECT json_group_array(DISTINCT json_object(
      'prId', pr.id,
      'number', pr.number,
      'title', pr.title,
      'author', pr.author_login
    ))
    FROM release_commits rc3
    JOIN pr_commits pc ON pc.commit_sha = rc3.commit_sha
    JOIN pull_requests pr ON pr.id = pc.pr_id
    WHERE rc3.release_id = r.id
  ) AS prs_json,
  -- Unique authors
  (
    SELECT json_group_array(DISTINCT json_object(
      'email', c.author_email,
      'name', c.author_name
    ))
    FROM release_commits rc4
    JOIN commits c ON c.sha = rc4.commit_sha
    WHERE rc4.release_id = r.id AND c.author_email IS NOT NULL
  ) AS authors_json,
  -- Artifacts published
  (
    SELECT json_group_array(json_object(
      'type', ra.artifact_type,
      'id', ra.identifier,
      'version', ra.version,
      'url', ra.url,
      'digest', ra.digest
    ))
    FROM release_artifacts ra
    WHERE ra.release_id = r.id
  ) AS artifacts_json,
  -- Aggregate counts
  (SELECT COUNT(*) FROM release_changes rc5 WHERE rc5.release_id = r.id) AS change_count,
  (SELECT COUNT(*) FROM release_changes rc6 WHERE rc6.release_id = r.id AND rc6.change_type = 'feature') AS feature_count,
  (SELECT COUNT(*) FROM release_changes rc7 WHERE rc7.release_id = r.id AND rc7.change_type = 'bug') AS bug_count,
  (SELECT COUNT(*) FROM release_changes rc8 WHERE rc8.release_id = r.id AND rc8.change_type = 'hotfix') AS hotfix_count,
  (SELECT COUNT(*) FROM release_changes rc9 WHERE rc9.release_id = r.id AND rc9.is_breaking = 1) AS breaking_count
FROM releases r;
```

**Query example**:

```sql
SELECT version, change_count, feature_count, bug_count, hotfix_count, json_extract(tasks_json, '$[0].taskId')
FROM releases_view
WHERE shipped_at > '2026-05-01'
ORDER BY shipped_at DESC;
```

**Why a view, not a materialized table**: SQLite doesn't have materialized views. The view is computed on read. For 100 releases, this is ~500ms cold; acceptable for dashboard use. If perf becomes an issue, the same shape can be materialized into a `releases_snapshot` table refreshed nightly.

---

## 10. Anti-Patterns — Rejected with Rationale

| Anti-pattern | Considered? | Why rejected |
|--------------|-------------|--------------|
| **Continue using `release_manifests.tasksJson` as primary source of truth** | Yes | Audit doc Phase 4 §Q4 explicitly flags this as the gap. JSON arrays can't be SQL-joined, can't be indexed for membership queries, and require full table scans. Replaced by `release_changes` junction. |
| **Per-language tables (e.g., `npm_releases`, `cargo_releases`, `docker_releases`)** | Yes | Would force schema changes every time a new artifact type is added. Rejected in favor of `release_artifacts` polymorphism + `metadata_json` for type-specific extras. Matches existing pattern (e.g. `pipeline_manifest.metadataJson`). |
| **Store CHANGELOG markdown as the source of truth** | Yes | CHANGELOG is a *render*, not a fact. If we store the markdown and lose the structured data, we cannot re-render in a different format (Mermaid, JSON, RSS). `release_changes` rows are the fact; CHANGELOG.md is generated FROM them. Hermes pattern reinforces this (hermes-agent-real-research.md:393 — `RELEASE_v0.13.0.md` is committed, but it's generated from `git log`). |
| **Tightly couple tasks to commits via FK on `tasks.commit_sha`** | Yes | A task has many commits over its lifecycle (initial impl + fix-up + merge). 1:1 FK forces lossy selection of "the" commit. M:N via `task_commits` with `is_primary` flag is correct. |
| **Store author identities in a separate `authors` table** | Yes | Author email is the de-facto identity in git. A `authors` table would add a normalization step with marginal benefit. The `commits.author_email` column with an index is sufficient. If author de-duplication is needed (one person, multiple emails), an opt-in `author_aliases` mapping table can be added later. |
| **Bake `release_kind='hotfix'` into a CHECK constraint that auto-derives from severity/timing** | Yes | Constraint logic at the DB level is brittle. The derivation (P0/P1 task + <72h window + hotfix/* branch) lives in application code at write time. The column is denormalized for query speed but the source of truth is the heuristic. Owner can override via explicit `--release-kind hotfix` flag. |
| **Use the existing `lifecycle_evidence` table to store commit SHAs** | Yes | `lifecycle_evidence.type` is constrained to `file|url|manifest` (tasks-schema.ts:164). Adding `commit` to that enum is feasible but mixes evidence (stage-bound) with provenance (release-bound). Separation of concerns: lifecycle_evidence stays task-stage-scoped; commits get their own first-class table. |
| **Cross-DB FK from `brain_decisions` to `releases`** | Yes | SQLite has no cross-database FK enforcement (each DB is its own connection). Using soft FK (TEXT column) + access-layer coordination is the existing CLEO pattern (see `brain-accessor-impl.ts`). |
| **Replace `release_manifests` entirely with `releases` in one migration** | Yes | Breaks all existing read paths in `engine-ops.ts:1359` etc. Zero-downtime requires the dual-write window of §4.2. The old table fades over 5 release cycles. |
| **Use SQLite's `generated columns` for derived fields like `is_release_commit`** | Yes | SQLite generated columns can't be indexed in older SQLite versions (<3.31), and our node:sqlite minimum is bundled with whatever Node ships. Concrete column + index is portable. |
| **Hardcode the 12 `CHANGE_TYPES` values in a CHECK constraint** | Considered, deferred | Soft enforcement at the application layer first (Zod schema in contracts), CHECK constraint added in a follow-up migration after stabilization. Avoids migration churn during initial rollout. |
| **Auto-detect "regresses" relations from commit reverts** | Yes | Possible but lossy — many regressions don't surface as git reverts (they're forward-fixes in new commits). Use explicit `task_relations.relation_type='regresses'` written by the agent that triages the bug. |
| **Store full PR HTML body in `pull_requests.body`** | Yes | Bodies can be huge (10s of KB) and GitHub-rendered Markdown is best fetched live. Store the raw markdown only; render at query time. |

---

## 11. Invariants & Constraints — Future Proofing

Beyond the 12 invariants in audit-cleo-release-subcommands.md §6, the new graph adds:

1. **Release commit must exist in `commits` table** — `releases.release_commit_sha` FK enforces this.
2. **Every `release_changes` row must reference either a task or a primary commit** — CHECK: `task_id IS NOT NULL OR primary_commit_sha IS NOT NULL` (ensures no totally orphan changes).
3. **Release tag SHA must match the commit it points at** — Validate on write: `commits.sha = releases.tag_sha`. Addresses audit Failure #6.
4. **PR merge_commit_sha must exist in `commits`** — FK enforces.
5. **No release can be `status='shipped'` without `shipped_at` populated** — CHECK constraint or trigger.
6. **`change_type='hotfix'` requires `release.release_kind` IN ('hotfix','regular')** — CHECK constraint OR application-level guard with audit log entry on violation.
7. **`task_relations.relation_type IN ('regresses','reverts','hotfixes')` requires a non-null `commit_sha`** — the relation must anchor to the offending commit.
8. **Backfill must be idempotent** — UPSERT on every insert; PK design supports this.
9. **No new write to `release_manifests.tasksJson` after Phase 3** — code path lints assert; CI gate.
10. **All new tables get `project_hash` column for multi-repo CLEO installs** — already done; matches `audit_log.project_hash` pattern (tasks-schema.ts:780).

---

## 12. Integration Points with Existing Subsystems

| Subsystem | Integration | Affected files (read-only inventory) |
|-----------|-------------|--------------------------------------|
| `cleo release ship` (engine-ops.ts:1105) | Add Step 13: "Record provenance graph" after tag push | engine-ops.ts |
| `cleo release changelog` (engine-ops.ts:886) | Read from `release_changes` (rich) instead of git log walk | engine-ops.ts |
| `releaseChangelogSince()` | Same | engine-ops.ts |
| `release-manifest.ts` (T5580) | Continue writing legacy `tasksJson`/`commitSha` during Phase 1 dual-write; CLI reads new tables | release-manifest.ts |
| `cleo nexus impact <symbol>` | New JOIN to `commit_files` enriches blast-radius | nexus impl |
| `cleo provenance backfill` (new) | Reads git log; writes to new tables | new file in core/src/release/provenance/ |
| `cleo orchestrate ivtr` | Stays decoupled (per ivtr-conflation-audit.md §6 Priority 1: decouple); no changes |
| BRAIN observation flow | After release, auto-emit observation with `brain_release_links` entry | memory-accessor.ts |
| `cleo memory find` | Optionally filters by release context (`--shipped-in v2026.5.74`) | memory-accessor.ts |
| Studio dashboard | Reads `releases_view` for the project timeline page | packages/studio/ |
| `forge-ts` docs generator | Can render provenance into `llms.txt` for AI context | packages/llmtxt-core/ |

---

## 13. Open Questions for Wave-3 Spec

These questions should be resolved in the spec-writer phase, not architecture:

1. **`commit_files.file_path` canonicalization**: should it be repo-relative-from-root or absolute? Recommendation: repo-relative, matches existing `tasks-schema.ts` conventions.
2. **Foreign repos**: when a CLEO project has multiple git repos (e.g. submodules), how is `project_hash` resolved? Defer to existing CLI's `project_hash` derivation logic (see `audit_log.project_hash`).
3. **`release_artifacts.digest` format**: standard sha256 prefix `sha256:` or raw hex? Recommendation: full `algo:hex` prefix to support sha512 and others.
4. **Hotfix detection time window**: 72h or 7d or configurable per project? Recommendation: configurable via `.cleo/release-config.json` key `release.hotfixWindowHours` (default 72).
5. **PR ingestion source**: poll `gh api` on every `release ship`, or async via GitHub webhooks? Initial impl: synchronous `gh api` calls during ship. Follow-up: webhook-driven ingestion for closed-but-unmerged PR data.
6. **Branch protection rules data**: currently not modeled. Consider `repo_protection_rules` table later, joined to PRs to record "this PR bypassed required reviews".
7. **Cross-project graph**: when global nexus-infra spans multiple CLEO projects, do `releases` from project A reference `tasks` in project B? Recommendation: NO. Each project's `tasks.db` is self-contained. Cross-project queries go through nexus federation, not direct FK.

---

## 14. Summary Table — What Each New Table Buys You

| Table | Closes which gap | Owner-visible payoff |
|-------|------------------|----------------------|
| `commits` | "No commits table" (audit §Phase 4 row 5) | "What did each author ship?" |
| `task_commits` | "task → commit MISSING" (audit §Phase 4 row 5) | "Show me the SHAs for T9344" |
| `commit_files` | (new capability — blast radius from data, not git shell-outs) | "Who last touched engine-ops.ts?" |
| `pull_requests` | "No PR linkage" (this design) | "Which PR shipped this hotfix?" |
| `pr_commits` / `pr_tasks` | (junction tables) | Cross-citation pattern from Letta (LET-XXXX (#PR)) |
| `releases` | Normalized release record (replaces `release_manifests` mixing draft/shipped) | "List shipped releases by month" |
| `release_commits` | "commit → release MISSING" (audit §Phase 4 row 6) | "What commits were in v2026.5.74?" |
| `release_changes` | "feature/bug/hotfix taxonomy" (owner ask, §2.2) | CHANGELOG generation, classification, search |
| `release_artifacts` | Multi-archetype portability (§7) | "Which npm packages did this release publish?" |
| `task_relations` extensions | Missing `regresses|follows-up|reverts|hotfixes` (§3.10) | Q8 regression provenance |
| `brain_release_links` | "BRAIN ↔ release missing" (§8) | "Which decisions shipped in v2026.5.74?" |
| `releases_view` | Materialized mental model (§9) | One-call payload for dashboards/agents |

---

## 15. Closeout — Why This Is the Right Shape

1. **Owner's mental model directly maps to SQL**. Every owner question in §5 is one well-indexed query, not a JSON walk or full-table scan.
2. **Zero-downtime migration**. Dual-write window + idempotent backfill + kill switch (`CLEO_PROVENANCE_DUAL_WRITE=0`) means no release is at risk during rollout.
3. **Hermes + Letta patterns absorbed**, not copied. Hermes's release-as-event seam (hermes-agent-real-research.md:268) maps to our `releases.status='shipped'` trigger; Letta's `T#### (#PR)` cross-citation (letta-harness-real-research.md:33) is captured natively in `pr_tasks.link_evidence` + `task_commits.link_source`.
4. **Decoupled from IVTR**. The provenance graph is a *fact layer* underneath both IVTR (which can deprecate per ivtr-conflation-audit.md Priority 4) and evidence gates (ADR-051 D1). Removing IVTR would not break the graph; the graph survives IVTR's retirement.
5. **Project-agnostic by design**. No node/pnpm assumptions in the schema. `release_artifacts` polymorphism covers npm/cargo/docker/pypi/binary/maven without column proliferation.
6. **Auditable orphans**. Q5 (orphan commits) is a first-class capability — owner can see drift where commits shipped without task linkage.
7. **BRAIN integration is the natural close**. The owner's "memory" requirement collapses into one new junction table (`brain_release_links`) and one auto-emit observation hook — no separate "release memory" subsystem needed.

---

**End of provenance-graph design — T9345 wave-2 architecture artifact**

Path written: `/mnt/projects/cleocode/.cleo/rcasd/T9345/research/provenance-graph-design.md`
