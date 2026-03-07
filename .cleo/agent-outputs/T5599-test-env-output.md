# T5599 Wave 1 — Test Environment Setup Report

**Agent**: Wave 1 Setup Agent
**Date**: 2026-03-07
**Task**: T5599
**Status**: COMPLETE

---

## Environment Setup

### Test Project Location
- Path: `/tmp/cleo-pipeline-test`
- CLEO CLI: `node /mnt/projects/claude-todo/dist/cli/index.js`
- CLEO version: `2026.3.17` (dev build)

### Git Branches Created
| Branch | Purpose |
|--------|---------|
| `main` | Stable release channel (@latest) |
| `develop` | Beta integration branch (@beta) |
| `feature/oauth-integration` | Feature branch (@alpha) |

### Tasks Created
| ID | Title | Status | Notes |
|----|-------|--------|-------|
| T001 | Add user authentication | done | JWT auth, completed + verified |
| T002 | Fix login timeout bug | done | Token expiry fix, completed + verified |
| T003 | Add password reset flow | done | Email reset, completed + verified |
| T004 | Research OAuth providers | pending | Left pending intentionally |
| T005 | Add API rate limiting | done | Rate limiting, completed + verified |

**4 tasks completed and eligible for release. T004 (research) left pending to test exclusion behavior.**

### Releases Prepared
| Version | Channel | Status | Tasks |
|---------|---------|--------|-------|
| v2026.3.2 | @latest (main) | prepared | T001,T002,T003,T005 |
| v2026.3.2-beta.1 | @beta (develop) | prepared | T001,T002,T003,T005 |
| v2026.3.2-alpha.1 | @alpha (feature) | prepared | T001,T002,T003,T005 |

### Setup Notes
- All 5 tasks required `verify --all` before `complete` (RCSD verification gate enforced)
- The `--type feat` flag is invalid — CLEO task types are `epic|task|subtask` (not `feat|fix`)
- A stub `dist/cli/index.js` was created at `/tmp/cleo-pipeline-test/dist/cli/index.js` to satisfy the `build_artifact` gate (the test project has no real build)
- `.cleo/` is initialized as an isolated nested git repo (CLEO checkpoint architecture); it appears as a submodule in the outer git repo

---

## Channel Detection Results

Channel detection is embedded in `release ship --dry-run` output (via `channel` field in result JSON). The MCP `release.channel.show` operation exists in the pipeline domain handler but is **NOT registered in `src/dispatch/registry.ts`** — see Issues Found section.

| Branch | Expected Channel | Actual Channel | PASS/FAIL |
|--------|-----------------|----------------|-----------|
| main | @latest | `latest` | PASS |
| develop | @beta | `beta` | PASS |
| feature/oauth-integration | @alpha | `alpha` | PASS |

All three branch-to-channel mappings resolved correctly via `resolveChannelFromBranch()` in `src/core/release/channel.ts`.

---

## Dry-Run Results — main branch (stable, v2026.3.2)

### Full Step Output
```
[Step 1/7] Validate release gates...
  ✓ Validate release gates
[Step 2/7] Check epic completeness...
  ✓ Check epic completeness
[Step 3/7] Check task double-listing...
  ✓ Check task double-listing
[Step 4/7] Generate CHANGELOG...
  ✓ Generate CHANGELOG
```

Steps 5-7 (commit, tag, push) are skipped in dry-run. The `wouldDo` array shows the exact commands that would execute:
```json
[
  "write CHANGELOG section for 2026.3.2 (492 chars)",
  "git add CHANGELOG.md",
  "git commit -m \"release: ship v2026.3.2 (T001)\"",
  "git tag -a v2026.3.2 -m \"Release v2026.3.2\"",
  "git push origin --follow-tags",
  "markReleasePushed(...)"
]
```

**Channel**: `latest` (correct for main)
**wouldCreatePR**: `false` (correct — no remote configured)

### Gate Results
| Gate | Status | Notes |
|------|--------|-------|
| has_tasks | PASS | 4 tasks in release |
| valid_version | PASS | 2026.3.2 is valid CalVer |
| has_changelog | PASS | Generated before ship |
| tasks_complete | PASS | All 4 tasks are done |
| build_artifact | PASS | Stub dist/cli/index.js present |
| clean_working_tree | PASS | Skipped in dry-run mode |
| branch_target | PASS | main branch → @latest |

### clean_working_tree with Untracked Files
Tested with `untracked-dir/test.txt` and `orphan.txt` present as untracked (`??`) files.

**Result**: PASS — dry-run succeeded. Confirmed behavior:
1. `clean_working_tree` gate is explicitly skipped (`status: 'passed', message: 'Skipped in dry-run mode'`) — see `src/core/release/release-manifest.ts:645`
2. Even in non-dry-run, untracked files (`??` prefix) are filtered from the dirty check — see line 660: `.filter(l => !l.startsWith('?? '))`

---

## Dry-Run Results — develop branch (pre-release, v2026.3.2-beta.1)

### Full Step Output
```
[Step 1/7] Validate release gates...
  ✓ Validate release gates
[Step 2/7] Check epic completeness...
  ✓ Check epic completeness
[Step 3/7] Check task double-listing...
  ✓ Check task double-listing
[Step 4/7] Generate CHANGELOG...
  ✓ Generate CHANGELOG
```

**Channel detected**: `beta` — PASS (develop branch correctly maps to @beta)
**branch_target gate**: PASS — develop branch with pre-release version (-beta.1) is valid

---

## Dry-Run Results — feature/oauth-integration branch (pre-release, v2026.3.2-alpha.1)

```
[Step 1/7] Validate release gates...
  ✓ Validate release gates
[Step 2/7] Check epic completeness...
  ✓ Check epic completeness
[Step 3/7] Check task double-listing...
  ✓ Check task double-listing
[Step 4/7] Generate CHANGELOG...
  ✓ Generate CHANGELOG
```

**Channel detected**: `alpha` — PASS (feature/ prefix correctly maps to @alpha)

---

## Changelog Quality

### Generated Content (for v2026.3.2)
```markdown
## v2026.3.2 (2026-03-07)

### Features
- **Add user authentication**: Implement JWT-based authentication for the API endpoints (T001)
- **Add password reset flow**: Allow users to reset their password via email link with 24-hour expiry (T003)
- **Add API rate limiting**: Implement per-IP rate limiting at 100 requests per minute to prevent abuse (T005)

### Bug Fixes
- **Fix login timeout bug**: Users were being logged out after 5 minutes due to incorrect token expiry calculation (T002)
```

### Assessment
| Check | Result | Notes |
|-------|--------|-------|
| Research task T004 excluded | YES | T004 (pending) not in any release manifest |
| Features categorized correctly | YES | T001, T003, T005 under `### Features` |
| Bug fixes categorized correctly | YES | T002 under `### Bug Fixes` |
| Task IDs included | YES | Each entry cites e.g. `(T001)` |
| Title + description both present | YES | `**Title**: Description` format |

### Changelog Duplication Bug
The CHANGELOG.md file has a **duplication issue**: `v2026.3.2` section appears **twice** in the file. This occurred because:
1. `release changelog 2026.3.2` was run once (prepended section)
2. `release ship --dry-run` runs `Generate CHANGELOG` as step 4 — even in dry-run, this **writes** the CHANGELOG section again

This is a notable behavior: the dry-run's Step 4 is NOT fully dry — it writes to CHANGELOG.md. The section is prepended a second time, creating a duplicate.

**Impact for Wave 2**: Wave 2 agents should test whether this is intentional or a bug. The `wouldDo` array says `"write CHANGELOG section for 2026.3.2 (492 chars)"` but doesn't say "skip if already present."

---

## Issues Found

### Issue 1: `release.channel.show` NOT in MCP registry (CRITICAL for T5586 validation)
**Location**: `src/dispatch/registry.ts`
**Problem**: The `channel.show` operation is implemented in `src/dispatch/domains/pipeline.ts` (line 377) and listed in `getSupportedOperations()` as `release.channel.show`, but it is **completely absent from `src/dispatch/registry.ts`** (the OPERATIONS array).

**Consequence**: MCP calls to `query pipeline release.channel.show` fail with:
```json
{"success": false, "error": {"code": "E_INVALID_OPERATION", "message": "Unknown operation: query:pipeline.release.channel.show"}}
```

**CLI workaround**: Channel detection works via `release ship --dry-run` which reads the branch internally without going through MCP dispatch.

**Wave 2 action**: Verify this is a known gap or file as a bug. The operation should be added to OPERATIONS array in `src/dispatch/registry.ts`.

### Issue 2: Dry-run Step 4 (Generate CHANGELOG) Writes to Disk
**Behavior**: `release ship --dry-run` runs 4 steps but only skips steps 5-7 (commit, tag, push). Step 4 (`Generate CHANGELOG`) **does write to CHANGELOG.md** even in dry-run mode. Running the dry-run on an already-changelоgged release causes duplicate sections.

**Evidence**: CHANGELOG.md contains v2026.3.2 section twice after one dry-run.

**Wave 2 action**: Determine if step 4 should be a no-op in dry-run. The `wouldDo` output correctly lists it as a planned action, suggesting it may be intentional.

### Issue 3: `--type feat` Not a Valid Task Type
**Minor finding**: The task type system uses `epic|task|subtask`, not `feat|fix|etc.` like conventional commits. The `--type feat` argument returns an error. Tasks are categorized in changelog by their title prefix (containing "Fix" → Bug Fixes, otherwise → Features). Wave 2 should be aware there is no native `feat`/`fix` type on tasks.

### Issue 4: Requires `--epic` Flag for `release ship`
The `--epic <id>` option is **required** (not optional) for `release ship`. The help text shows `[options]` suggesting it's optional, but omitting it produces: `error: required option '--epic <id>' not specified`. Wave 2 should always pass `--epic`.

---

## Test Environment State

### Current git branches
```
main           (HEAD for stable tests)
develop        (beta tests done)
feature/oauth-integration  (alpha tests done)
```

### Files in test project
- `/tmp/cleo-pipeline-test/VERSION` — `2026.3.1`
- `/tmp/cleo-pipeline-test/package.json` — `{"version": "2026.3.1", ...}`
- `/tmp/cleo-pipeline-test/CHANGELOG.md` — generated (has duplication issue, see above)
- `/tmp/cleo-pipeline-test/dist/cli/index.js` — stub artifact (1 line comment)
- `/tmp/cleo-pipeline-test/.cleo/tasks.db` — SQLite with 5 tasks, 3 release manifests

### CLEO data state
- 3 releases prepared: v2026.3.2, v2026.3.2-beta.1, v2026.3.2-alpha.1
- All releases have changelogs generated
- None have been shipped (dry-run only)

---

## Ready for Wave 2 Testing

**YES** — the test environment is set up and functional.

### Wave 2 Can Test
1. **MCP `release.channel.show` registration gap** — confirm bug, add to registry, re-test via MCP
2. **Dry-run idempotency** — determine if step 4 should skip changelog write when already present
3. **Non-dry-run ship on main** — run `release ship 2026.3.2 --no-push --epic T001` on main to test actual commit+tag (no remote configured so push would fail, use `--no-push`)
4. **Channel validation enforcement** — try shipping a stable version (no `-`) from develop branch; should gate-fail on `branch_target`
5. **Version-channel mismatch** — try `2026.3.2-beta.1` from main; should fail `validateVersionChannel` with message about pre-release suffix on @latest
6. **`--epic` optionality** — investigate if `--epic` should truly be required or made optional with a fallback

### How to Use the Test Environment
```bash
CLEO="node /mnt/projects/claude-todo/dist/cli/index.js"
cd /tmp/cleo-pipeline-test

# Switch branches
git checkout main       # stable channel tests
git checkout develop    # beta channel tests
git checkout feature/oauth-integration  # alpha channel tests

# Key commands
$CLEO release ship <version> --dry-run --epic T001
$CLEO release show <version>
$CLEO release changelog <version>
$CLEO list --human

# MCP channel detection (currently broken - for Wave 2 to fix/verify)
# mcp__cleo-dev__query pipeline release.channel.show
```
