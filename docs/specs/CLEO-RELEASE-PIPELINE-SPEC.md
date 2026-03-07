# CLEO Release Pipeline Specification

**Version**: 2026.3.6
**Status**: APPROVED
**Date**: 2026-03-06
**Task**: T5577
**Epic**: T5576
**Authors**: CLEO Agent Team
**Supersedes**: Informal release notes in ADR-016 §8.3 (workflow architecture sections remain; this spec adds the formal operation contract)

---

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT", "SHOULD", "SHOULD NOT", "RECOMMENDED", "MAY", and "OPTIONAL" in this document are to be interpreted as described in RFC 2119.

---

## 1. Overview

This specification defines the formal contract for the CLEO 5-step release pipeline. The pipeline is implemented as MCP operations in the `pipeline` domain and orchestrated by `release.ship`. Each step MUST complete successfully before the next step begins. The pipeline is atomic at the git level: if any step after `release.commit` fails, the release MUST NOT be re-attempted without manual intervention to resolve the partial state.

The canonical release system consists of two modules:
- `src/core/release/release-manifest.ts` — SQLite CRUD for `release_manifests` table
- `src/core/release/release-engine.ts` — state machine driving the 5-step flow

All other modules under `src/core/release/` are helpers called by these two.

---

## 2. Terminology

| Term | Definition |
|------|------------|
| **release_manifests** | SQLite table in `tasks.db` storing per-release metadata |
| **pipeline_id** | Foreign key linking a release to a `lifecycle_pipelines` row |
| **dist-tag** | npm distribution tag (`latest`, `beta`, `dev`) |
| **gate** | A pre-condition check that MUST pass before a step proceeds |
| **guard** | A post-condition check that MUST pass before the next step begins |
| **ship** | Composite operation: all 5 steps executed in sequence |
| **CalVer** | Calendar Versioning format `YYYY.M.PATCH` used by CLEO |

---

## 3. Release Manifest Schema

The `release_manifests` table in `tasks.db` is the authoritative store for all release metadata.

### 3.1 Table Definition

```sql
CREATE TABLE release_manifests (
  id             text PRIMARY KEY NOT NULL,
  version        text NOT NULL,
  status         text NOT NULL DEFAULT 'pending',
  pipeline_id    text,
  commit_sha     text,
  git_tag        text,
  npm_dist_tag   text,
  published_at   text,
  changelog_text text,
  metadata_json  text,
  created_at     text NOT NULL DEFAULT (datetime('now')),
  updated_at     text
);

CREATE INDEX idx_rm_version ON release_manifests(version);
CREATE INDEX idx_rm_status  ON release_manifests(status);
```

### 3.2 Status Lifecycle

```
pending → prepared → changelog_ready → gates_passed → committed → shipped
                                                            │
                                                       (on failure)
                                                            └──► failed
```

| Status | Set by | Meaning |
|--------|--------|---------|
| `pending` | `release.prepare` | Row created, not yet ready |
| `prepared` | `release.prepare` | Row updated with pipeline_id linkage |
| `changelog_ready` | `release.changelog` | CHANGELOG.md written successfully |
| `gates_passed` | `release.gates.run` | All gates and guards passed |
| `committed` | `release.commit` | Git commit + tag created |
| `shipped` | `release.ship` | npm publish succeeded, provenance recorded |
| `failed` | Any step | Unrecoverable error during pipeline |

### 3.3 Provenance Columns

| Column | Populated by | Description |
|--------|-------------|-------------|
| `commit_sha` | `release.commit` | Full SHA of the release commit |
| `git_tag` | `release.commit` | Tag string (e.g., `v2026.3.15`) |
| `npm_dist_tag` | `release.ship` | npm dist-tag used for publish |
| `published_at` | `release.ship` | ISO-8601 timestamp of npm publish |

---

## 4. The 5-Step Pipeline

### Step 1: release.prepare

**MCP operation**: `mutate pipeline release.prepare`

**Purpose**: Creates or updates the `release_manifests` row for the target version. Links the release to a `lifecycle_pipelines` row via `pipeline_id`.

**Inputs**:

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `version` | string | Yes | CalVer version string (e.g., `2026.3.15`) |
| `epicId` | string | No | Task ID of the release epic |
| `npmDistTag` | string | No | Override dist-tag; defaults to derived from version |

**Pre-conditions (gates)**:

1. **CalVer format gate**: Version MUST match `^\d{4}\.\d{1,2}\.\d+(-[\w.]+)?$`
2. **CalVer month gate**: For stable releases (no pre-release suffix), the year and month in the version MUST match current UTC date. Pre-release versions MAY use the current or next calendar month.
3. **No duplicate gate**: A `release_manifests` row with status `shipped` for the same version MUST NOT already exist.

**Output**: `EngineResult` with `release_manifests.id` and `pipeline_id`.

**Status transition**: `pending` → `prepared`

---

### Step 2: release.changelog

**MCP operation**: `mutate pipeline release.changelog`

**Purpose**: Generates CHANGELOG.md content from SQLite task data and writes it to `CHANGELOG.md` using the section-aware merge algorithm (ADR-028 §2.3).

**Inputs**:

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `version` | string | Yes | Version to generate changelog for |
| `releaseId` | string | No | `release_manifests.id`; resolved from version if omitted |
| `dryRun` | boolean | No | If true, return content without writing to disk |

**Algorithm** (normative):

1. Read `CHANGELOG.md` from the project root (create if absent with `# CHANGELOG` title)
2. Parse into sections by splitting on `## [` boundaries
3. Query `tasks.db`: select tasks linked to this release via `pipeline_id` → `lifecycle_pipelines` → task associations. Fall back to task IDs in `release_manifests.metadata_json`.
4. Group tasks by commit type prefix (`feat`, `fix`, `chore`, `docs`, `refactor`, `test`)
5. Extract `[custom-log]...[/custom-log]` block from the existing section for this version, if present
6. Build new section:
   ```
   ## [VERSION] (YYYY-MM-DD)

   {custom-log content without tags, if present}

   ### Features
   - task title (T####)

   ### Bug Fixes
   - task title (T####)
   ```
7. Replace existing `## [VERSION]` section, or prepend after `# CHANGELOG` title if absent
8. Write result atomically to `CHANGELOG.md`
9. Store section text in `release_manifests.changelog_text`

**Section header format** (MUST):
```
## [VERSION] (YYYY-MM-DD)
```

The `# VERSION` (H1) format is **prohibited** for version sections.

**Output**: `EngineResult` with `changelogPath`, `sectionLength`, `taskCount`.

**Status transition**: `prepared` → `changelog_ready`

---

### Step 3: release.gates.run

**MCP operation**: `query pipeline release.gates.run`

**Purpose**: Runs all pre-publish gates and post-step guards. MUST pass before `release.commit` is invoked.

**Gates (4, normative)**:

| ID | Gate | Failure Condition |
|----|------|------------------|
| G1 | **CalVer validity** | Version does not match CalVer pattern or month |
| G2 | **Build artifact** | `dist/` directory absent or `dist/cli/index.js` missing |
| G3 | **Test suite** | `npm test` exits non-zero |
| G4 | **CHANGELOG section** | `## [VERSION]` not present in `CHANGELOG.md` |

**Guards (2, normative)**:

| ID | Guard | Failure Condition |
|----|-------|------------------|
| GD1 | **Clean working tree** | `git status --porcelain` returns non-empty output (excluding `CHANGELOG.md` and `VERSION`) |
| GD2 | **Branch target** | Current branch is not `main` (for stable) or `develop` (for pre-release) |

All 4 gates and 2 guards MUST pass. The operation MUST return the full list of results for all checks, including passing ones, to support CI reporting.

**Output**: `EngineResult` with `passed: boolean`, `results: GateResult[]`.

**Status transition**: `changelog_ready` → `gates_passed` (on all pass)

---

### Step 4: release.commit

**MCP operation**: `mutate pipeline release.commit`

**Purpose**: Creates the git commit and tag for the release. Records commit SHA and tag in `release_manifests`.

**Inputs**:

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `version` | string | Yes | Version string |
| `epicId` | string | No | Epic task ID for commit message reference |

**Commit message format** (MUST):
```
release: ship vVERSION (T{EPIC_ID})
```

Examples:
- `release: ship v2026.3.15 (T5576)`
- `release: ship v2026.3.16-beta.1 (T5600)`

The `release:` prefix MUST be in the commit-msg hook's auto-bypass list so `--no-verify` is never needed.

**Tag format** (MUST):
```
vVERSION
```

Example: `v2026.3.15`

**Files staged for the release commit** (MUST include):
- `CHANGELOG.md`
- `VERSION`
- `package.json` (if version was bumped)

**Post-commit actions**:
1. Record `commit_sha` = full SHA of the new commit
2. Record `git_tag` = tag string
3. Update `release_manifests.status` = `committed`

**Output**: `EngineResult` with `commitSha`, `gitTag`.

**Status transition**: `gates_passed` → `committed`

---

### Step 5: release.ship (Composite)

**MCP operation**: `mutate pipeline release.ship`

**Purpose**: Composite operation. Orchestrates steps 1–4 in sequence, then pushes to remote and records the final provenance.

**Inputs**:

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `version` | string | Yes | Version to ship |
| `epicId` | string | No | Epic task ID |
| `npmDistTag` | string | No | Override npm dist-tag |
| `push` | boolean | No | If false, skip `git push` (default: true) |
| `bumpVersion` | boolean | No | If true, update VERSION and package.json before committing |
| `createTag` | boolean | No | If true, create git tag (default: true) |

**Execution sequence**:
```
release.prepare
    → release.changelog
    → release.gates.run   (abort on any failure)
    → release.commit
    → git push origin HEAD vVERSION
    → record npm_dist_tag + published_at in release_manifests
    → status = shipped
```

The `git push` step MUST push both the commit and the tag in a single push invocation:
```bash
git push origin HEAD refs/tags/vVERSION
```

**Provenance recording** (post-push):

After the tag is pushed, `release.ship` MUST update `release_manifests`:
- `npm_dist_tag` = determined from version suffix per ADR-016 §8.5
- `published_at` = ISO-8601 UTC timestamp at push completion
- `status` = `shipped`

Actual npm publish is performed by GitHub Actions `release.yml` after the tag push triggers the workflow. `release.ship` does not invoke `npm publish` directly.

**Output**: `EngineResult` with `version`, `gitTag`, `npmDistTag`, `commitSha`, `releaseId`.

**Status transition**: `committed` → `shipped`

---

## 5. Commit Message Format

All release commits MUST use the format:

```
release: ship vVERSION (T{EPIC_ID})
```

The `.cleo/templates/git-hooks/commit-msg` hook MUST bypass validation for lines matching:
- `^release:` prefix
- `^chore\(release\):` prefix

This eliminates the need for `--no-verify` on any release commit.

---

## 6. CHANGELOG Format

### Document Structure

```markdown
# CHANGELOG

## [LATEST_VERSION] (YYYY-MM-DD)

### Features
- Description (T####)

### Bug Fixes
- Description (T####)

## [PREVIOUS_VERSION] (YYYY-MM-DD)

...
```

### Section Header (MUST)

```
## [VERSION] (YYYY-MM-DD)
```

### Custom Block (MAY)

Contributors MAY add custom prose that survives regeneration:

```markdown
## [2026.3.16] (2026-03-07)

[custom-log]
### Breaking Changes
- Removed deprecated `--legacy-mode` flag.
[/custom-log]

### Features
<!-- auto-generated -->
```

The `[custom-log]...[/custom-log]` tags are stripped on merge; the content is injected at the top of the generated section.

---

## 7. CI Gate Assertion

`release.yml` MUST include a gate step between `release.changelog` and `npm publish`:

```yaml
- name: Assert CHANGELOG section exists
  run: |
    VERSION="${{ steps.version.outputs.version }}"
    if ! grep -qF "## [${VERSION}]" CHANGELOG.md; then
      echo "ERROR: ## [${VERSION}] section not found in CHANGELOG.md"
      exit 1
    fi
```

This gate MUST run before the `npm publish` step. If the section is absent, the job MUST fail with a clear error message.

---

## 8. npm Dist-Tag Mapping

Per ADR-016 §8.5:

| Tag suffix | npm dist-tag |
|------------|-------------|
| *(none)* | `latest` |
| `-rc.N` | `beta` |
| `-beta.N` | `beta` |
| `-alpha.N` | `dev` |
| `-dev.N` | `dev` |

---

## 9. Error Handling

| Exit Code | Name | Trigger |
|-----------|------|---------|
| 80 | LIFECYCLE_GATE_FAILED | Any gate in `release.gates.run` fails |
| 83 | LIFECYCLE_TRANSITION_INVALID | Step invoked out of sequence (e.g., `release.commit` before `gates_passed`) |
| 84 | PROVENANCE_REQUIRED | `release.ship` completes push but `release_manifests` update fails |

All release operations MUST log to the audit trail in `tasks.db`.

---

## 10. References

- ADR-016: Installation Channels and Release Pipeline (workflow architecture)
- ADR-026: Release System Consolidation (dead code removal, commit format)
- ADR-027: Manifest SQLite Migration (release_manifests schema)
- ADR-028: CHANGELOG Generation Model (section-aware merge algorithm)
- `docs/specs/CLEO-MANIFEST-SCHEMA-SPEC.md`
- `docs/specs/VERB-STANDARDS.md`
- `src/core/release/release-manifest.ts`
- `src/core/release/release-engine.ts`
- T5576: LOOM Release Pipeline Remediation (epic)
- T5577: Release System Consolidation documentation task
