---
epic: T11072
stage: decomposition
task: T11072
related:
  - type: task
    id: T11072
  - type: research
    path: ../research/T11072-research.md
  - type: spec
    path: ../specification/T11072-specification.md
  - type: consensus
    path: ../consensus/T11072-consensus.md
  - type: adr
    path: ../architecture/T11072-architecture-decision.md
created: 2026-05-27
updated: 2026-05-27
---
# Decomposition (T11072)

## Summary

SG-ADR-CANON decomposes into 10 concrete child tasks organized in 3 waves.
The saga supersedes T1824 and establishes database-first ADR SSoT with
`docs/adr/` as generated artifact.

## Current State (Pre-Wave-0)

- **92 files** in `.cleo/adrs/` (deprecated T1824 canonical location)
- **12 files** in `docs/adr/` (standard location, still receiving new ADRs — includes ARCHIVED.md)
- **81 rows** in `architecture_decisions` table (T1824-5 backfill)
- **121 entries** in cleo docs blob store (shadow storage)
- **84 numbering collisions** across locations
- **11 duplicate-numbered clusters** within/across locations
- **5 missing sequence numbers** (040, 060, 069, 076, 077 — investigation needed)
- `.cleo/canon.yml` does not exist; ADR-076 gate not wired

## Wave Structure

```
Wave 0 — Assessment & Policy (BLOCKS ALL WAVES)
  T11082 — ADR Collision Matrix & Content-Hash Inventory
  T11084 — Resolve 5 Missing ADR Number Gaps
  T11085 — Write ADR-090: Canonical ADR Policy (supersedes T1824)

Wave 1 — Reconciliation & Schema (DEPENDS ON Wave 0)
  T11083 — Resolve 11 Duplicate-Numbered ADR Clusters
  T11086 — Extend architecture_decisions Schema for Provenance Tracking
  T11087 — Backfill & Normalize All ADRs into Database

Wave 2 — Migration & Enforcement (DEPENDS ON Wave 1)
  T11088 — Migrate .cleo/adrs/ Content to docs/adr/ Canonical Location
  T11089 — Wire cleo docs adr to DB-First SSoT (purge blob storage)
  T11090 — Implement ADR Lint Gate: cleo check canon adr
  T11091 — Deprecate .cleo/adrs/ with CI Gate Enforcement

Final Gate
  T11092 — End-to-End ADR Provenance Smoke Test
```

## Child Tasks

### Wave 0 — Assessment & Policy

#### T11082 — ADR Collision Matrix & Content-Hash Inventory
**Priority:** P0 · **Depends on:** none · **Blocks:** Wave 1

Generate a single machine-readable inventory (JSON in
`.cleo/rcasd/T11072/evidence/adr-inventory.json`) covering ALL ADR
locations.  For every ADR file across `.cleo/adrs/`, `docs/adr/`, and
`cleo docs` blob entries compute:

- `sha256` of file content (normalize trailing whitespace)
- The YAML frontmatter fields: `id`, `status`, `date`, `task`, `saga`,
  `supersedes`, `supersededBy`
- Its location(s) — a single ADR number may have files in multiple
  locations
- Whether it is byte-identical to any other file with the same ADR number
  (collision classification: `unique`, `duplicate`, `divergent`)
- The source-of-truth determination for each ADR number (by recency +
  frontmatter completeness + location priority per canonical policy)

The inventory MUST also flag the 11 known duplicate-numbered clusters
(ADR-051, 052, 053, 054, 068, 070, 072, 078, 079, 086, 087, 088) with
per-file content hashes and divergence notes.

**Acceptance Criteria:**

- AC1: `adr-inventory.json` exists at
  `.cleo/rcasd/T11072/evidence/adr-inventory.json` with a top-level
  `generated_at` ISO-8601 timestamp and `total_files`, `total_numbers`,
  `collision_count`, `missing_numbers` summary fields.
- AC2: Every ADR number (001–089) has an entry.  Collision classification
  is one of `unique | duplicate(identical) | divergent | missing`.
- AC3: SHA-256 hashes match what `sha256sum` would produce on normalized
  file content (trailing newline trimmed, no carriage returns).
- AC4: The inventory is committed to the saga branch so other tasks can
  consume it programmatically.
- AC5: A human-readable summary at the top of the JSON root lists: total
  files, unique ADR numbers, duplicate clusters, missing numbers,
  and a recommended merge order (cluster-by-cluster).
- AC6: Validation: `jq '.adrs | length'` returns 89 and
  `jq '[.adrs[] | select(.classification == "divergent")] | length'`
  returns 11 ±1 (allowing for investigation discoveries).

---

#### T11084 — Resolve 5 Missing ADR Number Gaps
**Priority:** P0 · **Depends on:** T11082 (needs inventory) · **Blocks:** T11087

Investigate ADR numbers 040, 060, 069, 076, and 077 (the 5 missing numbers).
For each determine whether:

a) The number was skipped intentionally (check git history, commit
   messages, task descriptions for reservation notes)
b) An ADR was drafted under that number but later renamed to a different
   number (check content hashes against all other files)
c) The file was lost during the T1824 migration (check
   `.cleo/adrs/T1825-migration-manifest.json` and git reflog for deleted
   files)
d) The number was never created (a genuine gap)

For each gap, produce a one-paragraph finding in
`.cleo/rcasd/T11072/research/gap-analysis.md` with: hypothesized cause,
evidence, and recommended disposition (`fill`, `document-as-intentional`,
or `ignore`).

Note: ADR-076 exists at `docs/adr/ADR-076-canonical-docs-ssot.md` but has
no cleo docs entry.  ADR-077 exists at
`docs/adr/ADR-077-worktreeinclude-canonical-location.md`.  Both may be
false positives in the gap list — the inventory (T11082) should confirm.

**Acceptance Criteria:**

- AC1: `gap-analysis.md` exists with one section per missing number (040,
  060, 069, 076, 077).
- AC2: Each section contains: git-log evidence (first/last appearance,
  renames), migration-manifest cross-reference, and a clear disposition.
- AC3: If a gap is determined to be intentional, a note is added to the
  canonical numbering register for future `cleo docs adr add --number`
  guidance.
- AC4: ADR-076 and ADR-077 are confirmed to have files on disk (the gap
  is only in the cleo docs entries, not filesystem).
- AC5: The inventory (T11082) is updated to reflect gap resolutions (e.g.,
  mark ADR-076/077 as `present-on-filesystem` rather than `missing`).

---

#### T11085 — Write ADR-090: Canonical ADR Policy (supersedes T1824)
**Priority:** P0 · **Depends on:** none (can draft alongside T11082/T11084)
**Blocks:** T11087, T11088, T11090, T11091

Draft ADR-090 as a formal Architecture Decision Record at
`docs/adr/ADR-090-canonical-adr-policy.md` (via `cleo docs add` after
T11089 is wired; during Wave 0, draft at
`.cleo/rcasd/T11072/architecture/ADR-090-draft.md`).

The ADR MUST codify:
1.  **SSoT Declaration**: `architecture_decisions` table is the sole
    source of truth.  `docs/adr/` is a generated publish mirror.  
    `.cleo/adrs/` is deprecated.
2.  **Numbering Rules**: monotonic sequence, no reuse, decimal addendum
    suffix (ADR-NNN.A), gaps must be documented.
3.  **Provenance Tracking**: every ADR create/amend/supersede is recorded
    as a database row with immutable diff history.
4.  **File Naming Convention**: `docs/adr/ADR-NNN-slug.md` with YAML
    frontmatter (`id`, `status`, `date`, `task`, `saga`, `supersedes`,
    `supersededBy`).
5.  **Migration Path**: how the 11 duplicate clusters and 5 gaps are
    resolved per this ADR.
6.  **Supersession of T1824**: explicit statement that T1824's
    `.cleo/adrs/` canonical choice is reversed.

**Acceptance Criteria:**

- AC1: ADR-090 draft exists with all 6 required sections (SSoT, Numbering,
  Provenance, Naming, Migration Path, Supersession).
- AC2: The draft explicitly references the 11 duplicate clusters and 5
  missing numbers from T11082/T11084 findings.
- AC3: The `supersedes` frontmatter field lists T1824 and ADR-076 (where
  ADR-076's §2.1 `rawMdPaths: [.cleo/adrs/]` is updated to mark the
  path as deprecated).
- AC4: The ADR uses RFC 2119 keywords (MUST, MUST NOT, SHOULD, etc.).
- AC5: Once approved (consensus gate), the content is published via
  `cleo docs add --type adr` to the DB and mirrored to
  `docs/adr/ADR-090-canonical-adr-policy.md`.

---

### Wave 1 — Reconciliation & Schema

#### T11083 — Resolve 11 Duplicate-Numbered ADR Clusters
**Priority:** P1 · **Depends on:** T11082 (inventory), T11085 (policy)
**Blocks:** T11087, T11088

For each of the 11 duplicate-numbered clusters identified in the
collision matrix, determine the canonical version and disposition for
non-canonical versions.

Resolution strategies:
- **Merge**: combine multiple ADRs on the same topic into one (e.g.,
  ADR-079's 7 fragments)
- **Re-number**: assign a new number to the duplicate and update
  cross-references
- **Supersede**: mark one as superseded by the other (use
  `supersededBy` frontmatter)
- **Addendum**: keep as ADR-NNN.A decimal suffix (e.g., ADR-087.A
  for worktrunk-ssot-boundary)

Process each cluster:
1. Read all files in the cluster; compare content hashes from T11082
2. Identify the most authoritative version (by recency, frontmatter
   completeness, and cross-reference count)
3. Determine the pre-existing numbering claims (check git-blame for
   which ADR was created first under a given number)
4. Apply the chosen strategy; update all cross-references in other
   ADRs, task descriptions, and source code comments
5. Update `adr-inventory.json` (T11082) with resolved classifications

**Acceptance Criteria:**

- AC1: Every duplicate cluster has a documented resolution in
  `.cleo/rcasd/T11072/evidence/cluster-resolutions.json`.
- AC2: No two distinct ADRs share the same primary number after
  resolution (ADR-NNN.A addendums are distinct from ADR-NNN).
- AC3: All cross-references across ADR files, task descriptions, and
  source code (`grep -r "ADR-\d\d\d"` in the repo) are consistent
  with the new numbers.
- AC4: For ADR-079 (7 fragments): a single consolidated ADR-079
  exists covering all 7 sub-topics, OR 7 distinct ADR numbers are
  assigned with clear cross-references.
- AC5: For ADR-087.A (worktrunk-ssot-boundary): the addendum naming
  follows the decimal-suffix convention and does not collide with
  ADR-087 itself.
- AC6: `adr-inventory.json` updated: `collision_count` is 0 and all
  entries have `classification: unique`.

---

#### T11086 — Extend architecture_decisions Schema for Provenance Tracking
**Priority:** P1 · **Depends on:** T11085 (policy defines schema needs)
**Blocks:** T11087, T11089

Extend the `architecture_decisions` table and related Drizzle schema to
support full provenance tracking per ADR-090.

Required schema additions:
1.  Add `adr_sequence_number` INTEGER UNIQUE column to
    `architecture_decisions` (0-padded 3-digit display form is
    presentation-only; the integer is the authority).
2.  Add an `adr_revisions` table:
    - `id` TEXT PK (UUID)
    - `adr_id` TEXT FK → `architecture_decisions.id`
    - `content` TEXT NOT NULL (full markdown at this revision)
    - `content_hash` TEXT NOT NULL (SHA-256)
    - `diff_forward` TEXT (unified diff from previous revision)
    - `created_at` TEXT DEFAULT (datetime('now'))
    - `created_by_task_id` TEXT FK → `tasks.id`
    - UNIQUE INDEX on (`adr_id`, `content_hash`)
3.  Add `is_addendum` BOOLEAN DEFAULT FALSE and `base_adr_id` TEXT FK
    (self-referential) to `architecture_decisions` for decimal-suffix
    addendums.
4.  Migration file in `packages/core/src/db/migrations/` following
    existing Drizzle migration conventions.
5.  Update Drizzle schema TypeScript definitions in
    `packages/core/src/db/schema/`.

**Acceptance Criteria:**

- AC1: New Drizzle migration file exists and runs successfully
  (`cleo db migrate` or equivalent).
- AC2: `adr_sequence_number` is populated for all existing 81 rows
  (derived from the `id` field, e.g., `ADR-076` → 76).
- AC3: `adr_revisions` table exists with correct foreign keys and
  unique index constraints.
- AC4: `is_addendum` and `base_adr_id` columns exist with correct
  self-referential FK.
- AC5: Updated TypeScript schema types compile without errors.
- AC6: Existing queries against `architecture_decisions` continue to
  work (no breaking column renames).

---

#### T11087 — Backfill & Normalize All ADRs into Database
**Priority:** P1 · **Depends on:** T11082, T11083, T11084, T11085, T11086
**Blocks:** T11088, T11089

Backfill ALL 89 ADR records (001–089) into the `architecture_decisions`
table with full provenance.  This is a superset of the T1824-5 backfill
(which loaded 81 records).

For each ADR:
1.  Parse YAML frontmatter to extract: `id`, `status`, `date`, `task`,
    `saga`, `supersedes`, `supersededBy`.
2.  Normalize content (trim trailing whitespace, ensure single trailing
    newline, convert tabs to spaces).
3.  INSERT or UPDATE the `architecture_decisions` row.
4.  INSERT an initial `adr_revisions` row with content hash.
5.  If the ADR supersedes another, INSERT a row in `adr_relations`
    with `relation_type = 'supersedes'`.
6.  If linked tasks are listed, INSERT rows in `adr_task_links`.
7.  Handle the 5 gap numbers per T11084 resolution (either INSERT
    a placeholder with status `skipped` or skip the number entirely).
8.  Handle the 11 resolved clusters per T11083 (ensure canonical
    version is the one with the primary number; addendums get
    `is_addendum = true`).

**Acceptance Criteria:**

- AC1: `SELECT COUNT(*) FROM architecture_decisions` returns exactly 89
  (or 89 - gaps, if gaps resolved to `skip`).
- AC2: Every row has a non-NULL `adr_sequence_number` matching the
  numeric portion of its `id`.
- AC3: Every row has at least one `adr_revisions` entry with a matching
  `content_hash`.
- AC4: `adr_relations` contains supersession chains for all
  `supersedes`/`supersededBy` frontmatter declarations.
- AC5: `adr_task_links` contains links for all `task`/`saga` frontmatter
  fields.
- AC6: The backfill is idempotent — running it twice produces no
  duplicate rows.
- AC7: A validation query confirms: no two rows share the same
  `adr_sequence_number` (except addendums, which share the base
  number but have distinct `id` values like `ADR-087.A`).

---

### Wave 2 — Migration & Enforcement

#### T11088 — Migrate .cleo/adrs/ Content to docs/adr/ Canonical Location
**Priority:** P2 · **Depends on:** T11083, T11087 (DB must be SSoT first)
**Blocks:** T11091

Move all ADR content from `.cleo/adrs/` to `docs/adr/`.  After T11087 the
DB is the SSoT — the filesystem is a generated mirror.

Procedure:
1.  For each ADR in the DB (post-T11087 backfill), regenerate its
    markdown file at `docs/adr/ADR-NNN-slug.md` from the DB content.
2.  Include a generated-from-DB header comment:
    `<!-- Generated from architecture_decisions table. Do not edit directly. -->`
3.  Delete the `docs/adr/ARCHIVED.md` file (it falsely claims the
    directory was migrated away).
4.  After all 89 ADRs are written to `docs/adr/`, verify no content
    divergence by comparing SHA-256 of generated files against DB
    `content_hash`.
5.  Keep `.cleo/adrs/` intact for now (T11091 deprecates it with a CI
    gate).  Do NOT delete `.cleo/adrs/` files — they serve as a
    rollback safety net until Wave 2 gates are live.
6.  Commit the regenerated `docs/adr/` directory.

**Acceptance Criteria:**

- AC1: `docs/adr/` contains exactly the 89 canonical ADR markdown files
  (or 89 - gaps + addendums).
- AC2: Every file has the generated-from-DB header comment.
- AC3: `docs/adr/ARCHIVED.md` is deleted.
- AC4: SHA-256 of each generated file matches the DB `content_hash`
  for that ADR.
- AC5: No file in `docs/adr/` has a duplicate number (all clusters
  resolved per T11083).
- AC6: `git status docs/adr/` shows only additions/modifications, no
  deletions of existing canonical files (the 12 existing files are
  overwritten if content changed).
- AC7: `.cleo/adrs/` is untouched (92 files remain as rollback safety).

---

#### T11089 — Wire cleo docs adr to DB-First SSoT (Purge Blob Storage)
**Priority:** P2 · **Depends on:** T11086, T11087
**Blocks:** T11085 (publishing), T11092

Modify `cleo docs add --type adr` and `cleo docs publish` to use the
`architecture_decisions` table as the SSoT instead of the generic
attachments/blob store.

Required changes:
1.  `cleo docs add --type adr`: writes the ADR content to
    `architecture_decisions` (with auto-assigned next sequence number
    from `MAX(adr_sequence_number) + 1`), INSERTs an `adr_revisions`
    row, and regenerates the `docs/adr/ADR-NNN-slug.md` mirror.
2.  `cleo docs amend --type adr --id ADR-NNN`: INSERTs a new
    `adr_revisions` row with forward-diff, updates the
    `architecture_decisions.content` and `updated_at`.
3.  `cleo docs supersede --type adr --id ADR-NNN --superseded-by ADR-MMM`:
    sets `superseded_by_id` on ADR-NNN, sets `supersedes_id` on ADR-MMM,
    INSERTs `adr_relations` rows.
4.  `cleo docs fetch <slug>`: for `--type adr`, queries
    `architecture_decisions` by `adr_sequence_number` or slug; returns
    the canonical DB content.
5.  Remove or deprecate the base64 blob storage path for ADR kind —
    existing blob entries for ADRs are migrated to
    `architecture_decisions` as part of T11087 backfill.
6.  Update `ct-documentor` SKILL.md to reflect the new ADR flow.

**Acceptance Criteria:**

- AC1: `cleo docs add --type adr --title "Test ADR"` creates a new
  row in `architecture_decisions` with correct auto-assigned
  `adr_sequence_number`.
- AC2: The generated mirror file appears at
  `docs/adr/ADR-NNN-test-adr.md` with the generated-from-DB header.
- AC3: `cleo docs amend --type adr --id ADR-NNN --content "..."` adds
  a new `adr_revisions` row with `diff_forward` computed.
- AC4: `cleo docs fetch adr-076-canonical-docs-ssot` returns the DB
  content, not a blob-store entry.
- AC5: No new blob entries are created for `kind: adr` after this
  task is done.
- AC6: `ct-documentor` SKILL.md updated with new ADR workflow
  instructions.
- AC7: Integration test: end-to-end `add → amend → supersede` cycle
  produces correct DB state and regenerated mirrors.

---

#### T11090 — Implement ADR Lint Gate: cleo check canon adr
**Priority:** P2 · **Depends on:** T11085 (policy), T11089 (DB-first wire)
**Blocks:** T11091, T11092

Implement `cleo check canon adr` (or extend `cleo check canon docs` per
ADR-076) to enforce canonical ADR policy on every PR.

The gate MUST:
1.  **Diff-walk**: `git diff --diff-filter=A --name-only origin/main...HEAD`
    for new `*.md` files.
2.  **Path check**: If any new `.md` file's path starts with
    `.cleo/adrs/`, fail with `E_CANON_VIOLATION` and message: "New ADRs
    MUST be created via `cleo docs add --type adr`.  `.cleo/adrs/` is
    deprecated — see ADR-090."
3.  **Content check** (for `docs/adr/` additions): verify the file has the
    generated-from-DB header comment.  If missing, fail with
    `E_CANON_VIOLATION`: "ADRs in docs/adr/ MUST be generated from the
    architecture_decisions table.  Use `cleo docs publish` to regenerate."
4.  **Numbering check** (for `docs/adr/` additions): parse the ADR number
    from the filename; verify it matches
    `MAX(adr_sequence_number) FROM architecture_decisions`.  If
    mismatched, fail with `E_CANON_VIOLATION`: "ADR number NNN does not
    match next available sequence number."
5.  **Duplicate check** (for all ADR files): verify no two files in
    `docs/adr/` share the same ADR number (excluding addendums).
6.  Emit LAFS error envelope with full structured result under
    `error.details.result`.

**Acceptance Criteria:**

- AC1: `cleo check canon adr` exits 0 on a clean working tree.
- AC2: Creating a new file at `.cleo/adrs/ADR-100-test.md` and running
  `cleo check canon adr --base HEAD~1` exits non-zero with
  `E_CANON_VIOLATION`.
- AC3: Creating a new file at `docs/adr/ADR-100-test.md` WITHOUT the
  generated-from-DB header exits non-zero with `E_CANON_VIOLATION`.
- AC4: The error envelope includes a `details.result` field with the
  file list, kind, matched path, and fix hint.
- AC5: Pre-existing files (before the PR diff base) are NEVER flagged.
- AC6: CI job added to `.github/workflows/ci.yml` running
  `cleo check canon adr --base origin/${{ github.base_ref }}`.
- AC7: The gate is wired into `cleo check canon docs` as a sub-check
  so `cleo check canon docs` also catches ADR violations.

---

#### T11091 — Deprecate .cleo/adrs/ with CI Gate Enforcement
**Priority:** P2 · **Depends on:** T11088, T11090
**Blocks:** T11092

Finalize the deprecation of `.cleo/adrs/` as an ADR storage location.

1.  **Add a deprecation notice**: Create `.cleo/adrs/DEPRECATED.md`
    explaining the migration to `docs/adr/` and pointing to ADR-090.
2.  **Add `.cleo/adrs/` to `.cleo/canon.yml`** as a blocked path for
    `kind: adr` with `rawMdAllowed: false` (per ADR-076 §2.1).
3.  **Create `.cleo/canon.yml`** if it does not exist (it doesn't —
    ADR-076 specified it but it was never created for cleocode itself).
4.  **Wire `cleo check canon docs`** to enforce that `.cleo/adrs/` is a
    blocked path for new ADR file creation (already done in T11090, but
    verify the canon.yml integration).
5.  **Remove `.cleo/adrs/` from `.gitignore` exemptions** (if any exist
    that keep the directory tracked despite `.cleo/` partial gitignore).
6.  **Update ADR-076** frontmatter to note that `rawMdPaths: [.cleo/adrs/]`
    is now enforced (PR # for this task amends ADR-076 §2.1).
7.  **Do NOT delete the files** — they remain as a read-only historical
    archive until the next major version, per ADR-076 §4 step 6.

**Acceptance Criteria:**

- AC1: `.cleo/adrs/DEPRECATED.md` exists with migration instructions.
- AC2: `.cleo/canon.yml` exists with `adr` kind entry:
    ```yaml
    adr:
      canonicalHome: ssot
      publishMirror: docs/adr/
      rawMdAllowed: false
      rawMdPaths:
        - .cleo/adrs/
    ```
- AC3: `cleo check canon docs` fails when a new `.md` file is added
  under `.cleo/adrs/`.
- AC4: `.cleo/canon.schema.json` exists and validates `.cleo/canon.yml`.
- AC5: ADR-076 §2.1 note is updated (via amendment or PR reference) to
  indicate the gate is now active.
- AC6: The 92 historical files in `.cleo/adrs/` remain intact (not deleted).
- AC7: A new agent session attempting `Write` to `.cleo/adrs/` receives
  the LAFS `E_CANON_VIOLATION` envelope with fix hint pointing to
  `cleo docs add --type adr`.

---

### Final Gate

#### T11092 — End-to-End ADR Provenance Smoke Test
**Priority:** P2 · **Depends on:** T11087, T11088, T11089, T11090, T11091
**Blocks:** saga completion

A comprehensive smoke test validating that the entire ADR system works
end-to-end after all Wave 0–2 tasks are complete.

Test scenarios:
1.  **DB integrity**: 89 ADRs in `architecture_decisions`, all with
    revisions, no duplicate sequence numbers.
2.  **Mirror consistency**: Every `.md` file in `docs/adr/` has
    byte-identical content to its DB row.
3.  **Supersession chains**: `adr_relations` correctly links all
    supersedes/supersededBy pairs declared in frontmatter.
4.  **New ADR flow**: Run `cleo docs add --type adr` and verify:
    DB row inserted, mirror generated, `adr_revisions` entry created,
    lint gate passes.
5.  **Amend flow**: Run `cleo docs amend --type adr --id ADR-090` and
    verify: new revision with diff, mirror regenerated, content hash
    updated.
6.  **Supersede flow**: Create ADR-091 superseding ADR-090, verify
    `superseded_by_id` on 090, `supersedes_id` on 091,
    `adr_relations` populated.
7.  **Lint gate blocks**: Verify that raw `Write` to `.cleo/adrs/`
    is blocked by CI gate.
8.  **Canonical gaps**: Verify the 5 gap numbers are resolved per
    T11084 and no false-missing entries exist.

**Acceptance Criteria:**

- AC1: Smoke test script exists at
  `packages/core/src/docs/__tests__/adr-provenance-smoke.test.ts`.
- AC2: All 8 test scenarios pass.
- AC3: The test is runnable via `pnpm --filter @cleo/core test
  adr-provenance-smoke`.
- AC4: The test is added to CI (`canon-check` job or dedicated
  `adr-smoke` job).
- AC5: T11072 saga status advances to `done` after this task completes.

---

## Task Dependency Graph

```
Wave 0 (parallel where possible):
  T11082 ─────────────────────────┐
  T11084 ── (after T11082) ───────┤
  T11085 ── (parallel with above)─┤
                                   │
Wave 1 (all depend on Wave 0):    │
  T11083 ◄── T11082 + T11085 ─────┤
  T11086 ◄── T11085 ──────────────┤
  T11087 ◄── T11082 + T11083 + T11084 + T11085 + T11086
                                   │
Wave 2 (all depend on Wave 1):    │
  T11088 ◄── T11083 + T11087 ─────┤
  T11089 ◄── T11086 + T11087 ─────┤
  T11090 ◄── T11085 + T11089 ─────┤
  T11091 ◄── T11088 + T11090 ─────┤
                                   │
Final Gate:                       │
  T11092 ◄── T11087 + T11088 + T11089 + T11090 + T11091
```

## Notes

- The 12 existing child tasks (T11065–T11071, T11077–T11081) from the
  original research report are superseded by this decomposition.  They
  were planning-level tasks; these 10 tasks are concrete implementation
  tasks.
- Wave 0 tasks (T11082, T11084, T11085) can be executed in parallel.
  Wave 1 requires Wave 0 completion.  Wave 2 requires Wave 1.
- The existing `architecture_decisions` table with 81 rows provides a
  strong starting point — T11087 extends it rather than starting from
  scratch.
- T11089 (wire cleo docs) is the highest-risk task — it changes the
  write path for all future ADRs.  Must not break existing `cleo docs
  fetch` for non-ADR kinds.
