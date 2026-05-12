# Worktree Integrity Cluster — Remediation Plan

**Tasks**: T9175, T9092, T9193
**Date**: 2026-05-11
**Author**: Investigation agent (read-only)
**Scope**: Root-cause + surgical patches for three interacting data-loss bugs.

## Executive summary

All three bugs converge on **one structural defect**: `cleo complete` finalises tasks without orchestrating worktree integration, while several write paths under `.cleo/` continue to materialise directories against arbitrary CWDs without first asserting the project root.

| ID | Class | Severity | Root cause site |
|----|-------|----------|-----------------|
| T9175 | Data-loss on complete | P0 | `packages/core/src/tasks/complete.ts:654` — `teardownWorktree(... deleteBranch:false)` fired before any merge step |
| T9092 | Rogue `.cleo/` in spawned worktrees | P0 | Multiple write helpers under `packages/core/src/` skip `assertProjectInitialized()` and let `getDb()/mkdirSync()` auto-create the dir |
| T9193 | Stray `.cleo/` outside any project root | P0 | `packages/core/src/paths.ts:277` (`getCleoDirAbsolute`) resolves `cwd ?? process.cwd()` blindly; `packages/core/src/store/sqlite.ts:225` `mkdirSync(dirname(dbPath), { recursive: true })` then materialises the dir before any validator runs |

The three bugs share a single architectural fix: **all write paths that touch `.cleo/` must funnel through a guarded helper that calls `assertProjectInitialized(projectRoot)` before any directory creation, and the merge step must execute before any worktree teardown**.

Recommended sequencing: fix T9175 first (data-loss surface), then T9193 (universal guard helper), then T9092 (audit and patch remaining call sites that bypass the guard). Test each before proceeding.

---

## T9175 — `cleo complete` destroys worktree before integrating

### Root cause

`packages/core/src/tasks/complete.ts` line 654:

```ts
// T1462: Auto-prune the task worktree when the task is completed.
// Runs best-effort — Promise rejection (e.g. non-git directory) must not
// propagate as an unhandled rejection and must never block completion.
// T9175: deleteBranch:false preserves branch for ADR-062 orchestrator merge
teardownWorktree(projectRoot, { taskId: options.taskId, deleteBranch: false }).catch(() => {});
```

`teardownWorktree` is `packages/core/src/sentient/worktree-dispatch.ts::teardownWorktree`, which delegates to `packages/worktree/src/worktree-destroy.ts::destroyWorktree`. That function unconditionally `git worktree remove --force`s the worktree directory (line 102-115), only preserving the branch when `deleteBranch:false`.

Yes — the branch survives. But the worktree itself is destroyed *before* `completeAgentWorktreeViaMerge` ever runs, and there is no caller in `cleo complete` that invokes the merge at all. The orchestrator-side merge path (`cleo orchestrate worktree-complete`) is the only sanctioned site, but it must be invoked manually. So in the typical flow:

1. Worker commits 3090a75b1 to `task/T9166`
2. `cleo complete T9166` runs
3. `teardownWorktree` removes `~/.local/share/cleo/worktrees/<hash>/T9166/`
4. The branch `task/T9166` still exists in the repo's branch graph — but the working dir is gone, so subsequent rebase/merge from the worktree path fails (`completeAgentWorktreeViaMerge` line 643 `if (existsSync(worktreePath))` skips the rebase, then line 711 `git checkout targetBranch` + `git merge --no-ff task/T9166` still works *from the main repo*, **but** only if a human or another command actually runs it).

So strictly speaking the worker's commits are **recoverable from the branch**, but the standard `cleo complete` flow never integrates them. The user-reported symptom is that the work appears "orphaned" because no automatic merge fires.

The acceptance criterion is explicit: `cleo complete` MUST integrate (merge --no-ff) BEFORE worktree cleanup; integration failure aborts cleanup.

### Proposed patch — `packages/core/src/tasks/complete.ts`

Replace the single `teardownWorktree` call at line 650-654 with the merge-then-prune sequence:

```diff
@@ packages/core/src/tasks/complete.ts:650
-  // T1462: Auto-prune the task worktree when the task is completed.
-  // Runs best-effort — Promise rejection (e.g. non-git directory) must not
-  // propagate as an unhandled rejection and must never block completion.
-  // T9175: deleteBranch:false preserves branch for ADR-062 orchestrator merge
-  teardownWorktree(projectRoot, { taskId: options.taskId, deleteBranch: false }).catch(() => {});
+  // T9175: Worktree integration — MERGE BEFORE TEARDOWN.
+  //
+  // Per ADR-062, the worker's commits must be integrated into the project's
+  // default branch via `git merge --no-ff` BEFORE the worktree is removed.
+  // `completeAgentWorktreeIntegration` performs:
+  //   1. rebase inside the worktree (so the merge is fast-forward-able)
+  //   2. `git merge --no-ff task/<id>` on the default branch
+  //   3. delegate to pruneWorktree which removes the worktree dir + branch
+  //   4. append an audit entry to .cleo/audit/worktree-integration.jsonl
+  //
+  // If the merge fails (rebase conflict, missing branch, etc.), the worktree
+  // and branch are PRESERVED so the operator can resolve and re-run
+  // `cleo orchestrate worktree-complete <id>` manually.
+  //
+  // The whole step is best-effort with respect to non-worktree tasks (no branch
+  // exists, projectRoot is not a git repo, etc.) — those cases short-circuit
+  // inside completeAgentWorktreeIntegration without throwing.
+  try {
+    const { completeAgentWorktreeIntegration } = await import('../spawn/branch-lock.js');
+    const integration = completeAgentWorktreeIntegration(options.taskId, projectRoot, {
+      taskTitle: task.title,
+    });
+    if (!integration.merged && integration.error) {
+      // T9175: integration failure is NON-FATAL but the worktree+branch MUST
+      // remain so the operator can recover. Log via stderr (best-effort).
+      getLogger('tasks:complete').warn(
+        {
+          taskId: options.taskId,
+          mergeError: integration.error,
+          worktreeRemoved: integration.worktreeRemoved,
+        },
+        '[T9175] worktree integration failed — branch + worktree preserved for manual recovery',
+      );
+    }
+  } catch (err) {
+    // Completely non-fatal: integration helper threw (e.g. branch-lock module
+    // missing in a stripped build). Preserve original best-effort semantics.
+    getLogger('tasks:complete').debug(
+      { err: err instanceof Error ? err.message : String(err) },
+      '[T9175] worktree integration helper unavailable — skipping',
+    );
+  }
```

Required import housekeeping at the top of the file:

```diff
-import { teardownWorktree } from '../sentient/worktree-dispatch.js';
+// teardownWorktree removed — completion path uses completeAgentWorktreeIntegration
+// which handles merge+prune atomically (T9175 / ADR-062).
```

`getLogger` is already imported on line 12.

### Behavioural contract (post-patch)

1. **Success path**: worker commits → `cleo complete` → rebase onto origin/main → merge --no-ff into main → prune worktree + branch → audit log entry.
2. **Merge conflict path**: rebase fails → `completeAgentWorktreeViaMerge` returns `merged:false`, `worktreeRemoved:false`, `branchDeleted:false`, with the rebase aborted. Worktree + branch survive. Task status still flips to `done` (since gates already passed), but operator must run `cleo orchestrate worktree-complete <id>` after resolving.
3. **Non-worktree task path**: `getGitRoot` succeeds but `git branch --list task/<id>` is empty → helper returns early without side effects.

### Test to add

`packages/core/src/tasks/__tests__/complete-worktree-integration.test.ts`:

```ts
describe('cleo complete (T9175)', () => {
  it('merges worktree branch before removing the worktree directory', async () => {
    // 1. spawn fixture project with seeded worktree at task/T-test
    // 2. commit a file inside the worktree
    // 3. call completeTask({taskId:'T-test'}, projectRoot, accessor)
    // 4. assert: merge commit on main contains the worker's SHA via
    //    `git log main --grep "T-test" --format=%H`
    // 5. assert: worktree directory was removed
    // 6. assert: task/T-test branch was deleted
    // 7. assert: .cleo/audit/worktree-integration.jsonl has an entry
  });

  it('preserves worktree + branch when merge fails (rebase conflict)', async () => {
    // 1. seed worktree with commit that conflicts with main HEAD
    // 2. call completeTask
    // 3. assert: worktree dir still exists
    // 4. assert: task/T-test branch still exists
    // 5. assert: task.status === 'done' (gates already passed)
    // 6. assert: warn log captured with mergeError
  });

  it('no-ops cleanly when task has no worktree (non-spawned task)', async () => {
    // 1. seed task without spawning a worktree
    // 2. call completeTask
    // 3. assert: no throw, integration result is {merged:true, commitCount:0}
  });
});
```

### Risk callouts

- The merge now runs synchronously inside the completion path. The previous code used `.catch(() => {})` to fire-and-forget. Tests that mock the completion may need to mock `completeAgentWorktreeIntegration` to avoid spawning real git.
- `completeAgentWorktreeIntegration` calls `git checkout targetBranch` on the **main** repo — orchestrator must not have uncommitted changes in the main worktree (it doesn't, because the orchestrator never edits source). Worth gating with `git status --porcelain` in `completeAgentWorktreeViaMerge` before the checkout to be defensive — but this is out of scope for T9175.
- If the orchestrator is itself running inside a worktree (parallel orchestrators), the `git checkout` will fail. The existing logic handles this via `originalBranch` rollback (line 707-756 of branch-lock.ts), but the rollback also rolls back the merge on failure. Acceptable for now — parallel orchestrators are an advanced flow.

---

## T9092 — Rogue `.cleo/` directories in cleo-spawned worktrees

### Root cause analysis

The 2026-05-04 incident (documented in ADR-067) was supposed to be closed by three guards:

1. `validateProjectRoot` requires `project-info.json` or `.cleo/ + real .git/ directory` (T1864) — implemented at `paths.ts:339-398`.
2. CLI entrypoint bridges `CLEO_WORKTREE_ROOT` → `worktreeScope` ALS (T1873) — implemented at `packages/cleo/src/cli/index.ts:371-382`.
3. Worktree lifecycle overhaul (T1466) — implemented in `@cleocode/worktree`.

But the guard discipline is incomplete. Several core-side write helpers DO call `assertProjectInitialized()` (e.g. `events.ts:389`, `session-journal.ts:137`), but others bypass it entirely and rely on `mkdirSync({recursive:true})` to create whatever they need:

- `packages/core/src/audit.ts:80` — `appendContractViolation`: `mkdirSync(dirname(filePath), { recursive: true });` with `filePath = join(projectRoot, '.cleo/audit/contract-violations.jsonl')`. **No `assertProjectInitialized` call.**
- `packages/core/src/store/restore-conflict-report.ts:313` — `writeConflictReport`: `fs.mkdirSync(cleoDir, { recursive: true });` with `cleoDir = path.join(projectRoot, '.cleo')`. **No guard.**
- `packages/core/src/tools/adr-backfill-walker.ts:691` — `mkdir(join(projectRoot, '.cleo', 'agent-outputs'), { recursive: true });`. **No guard.**
- `packages/core/src/store/sqlite.ts:225` — `getDb`: `mkdirSync(dirname(dbPath), { recursive: true });` where `dbPath = getDbPath(cwd) = join(getCleoDirAbsolute(cwd), 'tasks.db')`. **No guard.** This is the primary leak point — any code path that asks for a DB connection (even read-only) creates a `.cleo/tasks.db` wherever `cwd` points.
- `packages/core/src/spawn/branch-lock.ts:394` — `pruneWorktree`: `mkdirSync(auditDir, { recursive: true });` where `auditDir = join(projectRoot, '.cleo', 'audit')`. **No guard.**
- `packages/core/src/spawn/branch-lock.ts:852` — `completeAgentWorktreeIntegration`: `mkdirSync(auditDir, { recursive: true });` same pattern. **No guard.**

In a worktree the ALS scope is set to the worktree path (priority 0 in `getProjectRoot`). The worktree path is NOT a valid project root (validateProjectRoot rejects gitlink-FILE-only candidates per the T9092 hardening on line 374-386 of paths.ts). So **any** of these `mkdirSync(join(projectRoot, '.cleo', ...))` calls running inside a worker creates a rogue `.cleo/` whose project-info.json never existed.

The leak is most acute for `getDb`: every CLI subcommand a worker runs (cleo find, cleo update, etc.) eventually opens a DB. The DB open creates `.cleo/` + `.cleo/tasks.db` + WAL/SHM sidecars under the worktree path. This is the exact 2026-05-04 dead-end-DB pattern.

### Why ALS bridge alone didn't close it

The ALS bridge sets `worktreeScope.worktreeRoot = CLEO_WORKTREE_ROOT`. `getProjectRoot()` returns that value verbatim — it does NOT re-route to the orchestrator's source project. So `getCleoDirAbsolute(projectRoot)` then = `<worktreeRoot>/.cleo`. The intent of ADR-067 §3 was apparently for workers to use the worktree's own `.cleo/`, but that contradicts T9092's stated invariant (worker DB must be the source project DB, not divergent).

There is a semantic mismatch between two ADRs:
- **ADR-067 (T1864/T1868)**: spawn worker, set ALS to worktree path, worker uses worktree-scoped `.cleo/`.
- **T9092 (this task)**: workers should NOT have their own `.cleo/` — they should share the source project's DB.

The correct interpretation (consistent with the user-reported regression) is that **the worktree's "project root" for purposes of `getProjectRoot()` is the worktree path** (for file-system writes inside the worktree, e.g. source files), **but** the **`.cleo/` directory always lives in the source project root**, not the worktree.

### Proposed patch — split path resolution

The cleanest fix is to introduce a new resolver `getCleoProjectRoot()` that ALWAYS returns the canonical source-project root (the one with `project-info.json`), regardless of ALS scope. `getCleoDirAbsolute()` should call this resolver, not `getProjectRoot()`. Source-file paths (e.g. `resolveProjectPath`) continue to use `getProjectRoot()` so they correctly point inside the worktree.

#### Step 1 — add `getCleoProjectRoot()` to `paths.ts`

```diff
@@ packages/core/src/paths.ts:481  (after getProjectRoot definition)
+/**
+ * Resolve the canonical CLEO project root — the directory that owns the
+ * authoritative `.cleo/` with `project-info.json`. Unlike {@link getProjectRoot},
+ * this function NEVER returns a worktree path: it skips the ALS worktreeScope
+ * (Priority 0) and walks up from the worktree's gitlink to the main repo.
+ *
+ * All `.cleo/` data-directory resolution (DB path, audit logs, journals, etc.)
+ * MUST flow through this resolver. Source-file paths (e.g. `resolveProjectPath`)
+ * continue to use `getProjectRoot()` so they correctly point inside the worktree
+ * where the agent is editing files.
+ *
+ * Resolution order:
+ *   1. ALS worktreeScope present → parse its `worktreeRoot` as a gitlink and
+ *      derive the main-repo root (matching the gitlink logic in step 2.5 of
+ *      `getProjectRoot`).
+ *   2. CLEO_PROJECT_ROOT / CLEO_ROOT env var.
+ *   3. Same walk-up as `getProjectRoot` (which gives the right answer when
+ *      not inside a worktree).
+ *
+ * @task T9092
+ */
+export function getCleoProjectRoot(cwd?: string): string {
+  const scope = worktreeScope.getStore();
+  if (scope !== undefined) {
+    try {
+      const startGit = join(scope.worktreeRoot, '.git');
+      if (existsSync(startGit) && statSync(startGit).isFile()) {
+        const linkContent = readFileSync(startGit, 'utf-8').trim();
+        const match = linkContent.match(/^gitdir:\s*(.+)$/m);
+        if (match) {
+          const mainRepo = dirname(dirname(dirname(match[1].trim())));
+          if (validateProjectRoot(mainRepo)) return mainRepo;
+        }
+      }
+    } catch {
+      /* fall through */
+    }
+  }
+  return getProjectRoot(cwd);
+}
```

#### Step 2 — rewire `getCleoDirAbsolute` to use the new resolver

```diff
@@ packages/core/src/paths.ts:277
 export function getCleoDirAbsolute(cwd?: string): string {
-  const cleoDir = getCleoDir();
-  if (isAbsolutePath(cleoDir)) {
-    return cleoDir;
-  }
-  return resolve(cwd ?? process.cwd(), cleoDir);
+  const cleoDir = getCleoDir();
+  if (isAbsolutePath(cleoDir)) {
+    return cleoDir;
+  }
+  // T9193: never resolve `.cleo/` against an arbitrary CWD — always anchor to
+  // the canonical project root (which is the main repo, even when the caller
+  // is running inside a worktree).
+  try {
+    return resolve(getCleoProjectRoot(cwd), cleoDir);
+  } catch {
+    // If we are NOT inside a project (cleo init has never run), fall back to
+    // the legacy behaviour so `cleo init` itself still works. The init verb
+    // is the only sanctioned bootstrap path.
+    return resolve(cwd ?? process.cwd(), cleoDir);
+  }
 }
```

This single change fixes T9092 because every DB-open path, every audit-log-write path, and every `.cleo/` directory creation flows through `getCleoDirAbsolute`. By anchoring it to the canonical main repo, a worker running inside a worktree writes to `<mainRepo>/.cleo/tasks.db` — the same DB the orchestrator wrote.

The remaining direct `join(projectRoot, '.cleo', ...)` call sites (events.ts, session-journal.ts, audit.ts, restore-conflict-report.ts, adr-backfill-walker.ts) must be migrated to use `getCleoDirAbsolute(projectRoot)` so they pick up the redirect. Several already call `assertProjectInitialized(projectRoot)` first — if `projectRoot` is a worktree, that assertion will now throw (because validateProjectRoot rejects gitlink-FILE candidates). The fix is to feed them `getCleoProjectRoot(projectRoot)` instead.

#### Step 3 — patch the direct-`join` callers

```diff
@@ packages/core/src/sentient/events.ts:389
-  assertProjectInitialized(projectRoot);
-  await mkdir(join(projectRoot, '.cleo', 'audit'), { recursive: true });
+  const canonicalRoot = getCleoProjectRoot(projectRoot);
+  assertProjectInitialized(canonicalRoot);
+  await mkdir(join(getCleoDirAbsolute(canonicalRoot), 'audit'), { recursive: true });
```

```diff
@@ packages/core/src/sessions/session-journal.ts:137
-  assertProjectInitialized(projectRoot);
-  await mkdir(join(projectRoot, '.cleo', SESSION_JOURNALS_DIR), { recursive: true });
+  const canonicalRoot = getCleoProjectRoot(projectRoot);
+  assertProjectInitialized(canonicalRoot);
+  await mkdir(join(getCleoDirAbsolute(canonicalRoot), SESSION_JOURNALS_DIR), { recursive: true });
```

Similar mechanical edits for:
- `packages/core/src/audit.ts:80` — `appendContractViolation`: insert `assertProjectInitialized(getCleoProjectRoot(projectRoot))` before `mkdirSync`, recompute filePath.
- `packages/core/src/store/restore-conflict-report.ts:313` — `writeConflictReport`.
- `packages/core/src/tools/adr-backfill-walker.ts:691` — backfill walker output path.
- `packages/core/src/spawn/branch-lock.ts:394` (`pruneWorktree` audit dir) and `:852` (`completeAgentWorktreeIntegration` audit dir).

### Test to add

`packages/core/src/__tests__/worktree-cleo-leak.test.ts`:

```ts
describe('T9092 — no rogue .cleo/ in spawned worktrees', () => {
  it('getDb() inside a worktree opens the source-project DB, not a worktree-scoped one', async () => {
    // 1. seed main repo with .cleo/project-info.json and tasks.db
    // 2. create a worktree under /tmp/wt
    // 3. inside worktreeScope.run({worktreeRoot:'/tmp/wt', projectHash:'xx'}, () => getDb())
    // 4. assert: /tmp/wt/.cleo does NOT exist
    // 5. assert: getDbPath() returns <mainRepo>/.cleo/tasks.db
  });

  it('appendSentientEvent inside a worktree writes to the source-project audit/', async () => {
    // Similar — assert no /tmp/wt/.cleo/audit/* materialised.
  });

  it('writeConflictReport in a worktree writes to the source-project .cleo/', async () => {});
});
```

### Risk callouts

- The `getCleoProjectRoot` rewrite changes the semantics of every existing DB call. Tests that pass a worktree path expecting a worktree-scoped DB (if any) will break. Audit `packages/core/src/store/__tests__/` for tests that exploit ALS scoping.
- Workers running inside a worktree now write to the source project DB concurrently with the orchestrator. The DB is already WAL-mode and accepts concurrent readers + serialised writers, but heavy fan-out may surface contention. Consider running the existing concurrency stress tests after the change.
- `assertProjectInitialized` may now throw in test fixtures that previously did not initialise `project-info.json`. Audit `packages/*/src/__tests__/` for `mkdir(cleoDir...)` patterns that need the marker file.

---

## T9193 — Stray `.cleo/` and `T###` dirs outside the registered project root

### Root cause

This is the surface manifestation of the same defect as T9092, expressed from a different angle. The two failure modes are:

1. **`getCleoDirAbsolute(cwd)` resolves relative paths against `process.cwd()`** (paths.ts:282). When a subagent runs from a temp dir, a CI scratch path, or any non-project location, `getCleoDirAbsolute()` returns `<cwd>/.cleo`. Any subsequent write call (DB open, audit, session journal) creates the dir.
2. **`getDb()`'s `mkdirSync(dirname(dbPath), {recursive:true})`** is the closest gatekeeper to the filesystem, but it does no validation. It happily creates `.cleo/` and `tasks.db` anywhere it is told to.

### Proposed patch

The T9092 patch above (rewiring `getCleoDirAbsolute` through `getCleoProjectRoot`) closes the relative-resolution leak entirely — there is no longer any way for `getCleoDirAbsolute` to land outside the canonical project root.

For defence-in-depth, add an `assertProjectInitialized()` call inside `getDb()` so that even a buggy caller that hands `getCleoDirAbsolute` a path resolving to a non-project root cannot create the DB:

```diff
@@ packages/core/src/store/sqlite.ts:208 (top of getDb)
   _initPromise = (async () => {
     const dbPath = requestedPath;
     _dbPath = dbPath;

-    // Ensure directory exists
-    mkdirSync(dirname(dbPath), { recursive: true });
+    // T9193: refuse to materialise a DB outside a recognised project root.
+    // The only sanctioned bootstrap path is `cleo init`, which creates the
+    // project-info.json marker before any DB open.
+    const projectRoot = dirname(dirname(dbPath)); // <root>/.cleo/tasks.db → <root>
+    const { assertProjectInitialized } = await import('../paths.js');
+    assertProjectInitialized(projectRoot);
+    // Ensure directory exists (project-info.json was just confirmed)
+    mkdirSync(dirname(dbPath), { recursive: true });
```

Add a CLI-level escape hatch for `cleo init` so it can create the DB on first run. The current `cleo init` flow already calls `scaffoldDotCleo` / `ensureGitignore` / `ensureProjectInfo` before opening any DB, so it should run those first then call `getDb`. If `cleo init` itself fails the assertion, gate it via an `INIT_BOOTSTRAP` flag:

```diff
@@ packages/core/src/store/sqlite.ts (new helper)
+let _initBootstrapMode = false;
+/** Internal: enable DB creation outside a recognised project root for `cleo init`. */
+export function _setInitBootstrapMode(on: boolean): void {
+  _initBootstrapMode = on;
+}
```

And in `getDb`:

```diff
-    const { assertProjectInitialized } = await import('../paths.js');
-    assertProjectInitialized(projectRoot);
+    if (!_initBootstrapMode) {
+      const { assertProjectInitialized } = await import('../paths.js');
+      assertProjectInitialized(projectRoot);
+    }
```

`cleo init` command handler wraps its DB opens in `_setInitBootstrapMode(true)` then `_setInitBootstrapMode(false)`.

### Test to add

`packages/core/src/store/__tests__/db-init-guard.test.ts`:

```ts
describe('T9193 — getDb refuses non-project roots', () => {
  it('throws E_NOT_INITIALIZED when no project-info.json exists in target dir', async () => {
    // 1. mkdtemp tempDir
    // 2. await expect(getDb(tempDir)).rejects.toThrow('E_NOT_INITIALIZED')
    // 3. assert: tempDir/.cleo does NOT exist
  });

  it('succeeds inside a project with project-info.json', async () => {
    // 1. mkdtemp tempDir; write tempDir/.cleo/project-info.json with valid projectId
    // 2. const db = await getDb(tempDir); expect(db).toBeDefined()
  });

  it('succeeds during cleo init bootstrap mode', async () => {
    // 1. mkdtemp tempDir (no project-info.json)
    // 2. _setInitBootstrapMode(true)
    // 3. const db = await getDb(tempDir); expect(db).toBeDefined()
    // 4. _setInitBootstrapMode(false)
  });
});
```

### Risk callouts

- The assertion will surface latent test fixtures that open a DB without writing `project-info.json`. Many `__tests__` files (database-topology-integration, sessions, etc.) call `mkdirSync(cleoDir,...)` then `getDb` — they will need a one-line `writeFileSync(join(cleoDir,'project-info.json'), JSON.stringify({projectId:'test-fixture'}))` before the DB open. This is a tractable mechanical change, but it's many files.
- Alternatively, gate the assertion on `!process.env.VITEST` initially, file a follow-up to migrate fixtures, then remove the env exemption.

---

## Shared root cause + recommended sequencing

The three bugs share a **single semantic gap**: there is no canonical, enforced funnel for "where does CLEO state live for this process". The defence layers (validateProjectRoot, assertProjectInitialized, ALS bridge) exist but are not threaded through the data-write paths consistently. The fix is a small additional resolver (`getCleoProjectRoot`) that anchors all `.cleo/` writes to the source-project root regardless of execution location, plus a single guard in `getDb` to prevent any future regression.

### Sequencing

1. **T9175 first** (1 file changed, ~20 lines). Closes the immediate data-loss surface. Independent of T9092/T9193 in code, but depends on `completeAgentWorktreeIntegration` already existing (it does).
2. **T9092 + T9193 together** as a single change-set. They are one architectural decision split across two task IDs. Land the `getCleoProjectRoot` resolver, rewire `getCleoDirAbsolute`, migrate the direct-`join` callers, add the `getDb` guard. Test stress-cycles between subagent + orchestrator after merge.
3. **Audit pass**: re-run the rg query from ADR-067 §Migration to confirm no remaining `mkdirSync(... .cleo)` or `new Database(... .cleo/...)` sites bypass the funnel.
4. **Migration tool**: file a follow-up task for `cleo doctor --quarantine-rogue` to clean any pre-existing stray dirs in user installs (out of scope here).

### Test matrix

| Bug | New test file | Touches |
|-----|---------------|---------|
| T9175 | `complete-worktree-integration.test.ts` | merge + prune flow |
| T9092 | `worktree-cleo-leak.test.ts` | getDb + audit writes inside worktreeScope |
| T9193 | `db-init-guard.test.ts` | getDb refusal + bootstrap mode |

Run the full `pnpm run test` suite after each phase. Expect 5–15 fixture failures in T9193 caused by missing `project-info.json` in test setups — fix forward (mechanical).

### Risk summary

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| `completeAgentWorktreeIntegration` blocks completion when merge needs human resolution | Medium | Helper returns `merged:false` with worktree preserved; status still flips to done. Document the recovery path. |
| `getCleoProjectRoot` rewrite breaks tests that exploit the worktreeScope = "project root" semantic | Medium-High | Audit `__tests__/` for ALS-based fixtures; expect mechanical migration. |
| `getDb` assertion breaks fixtures that skip `project-info.json` | High | Add the marker write to fixtures or gate behind VITEST initially. |
| Concurrent worktree writes contend on the source-project SQLite | Low | WAL mode already serialises writers; existing benchmark suite covers it. |
| `cleo init` bootstrap-mode flag is forgotten in some new init path | Low | Test asserts E_NOT_INITIALIZED in non-init; init path is the only sanctioned bypass. |

---

## Appendix — Concrete file/line index for reviewers

| File | Line(s) | Change |
|------|---------|--------|
| `packages/core/src/tasks/complete.ts` | 16, 650-654 | Drop teardownWorktree import; replace with completeAgentWorktreeIntegration call |
| `packages/core/src/paths.ts` | 277-283 | Rewire `getCleoDirAbsolute` through `getCleoProjectRoot` |
| `packages/core/src/paths.ts` | (new) after 641 | Add `getCleoProjectRoot()` function |
| `packages/core/src/index.ts` | export list | Export `getCleoProjectRoot` |
| `packages/core/src/internal.ts` | export list | Export `getCleoProjectRoot` |
| `packages/core/src/store/sqlite.ts` | 220-225 | Add `assertProjectInitialized` guard + `_setInitBootstrapMode` flag |
| `packages/core/src/sentient/events.ts` | 389-391 | Use `getCleoProjectRoot` + `getCleoDirAbsolute` |
| `packages/core/src/sessions/session-journal.ts` | 137-139 | Same |
| `packages/core/src/audit.ts` | 78-93 | Add guard, use `getCleoDirAbsolute` |
| `packages/core/src/store/restore-conflict-report.ts` | 311-317 | Same |
| `packages/core/src/tools/adr-backfill-walker.ts` | 690-693 | Same |
| `packages/core/src/spawn/branch-lock.ts` | 389-403, 848-865 | Same (audit-dir creation) |
| `packages/cleo/src/cli/commands/init.ts` | (TBD) | Wrap DB opens with `_setInitBootstrapMode(true/false)` |

End of remediation plan.
