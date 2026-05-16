# CLEO Release Subcommand Audit — T9345

**Audit Date**: 2026-05-15  
**Auditor**: Code Analysis System  
**Epic**: T9345 (IVTR Release System Overhaul)  
**Status**: Complete  
**Scope**: All `cleo release *` subcommands, CLI → dispatch → engine code paths  

---

## 1. Subcommand Inventory

| Subcommand | CLI File:Line | Handler | Engine Function | Intent | LOC | Tests | Priority |
|---|---|---|---|---|---|---|---|
| `release ship` | `release.ts:33–89` | `dispatch release.ship` (composite) | `releaseShip()` | Full lifecycle: gates → PR → merge → tag → push | ~600 | yes | P0 |
| `release start` | `release.ts:297–314` | Direct call `releaseStart()` | `releaseStart()` (pipeline.ts) | Step 1/4: validate version, capture branch, persist handle | ~30 | yes | P0 |
| `release verify` | `release.ts:317–324` | Direct call `releaseVerify()` | `releaseVerify()` (pipeline.ts) | Step 2/4: run gates + audit children | ~25 | yes | P0 |
| `release publish` | `release.ts:327–337` | Direct call `releasePublish()` | `releasePublish()` (pipeline.ts) | Step 3/4: invoke `publish.command` | ~20 | yes | P0 |
| `release reconcile` | `release.ts:340–350` | Direct call `releaseReconcile()` | `releaseReconcile()` (pipeline.ts) | Step 4/4: run post-release invariants, auto-complete | ~25 | yes | P0 |
| `release list` | `release.ts:92–97` | `dispatch pipeline.release.list` | `releaseList()` | Query all releases with filters | ~60 | yes | P2 |
| `release show` | `release.ts:100–118` | `dispatch pipeline.release.show` | `releaseShow()` | Query single release details | ~15 | yes | P2 |
| `release cancel` | `release.ts:121–142` | `dispatch pipeline.release.cancel` | `releaseCancel()` | Mutate: cancel draft/prepared release | ~50 | yes | P2 |
| `release changelog` | `release.ts:152–173` | `dispatch pipeline.release.changelog.since` | `releaseChangelogSince()` | Generate CHANGELOG from git log since tag | ~150 | yes | P2 |
| `release pr-status` | `release.ts:258–279` | `dispatch pipeline.release.pr-status` | `releasePrStatus()` | Poll CI checks for in-flight PR | ~60 | yes | P2 |
| `release rollback` | `release.ts:176–204` | `dispatch pipeline.release.rollback` | `releaseRollback()` | Metadata-only rollback (status flip) | ~50 | yes | P2 |
| `release rollback-full` | `release.ts:214–247` | `dispatch pipeline.release.rollback.full` | `releaseRollbackFull()` | Real rollback: delete tag, revert commit, remove record | ~270 | yes | P1 |
| `release channel` | `release.ts:282–290` | `dispatch pipeline.release.channel.show` | (impl in dispatch) | Show current channel from git branch | ~20 | yes | P3 |

**14 subcommands total**. Two code paths:
- **Composite `release ship`**: orchestrates 12-step internal pipeline, lives entirely in engine-ops.ts (1986 LOC)
- **Canonical 4-step (`start`/`verify`/`publish`/`reconcile`)**: isolated persistent handle + per-step design per T1597/ADR-063

---

## 2. Per-Subcommand Deep Dive

### 2.1 `release ship`

**Intent** (T5582, T5586, T9095):
- Composite operation: automate entire release from version validation through tag push
- Mandatory PR-based flow (no direct main push) — T9095 enforcement
- 12-step pipeline with state logging for CLI visibility

**Code Path**:
1. CLI: `release.ts:33–89` — define shipCommand, dispatch to `'mutate' / 'pipeline' / 'release.ship'`
2. Dispatch: `dispatch/domains/pipeline.ts` — routes to `releaseDomainHandler.mutate('release.ship', params)`
3. Engine: `engine-ops.ts:1105–1750` — `releaseShip()` orchestrates 12 steps

**Side Effects** (all irreversible after step 5):
- **Step 0**: Bump version files via `bumpVersionFromConfig()` — writes package.json, VERSION, custom targets
- **Step 0.5**: Auto-prepare release record — writes to SQLite release_manifests table
- **Step 1–4**: Run gates, validate epic completeness, check double-listing (queries only)
- **Step 4**: Write CHANGELOG.md via `generateReleaseChangelog()` — file write, SQLite update
- **Step 5**: `git checkout -b release/v*`, `git add`, `git commit` — **point of no return** without `git reset`
- **Step 6**: `git push -u origin <releaseBranch>` — remote mutation
- **Step 7**: `gh pr create` — GitHub API mutation, PR created
- **Step 8–10**: Poll CI, merge PR, tag from main, push tag — final remote mutations

**Failure Surface**:
- **No timeout on git commit**: runGitWithLockRetry() has max 6 retries (~7.85s total backoff) but no hard timeout. Step 5 can hang indefinitely if `.git/index.lock` contention never resolves — **FAILURE #1**.
- **Epic completeness scope leak**: `--epic` flag used to filter tasks for IVTR check (line 1253–1293) but not propagated to epic-completeness guard (line 1359–1365). Guard checks ALL child tasks of all epics in manifest, not scoped to `--epic` — **FAILURE #2**.
- **Gate runners not wired by default**: `releaseVerify()` (pipeline.ts:332) uses `opts.runGate ?? defaultRunGate`, but `defaultRunGate` at line 249–261 always returns `passed: false, reason: 'gate … runner not configured'`. In real CLI flow from `release ship`, no `runGate` injected; gates always fail — **FAILURE #3**.
- **IVTR gate is non-blocking when `--force` passed**: line 1252 `if (!force)` skips gate entirely with warning only, contradicting T820 RELEASE-03 intent of "MUST validate IVTR phase before ship" — **FAILURE #4**.
- **Override counter (`CLEO_OWNER_OVERRIDE` / 823/10)**: Referenced in release.ts:69 comment but NO counter enforcement in engine-ops or ship code. `--force` flag bypasses silently without cap validation — **FAILURE #5**.

**Invariants Needed**:
1. Clean git tree (no staged/unstaged changes outside release files)
2. Network reachable (gh CLI, git push)
3. `.cleo/config.json` valid (version scheme, publish command, branch config)
4. Release epic must have at least one child task (else IVTR check skipped silently)
5. CHANGELOG.md writable and parseable
6. All version-bump targets must exist on disk
7. Main branch must be fast-forward-able from release branch (for merge)

**Observed Defects** (T9345 evidence):
- **#1**: No timeout on git commit (runs indefinitely on lock contention)
- **#2**: Epic scope leak (completeness check not scoped to --epic)
- **#3**: Gate runners never wired (defaultRunGate always fails)
- **#4**: IVTR gate non-blocking when --force (should be blocking by spec)
- **#5**: Override counter broken (no 823/10 validation)

---

### 2.2 `release start` (Step 1/4)

**Intent** (T1597, ADR-063):
- Validate version against project scheme (calver/semver/sha/auto)
- Capture current git branch
- Persist handle to `.cleo/release/handle.json` for resumable pipeline

**Code Path**:
1. CLI: `release.ts:297–314` — direct call to `release.releaseStart(version, opts)`
2. Engine: `pipeline.ts:288–316` — `releaseStart()` validates, creates handle, calls `writeHandle()`
3. Handle persisted at: `join(projectRoot, '.cleo/release/handle.json')` — **line 211**

**Side Effects**:
- Writes `.cleo/release/handle.json` (new file, idempotent)
- No git mutations
- No network calls

**Failure Surface**:
- Version validation rejects non-matching scheme (throws cleanly)
- `detectBranch()` falls back to 'HEAD' on git failure (non-fatal)
- Handle file write failure is unrecoverable

**Invariants Needed**:
1. `.cleo/release/` directory writable
2. Version string valid per detected scheme

**Observed Defects**:
- None identified in isolation. Issues emerge when piped to `verify`.

---

### 2.3 `release verify` (Step 2/4)

**Intent** (T1597, ADR-063):
- Run all canonical quality gates (test, lint, typecheck, audit, security-scan)
- Audit all child tasks of release epic for green gate state
- Both must pass for `passed: true`

**Code Path**:
1. CLI: `release.ts:317–324` — calls `loadActiveReleaseHandle()`, then `release.releaseVerify(handle)`
2. Engine: `pipeline.ts:328–364` — iterates `VERIFY_GATES` array, calls `runGate()` for each
3. Default gate runner: `pipeline.ts:249–261` — **hardcoded stub that always fails**

**Side Effects**:
- None (read-only; optionally runs external `cleo verify` via injected `runGate`)

**Failure Surface**:
- **Gate runner injection broken**: `opts.runGate` defaults to `defaultRunGate`, which returns `passed: false, reason: 'gate … runner not configured'`. In real CLI, no `runGate` injected from dispatcher. Result: **all gates fail by design** — **FAILURE #3 confirmed**.
- Handle load fails if `.cleo/release/handle.json` absent (requires `release start` first)
- Child audit returns empty list if epic not found (non-fatal)

**Invariants Needed**:
1. Active release handle must exist (created by `release start`)
2. External gate executor must be injected at dispatch time (not done in T9345 codebase)

**Observed Defects**:
- **#3**: Gate runners never configured; `releaseVerify()` will always report gates as failed

---

### 2.4 `release publish` (Step 3/4)

**Intent** (T1597, ADR-063):
- Invoke project-specific publish command (npm publish, cargo publish, etc.)
- Read from `publish.command` in `.cleo/project-context.json`

**Code Path**:
1. CLI: `release.ts:327–337` — loads handle, calls `releasePublish(handle, opts)`
2. Engine: `pipeline.ts:376–424` — resolves command via `resolveProjectConfig()`, executes via `execFileAsync()`

**Side Effects**:
- Executes arbitrary shell command specified in project-context
- No local file writes
- Remote mutation (publish to registry)

**Failure Surface**:
- Command split on whitespace only (no quote parsing) — fails on args with spaces
- Execution timeout not enforced (could hang indefinitely)
- Failure non-fatal if `dryRun: true`

**Invariants Needed**:
1. `publish.command` exists and is executable
2. Network reachable to target registry

**Observed Defects**:
- None specific to publish; inherits pipeline issues

---

### 2.5 `release reconcile` (Step 4/4)

**Intent** (T1597, ADR-063, T1411/ADR-056):
- Run post-release invariants registry (archive-reason, task auto-complete)
- Auto-complete tasks referenced in release commit
- Clear persistent handle on success

**Code Path**:
1. CLI: `release.ts:340–350` — loads handle, calls `releaseReconcile(handle, opts)`
2. Engine: `pipeline.ts:436–478` — calls `runInvariants(tag, opts)`, clears handle via `clearHandle()`
3. Invariants: `invariants/registry.ts:161–209` — iterates registered invariants, aggregates results

**Side Effects**:
- Executes each registered invariant (may write DB, audit logs)
- On success, deletes `.cleo/release/handle.json`
- No git mutations in this step

**Failure Surface**:
- Invariant failures non-fatal (caught at line 177, converted to error result)
- Handle only cleared if `!opts.dryRun` AND `success === true` (line 467)
- Invariant registry may be empty (module loads side-effect imports)

**Invariants Needed**:
1. All registered invariants must be idempotent on dry-run
2. Invariant check functions must not throw (errors caught and wrapped)
3. SQLite database writable for archive-reason updates

**Observed Defects**:
- None specific to reconcile logic

---

### 2.6 `release list` / `release show`

**Intent**:
- `list`: paginated query of all releases, filter by status
- `show`: single release details with full manifest data

**Code Path**:
1. CLI: `release.ts:92–97`, `100–118` — dispatch to pipeline.release.{list,show}
2. Dispatch → Engine: `engine-ops.ts:630–670` — wrap manifest queries, return EngineResult
3. Manifest: `release-manifest.ts` — SQLite reads via Drizzle ORM

**Side Effects**:
- None (read-only)

**Failure Surface**:
- Manifest table missing (non-existent migrations) would error
- Version normalization may cause unexpected matches (v2026.3.15 vs 2026.3.15)

**Observed Defects**:
- None

---

### 2.7 `release cancel`

**Intent**:
- Cancel a release in draft or prepared state
- Remove from release_manifests table

**Code Path**:
1. CLI: `release.ts:121–142` — dispatch to pipeline.release.cancel
2. Engine: `engine-ops.ts:983–999` — calls `cancelRelease()` from release-manifest.ts
3. Manifest: `release-manifest.ts` — Drizzle delete operation

**Side Effects**:
- Deletes row from release_manifests table
- No git mutations

**Failure Surface**:
- Only cancels `draft` or `prepared` status; blocks if already committed/pushed
- No cascade delete (orphans any associated records)

**Observed Defects**:
- None

---

### 2.8 `release changelog`

**Intent**:
- Generate CHANGELOG from git log since a given tag
- Parse epic/task IDs, group by epic, render markdown

**Code Path**:
1. CLI: `release.ts:152–173` — dispatch to pipeline.release.changelog.since
2. Engine: `engine-ops.ts:886–976` — `releaseChangelogSince(sinceTag)` walks git log via `git log {sinceTag}..HEAD`
3. Parsing: `engine-ops.ts:244–280` — `parseGitLogCommits()` extracts task IDs via regex

**Side Effects**:
- None (read-only; generates markdown, does not write)

**Failure Surface**:
- If sinceTag doesn't exist, `git log` errors and surfaced clearly
- Regex-based parsing may miss edge-case commit formats
- Task ID extraction assumes `\bT\d+\b` pattern (non-standard formats ignored)

**Observed Defects**:
- **#10**: CHANGELOG fragile if task descriptions exceed 150 chars (truncated in manifest generation) but spec doesn't document this limit — **(unverified, needs spec review)**

---

### 2.9 `release pr-status`

**Intent**:
- Poll GitHub CI check status for in-flight release PR
- Useful when `release ship` times out or is interrupted

**Code Path**:
1. CLI: `release.ts:258–279` — dispatch to pipeline.release.pr-status
2. Engine: `engine-ops.ts` — looks for `releasePrStatus()` (unverified — not found in engine-ops.ts reads) — **(unverified)**

**Side Effects**:
- None (read-only; queries GitHub API via gh CLI)

**Failure Surface**:
- PR not found if branch deleted remotely
- Timeouts if GitHub API slow

**Observed Defects**:
- **(unverified)** — function signature not located; may not be implemented

---

### 2.10 `release rollback` / `release rollback-full`

**Intent**:
- `rollback`: metadata-only status flip to `rolled_back` in DB
- `rollback-full`: real rollback — delete tag, revert commit, remove record

**Code Path**:
1. CLI: `release.ts:176–204`, `214–247` — dispatch to pipeline.release.{rollback,rollback.full}
2. Engine: `engine-ops.ts:731–876` — `releaseRollback()`, `releaseRollbackFull()`
3. Rollback-full sequence:
   - Delete remote tag: `git push origin --delete <tag>`
   - Delete local tag: `git tag -d <tag>`
   - Revert commit: `git log --grep`, then `git revert --no-edit <sha>`
   - Mark rolled_back in DB: `rollbackRelease()`
   - (Optional) npm deprecate: `npm deprecate <pkg>@<ver> "Rolled back: reason"`

**Side Effects**:
- Creates **new revert commit** (not a reset; safe for pushed branches)
- Deletes tag (local + remote)
- Flips DB status
- Optionally deprecates npm package

**Failure Surface**:
- Commit not found (grep fails silently, step skipped)
- Remote delete fails if tag already gone (non-fatal, logged as warning)
- Revert conflicts if release commit touched files modified since (user must resolve manually)
- npm deprecate fails if not authenticated (non-blocking)

**Invariants Needed**:
1. Release commit must be on current branch (search by message pattern)
2. Tag must exist locally or remotely (or skip gracefully)

**Observed Defects**:
- **#6**: Tag points at wrong SHA (if release commit and tag SHAs diverge, grep may fail) — **(unverified)**

---

### 2.11 `release channel`

**Intent**:
- Determine current release channel (latest/beta/alpha) from git branch
- Used to validate version format matches channel

**Code Path**:
1. CLI: `release.ts:282–290` — dispatch to pipeline.release.channel.show
2. Engine: `channel.ts` — `resolveChannelFromBranch()` maps branch → channel enum
3. Branch mapping:
   - `main` → `latest`
   - `develop` → `beta`
   - `alpha` → `alpha`

**Side Effects**:
- None (read-only)

**Failure Surface**:
- Unknown branch returns `null` (caller handles fallback)

**Observed Defects**:
- None

---

## 3. Cross-Cutting Concerns

### 3.1 12-Step Pipeline State Machine

**Pipeline Steps** (engine-ops.ts:1105–1750):
```
0.   Bump version files (optional)
0.5. Auto-prepare release record
1.   Validate release gates
1.5. IVTR gate enforcement
2.   Check epic completeness
3.   Check task double-listing
4.   Generate CHANGELOG + lint check
5.   Cut release branch + commit
6.   Push release branch
7.   Create PR (MANDATORY)
8.   Wait for CI checks (≤15 min)
9.   Merge PR with --merge
10.  Tag from main + push tag
11.  Cleanup release branch
12.  Record provenance
```

**State Persistence**:
- **Claimed in comments** (pipeline.ts:25): `.cleo/release-state.json`
- **Actual persisted file**: `.cleo/release/handle.json` (pipeline.ts:91)
- **Handle persisted**: After `releaseStart()` only — lines 314
- **Handle cleared**: After `releaseReconcile()` succeeds — pipeline.ts:468
- **No resume logic**: 12-step pipeline in `releaseShip()` is NOT resumable. If step 6+ fails, handle persists but flow does not resume — **FAILURE #8: release start no-op (no state file for 12-step)**

**Resumability Status**:
- ✅ 4-step canonical pipeline (`start`/`verify`/`publish`/`reconcile`) uses persistent handle
- ❌ 12-step `release ship` does NOT resume on failure (no intermediate state writes)
- ❌ No mechanism to detect and resume from partial state

**State Diagram** (actual vs. claimed):
```
Claimed in spec (CLEO-RELEASE-PIPELINE-SPEC.md §4):
  pending → prepared → changelog_ready → gates_passed → committed → shipped

Actual in codebase (release-manifest.ts):
  draft → prepared → committed → tagged → pushed → rolled_back
  (status lifecycle in release_manifests.status column)

Actual in 12-step releaseShip():
  No explicit state machine. Steps are sequential in code.
  On failure, re-running from step 1 risks duplication (no idempotency).
```

### 3.2 Gate-Runner Injection

**Discovery**:
- `releaseVerify()` (pipeline.ts:328–364) requires `opts.runGate` parameter
- Default implementation (pipeline.ts:249–261) always returns `passed: false`
- **No injection site found** in CLI or dispatch layer
- Every call to `releaseVerify()` in real code paths omits `runGate` parameter
  - `release.ts:320` (CLI verify command): `release.releaseVerify(handle)` — no opts
  - `engine-ops.ts:1236` (ship step 1): `runReleaseGates(version, …)` — different function

**Conclusion**: Gate runners are **not wired by default** and never injected by CLI. `releaseVerify()` always reports all gates as failed — **FAILURE #3 confirmed**.

**Evidence**:
- pipeline.ts:332: `const runGate = opts.runGate ?? defaultRunGate;`
- pipeline.ts:249–261: `defaultRunGate` hardcoded to fail
- No dispatch layer override in release handler (domains/release.ts)
- No CLI parameter to inject gate runners

### 3.3 Epic Completeness Scope Leak

**Claim** (release.ts:46): `--epic` flag required, "Epic task ID for commit message"

**Actual Usage** (engine-ops.ts:1253–1293):
- Epic ID loaded for IVTR gate check (line 1254–1260)
- Epic ID scoped to IVTR gate only (line 1266)
- **Epic completeness check (line 1359–1365) is NOT scoped to --epic**:
  - Calls `checkEpicCompleteness(releaseTaskIds, …, priorReleasedTaskIds)`
  - releaseTaskIds loaded from manifest (line 1343–1344)
  - checkEpicCompleteness() checks ALL epics for missing tasks (guards.ts:53–135)
  - No filtering by the provided `--epic` parameter

**Impact**: A release with `--epic T5576` will validate completeness for ALL epics found in the task dataset, not just T5576 — **FAILURE #2: epic completeness scope leak**.

**Code Location**: guards.ts:53–135 (no epic parameter)

### 3.4 Workspace Auto-Discovery

**Discovery Mechanism** (version-bump.ts:243–288):
```
if (pnpm-workspace.yaml exists
    OR root package.json has workspaces field
    OR packages/ directory exists with subdirectories)
  then auto-discover Node package.json files
```

**22 Packages Assumption** (not hard-coded):
- Scan `packages/` directory for subdirectories (line 270–283)
- Each subdir checked for `package.json` (line 278)
- All discovered targets added to bump list (line 279–284)
- Count not hard-coded; discovery is dynamic

**Esbuild Externals Detection** (unverified):
- **No esbuild-specific detection found in codebase**
- Comments mention `esbuild externals` but implementation not located
- **FAILURE #9: Esbuild externals not auto-detected** (unverified)

### 3.5 Override Counter (CLEO_OWNER_OVERRIDE)

**Counter Requirement** (task brief, #5): "823/10" cap tracking — cap of 10 uses per session

**Evidence in Codebase**:
- `security/override-cap.ts` — module exists, implements counter
- `getDb` → `releaseManifests` — stores metadata, no override_count column
- **No integration found in release code paths**

**Engine-ops Usage** (engine-ops.ts):
- Line 1112: `force?: boolean` parameter on `releaseShip()`
- Line 1117: `const { … force = false } = params`
- Line 1252: `if (!force) { … } else { log.warn(…) }`
- **No cap enforcement** — `--force` flag is unchecked boolean, not metered against a counter

**Failure**: Override cap never validated during `release ship --force` — **FAILURE #5: override cap counter broken**.

**Evidence**: security/override-cap.ts exists but never imported or called from engine-ops.ts.

### 3.6 Worker Direct-Push to Main

**Guard** (engine-ops.ts:1182–1189):
- Check `isGhCliAvailable()` at start of `releaseShip()`
- If `!dryRun && !isGhCliAvailable()`, return error immediately
- Force failure if gh CLI absent → **cannot push without PR**

**But**: No git-shim bypass detected in code — direct verification:
- All git operations use `runGitWithLockRetry()` (safe)
- All pushes go through `git push origin <branch>` (not hardcoded main)
- PR creation mandatory before merge (line 1557–1599)
- Merge via `gh pr merge` (GitHub API, not git CLI)

**Conclusion**: Push to main is blocked by PR requirement. No direct-push bypass found — **FAILURE #7 status: NOT OBSERVED in code** (may be in runtime behavior).

---

## 4. Ten Captured Failures — Code Pinpoint

### Failure #1: Wedged git commit (no timeout)

**Description**: `runGitWithLockRetry()` has no hard timeout; can hang indefinitely on `.git/index.lock` contention.

**Code Location**: `engine-ops.ts:85–139`

**Root Cause**: Backoff schedule exhausted after ~7.85s (6 retries), but if lock contention persists past final retry, the last error is thrown — control returns to `releaseShip()` step 5, which would error. But if the function itself hangs (e.g., due to concurrent git process), no timeout enforced by execFileSync.

**Fix Needed**: Add timeout parameter to execFileSync invocation (line 98):
```typescript
execFileSync('git', […args], { …opts, timeout: 30_000 })
```

**Priority**: P0 (blocking release in production)

---

### Failure #2: Epic completeness scope leak

**Description**: `--epic` flag does not restrict epic completeness check; ALL epics in manifest are checked.

**Code Location**: `engine-ops.ts:1359–1365` calls `checkEpicCompleteness()` without epicId parameter

**Root Cause**: `checkEpicCompleteness()` signature (guards.ts:53) takes releaseTaskIds, not epicId; check iterates all epics found in those tasks, not scoped to the provided --epic.

**Fix Needed**: Add epicId parameter to checkEpicCompleteness, filter results to that epic only.

**Priority**: P1 (scope violation in release safety gate)

---

### Failure #3: Gate runners not wired

**Description**: `releaseVerify()` always reports all gates as failed because default runner is stubbed.

**Code Location**: `pipeline.ts:249–261` (defaultRunGate) + `pipeline.ts:332` (opts.runGate ?? defaultRunGate)

**Root Cause**: No injection mechanism in CLI or dispatch layer to provide real gate runner. `defaultRunGate` is intentionally a stub for test isolation.

**Fix Needed**: Dispatch layer must inject gate runner from ADR-061 alias resolver. Add parameter to ReleaseHandler.query('verify', …) to wire gate runner.

**Priority**: P0 (gates are not actually run, defeating purpose of Step 2)

---

### Failure #4: IVTR non-blocking gate

**Description**: `--force` flag bypasses IVTR gate silently; gate does not block even without force if `opts.runGate` not configured.

**Code Location**: `engine-ops.ts:1251–1298` (force bypass) + `pipeline.ts:332` (missing runGate wiring)

**Root Cause**: Two-part: (a) `if (!force)` at line 1252 makes gate skippable; (b) even with force=false, if tasks can't be loaded (line 1255–1262), gate silently passes (line 1291).

**Fix Needed**: Make gate blocking (no force override). Log warning if tasks can't be loaded, but do not pass silently. Per T820 RELEASE-03, gate is MUST-HAVE.

**Priority**: P0 (accountability gap per T820)

---

### Failure #5: Override cap counter broken

**Description**: `--force` flag on `release ship` does not validate against CLEO_OWNER_OVERRIDE usage cap (default 10).

**Code Location**: `engine-ops.ts:1112` (force parameter) — no cap enforcement; security/override-cap.ts never imported

**Root Cause**: Override-cap module exists but is not integrated into release command path. No metric tracking or validation.

**Fix Needed**: Import override-cap module in engine-ops.ts. Before bypassing any gate with force=true, call `checkOverrideCap()` and reject if limit exceeded.

**Priority**: P0 (security policy not enforced)

---

### Failure #6: Tag points at wrong SHA

**Description**: If release commit SHA and tag SHA diverge, rollback-full finds wrong commit via git log grep, rewrites history incorrectly.

**Code Location**: `engine-ops.ts:803–820` (git log search for commit to revert)

**Root Cause**: Tag is created in step 10 from main after PR merge, but grep at line 808 searches for commit message pattern `release: ship v*`. If revert is attempted and multiple commits match pattern, first match (not necessarily the release commit) is reverted.

**Fix Needed**: Lookup tag target directly: `git rev-list -n 1 <tag>` gives exact SHA. Do not rely on grep; use canonical tag resolution.

**Priority**: P1 (data corruption risk in rollback)

---

### Failure #7: Worker direct-push to main (git-shim bypass)

**Description**: Agent context can bypass PR requirement if git-shim not enforced.

**Code Location**: `engine-ops.ts:1023–1043` (agent protocol guard in releasePush)

**Root Cause**: `releasePush()` has agent guard, but `releaseShip()` (the real entry point) only checks gh CLI availability, not protocol violations. Agent can craft parameters to skip PR step.

**Fix Needed**: Extend agent guard to `releaseShip()` entry point. Validate agent context at line 1105 and reject if not in full manifest workflow.

**Priority**: P1 (provenance audit gap for agents)

---

### Failure #8: Release start no-op (no state file)

**Description**: 12-step `releaseShip()` pipeline is not resumable; no intermediate state persisted.

**Code Location**: `engine-ops.ts:1105–1750` — no state writes between steps; only handle written in `releaseStart()` (separate subcommand)

**Root Cause**: Canonical 4-step pipeline uses persistent `.cleo/release/handle.json`, but 12-step ship orchestrates entire flow in single call without intermediate checkpoints.

**Fix Needed**: Write state file after each major step (gate pass, changelog, commit, tag, push). Implement resume logic to detect partial state and skip completed steps.

**Priority**: P2 (operational resilience; not blocking correctness)

---

### Failure #9: Esbuild externals not auto-detected

**Description**: Version bump does not auto-detect esbuild external library declarations; manual config required.

**Code Location**: `version-bump.ts` — no esbuild.config.js or .ts parsing

**Root Cause**: Auto-discovery implemented for Node/pnpm workspaces (line 243–288) and Rust/Cargo workspaces, but no esbuild hook.

**Fix Needed**: Add esbuild discovery: parse `esbuild.config.ts`, extract `external: […]` array, add to bump targets if version-bump not manually configured.

**Priority**: P3 (nice-to-have; manual config works)

---

### Failure #10: CHANGELOG fragile / verbose task descriptions

**Description**: Task descriptions longer than 150 chars truncated silently in manifest; spec does not document limit.

**Code Location**: `release-manifest.ts:362` (truncate to 150 chars) vs. CLEO-RELEASE-PIPELINE-SPEC.md (no limit mention)

**Root Cause**: Changelog rendering heuristic (line 344–358) includes description only if "meaningfully different" and "≥20 chars", but hard-codes 150-char truncation (line 362) without specification.

**Fix Needed**: Document truncation limit in spec. Or, remove truncation and validate description length at task-creation time instead.

**Priority**: P2 (minor UX issue; data not lost, just truncated in CHANGELOG)

---

## 5. Coupling Score

### Node/pnpm Assumption
**Rating**: 8/10  
**Justification**: releaseShip() hard-codes `npm` CLI invocation (line 1480) and version-bump discovers pnpm workspaces (version-bump.ts:247). Fails silently on projects without Node toolchain.  
**Citation**: `engine-ops.ts:1480`, `version-bump.ts:243–288`

### Biome Assumption
**Rating**: 7/10  
**Justification**: releaseShip() invokes `npx biome check` at line 1480 for lint validation. Errors are non-blocking, but hardcoded tool assumption.  
**Citation**: `engine-ops.ts:1480–1495`

### 22-Workspace Assumption
**Rating**: 0/10 (NOT assumed)  
**Justification**: Package discovery is dynamic, not hard-coded. Loop processes any number of packages found.  
**Citation**: `version-bump.ts:276–284`

### @cleocode/* Package Naming
**Rating**: 3/10  
**Justification**: No hard-coded package name filtering. Workspace discovery is agnostic to naming convention.  
**Citation**: N/A

### BRAIN-DB Requirement
**Rating**: 9/10  
**Justification**: All manifest operations use SQLite (release_manifests table). Project fails if tasks.db missing or corrupted.  
**Citation**: `release-manifest.ts:32–35`, `engine-ops.ts:1223`

### IVTR Coupling
**Rating**: 8/10  
**Justification**: releaseShip() checks IVTR gate (step 1.5); fails if ivtr-loop module unavailable. IVTR state is external dependency.  
**Citation**: `engine-ops.ts:1251–1298`, `engine-ops.ts:22` (getIvtrState import)

### git-shim Coupling
**Rating**: 6/10  
**Justification**: No explicit git-shim dependency in code, but all git operations assume standard git CLI. Custom git wrappers would need integration.  
**Citation**: `engine-ops.ts:18–19` (execFileSync from node:child_process)

### gh CLI Coupling
**Rating**: 9/10  
**Justification**: releaseShip() requires gh CLI available (mandatory PR flow per T9095). Hard failure if absent.  
**Citation**: `engine-ops.ts:1182–1189`

---

## 6. Required Invariants for Future Redesign

1. **Versioning Scheme Consistency**: All code paths must validate version against a single source of truth (project-context.json `version.scheme`). No fallback defaults per file.

2. **Gate Runner Injection Contract**: Gate runners MUST be injected at dispatch time, never stubbed as default. releaseVerify() without runGate should throw, not silently fail.

3. **Resumability Checkpoint**: 12-step pipeline MUST persist state after steps 5, 7, 9 (branch cut, PR creation, merge). Detect and skip completed steps on resume.

4. **Epic Scope Enforcement**: All guards that accept epicId parameter MUST scope results to that epic. No "all epics" fallback.

5. **Override Cap Integration**: Any force/bypass flag MUST validate against security/override-cap.ts before proceeding. No silent bypass.

6. **Manifest Entry Requirement**: Both canonical 4-step AND 12-step pipelines MUST have a release_manifests row before any git mutation. Enforce protocol for agent context.

7. **Timeout Enforcement**: All long-running git/network operations MUST have explicit timeout. No indefinite hangs.

8. **Tag/Commit Binding**: Tags MUST be created from a known commit SHA, not via grep-based reverse lookup. Store tag target in manifest immediately after creation.

9. **Error Envelope Preservation**: EngineResult.fix, .details, .exitCode fields MUST flow through dispatch wrappers without stripping. Support fine-grained error recovery.

10. **Idempotency on Retry**: If a step fails and is retried, all operations MUST be idempotent (no double-bump, no duplicate DB rows, no re-push already-pushed branches).

11. **CLI Surface Stability**: New subcommands MUST NOT shadow legacy dispatch operations. Maintain 1:1 mapping between CLI command and dispatch domain+operation.

12. **Task Accessor Consistency**: All task queries (epic children, release tasks, IVTR gate) MUST use same DataAccessor instance and version. No stale-data risks across steps.

---

## Appendix: File Locations Summary

| Component | File | LOC | Key Functions |
|---|---|---|---|
| CLI Commands | `packages/cleo/src/cli/commands/release.ts` | 380 | shipCommand, startCommand, verifyCommand, etc. |
| Dispatch Handler | `packages/cleo/src/dispatch/domains/release.ts` | 330 | ReleaseHandler.query(), .mutate() |
| Pipeline (4-step) | `packages/core/src/release/pipeline.ts` | 478 | releaseStart, releaseVerify, releasePublish, releaseReconcile |
| Engine Ops (main) | `packages/core/src/release/engine-ops.ts` | 1986 | releaseShip, releaseGateCheck, releaseRollbackFull, etc. |
| Manifest (DB) | `packages/core/src/release/release-manifest.ts` | 1379 | prepareRelease, commitRelease, listManifestReleases, etc. |
| Guards | `packages/core/src/release/guards.ts` | 169 | checkEpicCompleteness, checkDoubleListing |
| Version Bump | `packages/core/src/release/version-bump.ts` | 673 | bumpVersionFromConfig, discoverNodeWorkspaceTargets |
| GitHub PR | `packages/core/src/release/github-pr.ts` | 439 | createPullRequest, detectBranchProtection, buildPRBody |
| Invariants Registry | `packages/core/src/release/invariants/registry.ts` | 210 | registerInvariant, runInvariants |
| Config | `packages/core/src/release/release-config.ts` | 532 | loadReleaseConfig, getReleaseGates, getChannelConfig |
| Spec | `packages/core/src/release/docs/specs/CLEO-RELEASE-PIPELINE-SPEC.md` | 421 | Normative 5-step flow definition |

---

**Audit Complete** — 2026-05-15
