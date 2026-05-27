# E-WORKTREE-IVTR: RCASD Spec — Worktree-Aware Evidence Validation

**Epic**: E-WORKTREE-IVTR  
**Saga**: SG-CLEO-CORE-V2 (T9585)  
**RCASD Version**: 1.0  
**Date**: 2026-05-18  
**Status**: PROPOSED — awaiting decomposition approval  
**Author**: RCASD Architect subagent (Claude Sonnet 4.6)

---

## Table of Contents

1. [Research — Exact Bug Trace](#1-research--exact-bug-trace)
2. [Consensus — Design Decisions and HITL Questions](#2-consensus--design-decisions-and-hitl-questions)
3. [Architecture — Proposed Solution](#3-architecture--proposed-solution)
4. [Specification — RFC 2119 Acceptance Criteria](#4-specification--rfc-2119-acceptance-criteria)
5. [Decomposition — Proposed Tasks](#5-decomposition--proposed-tasks)
6. [Worker Dispatch Plan](#6-worker-dispatch-plan)
7. [Verification Plan](#7-verification-plan)

---

## 1. Research — Exact Bug Trace

### 1.1 Overview of the Execution Path

When a worker agent inside a git worktree runs `cleo verify <taskId> --gate implemented --evidence "commit:<sha>;files:<paths>"`, the following chain fires:

```
packages/cleo/src/cli/index.ts  bootstrap()
  └─ packages/cleo/src/cli/index.ts  startCli()
       └─ packages/cleo/src/cli/commands/verify.ts  verifyCommand.run()
            └─ packages/cleo/src/dispatch/domains/check.ts  gate.set handler
                 └─ packages/core/src/validation/engine-ops.ts  validateGateVerify()
                      └─ packages/core/src/tasks/evidence.ts  validateAtom() → validateCommit()
```

### 1.2 The ALS Bridge (T1873 / ADR-041 §D3)

`packages/cleo/src/cli/index.ts:393-402` — the bootstrap function:

```ts
async function bootstrap(): Promise<void> {
  if (process.env['CLEO_WORKTREE_ROOT']) {
    const { runWithWorktreeScopeFromEnv } = await import('@cleocode/core/internal');
    runWithWorktreeScopeFromEnv(() => {
      void startCli();
    });
  } else {
    void startCli();
  }
}
```

This bridge runs ONLY when `CLEO_WORKTREE_ROOT` is present in the process environment. The spawn pipeline sets this env var in the agent's environment block (`packages/worktree/src/worktree-create.ts:287`):

```ts
CLEO_WORKTREE_ROOT: worktreePath,
CLEO_WORKTREE_BRANCH: branch,
```

When active, `runWithWorktreeScopeFromEnv` (defined at `packages/core/src/paths.ts:133-138`) calls `worktreeScope.run({ worktreeRoot: wtRoot, projectHash: projHash }, fn)`, establishing an AsyncLocalStorage (ALS) scope.

### 1.3 `getProjectRoot()` — Three Relevant Paths

`packages/core/src/paths.ts:481-609` — resolution order:

```
Step 0: ALS worktreeScope.getStore() — FIRST. Returns scope.worktreeRoot if active.
Step 1: CLEO_ROOT / CLEO_PROJECT_ROOT env var — bypass walk entirely.
Step 2: CLEO_DIR absolute path — derive project root from dirname.
Step 2.5: T9092 gitlink detection — if cwd/.git is a FILE (not directory),
          parse gitdir: path, derive mainRepo = dirname(dirname(dirname(gitdir))).
          Returns mainRepo if it has .cleo/ + passes validateProjectRoot().
Step 3: Walk ancestors for .cleo/ with .git/ or package.json sibling.
```

**Step 2.5 canonical example** for a worktree at `~/.local/share/cleo/worktrees/1e3146b7352ba279/T9311/`:

- `.git` content: `gitdir: /mnt/projects/cleocode/.git/worktrees/T9311`
- `mainRepo = dirname(dirname(dirname("/mnt/projects/cleocode/.git/worktrees/T9311")))`
  `= dirname(dirname("/mnt/projects/cleocode/.git/worktrees"))`
  `= dirname("/mnt/projects/cleocode/.git")`
  `= "/mnt/projects/cleocode"`
- `/mnt/projects/cleocode/.cleo` exists and `validateProjectRoot()` passes
- **Returns** `/mnt/projects/cleocode`

### 1.4 Primary Bug: HEAD-Ancestry Check Against Wrong HEAD

`packages/core/src/tasks/evidence.ts:468-478`:

```ts
const reachable = await runCommand(
  'git',
  ['merge-base', '--is-ancestor', sha, 'HEAD'],
  projectRoot,          // <-- THIS IS THE BUG SITE
);
if (reachable.exitCode !== 0) {
  return {
    ok: false,
    reason: `Commit ${sha} exists but is not reachable from HEAD`,
    codeName: 'E_EVIDENCE_INVALID',
  };
}
```

**Bug A** (primary IVTR blocker): When `CLEO_WORKTREE_ROOT` is NOT set in the agent's environment (or the ALS bridge is not active for any reason), `getProjectRoot()` falls through to step 2.5 and returns the **main repo root**. The `git merge-base --is-ancestor <sha> HEAD` command then runs with `cwd=mainRepo`, where `HEAD` points to the current tip of the main branch (e.g., `fix/T9580-cli-dispatch-bugs` at SHA `5a9474d5a`).

A commit that only exists on `task/<taskId>` — which is the entire purpose of IVTR workflow — is by construction **NOT** an ancestor of the main branch HEAD until the PR is merged. This causes the verify to fail with `E_EVIDENCE_INVALID: Commit <sha> exists but is not reachable from HEAD`.

**The fix needed**: The `--is-ancestor` check must use `task/<taskId>` as the "HEAD" reference (or the effective worktree HEAD), not `HEAD` in the main repo.

### 1.5 Bug B: T9178 Branch-Scope Check Uses Same Wrong `projectRoot`

`packages/core/src/tasks/evidence.ts:486-502`:

```ts
if (taskId) {
  const branchRef = `task/${taskId}`;
  const branchExists = await runCommand('git', ['rev-parse', '--verify', branchRef], projectRoot);
  if (branchExists.exitCode === 0) {
    const onBranch = await runCommand(
      'git',
      ['merge-base', '--is-ancestor', sha, branchRef],
      projectRoot,     // <-- Uses same potentially-wrong projectRoot
    );
```

When `projectRoot` is the main repo root, the T9178 check actually _passes_ because `task/<taskId>` IS resolvable from the main repo's git metadata (all branches are accessible from the main gitdir). So Bug B is not itself a blocker — it happens to work correctly because all branch refs are accessible from the main gitdir regardless of `cwd`. But it is architecturally wrong: it only works because git shares its object store.

### 1.6 Bug C: Content-Intersect Uses Stale tasks.db When ALS Is Active

`packages/core/src/tasks/evidence.ts:627-685` — `checkCommitContentIntersect`:

```ts
const { getTaskAccessor } = await import('../store/data-accessor.js');
const accessor = await getTaskAccessor(projectRoot);  // projectRoot from getProjectRoot()
task = await accessor.loadSingleTask(taskId);
```

When `CLEO_WORKTREE_ROOT` IS set correctly and the ALS scope is active, `getProjectRoot()` returns the **worktree path**. The worktree's `.cleo/tasks.db` is a **point-in-time copy** made during spawn (`packages/worktree/src/worktree-create.ts` bootstrap step). This copy is stale:

- If the orchestrator updates `task.files` or `task.acceptance` after spawn (e.g., narrowing the AC scope), the worktree DB does not reflect the change.
- If a task was created with an `acceptance` string containing file paths, the copy may be missing them if the string was updated post-spawn.
- The stale DB produces a mismatched `acFiles` list, causing `diffIntersectsAc()` to return `false` even when the commit correctly modifies the declared files.

**Manifestation**: The error report shows identical file lists in both "Diff touched" and "AC declared" fields — this happens when `acFiles` is derived from a stale DB copy where the original AC text before spawn _matched_ the correct paths, but the normalization differs from the paths in `git show --name-only` output (e.g., `./packages/foo` vs `packages/foo`). However, the most common manifestation is simply that the stale DB has `task.files = []` and no AC strings that parse to paths, causing `acFiles = null` (vacuous pass) — but if the post-spawn orchestrator added files via `--files`, the stale copy still has `task.files = []` and the check passes vacuously instead of enforcing the correct AC.

**Note**: When Bug C causes a vacuous pass (acFiles = null), it represents a security regression — the content-intersect T9245 hardening is silently bypassed for agents using worktrees correctly. When it causes a false failure, it represents an IVTR blocker.

### 1.7 Critical Path Summary

The two scenarios that block IVTR:

**Scenario 1** (most common): Agent spawned by orchestrator without `CLEO_WORKTREE_ROOT` in its environment (harness adapter does not inject it, or the worker runs `cleo verify` in a subprocess that doesn't inherit the env var):

```
cleo verify TXXX --gate implemented --evidence "commit:abc123;files:packages/foo/src/bar.ts"
  → getProjectRoot() → /mnt/projects/cleocode (main repo, step 2.5)
  → validateCommit(abc123, /mnt/projects/cleocode)
  → git merge-base --is-ancestor abc123 HEAD (cwd=/mnt/projects/cleocode)
  → HEAD = main branch tip (5a9474d5a)
  → abc123 not on main yet → EXIT 1
  → E_EVIDENCE_INVALID: "Commit abc123 exists but is not reachable from HEAD"
```

**Scenario 2**: Agent spawned with `CLEO_WORKTREE_ROOT` set, but stale tasks.db breaks content-intersect:

```
CLEO_WORKTREE_ROOT=/home/.local/share/.../TXXX cleo verify TXXX --gate implemented --evidence "commit:abc123;files:packages/foo/src/bar.ts"
  → getProjectRoot() → /home/.local/share/.../TXXX/ (ALS, step 0)
  → validateCommit(abc123, /home/.local/share/.../TXXX/)
  → git merge-base --is-ancestor abc123 HEAD (cwd=worktreePath)
  → HEAD in worktree = task/TXXX tip = abc123 → EXIT 0 ✓
  → checkCommitContentIntersect(abc123, TXXX, /home/.local/share/.../TXXX/)
  → getTaskAccessor(/home/.local/share/.../TXXX/) → opens STALE tasks.db
  → task.files = [] or missing paths (stale DB)
  → acFiles = null (vacuous pass) → security bypass
    OR acFiles = ["wrong/paths"] → false failure
```

### 1.8 File:Line Reference Table

| File | Lines | What |
|------|-------|------|
| `packages/core/src/tasks/evidence.ts` | 468-478 | BUG A: HEAD-ancestry check against main HEAD |
| `packages/core/src/tasks/evidence.ts` | 486-502 | T9178 branch-scope check (works by accident) |
| `packages/core/src/tasks/evidence.ts` | 627-685 | BUG C: content-intersect uses stale tasks.db |
| `packages/core/src/paths.ts` | 481-609 | `getProjectRoot()` — full resolution ladder |
| `packages/core/src/paths.ts` | 511-536 | Step 2.5 gitlink detection (T9092) |
| `packages/core/src/paths.ts` | 482-488 | Step 0 ALS scope check |
| `packages/cleo/src/cli/index.ts` | 393-402 | `bootstrap()` — ALS bridge entry point |
| `packages/worktree/src/worktree-create.ts` | 282-293 | Env vars set for spawned agent |
| `packages/contracts/src/branch-lock.ts` | 314-319 | `ISOLATION_ENV_KEYS` — canonical env key list |

---

## 2. Consensus — Design Decisions and HITL Questions

### 2.1 Accepted Decisions

**D-WT-01**: The fix MUST be surgical. The `validateCommit` function must resolve the "effective HEAD" for the ancestry check without changing the semantics of `projectRoot` for everything else. A flag parameter (`effectiveHead?: string`) is the cleanest boundary.

**D-WT-02**: The effective HEAD for the `--is-ancestor` check is `task/<taskId>` when a `taskId` is provided and the branch exists. This is already the semantically correct reference: "is this commit reachable from the agent's branch?" When the task branch does not exist (meta-task, owner-driven completion), fall back to `HEAD` in `projectRoot`. This matches existing T9178 logic intent.

**D-WT-03**: The content-intersect DB staleness fix (Bug C) requires that `checkCommitContentIntersect` ALWAYS reads from the canonical (main) project DB, regardless of `getProjectRoot()` resolution. This means `checkCommitContentIntersect` needs the main project root, not the worktree path, for its DB read. The git operations inside it (like `gitShowFiles`) already use `projectRoot` for `cwd` — this is fine because git shares its object store across worktrees.

**D-WT-04**: The `packages/worktree/` package MUST own a new exported primitive `getEffectiveHead(projectRoot: string, taskId?: string): Promise<string>` that resolves the correct ref to use for ancestry checks. Rationale: centralizing this logic prevents future callers from re-inventing it and provides a single point for testing.

**D-WT-05**: The worktree's `.cleo/tasks.db` is read-only from the perspective of gate verification. The MAIN repo's `tasks.db` is authoritative for all task metadata reads during `cleo verify`. This is a hard architectural constraint.

**D-WT-06**: `CLEO_WORKTREE_ROOT` being set means the DB path diverges from the git ancestry path. `getProjectRoot()` MUST return the worktree path when ALS is active (existing behavior) but git operations inside `validateCommit` MUST use the effective worktree branch for ancestry, not `HEAD` of wherever `projectRoot` resolves.

**D-WT-07**: Worker dispatch plan: since `cleo release` is broken, all task work flows through manual git operations: commit on `task/<taskId>` branch, push, open PR, merge. The orchestrator observes merge via `git log --grep` and marks tasks complete after merge.

### 2.2 Open HITL Questions (Require Owner Decision)

**Q1** (HIGH): Should `getEffectiveHead` live in `packages/worktree/` or `packages/core/src/tasks/`?

- Option A: `packages/worktree/src/` — architecturally correct (worktree concern), but creates a new dependency from `packages/core` on `packages/worktree`.
- Option B: Inline in `packages/core/src/tasks/evidence.ts` — avoids new dep, less reusable.
- Option C: New file `packages/core/src/worktree/effective-head.ts` — keeps it in core but scoped to worktree concerns.

**Recommendation**: Option C. `packages/core` already has `packages/core/src/worktree/` (see `force-unlock.ts`, `prune.ts`, `list.ts`). The function is a git primitive that belongs in the worktree subdirectory of core.

**Q2** (MEDIUM): Should `cleo verify` read from MAIN DB always, or should it prefer the worktree DB when it's fresh enough?

- Option A: Always read from main DB for all task metadata during verify — simple and safe.
- Option B: Check DB modification time; use main DB if worktree DB is older than N minutes — complex, fragile.

**Recommendation**: Option A. Always read from main DB. The worktree DB is a bootstrap convenience (for `cleo show`, `cleo focus`, `cleo next`), not an authoritative source for verification.

**Q3** (LOW): The T9245 content-intersect hardening introduced a security gate. Bug C potentially defeats this gate for all worktree-spawned agents when their tasks.db is stale. Should we add a CI integration test that:
  1. Creates a worktree
  2. Spawns a fake agent that commits to the task branch
  3. Runs `cleo verify` from the worktree with correct evidence
  4. Verifies no `E_EVIDENCE_CONTENT_MISMATCH` false failure occurs

**Recommendation**: Yes. This should be a BATS integration test in T-WT-6 (Verification task).

**Q4** (LOW): When `getEffectiveHead` determines the effective HEAD is `task/<taskId>`, should it also confirm that `HEAD` in the worktree already points there? This would add a safety check that the ALS scope is consistent with the git state.

**Recommendation**: No. Keep it simple. The effective-head function resolves a ref string; it does not validate ALS state. ALS consistency is the responsibility of `bootstrap()`.

---

## 3. Architecture — Proposed Solution

### 3.1 New Primitive: `getEffectiveHead`

**Location**: `packages/core/src/worktree/effective-head.ts`

```ts
/**
 * Resolve the effective HEAD ref for commit-ancestry validation in worktree contexts.
 *
 * When a taskId is provided and `task/<taskId>` exists as a git ref in the
 * repository at `projectRoot`, returns `"task/<taskId>"` as the ancestry target.
 * This ensures `git merge-base --is-ancestor <sha> <effectiveHead>` validates
 * against the worker's branch rather than the main branch tip.
 *
 * Falls back to `"HEAD"` when:
 *   - taskId is not provided (legacy callers)
 *   - `task/<taskId>` does not exist as a ref (meta-tasks, owner-driven completion)
 *   - git command fails (best-effort tolerance)
 *
 * @param projectRoot - Absolute path to the git repository root (main repo or worktree).
 * @param taskId - Optional CLEO task ID (e.g. "T9586"). When provided, attempt to
 *   use the task branch ref as the effective HEAD.
 * @returns The git ref string to use in `--is-ancestor` checks.
 *
 * @task T-WT-1
 */
export async function getEffectiveHead(
  projectRoot: string,
  taskId?: string,
): Promise<string> {
  if (!taskId) return 'HEAD';
  const branchRef = `task/${taskId}`;
  // Use runCommand (same helper as validateCommit) so we share timeout behavior.
  const check = await runCommand('git', ['rev-parse', '--verify', branchRef], projectRoot);
  if (check.exitCode === 0) return branchRef;
  return 'HEAD';
}
```

This primitive is intentionally narrow: it resolves a ref string and nothing else. It makes no DB calls, has no side effects, and is safe to call from any context.

### 3.2 Modified `validateCommit` in `packages/core/src/tasks/evidence.ts`

**Change**: Replace `'HEAD'` literal on line 470 with `await getEffectiveHead(projectRoot, taskId)`.

Before (lines 468-478):
```ts
const reachable = await runCommand(
  'git',
  ['merge-base', '--is-ancestor', sha, 'HEAD'],
  projectRoot,
);
```

After:
```ts
const effectiveHead = await getEffectiveHead(projectRoot, taskId);
const reachable = await runCommand(
  'git',
  ['merge-base', '--is-ancestor', sha, effectiveHead],
  projectRoot,
);
if (reachable.exitCode !== 0) {
  return {
    ok: false,
    reason: `Commit ${sha} exists but is not reachable from ${effectiveHead}`,
    codeName: 'E_EVIDENCE_INVALID',
  };
}
```

**Note**: The T9178 branch-scope check at lines 486-502 uses the SAME `projectRoot` for `git rev-parse --verify task/<taskId>`. This continues to work correctly because git branch refs are accessible from the main gitdir regardless of the worktree's cwd. No change needed to T9178.

### 3.3 Modified `checkCommitContentIntersect` — Canonical DB Resolution

**Location**: `packages/core/src/tasks/evidence.ts:627-685`

The problem: `getTaskAccessor(projectRoot)` where `projectRoot` may be the worktree path when ALS is active, opening the stale worktree tasks.db.

**Fix**: Introduce a `resolveCanonicalProjectRoot(projectRoot)` helper that, given any path (worktree or main repo), returns the canonical main project root. This uses the same gitlink-parsing logic as step 2.5 of `getProjectRoot()`:

```ts
/**
 * Given a project root that may be a git worktree path, resolve the canonical
 * main repository root. When `projectRoot` is already the main repo, returns it
 * unchanged. Used to ensure DB reads always target the authoritative tasks.db.
 *
 * @param projectRoot - Absolute path (may be worktree or main repo root).
 * @returns Absolute path to the canonical main repository root.
 *
 * @task T-WT-2
 */
export async function resolveCanonicalProjectRoot(projectRoot: string): Promise<string> {
  // Check if .git is a gitlink FILE (worktree marker).
  const gitPath = join(projectRoot, '.git');
  try {
    const st = statSync(gitPath);
    if (st.isFile()) {
      const content = readFileSync(gitPath, 'utf-8').trim();
      const match = content.match(/^gitdir:\s*(.+)$/m);
      if (match) {
        const gitdir = match[1].trim();
        // gitdir = <main>/.git/worktrees/<name>
        // strip last 3 path segments to get main repo root
        const mainRepo = dirname(dirname(dirname(gitdir)));
        if (existsSync(join(mainRepo, '.cleo'))) {
          return mainRepo;
        }
      }
    }
  } catch {
    // Not a worktree — return as-is.
  }
  return projectRoot;
}
```

Then in `checkCommitContentIntersect`:

```ts
async function checkCommitContentIntersect(
  sha: string,
  taskId: string,
  projectRoot: string,
): Promise<AtomValidation> {
  // BUG-C FIX: always read task metadata from the canonical (main) DB.
  // When projectRoot is a worktree path, the worktree's tasks.db is a stale
  // spawn-time snapshot. The main DB is authoritative for all task metadata.
  const canonicalRoot = await resolveCanonicalProjectRoot(projectRoot);

  let task = ...;
  try {
    const { getTaskAccessor } = await import('../store/data-accessor.js');
    const accessor = await getTaskAccessor(canonicalRoot);  // USE canonicalRoot
    task = await accessor.loadSingleTask(taskId);
  } catch {
    ...
  }
```

**Note**: The `gitShowFiles` call inside `checkCommitContentIntersect` uses `projectRoot` (not `canonicalRoot`) as the `cwd` for `git show`. This is correct: `projectRoot` may be the worktree path, and git will correctly resolve the commit from any dir that shares the git object database. The important distinction is DB reads (need canonical root) vs git operations (any repo dir works).

### 3.4 Env-Var Passthrough Hardening

The root cause of Scenario 1 is that `CLEO_WORKTREE_ROOT` may not be present when an agent invokes `cleo verify`. This happens when:

1. A harness adapter invokes `cleo verify` in a subprocess that does not inherit `CLEO_WORKTREE_ROOT` from the spawn env.
2. A worker writes a shell script and runs it, losing the env var.
3. The agent SDK does not inject the env vars when creating a subagent.

The fix in section 3.2 makes `validateCommit` worktree-aware WITHOUT relying on `CLEO_WORKTREE_ROOT`. The `getEffectiveHead` function uses `git rev-parse --verify task/<taskId>` to determine the effective HEAD independently of the ALS scope. This eliminates the env-var dependency for the ancestry check.

### 3.5 Architecture Decision Record (ADR entry for this spec)

**Decision**: Worktree-aware HEAD resolution for evidence validation

**Context**: `validateCommit` in the evidence-gate system uses `git merge-base --is-ancestor <sha> HEAD` to confirm a commit is reachable. HEAD in the main repository does not include commits on unmerged task branches, causing false failures for all IVTR worker agents.

**Decision**: Introduce `getEffectiveHead(projectRoot, taskId)` in `packages/core/src/worktree/effective-head.ts`. When `task/<taskId>` exists as a git ref, use it as the ancestry target. This makes the check semantically correct: "is this commit on the agent's branch?" Additionally, always read task metadata from the canonical main DB (resolving gitlinks) to prevent content-intersect false failures against stale worktree-local DB copies.

**Status**: PROPOSED

---

## 4. Specification — RFC 2119 Acceptance Criteria

This section uses RFC 2119 keywords (MUST, SHOULD, MAY, MUST NOT).

### 4.1 Core Requirements

**REQ-1**: `validateCommit` MUST use `getEffectiveHead(projectRoot, taskId)` for the `--is-ancestor` check when `taskId` is provided.

**REQ-2**: `getEffectiveHead` MUST return `"task/<taskId>"` when `git rev-parse --verify task/<taskId>` exits 0 in the provided `projectRoot`.

**REQ-3**: `getEffectiveHead` MUST return `"HEAD"` when `taskId` is not provided, the task branch does not exist, or the git command fails.

**REQ-4**: `checkCommitContentIntersect` MUST read task metadata from the canonical main repository's `tasks.db`, not from a worktree-local copy. It MUST use `resolveCanonicalProjectRoot(projectRoot)` to obtain the main DB path.

**REQ-5**: `resolveCanonicalProjectRoot` MUST detect gitlink FILES (worktree markers) at `<path>/.git` and derive the main repo root from the gitdir path (strip last 3 path components from the gitdir value).

**REQ-6**: `resolveCanonicalProjectRoot` MUST return `projectRoot` unchanged when `.git` is a directory (already main repo) or when the gitlink parse fails.

**REQ-7**: A commit on `task/T<N>` that has NOT been merged to the main branch MUST pass the `--is-ancestor` check when verified with `--gate implemented` and the commit's diff intersects the task's AC files.

**REQ-8**: The error message for ancestry failure MUST include the ref that was checked (e.g., `"not reachable from task/TXXX"`) so agents can diagnose the failure.

### 4.2 Worktree Integration Test

**REQ-9**: An integration test MUST exist that:
1. Creates a fresh git repo with `cleo init`.
2. Creates a task with explicit `--files` pointing to a test file.
3. Creates a git worktree via `createWorktree()`.
4. Commits a change to the test file on the task branch.
5. Calls `validateAtom({ kind: 'commit', sha: <new-sha> }, worktreePath, taskId)`.
6. Asserts the result is `{ ok: true }` (no false failure).

**REQ-10**: The same integration test MUST verify that after the fix, running the same scenario WITHOUT `CLEO_WORKTREE_ROOT` in the environment (i.e., `getProjectRoot()` resolves via gitlink to main repo) also produces `{ ok: true }`.

### 4.3 Non-Regressions

**REQ-11**: Existing behavior when `taskId` is not provided MUST be unchanged. The `--is-ancestor sha HEAD` check MUST continue to use `HEAD` in that case.

**REQ-12**: The T9245 content-intersect gate MUST remain in force. The fix MUST NOT weaken it — it MUST strengthen it by ensuring the canonical DB is always consulted.

**REQ-13**: The T9178 branch-scope check (lines 486-502 of `evidence.ts`) MUST continue to work unchanged. No modification to T9178 logic is required.

**REQ-14**: Override behavior for non-critical gates MUST be unchanged.

**REQ-15**: `cleo verify` invoked from the main repo (not a worktree) MUST work identically to today. `getEffectiveHead` returns `"HEAD"` when the task branch does not exist, and the check proceeds as before.

---

## 5. Decomposition — Proposed Tasks

### Architecture: 1 Epic, 7 Tasks, Each with Atomic Subtasks

**Epic E-WT (T-WT-0)**: Worktree-Aware Evidence Validation

Tasks T-WT-1 through T-WT-7.

---

### T-WT-1: `getEffectiveHead` primitive in `packages/core/src/worktree/`

**Kind**: work | **Sizing**: small | **Priority**: P0

**Acceptance**: `packages/core/src/worktree/effective-head.ts` exports `getEffectiveHead(projectRoot: string, taskId?: string): Promise<string>` that:
- Returns `"task/<taskId>"` when branch exists (git exit 0)
- Returns `"HEAD"` in all fallback cases
- Has TSDoc comments with `@task T-WT-1`
- Is re-exported from `packages/core/src/worktree/index.ts` (or equivalent barrel)

**Files**:
- `packages/core/src/worktree/effective-head.ts` (NEW)
- `packages/core/src/worktree/__tests__/effective-head.test.ts` (NEW)
- `packages/core/src/internal.ts` (add export)

**Evidence pattern**: `commit:<sha>;files:packages/core/src/worktree/effective-head.ts,packages/core/src/worktree/__tests__/effective-head.test.ts`

**Subtasks**:

- **T-WT-1a**: Write `getEffectiveHead` implementation in `effective-head.ts`. Uses the same `runCommand` helper as `evidence.ts` (or import the git spawn helper). Handles: taskId absent, branch exists, branch absent, git error. No DB calls. No side effects. (One window: define function, write TSDoc, export.)

- **T-WT-1b**: Write unit tests for `getEffectiveHead` in a temp git repo. Test matrix: (1) no taskId → "HEAD", (2) branch exists → "task/TXXX", (3) branch absent → "HEAD", (4) git fails → "HEAD". Use `execFileSync` to set up ephemeral repos in `beforeEach`. (One window: write 4 test cases, verify all pass.)

- **T-WT-1c**: Export `getEffectiveHead` from `packages/core/src/internal.ts` (or whichever barrel exports the worktree primitives). Verify no circular deps by running `pnpm run build`. (One window: add one export line, run build, fix any type issues.)

---

### T-WT-2: `resolveCanonicalProjectRoot` in `packages/core/src/tasks/evidence.ts`

**Kind**: work | **Sizing**: small | **Priority**: P0

**Acceptance**: A function `resolveCanonicalProjectRoot(projectRoot: string): string` (synchronous, uses `statSync`/`readFileSync`) is defined in `evidence.ts` or an adjacent file and is used by `checkCommitContentIntersect`. It correctly resolves worktree paths to main repo paths.

**Files**:
- `packages/core/src/tasks/evidence.ts` (modify — add helper + update `checkCommitContentIntersect`)
- `packages/core/src/tasks/__tests__/evidence-content-intersect.test.ts` (modify — add test cases)

**Evidence pattern**: `commit:<sha>;files:packages/core/src/tasks/evidence.ts,packages/core/src/tasks/__tests__/evidence-content-intersect.test.ts`

**Subtasks**:

- **T-WT-2a**: Add `resolveCanonicalProjectRoot(projectRoot: string): string` to `evidence.ts`. It uses synchronous `statSync(join(projectRoot, '.git'))` — sync is acceptable because this is already within an async gate-validation context but avoids adding another Promise in the call chain. Handles: normal dir (return as-is), gitlink file (parse → return mainRepo), parse failure (return as-is). (One window: write function, handle 3 branches.)

- **T-WT-2b**: Modify `checkCommitContentIntersect` to call `const canonicalRoot = resolveCanonicalProjectRoot(projectRoot)` and use `canonicalRoot` for `getTaskAccessor()`. `gitShowFiles()` continues to use `projectRoot` (not `canonicalRoot`). Add a comment explaining the split. (One window: 3-line change + comment.)

- **T-WT-2c**: Add test cases to `evidence-content-intersect.test.ts` verifying that content-intersect correctly reads from the main DB when given a worktree path as `projectRoot`. Create a simulated scenario: init repo at path A, create worktree at path B (with gitlink to A), seed tasks.db in A with a task, call `checkCommitContentIntersect` with `projectRoot=B`. Assert it reads from A's DB. (One window: 1-2 new test cases.)

---

### T-WT-3: Wire `getEffectiveHead` into `validateCommit`

**Kind**: work | **Sizing**: small | **Priority**: P0

**Acceptance**: `validateCommit` in `packages/core/src/tasks/evidence.ts:468-478` uses `getEffectiveHead(projectRoot, taskId)` instead of the literal `'HEAD'`. The error message includes the resolved ref name. The change is backward-compatible: when `taskId` is absent, behavior is unchanged.

**Files**:
- `packages/core/src/tasks/evidence.ts` (modify)
- `packages/core/src/tasks/__tests__/evidence-content-intersect.test.ts` (modify — add worktree-HEAD scenario)

**Evidence pattern**: `commit:<sha>;files:packages/core/src/tasks/evidence.ts`

**Subtasks**:

- **T-WT-3a**: Import `getEffectiveHead` into `evidence.ts`. Replace `'HEAD'` with `await getEffectiveHead(projectRoot, taskId)` at line 470. Update the error reason string to include `effectiveHead`. Run `pnpm biome check --write .` to verify no lint issues. (One window: 3-line change.)

- **T-WT-3b**: Add integration test to `evidence-content-intersect.test.ts` exercising the full flow: init repo, create task branch, commit to task branch, call `validateAtom` with `projectRoot=mainRepo` (simulating step 2.5 resolution) and `taskId` provided. Assert `ok: true`. This is the regression lock for Scenario 1. (One window: 1 test case, ~25 lines including git setup.)

- **T-WT-3c**: Add a second integration test: same scenario but WITHOUT `taskId` provided (backward-compat check). Commit on task branch, call `validateAtom` WITHOUT `taskId`. Assert it returns `ok: false` ("not reachable from HEAD") since the task branch isn't merged. This confirms that the `taskId`-absent behavior is unchanged. (One window: 1 test case.)

---

### T-WT-4: Regression Test Suite for Worktree IVTR Flow

**Kind**: work | **Sizing**: medium | **Priority**: P1

**Acceptance**: A comprehensive test in `packages/core/src/tasks/__tests__/worktree-ivtr.test.ts` covers:
1. Worktree-spawned agent can verify an `implemented` gate with a commit on its task branch (Scenario 1 fix).
2. Content-intersect reads from main DB even when `projectRoot` is the worktree path (Scenario 2 fix / Bug C).
3. The T9178 branch-scope check continues to pass with the same setup.
4. A commit on main (not task branch) fails verification when `taskId` is provided and the branch exists (ensures we didn't weaken the branch-scope check).

All 4 cases pass in CI.

**Files**:
- `packages/core/src/tasks/__tests__/worktree-ivtr.test.ts` (NEW)

**Evidence pattern**: `commit:<sha>;files:packages/core/src/tasks/__tests__/worktree-ivtr.test.ts`

**Subtasks**:

- **T-WT-4a**: Scaffold the test file: define `initGitRepo`, `gitCommitFile`, `createWorktreeDir`, `createFakeGitlink` helpers. Create a `beforeEach` that provisions: a main git repo at a tmpdir, a task in the DB at mainRepo, a worktree dir with a gitlink pointing to mainRepo's `.git/worktrees/TXXX`. (One window: helper functions, beforeEach setup.)

- **T-WT-4b**: Write test case 1 (Scenario 1 fix): commit to task branch in mainRepo, set `projectRoot=mainRepo`, call `validateAtom({ kind: 'commit', sha }, mainRepo, taskId)`. Assert `ok: true`. (One window: one test case.)

- **T-WT-4c**: Write test case 2 (Bug C fix): set `projectRoot=worktreePath` (simulating ALS returning worktree root), call same `validateAtom`. Assert `ok: true` and that the task metadata was read from mainRepo's DB (verify via spy or by seeding different data in each DB). (One window: one test case with spy or distinctive data check.)

- **T-WT-4d**: Write test cases 3 and 4 (non-regression): T9178 branch-scope still blocks a main-branch commit when task branch exists; a commit not on either branch still fails. (One window: two test cases.)

---

### T-WT-5: End-to-End Spawn → Verify Integration Test

**Kind**: work | **Sizing**: medium | **Priority**: P1

**Acceptance**: A test in `packages/worktree/src/__tests__/spawn-verify-e2e.test.ts` exercises the full canonical IVTR pipeline without a live LLM agent:

1. Call `createWorktree(projectRoot, { taskId: 'T-WT-5' })`.
2. Commit a file to the task branch in the created worktree.
3. Call `validateAtom({ kind: 'commit', sha }, projectRoot, 'T-WT-5')` where `projectRoot` is the MAIN repo.
4. Assert `ok: true`.
5. Clean up worktree via `destroyWorktree`.

**Files**:
- `packages/worktree/src/__tests__/spawn-verify-e2e.test.ts` (NEW)

**Evidence pattern**: `commit:<sha>;files:packages/worktree/src/__tests__/spawn-verify-e2e.test.ts`

**Subtasks**:

- **T-WT-5a**: Scaffold test: provision a real git repo with `cleo init` in a tmpdir, create a task record in the DB, call `createWorktree` to provision a real worktree with a gitlink file. (One window: scaffold + repo setup.)

- **T-WT-5b**: Write commit step: use `execFileSync('git', ['commit', ...], { cwd: worktreePath })` to commit a change to the task-owned file. Capture the SHA. Verify the commit is on the task branch but NOT on the main branch tip. (One window: git commit + assertion.)

- **T-WT-5c**: Write verify step: call `validateAtom` with `projectRoot = mainRepoPath` (the canonical path, NOT the worktree path, simulating the real bug scenario). Assert `ok: true`. (One window: one assertion call.)

- **T-WT-5d**: Write cleanup step: call `destroyWorktree`, assert the worktree directory is removed. (One window: cleanup + assertion.)

---

### T-WT-6: Spec Documentation and ADR Update

**Kind**: work | **Sizing**: small | **Priority**: P2

**Acceptance**: `.cleo/adrs/ADR-051-evidence-gate-worktree.md` or an addendum to `ADR-051` documents the worktree-aware extension. The commit that ships T-WT-1 through T-WT-5 passes `pnpm run build` and `pnpm run test` with zero new failures.

**Files**:
- `.cleo/adrs/ADR-051-worktree-extension.md` (NEW — addendum to ADR-051)
- `packages/core/src/tasks/evidence.ts` (verify existing TSDoc updated to reference T-WT tasks)

**Evidence pattern**: `commit:<sha>;files:.cleo/adrs/ADR-051-worktree-extension.md`

**Subtasks**:

- **T-WT-6a**: Write the ADR addendum documenting: (1) the bug, (2) the two fix strategies, (3) the decision to use `getEffectiveHead` + `resolveCanonicalProjectRoot`, (4) implications for future callers of `validateCommit`. (One window: write ADR ~200 lines.)

- **T-WT-6b**: Update TSDoc comments in `evidence.ts` for `validateCommit` and `checkCommitContentIntersect` to reference T-WT-1, T-WT-2, T-WT-3 and explain the worktree-aware behavior. (One window: update 3 TSDoc blocks.)

---

### T-WT-7: CI Green Verification and PR Merge

**Kind**: work | **Sizing**: small | **Priority**: P0 (blocking shipping)

**Acceptance**: The PR containing T-WT-1 through T-WT-6 changes has green CI (lint + typecheck + test). The merge commit SHA is captured as the release anchor.

**Files**: none new (this task is the gate task for the PR pipeline)

**Evidence pattern**: `commit:<merge-sha>;note:CI green on PR merging T-WT-1 through T-WT-6`

**Subtasks**:

- **T-WT-7a**: Run `pnpm biome check --write .` across the entire monorepo. Fix any lint violations introduced by the new files. (One window: run + fix.)

- **T-WT-7b**: Run `pnpm run typecheck` (full `tsc -b` project references). Fix any type errors. (One window: run + fix.)

- **T-WT-7c**: Run `pnpm run test` and confirm zero new failures. Record the test run output. (One window: run + record.)

- **T-WT-7d**: Open PR from `task/E-WT` branch against `main`. Confirm CI passes on the PR. (One window: `git push` + `gh pr create`.)

---

## 6. Worker Dispatch Plan

### 6.1 Sequencing

Tasks T-WT-1 and T-WT-2 are independent and MUST be completed before T-WT-3 (which imports T-WT-1 and uses T-WT-2). T-WT-4 and T-WT-5 depend on T-WT-3 being complete. T-WT-6 can run in parallel with T-WT-4/5. T-WT-7 runs last.

```
T-WT-1 ─┐
          ├─► T-WT-3 ─┬─► T-WT-4 ─┐
T-WT-2 ─┘             └─► T-WT-5 ─┤─► T-WT-7
                                    │
T-WT-6 ─────────────────────────────┘
```

Wave 1 (parallel): T-WT-1, T-WT-2, T-WT-6
Wave 2 (serial): T-WT-3 (depends on Wave 1)
Wave 3 (parallel): T-WT-4, T-WT-5 (depend on T-WT-3)
Wave 4 (serial): T-WT-7 (gate task, depends on all)

### 6.2 Worktree-Per-Task Dispatch

Each task worker spawns in its own worktree under `~/.local/share/cleo/worktrees/<projectHash>/T-WT-N/` on branch `task/T-WT-N`. The orchestrator:

1. Calls `cleo orchestrate spawn T-WT-N` to get the spawn prompt.
2. Dispatches the agent with `CLEO_WORKTREE_ROOT`, `CLEO_WORKTREE_BRANCH`, `CLEO_PROJECT_HASH` set.
3. Agent works exclusively within `worktreePath`.
4. Agent commits on `task/T-WT-N`, runs `cleo verify` with commit+files evidence.
5. **Since `cleo release` is broken**, the orchestrator merges manually:
   ```bash
   git -C /mnt/projects/cleocode fetch origin task/T-WT-N
   git -C /mnt/projects/cleocode checkout main
   git -C /mnt/projects/cleocode merge --no-ff task/T-WT-N -m "feat(T-WT-N): <description>"
   git -C /mnt/projects/cleocode push origin main
   ```
6. After merge, orchestrator runs `cleo complete T-WT-N` with merge commit SHA as evidence.

### 6.3 Branch Naming

All worker branches follow `task/T-WT-N` pattern. The spec branch is `rcasd/T9586` (this branch). The epic implementation branch is `feat/E-WT` or `task/T-WT-0` (owner decides).

### 6.4 Evidence Requirements Per Task

| Task | Required Evidence Atoms |
|------|------------------------|
| T-WT-1 | `commit:<sha>;files:packages/core/src/worktree/effective-head.ts,packages/core/src/worktree/__tests__/effective-head.test.ts` |
| T-WT-2 | `commit:<sha>;files:packages/core/src/tasks/evidence.ts` |
| T-WT-3 | `commit:<sha>;files:packages/core/src/tasks/evidence.ts,packages/core/src/tasks/__tests__/evidence-content-intersect.test.ts` |
| T-WT-4 | `commit:<sha>;files:packages/core/src/tasks/__tests__/worktree-ivtr.test.ts` |
| T-WT-5 | `commit:<sha>;files:packages/worktree/src/__tests__/spawn-verify-e2e.test.ts` |
| T-WT-6 | `commit:<sha>;files:.cleo/adrs/ADR-051-worktree-extension.md` |
| T-WT-7 | `commit:<merge-sha>;note:CI green on PR merging T-WT-1 through T-WT-6` |

### 6.5 Parallelism Constraints

- T-WT-1, T-WT-2, T-WT-6 MUST NOT modify the same file. Verified: T-WT-1 only creates new files, T-WT-2 modifies `evidence.ts`, T-WT-6 creates `.cleo/adrs/`. No conflict.
- T-WT-3 modifies `evidence.ts` — MUST be serialized after T-WT-2. The T-WT-3 worker MUST rebase onto the T-WT-2 merge commit before opening their PR.
- T-WT-4 and T-WT-5 create new test files only — can be parallelized with T-WT-6.

---

## 7. Verification Plan

### 7.1 Real-World Integration Test Scenario

This is the canonical proof that the fix works end-to-end. It can be run manually or as a CI gate.

**Setup**:
```bash
# 1. Create a test project
export TEST_DIR=$(mktemp -d)
cd "$TEST_DIR"
git init -q
git config user.name "IVTR Test"
git config user.email "ivtr@test.local"
git config commit.gpgsign false
cleo init --yes

# 2. Create a test task with explicit file declaration
cleo add "Test task for IVTR" --acceptance "packages/test/src/foo.ts implements the feature" --files packages/test/src/foo.ts
export TASK_ID=$(cleo list --format json | jq -r '.tasks[-1].id')

# 3. Transition task to implementation stage (if required by lifecycle)
# cleo lifecycle complete research "$TASK_ID" (only if IVTR requires this)

# 4. Create worktree
mkdir -p packages/test/src
git add packages/test
git commit -m "init: scaffold test package"

# 5. Spawn worktree
WORKTREE_RESULT=$(cleo orchestrate spawn "$TASK_ID" --tier 0 --json)
WORKTREE_PATH=$(echo "$WORKTREE_RESULT" | jq -r '.data.worktreeCwd')
export CLEO_WORKTREE_ROOT="$WORKTREE_PATH"
export CLEO_WORKTREE_BRANCH="task/$TASK_ID"

# 6. Create a commit in the worktree that touches the declared AC file
mkdir -p "$WORKTREE_PATH/packages/test/src"
echo "export function foo() { return 42; }" > "$WORKTREE_PATH/packages/test/src/foo.ts"
git -C "$WORKTREE_PATH" add packages/test/src/foo.ts
git -C "$WORKTREE_PATH" commit -m "feat($TASK_ID): implement foo"
COMMIT_SHA=$(git -C "$WORKTREE_PATH" rev-parse HEAD)

# 7. Verify from the worktree (with CLEO_WORKTREE_ROOT set — Scenario 2 test)
CLEO_WORKTREE_ROOT="$WORKTREE_PATH" cleo verify "$TASK_ID" \
  --gate implemented \
  --evidence "commit:$COMMIT_SHA;files:packages/test/src/foo.ts"
# MUST succeed with exit code 0

# 8. Verify from main repo dir (without CLEO_WORKTREE_ROOT — Scenario 1 test)
unset CLEO_WORKTREE_ROOT
cd "$TEST_DIR"
cleo verify "$TASK_ID" \
  --gate implemented \
  --evidence "commit:$COMMIT_SHA;files:packages/test/src/foo.ts"
# MUST succeed with exit code 0 after the fix

# 9. Clean up
cd /
git worktree remove --force "$WORKTREE_PATH" 2>/dev/null || true
rm -rf "$TEST_DIR"
```

### 7.2 Negative Test: Unrelated Commit Still Fails

After the fix, a commit that touches DIFFERENT files than the AC declaration MUST still fail `E_EVIDENCE_CONTENT_MISMATCH`:

```bash
# Commit a file NOT in AC
echo "# readme" > "$WORKTREE_PATH/README.md"
git -C "$WORKTREE_PATH" add README.md
git -C "$WORKTREE_PATH" commit -m "chore: add readme"
UNRELATED_SHA=$(git -C "$WORKTREE_PATH" rev-parse HEAD)

cleo verify "$TASK_ID" \
  --gate implemented \
  --evidence "commit:$UNRELATED_SHA;files:packages/test/src/foo.ts"
# MUST fail with E_EVIDENCE_CONTENT_MISMATCH
```

### 7.3 Negative Test: Commit Not on Task Branch Still Fails

A commit that exists on main but NOT on the task branch MUST still fail:

```bash
# Commit directly to main (not task branch)
git -C "$TEST_DIR" add some_file.txt && git commit -m "chore"
MAIN_SHA=$(git -C "$TEST_DIR" rev-parse HEAD)

cleo verify "$TASK_ID" \
  --gate implemented \
  --evidence "commit:$MAIN_SHA;files:some_file.txt"
# MUST fail with E_EVIDENCE_INVALID (not reachable from task/TXXX when branch exists)
```

### 7.4 CI Test Coverage Map

| Test | Location | Covers |
|------|----------|--------|
| `getEffectiveHead` unit | `effective-head.test.ts` | REQ-2, REQ-3 |
| `resolveCanonicalProjectRoot` unit | `evidence-content-intersect.test.ts` | REQ-5, REQ-6 |
| `validateCommit` worktree scenario | `evidence-content-intersect.test.ts` | REQ-7, REQ-8 |
| Full worktree-IVTR matrix | `worktree-ivtr.test.ts` | REQ-9, REQ-10, REQ-11 |
| Spawn → verify end-to-end | `spawn-verify-e2e.test.ts` | REQ-7, REQ-12 |
| Backward compat (no taskId) | `evidence-content-intersect.test.ts` | REQ-11 |
| T9245 non-regression | `evidence-content-intersect.test.ts` | REQ-12 |

### 7.5 Manual Owner-Review Checklist

Before merging the PR, the owner SHOULD verify:

- [ ] `pnpm run test` passes with zero new failures
- [ ] `pnpm run typecheck` exits 0
- [ ] `pnpm biome check .` exits 0
- [ ] The integration test in §7.1 passes end-to-end in a fresh clone
- [ ] `git log --grep "T-WT"` shows all expected commits on the branch
- [ ] No `.cleo/tasks.db`, `.cleo/brain.db` tracked in the commit (checked by `.gitignore`)

---

## Appendix A: Known Open Issues (Not in Scope)

**OOS-1**: The worktree's `.cleo/tasks.db` receives no updates after spawn. A background sync mechanism would allow workers to see task updates (e.g., narrowed AC scope) without requiring the main DB fallback. Filed as future work; current fix is to always read from main DB for gate verification.

**OOS-2**: When `CLEO_WORKTREE_ROOT` is set but the ALS bridge in `bootstrap()` fails silently (e.g., `@cleocode/core/internal` import fails), the ancestry check falls back to main HEAD. This is a latent failure mode. Hardening the ALS bridge is a separate task.

**OOS-3**: The gitlink-parsing logic in `resolveCanonicalProjectRoot` duplicates logic from step 2.5 of `getProjectRoot()`. A future cleanup task should extract a shared `parseGitlink(path)` utility to eliminate the duplication. Not in scope for this epic to avoid scope creep.

**OOS-4**: `CLEO_WORKTREE_ROOT` is injected by `packages/worktree/src/worktree-create.ts:287` but the Claude Code harness adapter (`packages/cleo-os/src/harnesses/pi-coding-agent/adapter.ts`) must pass this env var to any subprocess spawned by the agent. This is already required by ADR-055 but has not been verified by an integration test. Out of scope here; tracked as a follow-up.

---

## Appendix B: Relation to Hardened Commits (T9245)

The two commits shipped in T9245 (`44fa60526`, `f78bed8a8`) introduced:
1. Content-intersect check in `validateCommit` (Bug C site)
2. Override rejection for critical gates in `revalidateEvidence`

These changes assumed that `projectRoot` is always the canonical main repo. T9245 did NOT consider worktree contexts. This spec retroactively closes the worktree blindspot in T9245:

| T9245 Change | Bug Introduced | This Spec Fixes |
|-------------|---------------|----------------|
| `--is-ancestor sha HEAD` reachability check | Bug A: HEAD = main tip, not task branch | T-WT-3 (via T-WT-1) |
| `getTaskAccessor(projectRoot)` in content-intersect | Bug C: stale worktree DB | T-WT-2 |

The override-rejection behavior (`revalidateEvidence` + `CRITICAL_GATES_NO_OVERRIDE`) is NOT affected by this spec — it operates on already-validated atoms and does not involve git ancestry or DB reads.
