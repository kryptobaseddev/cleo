# ADR-028: CHANGELOG Generation Model

**Status**: Accepted
**Date**: 2026-03-06
**Task**: T5577
**Epic**: T5576
**Related ADRs**: ADR-026, ADR-027

---

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT", "SHOULD", "SHOULD NOT", "RECOMMENDED", "MAY", and "OPTIONAL" in this document are to be interpreted as described in RFC 2119.

---

## 1. Context

CHANGELOG generation in CLEO had two competing implementations:

1. **Legacy path** (`src/core/release/index.ts` — deleted per ADR-026): prepended a bare `# VERSION` header to `CHANGELOG.md` with no section structure. No task-sourced content. No deduplication with existing sections.

2. **Manifest path** (`src/core/release/release-manifest.ts`): stored `## VERSION (date)` as part of the `changelog_text` field in `releases.json` (now `release_manifests` per ADR-027) but never wrote it to `CHANGELOG.md`.

Neither path performed section-aware merging. Running `release ship` twice on the same version could produce duplicate headers. There was no mechanism for contributors to inject custom prose into generated sections.

Additionally, auto-generated content was sourced from `releases.json` (a flat JSON file), while task metadata was stored in `tasks.db`. Sourcing from the database directly enables richer queries (by epic, by status, by type).

---

## 2. Decision

### 2.1 Canonical Section Header Format

All CHANGELOG sections MUST use the format:

```
## [VERSION] (YYYY-MM-DD)
```

Examples:
- `## [2026.3.15] (2026-03-06)`
- `## [2026.3.16] (2026-03-07)`

The `#` (H1) header format used by the legacy path is **prohibited** for version sections. The H1 level is reserved for the document title `# CHANGELOG` only.

### 2.2 Custom Log Block Preservation

Contributors MAY embed a `[custom-log]...[/custom-log]` block anywhere in `CHANGELOG.md`:

```markdown
## [2026.3.16] (2026-03-07)

[custom-log]
### Breaking Changes
- Removed `--legacy-mode` flag. Migrate to `--compat` before upgrading.
[/custom-log]

### Tasks Completed
<!-- auto-generated below -->
```

The section-aware merge algorithm (§2.3) MUST:
1. Extract the content between `[custom-log]` and `[/custom-log]` tags
2. Strip the tags themselves
3. Inject the extracted content (without tags) at the top of the generated section, before auto-generated task content

If no `[custom-log]` block is present in a section, only auto-generated content is written.

`[custom-log]` blocks in sections for versions other than the current release MUST be preserved verbatim (content without tags).

### 2.3 Section-Aware Merge Algorithm

`release.changelog` MUST implement the following merge algorithm when writing `CHANGELOG.md`:

1. **Parse** the existing `CHANGELOG.md` into sections, splitting on `## [` boundaries
2. **Locate** the section matching `## [VERSION]` for the current release version
3. **Generate** new section content:
   a. Query `tasks.db` for tasks linked to the release (by epic or task IDs in `release_manifests`)
   b. Group tasks by type: `feat`, `fix`, `chore`, `docs`, `refactor`, `test`
   c. Format as grouped Markdown lists under H3 subheadings (`### Features`, `### Bug Fixes`, etc.)
   d. Prepend any `[custom-log]` block content (extracted per §2.2), without the tags
4. **Replace or prepend**:
   - If the `## [VERSION]` section exists: replace its content with the newly generated content
   - If it does not exist: prepend the new section immediately after the `# CHANGELOG` title line
5. **Write** the result back to `CHANGELOG.md` atomically (temp file → validate → rename)

The algorithm MUST be idempotent: running it twice on the same version MUST produce the same output.

### 2.4 Auto-Generated Content Source

Auto-generated task lists MUST be sourced from `tasks.db` SQLite queries, not from `releases.json`, `releases.json.migrated`, or any JSONL file. This ensures the content is always consistent with the live task database.

The query for a release's tasks MUST use the `pipeline_id` field on `release_manifests` (linking to `lifecycle_pipelines`) to identify which tasks are in scope, falling back to task IDs embedded in the `metadata_json` field.

### 2.5 CI Gate Assertion

`release.yml` MUST assert that a `## [VERSION]` section exists in `CHANGELOG.md` before proceeding to `npm publish`. The gate check MUST:

1. Extract the version from the git tag (strip leading `v`)
2. Run: `grep -qF "## [${VERSION}]" CHANGELOG.md`
3. Fail the job with a clear error message if the section is absent

This prevents publishing a release without a documented changelog entry. The gate runs after `release.changelog` step and before the `npm publish` step.

### 2.6 Supersession of Legacy Path

The legacy `writeChangelogFile()` function in `src/core/release/index.ts` is superseded by this ADR. `index.ts` is deleted per ADR-026. The section-aware algorithm in §2.3 is the sole CHANGELOG generation mechanism.

---

## 3. Consequences

### Positive

- Idempotent generation: re-running `release ship` on the same version produces identical CHANGELOG content
- Section-aware merge: no duplicate headers, no lost existing content
- Custom prose preserved: contributors can document breaking changes or migration notes that survive regeneration
- Task-sourced content: richer, more accurate release notes drawn directly from the task database
- CI gate: impossible to publish without a CHANGELOG entry

### Negative

- Existing `CHANGELOG.md` entries that used the legacy `# VERSION` format (H1) do not match the new `## [VERSION]` format. A one-time normalization pass MAY be run, but is not required — the parser MUST handle both formats in existing sections without corrupting them
- `[custom-log]` block syntax is new; contributors must learn it to inject custom prose

### Neutral

- The CI gate adds one step to `release.yml` but has negligible runtime cost
- Tasks without a linked release (orphan tasks) are not included in the generated content

---

## 4. Migration Path

1. Implement `parseChangelog()` and `mergeChangelogSection()` in `src/core/release/changelog-generator.ts`
2. Wire `release.changelog` MCP operation to the new generator
3. Update `release.yml` to add the CI gate assertion step between `release.changelog` and `npm publish`
4. Add `[custom-log]` documentation to `docs/guides/release-workflow.md`
5. Optionally run a one-time normalization to convert existing `# VERSION` headers to `## [VERSION] (date)` format

---

## 5. References

- ADR-026: Release System Consolidation (deletion of legacy `writeChangelogFile()`)
- ADR-027: Manifest SQLite Migration (`release_manifests` table, `pipeline_id` linkage)
- ADR-016 §8.3: Release workflow architecture
- T5576: LOOM Release Pipeline Remediation (epic)
- T5577: Release System Consolidation documentation task
- `docs/specs/CLEO-RELEASE-PIPELINE-SPEC.md`

---

**END OF ADR-028**
