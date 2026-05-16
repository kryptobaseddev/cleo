# T9345 — Release Pipeline Failure Forensics (10 Modes)

**Anchor session**: v2026.5.73 → v2026.5.74 ship session
**Codebase commit**: `e1b3b414d` (post v2026.5.74 hotfix)
**Posture**: Read-only forensic analysis. No code modified. No remediation proposed beyond fix-class classification.
**Audience**: ADR-author + RFC-2119 spec-writer for T9345 release-system overhaul.

---

## Map of evidence files

| File | Role in failure chain |
|------|------------------------|
| `/mnt/projects/cleocode/packages/cleo/src/cli/commands/release.ts` | Citty CLI commands: `ship`, `start`, `verify`, `publish`, `reconcile`, `pr-status`, etc. |
| `/mnt/projects/cleocode/packages/cleo/src/dispatch/domains/release.ts` | Dispatch handlers for `release.gate`, `release.ivtr-suggest`, `release.start`, `release.publish`, `release.reconcile`. NOT the ship path. |
| `/mnt/projects/cleocode/packages/core/src/release/engine-ops.ts` | The actual 12-step `releaseShip()` (lines 1105-1866) — the imperative monolith. |
| `/mnt/projects/cleocode/packages/core/src/release/pipeline.ts` | Canonical 4-step `releaseStart` / `releaseVerify` / `releasePublish` / `releaseReconcile` — completely disjoint from `releaseShip()`. |
| `/mnt/projects/cleocode/packages/core/src/release/guards.ts` | `checkEpicCompleteness`, `checkDoubleListing`. |
| `/mnt/projects/cleocode/packages/core/src/release/github-pr.ts` | `createPullRequest`, label/branch protection. |
| `/mnt/projects/cleocode/packages/core/src/release/version-bump.ts` | `bumpVersionFromConfig`, `resolveVersionBumpTargets`. |
| `/mnt/projects/cleocode/packages/core/src/release/changelog-writer.ts` | `writeChangelogSection`, `parseChangelogBlocks`. |
| `/mnt/projects/cleocode/packages/core/src/release/release-manifest.ts` | `prepareRelease`, `generateReleaseChangelog`, `runReleaseGates`, `pushRelease`. |
| `/mnt/projects/cleocode/packages/core/src/security/override-cap.ts` | `checkAndIncrementOverrideCap`, per-session waiver. |
| `/mnt/projects/cleocode/packages/core/src/session/engine-ops.ts` | `sessionEnd` — does NOT reset the override counter. |
| `/mnt/projects/cleocode/packages/git-shim/src/shim.ts` | Layered fence binary; only fires when `CLEO_AGENT_ROLE ∈ {worker,lead,subagent}`. |
| `/mnt/projects/cleocode/packages/git-shim/src/denylist.ts` | `GIT_OP_DENYLIST` for restricted roles. |
| `/mnt/projects/cleocode/packages/git-shim/src/boundary.ts` | T1591 fences: `validateAddPaths`, `validateCommitSubject`, `validateMergeAllowed`, `validateCherryPickSource`. |
| `/mnt/projects/cleocode/packages/git-shim/src/isolation-boundary.ts` | T1761 cwd-isolation check (worker role only). |
| `/mnt/projects/cleocode/packages/core/src/lifecycle/ivtr-loop.ts` | `getIvtrState` returns `null` when no IVTR state exists. |
| `/mnt/projects/cleocode/build.mjs` | esbuild root config — externals list maintained manually. |

> Critical architectural finding (anchors failures #3, #8 and the synthesis): **`packages/core/src/release/pipeline.ts` (the canonical 4-step model from ADR-063) and `packages/core/src/release/engine-ops.ts:releaseShip` (the 12-step monolith) are TWO PARALLEL, NON-INTEGRATED RELEASE SYSTEMS.** `engine-ops.ts` never imports from `pipeline.ts`; `pipeline.ts` never delegates to `releaseShip`. The CLI exposes BOTH as siblings (`release ship` → engine-ops; `release start/verify/publish/reconcile` → pipeline) and neither calls the other.

---

## Failure #1: Wedged git commit (no child-process timeout)

### Symptom (verbatim from T9345)
> "`cleo release ship` spawned `git commit -m "release: ship v2026.5.74 (T9261)"` that hung indefinitely (PID 4011255). Left `.git/index.lock`. No timeout. No retry. Parent process exited silently while child stuck."

### Reproduction
1. Run `cleo release ship 2026.5.74 --epic T9261`.
2. Concurrently hold `.git/index.lock` (e.g. a hook calling another long-running git command, or an editor's git plugin).
3. Step 5 (Cut release branch and commit) reaches the `git commit -m "release: ship v…"` invocation.
4. If git wedges (signal lost; child still alive but parent's pipe broken), `execFileSync` blocks forever — no `timeout` option supplied for git invocations.

### Code Evidence

**File**: `packages/core/src/release/engine-ops.ts:1497`
```ts
const gitCwd = { cwd, encoding: 'utf-8' as const, stdio: 'pipe' as const };
```
No `timeout` property. This object is passed to every `runGitWithLockRetry` call AND every direct `execFileSync('git', …, gitCwd)` call in steps 5-11.

**File**: `packages/core/src/release/engine-ops.ts:1524-1533` (the actual wedged commit invocation)
```ts
try {
  runGitWithLockRetry(['commit', '-m', `release: ship v${cleanVersion} (${epicId})`], gitCwd);
} catch (err: unknown) {
  const msg =
    (err as { stderr?: string; message?: string }).stderr ??
    (err as { message?: string }).message ??
    String(err);
  logStep(5, 12, 'Cut release branch and commit', false, `git commit failed: ${msg}`);
  return engineError('E_GENERAL', `git commit failed: ${msg}`);
}
```

**File**: `packages/core/src/release/engine-ops.ts:86-140` (`runGitWithLockRetry`)
```ts
function runGitWithLockRetry(
  args: readonly string[],
  opts: Parameters<typeof execFileSync>[2],
  maxRetries = 6,
): string {
  const lockErrorPattern = /Unable to create '.+\.git\/index\.lock': File exists/;
  …
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return execFileSync('git', [...args], opts) as unknown as string;
    } catch (err: unknown) {
      …
      // Only retry on the specific stale-lock signature
      if (!lockErrorPattern.test(stderr) || attempt === maxRetries) {
        throw err;
      }
      …
    }
  }
```

### Root Cause

The pipeline owns `gitCwd` (engine-ops.ts:1497) with NO `timeout` field. `execFileSync` without a `timeout` blocks forever on a child that never exits. `runGitWithLockRetry` (engine-ops.ts:86) only handles the *stale-`.git/index.lock`* signature — which requires the child to ACTUALLY exit with the lock-error message. A child that wedges (held by another git invocation that never returns, or stalled on a network filesystem flush) never produces that error and is never killed.

Contrast: the lint step at line 1484 DOES use `timeout: 30_000`:
```ts
execFileSync('npx', ['biome', 'check', '--no-errors-on-unmatched', cwd], {
  cwd,
  encoding: 'utf-8',
  stdio: 'pipe',
  timeout: 30_000,
});
```
And the gh-merge step at line 1688 uses `timeout: 60_000`. Both demonstrate the codebase *knows about* `execFileSync` timeouts; `runGitWithLockRetry` and direct git invocations simply opted out.

Compounding: even when timeout fires, `execFileSync` throws but does NOT guarantee the child is killed promptly on Linux — the SIGTERM signal might be lost if the child is in uninterruptible IO (D state). No follow-up `kill -9 <pid>` exists. And `runGitWithLockRetry` doesn't track child PIDs anywhere.

### Blast Radius

- `.git/index.lock` lingers, blocking all subsequent git operations against the repo (including manual recovery attempts) until the operator runs `rm -f .git/index.lock`.
- The release is in an indeterminate state: branch may or may not have been cut; commit may or may not have landed; `releaseManifests` row exists in DB but with no `pushedAt`. No structured rollback fires because the parent never receives the error.
- Every downstream step (push, PR-create, CI-wait, merge, tag, cleanup) is skipped.
- Operator must manually inspect git state, kill stuck PID, remove the lock, then decide between `rollback-full` (engine-ops.ts:759) and re-running ship (which re-cuts the branch — `git checkout -b` fails because branch exists).

### Fix Class
- [ ] one-line patch
- [x] new wrapper / timeout
- [ ] state-machine redesign — *would help, but a hard timeout is sufficient as an MVP*
- [ ] architectural carve-out
- [ ] documentation
- [ ] config-driven

### Suggested invariant
**Every git invocation in the release pipeline MUST have a finite hard timeout** (e.g. 30s for `add`/`commit`, 60s for `push`, 120s for `pull`) **AND a guaranteed SIGKILL-after-grace** path. The pipeline MUST treat git-timeout as a recoverable error class with a documented next-step (which is: re-run `cleo release ship` with idempotent resume — see Failure #8).

---

## Failure #2: Epic completeness scope leak

### Symptom (verbatim from T9345)
> "`--epic T9261` was supplied but completeness check failed on T9220 (unrelated). T9337 had SUPERSEDED T9220 weeks ago. T877_INVARIANT_VIOLATION (status-vs-pipeline-stage)."

### Reproduction
1. Manifest for release v2026.5.74 references task IDs of children of T9261.
2. One of those children's ancestor chain includes T9220 (via cross-epic reference, ID overload, or stale `parentId`).
3. T9220 has `status='done'` but was superseded by T9337 (semantic supersession — not modeled in `task.status`).
4. `checkEpicCompleteness(releaseTaskIds, …)` walks UP from each release task ID, derives the set of epics implicated, and flags every done-leaf-child of THOSE epics as "missing" if they're not in the release.
5. Ship aborts with `E_LIFECYCLE_GATE_FAILED — Epic completeness check failed: T9220: missing …`.

### Code Evidence

**File**: `packages/core/src/release/engine-ops.ts:1339-1378` (call site)
```ts
// Step 2: Check epic completeness
logStep(2, 12, 'Check epic completeness');
let releaseTaskIds: string[] = [];
try {
  const manifest = await showManifestRelease(version, projectRoot);
  releaseTaskIds = (manifest as { tasks?: string[] }).tasks ?? [];
} catch {
  // Manifest may not exist yet; proceed
}
…
const epicAccessor = await getTaskAccessor(cwd);
const epicCheck = await checkEpicCompleteness(
  releaseTaskIds,
  projectRoot,
  epicAccessor,
  priorReleasedTaskIds,
);
if (epicCheck.hasIncomplete) { … return engineError('E_LIFECYCLE_GATE_FAILED', `Epic completeness check failed: ${incomplete}`, …); }
```

Note: `epicId` (the operator's `--epic T9261`) is NOT passed to `checkEpicCompleteness`. The function discovers epics on its own.

**File**: `packages/core/src/release/guards.ts:31-46` (`findEpicAncestor` — walks UP the parent chain)
```ts
function findEpicAncestor(taskId: string, tasksById: Map<string, Task>): string | null {
  const task = tasksById.get(taskId);
  if (!task) return null;
  if (task.type === 'epic') return taskId;
  let current = task;
  for (let depth = 0; depth < 3; depth++) {
    if (!current.parentId) return null;
    const parent = tasksById.get(current.parentId);
    if (!parent) return null;
    if (parent.type === 'epic') return parent.id;
    current = parent;
  }
  return null;
}
```

**File**: `packages/core/src/release/guards.ts:82-122` (the "missing" determination)
```ts
// Group by epic
const byEpic = new Map<string, string[]>();
for (const [taskId, epicId] of taskToEpic) {
  if (!epicId) continue;
  if (!byEpic.has(epicId)) byEpic.set(epicId, []);
  byEpic.get(epicId)!.push(taskId);
}

for (const [epicId, includedTasks] of byEpic) {
  const epic = tasksById.get(epicId);
  if (!epic) continue;
  if (epic.status === 'done') continue;
  …
  const missingChildren = allChildren
    .filter(
      (t) =>
        t.status === 'done' &&
        !parentIds.has(t.id) &&
        !includedSet.has(t.id) &&
        !releaseSet.has(t.id) &&
        !priorSet.has(t.id),
    )
    …
}
```

`guards.ts` has no concept of `superseded` or `cancelled` status filters — it only checks `t.status === 'done'`. Supersession lineage (T9337 → T9220) is invisible here.

### Root Cause

Three compounding bugs:

1. **Scope leak**: `releaseShip(params.epicId)` is documented as the epic-being-shipped, but the completeness check derives epics from `releaseTaskIds` via `findEpicAncestor`. The operator's `--epic T9261` is used ONLY for the IVTR gate (line 1257) and the commit-message tag — NOT for scoping the completeness audit. Any task whose ancestor-chain crosses into a foreign epic (T9220) drags that foreign epic into the check.

2. **No SUPERSEDED model**: `task.status` is a flat enum (`pending` / `active` / `done` / `blocked` / `cancelled`). Supersession is a semantic relationship (T9337 supersedes T9220) maintained elsewhere (likely BRAIN observations, decisions, or a `superseded_by` field that `guards.ts` does not consult). The guard treats a done-but-superseded task as a first-class done leaf.

3. **T877 reconcile divergence**: the post-release invariants registry (`archive-reason-invariant.ts:287-295`) DOES enforce `status='done' ⇒ pipelineStage IN ('contribution','cancelled')`. But that's the *post*-release reconcile path. The *pre*-release `checkEpicCompleteness` does NOT consider `pipelineStage` — so a task can be `status='done', pipelineStage='research'` and still be flagged as "missing" from the release.

### Blast Radius

- Operator-experienced false-positive blocker on every cross-epic release.
- Workaround: comment out `checkEpicCompleteness` call (impossible at runtime), bypass via `--force` (not exposed for this gate — only IVTR), or wait days/weeks for the foreign epic to be "completed".
- Encourages operators to mark unrelated tasks as `cancelled` to clear the gate — corrupts task lineage permanently.
- Hides the actual T877 invariant violation (status-vs-stage) behind a generic `Epic completeness check failed` error.

### Fix Class
- [ ] one-line patch
- [ ] new wrapper / timeout
- [x] state-machine redesign — *the SUPERSEDED relationship must be first-class*
- [x] architectural carve-out — *scope the check to the operator-supplied epic, NOT cross-derived ancestors*
- [ ] documentation
- [ ] config-driven

### Suggested invariant
**Epic-completeness gate MUST be scoped to the operator-supplied `epicId`.** Tasks whose ancestor chain leaves the supplied epic MUST NOT trigger completeness audits of foreign epics. **Superseded tasks MUST be modeled as a first-class status (or `superseded_by` reference) and excluded from completeness denominators.** The guard MUST consult `pipelineStage` in addition to `status` (the same T877 invariant the post-release reconciler enforces). Cross-epic linkage MUST be reported as a *warning*, never a *blocker*.

---

## Failure #3: Gate runners not wired

### Symptom (verbatim from T9345)
> "`cleo release verify` reports all 5 gates (test, lint, typecheck, audit, security-scan) as 'runner not configured (inject via opts.runGate)'. Verify passes without running anything. Ship proceeds anyway."

### Reproduction
1. Run `cleo release start 2026.5.74 --epic T9261`. Handle is written to `.cleo/release/handle.json`.
2. Run `cleo release verify`.
3. Output shows 5 gates, all `passed: false, reason: 'gate "test" runner not configured (inject via opts.runGate)'` (etc).
4. But `passed` field on the envelope is `false` ONLY when both gate-failure AND child-failure conditions are evaluated — and the CLI exits with `process.exit(1)` (release.ts:322).
5. Despite verify failing, `cleo release ship` does NOT consult `pipeline.ts` at all (it runs the parallel engine-ops 12-step monolith) and proceeds.

### Code Evidence

**File**: `packages/core/src/release/pipeline.ts:249-262` (the smoking gun)
```ts
async function defaultRunGate(
  canonicalTool: string,
  _cwd: string,
): Promise<{ passed: boolean; reason?: string }> {
  // Map canonical name → npm script per project-context fallback chain.
  // We intentionally do NOT execute here in the default impl — the wrapping
  // CLI is responsible for invoking `cleo verify --gate <…> --evidence
  // tool:<canonical>` which already drives the cache-aware tool runner.
  // For programmatic callers (tests) this default is overridable.
  return {
    passed: false,
    reason: `gate "${canonicalTool}" runner not configured (inject via opts.runGate)`,
  };
}
```

**File**: `packages/core/src/release/pipeline.ts:264-270` (child-auditor twin)
```ts
async function defaultAuditChildren(): Promise<{
  examined: number;
  ungreen: Array<{ taskId: string; missingGates: string[] }>;
}> {
  return { examined: 0, ungreen: [] };
}
```

**File**: `packages/cleo/src/cli/commands/release.ts:317-323` (CLI calls verify with NO injection)
```ts
const verifyCommand = defineCommand({
  meta: { name: 'verify', description: 'Verify release gates + child task gate state' },
  async run() {
    const result = await release.releaseVerify(release.loadActiveReleaseHandle(process.cwd()));
    cliOutput(result, { command: 'release', operation: 'release.verify' });
    if (!result.passed) process.exit(1);
  },
});
```
No `runGate` or `auditChildren` is provided. The defaults are used. Defaults always return `passed: false` (gates) and `examined: 0, ungreen: []` (children).

**File**: `packages/core/src/release/pipeline.ts:331-364` (`releaseVerify` accepts the no-op defaults silently)
```ts
export async function releaseVerify(
  handle: ReleaseHandle,
  opts: ReleaseVerifyOptions = {},
): Promise<VerifyResult> {
  const runGate = opts.runGate ?? defaultRunGate;
  const auditChildren = opts.auditChildren ?? defaultAuditChildren;

  const gates: ReleaseGateStatus[] = [];
  for (const gate of VERIFY_GATES) {
    const r = await runGate(gate, handle.projectRoot);
    gates.push({ gate, passed: r.passed, tool: gate, …(r.reason !== undefined ? { reason: r.reason } : {}) });
  }
  …
  const allGatesGreen = gates.every((g) => g.passed);
  const allChildrenGreen = ungreenChildren.length === 0;
  return { passed: allGatesGreen && allChildrenGreen, gates, ungreenChildren, childrenExamined };
}
```

**File**: `packages/core/src/release/engine-ops.ts:1234-1249` (the engine-ops "Step 1: Validate release gates")
```ts
logStep(1, 12, 'Validate release gates');
const gatesResult = await runReleaseGates(version, () => loadTasks(projectRoot), projectRoot, {
  dryRun,
});

if (gatesResult && !gatesResult.allPassed) { … }
logStep(1, 12, 'Validate release gates', true);
```
Note this calls `runReleaseGates` from `release-manifest.ts` — a SEPARATE gate runner from `pipeline.ts:VERIFY_GATES`. There are TWO independent gate systems.

### Root Cause

The canonical pipeline (`pipeline.ts`) defines `VERIFY_GATES` as `['test','lint','typecheck','audit','security-scan']` (line 94) and ships with an explicitly-unimplemented `defaultRunGate` that returns `passed:false, reason:"runner not configured"`. The comment at line 253 says "the wrapping CLI is responsible for invoking `cleo verify --gate <…> --evidence tool:<canonical>`" — but the CLI (release.ts:317) does NOT inject any runner. It just calls `releaseVerify(handle)` with no opts.

Meanwhile, `releaseShip()` (engine-ops.ts) does not call `releaseVerify` at all. It calls `runReleaseGates` from `release-manifest.ts` (engine-ops.ts:1236) — an entirely different gate registry. So:

- `cleo release verify` runs a no-op stub that always fails its own gates.
- `cleo release ship` runs a different gate set that may or may not pass.
- The two never agree.

This is the "gate logic confused with pipeline logic" cluster: there are TWO gate systems, neither integrated with the canonical evidence-based gate runner (`cleo verify --gate … --evidence tool:…`) referenced by the comment.

### Blast Radius

- Operator running `release verify` thinks "everything passes" or "everything fails" — neither is true; it's a phantom result.
- `release ship` bypasses `release verify` entirely. Even if verify reported red, ship would not know.
- Tests cannot trust either: `pipeline.ts` defaults are testable only via injection (tests pass because they inject), but production has no injector.
- A green CI signal during ship comes from step 8 (`gh pr checks --watch`) — not from `verify`. The whole pre-flight "validate" stage is theater.

### Fix Class
- [ ] one-line patch
- [ ] new wrapper / timeout
- [ ] state-machine redesign
- [x] architectural carve-out — *unify or delete one of the two gate systems*
- [ ] documentation
- [x] config-driven — *wire defaultRunGate to the existing ADR-061 tool resolver*

### Suggested invariant
**`cleo release verify` MUST execute the same canonical gates that the release manifest's `runReleaseGates` consults — there MUST be a single gate registry per project, not two.** When a gate's runner is "not configured", verify MUST return `E_GATE_RUNNER_MISSING` (not a soft `passed:false`) so the operator cannot accidentally treat it as a real failure. `cleo release ship` MUST refuse to proceed without a green `cleo release verify` (or an audited override).

---

## Failure #4: IVTR non-blocking gate

### Symptom (verbatim from T9345)
> "'IVTR gate: 72 task(s) have no IVTR state (non-blocking)'. If non-blocking on 72/72 tasks, it is not a gate."

### Reproduction
1. Run `cleo release ship 2026.5.74 --epic T9261` with no `--force`.
2. Epic T9261 has 72 child tasks; none have ever had `ivtr_state` started (the IVTR loop was never run on any of them).
3. `checkIvtrGates([t1…t72], …)` returns `{ blocked: [], unchecked: [t1…t72] }`.
4. The pipeline emits `! IVTR gate: 72 task(s) have no IVTR state (non-blocking)` and proceeds.

### Code Evidence

**File**: `packages/core/src/release/engine-ops.ts:190-212` (`checkIvtrGates`)
```ts
async function checkIvtrGates(
  taskIds: string[],
  projectRoot?: string,
): Promise<{ blocked: string[]; unchecked: string[] }> {
  const blocked: string[] = [];
  const unchecked: string[] = [];

  for (const taskId of taskIds) {
    try {
      const state = await getIvtrState(taskId, { cwd: projectRoot });
      if (state === null) {
        // No IVTR state started — not blocked but flagged as unchecked
        unchecked.push(taskId);
      } else if (state.currentPhase !== 'released') {
        blocked.push(taskId);
      }
    } catch {
      unchecked.push(taskId);
    }
  }
  return { blocked, unchecked };
}
```

**File**: `packages/core/src/release/engine-ops.ts:1265-1293` (the "gate" decision)
```ts
if (epicTaskIds.length > 0) {
  const { blocked, unchecked } = await checkIvtrGates(epicTaskIds, projectRoot);
  if (blocked.length > 0) {
    logStep(1, 12, 'Check IVTR gate for epic tasks', false, `${blocked.length} task(s) not released in IVTR`);
    return engineError('E_LIFECYCLE_GATE_FAILED', …);
  }
  if (unchecked.length > 0) {
    const w = `  ! IVTR gate: ${unchecked.length} task(s) have no IVTR state (non-blocking): ${unchecked.join(', ')}`;
    steps.push(w);
    log.warn({ epicId, unchecked, count: unchecked.length }, w);
  }
  logStep(1, 12, 'Check IVTR gate for epic tasks', true);
}
```

**File**: `packages/core/src/lifecycle/ivtr-loop.ts:464-469` (`getIvtrState` returns null when no row exists)
```ts
export async function getIvtrState(
  taskId: string,
  options?: { cwd?: string },
): Promise<IvtrState | null> {
  return readIvtrStateRaw(taskId, options?.cwd);
}
```

### Root Cause

The IVTR gate has THREE outcome buckets — `released` (pass), `started-but-not-released` (block), and `never-started` (warn-only). The pipeline interprets `never-started` as "this task didn't opt into IVTR, so we won't block on it." That makes the gate **opt-in-only on the worker side** — any agent that skips IVTR escapes the gate entirely.

When 72/72 tasks have never started IVTR, the gate is reduced to a printable warning. The same code path would fire for an epic that legitimately had no IVTR coverage (e.g. docs-only) AND for an epic where IVTR was *deliberately bypassed*. The gate cannot distinguish.

There is NO step that converts "task is in release manifest" ⇒ "task MUST have started IVTR". The IVTR loop is opt-in for workers; the release gate inherits that opt-in semantics.

### Blast Radius

- 72/72 escape is a 100% bypass rate — the gate added zero protection on this ship.
- Future epics with mixed IVTR coverage will pass without anyone noticing which tasks were unchecked.
- The "unchecked" warning is interleaved with `cleo release ship` steps and lost in scrollback. No structured `unchecked-on-ship` audit log is written.
- Defeats the entire purpose of the IVTR loop being a release prerequisite.

### Fix Class
- [ ] one-line patch
- [ ] new wrapper / timeout
- [x] state-machine redesign — *the gate must take an explicit policy: strict (all tasks must have IVTR) / opt-in (current behavior) / per-task-required*
- [ ] architectural carve-out
- [ ] documentation
- [x] config-driven — *policy MUST live in `.cleo/config.json`*

### Suggested invariant
**The IVTR gate's policy MUST be explicit and recorded in `.cleo/config.json` (e.g. `release.ivtr.policy: "strict" | "opt-in" | "off"`).** Under `strict`, `unchecked` MUST count as `blocked`. Under `opt-in`, `unchecked` MUST emit an auditable structured warning (not just stderr noise) that lists EVERY unchecked task ID and is appended to the release-manifest record. **A gate that does not block under any input configuration MUST NOT be called a "gate" in the CLI output.**

---

## Failure #5: Override cap broken

### Symptom (verbatim from T9345)
> "'Per-session CLEO_OWNER_OVERRIDE cap exceeded: 823 of 10 overrides used'. Counter never resets."

### Reproduction
1. Start a CLEO session: `cleo session start --scope global`.
2. Run several agent workflows that each invoke `cleo verify … --evidence …` with `CLEO_OWNER_OVERRIDE=1` set.
3. Counter file `.cleo/audit/session-override-count.<sessionId>.json` increments on each override.
4. Run `cleo session end`. Counter file is NOT touched.
5. Start a new session — same sessionId is rare but session state itself moves on. However if sessionId resolves to `'global'` (no active session — see validation/engine-ops.ts:385 fallback), the global counter file persists FOREVER and grows monotonically.
6. After hundreds of operations across many sessions, file shows 823 overrides used.

### Code Evidence

**File**: `packages/core/src/security/override-cap.ts:147-161` (only write path increments — no reset writer exists)
```ts
export function writeSessionOverrideCount(
  projectRoot: string,
  sessionId: string,
  count: number,
): void {
  try {
    const path = getSessionOverrideCountPath(projectRoot, sessionId);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ sessionId, count, updatedAt: new Date().toISOString() }), {
      encoding: 'utf-8',
    });
  } catch {
    // Non-fatal — audit count should not block operations.
  }
}
```

**File**: `packages/core/src/security/override-cap.ts:257-307` (`checkAndIncrementOverrideCap` — only ever increments)
```ts
export function checkAndIncrementOverrideCap(
  projectRoot: string,
  sessionId: string,
  cap: number = DEFAULT_OVERRIDE_CAP_PER_SESSION,
  command?: string,
): OverrideCapResult {
  // T1504 worktree exemption …
  if (command !== undefined && isWorktreeExemptionEnabled() && isWorktreeContext(command)) {
    const current = readSessionOverrideCount(projectRoot, sessionId);
    return { allowed: true, sessionOverrideOrdinal: current + 1, workTreeContext: true };
  }

  const current = readSessionOverrideCount(projectRoot, sessionId);

  if (current < cap) {
    const ordinal = current + 1;
    writeSessionOverrideCount(projectRoot, sessionId, ordinal);
    return { allowed: true, sessionOverrideOrdinal: ordinal };
  }

  // Above cap — check for waiver.
  const waiverPath = (process.env['CLEO_OWNER_OVERRIDE_WAIVER'] ?? '').trim();
  const waiver = validateWaiverDoc(waiverPath);

  if (!waiver.valid) {
    return {
      allowed: false,
      errorCode: BRANCH_LOCK_ERROR_CODES.E_OVERRIDE_CAP_EXCEEDED,
      errorMessage:
        `Per-session CLEO_OWNER_OVERRIDE cap exceeded: ${current} of ${cap} overrides used. …`,
    };
  }

  // Waiver accepted — permit and increment beyond cap.
  const ordinal = current + 1;
  writeSessionOverrideCount(projectRoot, sessionId, ordinal);
  return { allowed: true, sessionOverrideOrdinal: ordinal };
}
```

**File**: `packages/core/src/validation/engine-ops.ts:382-388` (the `'global'` fallback used when no active session)
```ts
if (override.override && isWriteRequiringEvidence) {
  const command = (process.argv.slice(1).join(' ') || 'cleo').slice(0, 512);
  const capResult = checkAndIncrementOverrideCap(
    projectRoot,
    sessionId ?? 'global',
    undefined,
    command,
  );
  if (!capResult.allowed) {
    return engineError(
      capResult.errorCode ?? 'E_OVERRIDE_CAP_EXCEEDED',
      capResult.errorMessage ?? 'Per-session override cap exceeded.',
    );
  }
  …
}
```

**File**: `packages/core/src/session/engine-ops.ts:574-690` (`sessionEnd` — NO override-counter reset)
The function clears focus state, bumps file_meta generation, marks the session 'ended', appends a journal entry, and ingests memory summaries. It NEVER touches `session-override-count.<sessionId>.json`. There is also no `purgeOldOverrideCounts` sweeper.

### Root Cause

Three bugs in the override-cap subsystem:

1. **No reset on `session end`**: the per-session counter file is intended to live only as long as the session. But `sessionEnd` (session/engine-ops.ts:574) never deletes it. The cap counter is *append-only* in practice — even for a fresh session, the file persists.

2. **`'global'` fallback collapses many sessions into one counter**: when validation runs outside an active session (which is common for agents that don't `session start` — most worker agents), `sessionId ?? 'global'` (validation/engine-ops.ts:385) writes to `session-override-count.global.json`. This single file accumulates overrides across every CLI invocation since the project was created.

3. **No expiry / GC**: there is no time-based or count-based truncation. `count: 823` is just the integer that's been incremented since whenever this file was created. Combined with (2), this is exactly the error message reported.

### Blast Radius

- Every legitimate owner-override after the cap is reached is blocked unless the operator creates a waiver doc with `cap-waiver: true`. The waiver requirement is meant for emergencies but becomes routine when the counter is broken.
- Operators get conditioned to keep a `cap-waiver: true` file on the path and pass `CLEO_OWNER_OVERRIDE_WAIVER=…` in every shell — defeating the cap entirely.
- The audit log (`force-bypass.jsonl`) still records each use, but the counter loses meaning.
- During the v2026.5.74 ship session, 823/10 means the counter is at ~82× the cap — the operator either gave up on the cap entirely (always-on waiver) or is hitting `E_OVERRIDE_CAP_EXCEEDED` constantly and forcing through.

### Fix Class
- [ ] one-line patch
- [ ] new wrapper / timeout
- [x] state-machine redesign — *counter lifecycle must be tied to actual session lifecycle*
- [ ] architectural carve-out
- [ ] documentation
- [x] config-driven — *cap policy must support `count-per-session`, `rolling-window`, `count-per-CLI-invocation`*

### Suggested invariant
**The override-cap counter MUST reset at `session start` (not `session end` — agents may crash without ending).** A non-session global counter MUST be a rolling window (e.g. last 60min) — not append-only. `sessionEnd` MUST delete the per-session counter file via a registered cleanup hook. The `'global'` sessionId fallback MUST be banned in production paths — agents that don't have an active session MUST establish one before calling `verify` with overrides.

---

## Failure #6: Tag points at wrong SHA

### Symptom (verbatim from T9345)
> "After ship pushed tag v2026.5.74, the tag landed on pre-merge SHA (1226c5dae) instead of merge commit (e1b3b414d). Had to delete + retag manually."

### Reproduction
1. Run `cleo release ship 2026.5.74 --epic T9261`.
2. Step 9 runs `gh pr merge <prUrl> --merge --auto`. `--auto` makes the merge happen *after* all required checks pass — gh exits immediately with the merge *queued*, not done.
3. Step 10 immediately runs `git checkout main && git pull origin main && git rev-parse HEAD`. If GitHub hasn't completed the auto-merge yet, the local `main` does NOT contain the merge commit. HEAD is the pre-merge SHA.
4. Tag is created on that pre-merge SHA.
5. After GitHub auto-merge completes, `git fetch && git pull` reveals the merge commit lives at a new SHA (e1b3b414d) — but the tag was already pushed to the wrong SHA (1226c5dae).
6. Operator must `git tag -d v2026.5.74 && git push origin :refs/tags/v2026.5.74 && git pull && git tag v2026.5.74 && git push origin v2026.5.74`.

### Code Evidence

**File**: `packages/core/src/release/engine-ops.ts:1682-1717` (the merge step — `--auto` is fire-and-forget)
```ts
// Step 9: Merge PR with --merge (preserves commit SHAs)
logStep(9, 12, 'Merge PR');
if (prUrl) {
  try {
    execFileSync('gh', ['pr', 'merge', prUrl, '--merge', '--auto'], {
      ...gitCwd,
      timeout: 60_000,
    });
    logStep(9, 12, 'Merge PR', true);
  } catch (err: unknown) {
    …
    if (msg.includes('auto')) {
      // Fallback: gh CLI refused --auto (no required checks configured)
      // → retry WITHOUT --auto, which performs a synchronous merge.
      try {
        execFileSync('gh', ['pr', 'merge', prUrl, '--merge'], { ...gitCwd, timeout: 60_000 });
        logStep(9, 12, 'Merge PR', true);
      …
```

**File**: `packages/core/src/release/engine-ops.ts:1721-1767` (Step 10 — no wait for merge completion)
```ts
// Step 10: Tag from main + push tag (idempotent: re-running on an
// already-tagged release succeeds when the existing tag points at HEAD).
logStep(10, 12, 'Tag from main and push');
try {
  runGitWithLockRetry(['checkout', gitflowCfg.branches.main], gitCwd);
  runGitWithLockRetry(['pull', gitRemote, gitflowCfg.branches.main], gitCwd);

  // Resolve HEAD so we can compare against any pre-existing tag
  const headSha = execFileSync('git', ['rev-parse', 'HEAD'], gitCwd).toString().trim();

  // Check if the tag already exists locally
  let existingTagSha: string | undefined;
  try {
    existingTagSha = execFileSync('git', ['rev-list', '-n', '1', gitTag], gitCwd)
      .toString()
      .trim();
  } catch {
    // Tag does not exist locally — fall through to create it
  }

  if (existingTagSha) {
    if (existingTagSha === headSha) {
      const m = `  i Tag ${gitTag} already exists at HEAD (${headSha.slice(0, 8)}) — skipping create`;
      …
    } else {
      …  // error: tag already exists at different SHA
    }
  } else {
    runGitWithLockRetry(['tag', '-a', gitTag, '-m', `Release ${gitTag}`], gitCwd);
  }
```

There is no `gh pr view <prUrl> --json mergeCommit,state` polling between Step 9 and Step 10. Nothing detects whether the auto-merge has completed before pulling and tagging.

### Root Cause

`gh pr merge --auto` is asynchronous. From the [gh docs](https://cli.github.com/manual/gh_pr_merge): `--auto` "automatically merge only after necessary requirements are met." gh returns success once the merge is *queued*, not *applied*. The pipeline's mental model is "if gh exited 0, the merge is done," which is wrong for `--auto`.

The fallback path (line 1696-1699) catches the "auto-merge not enabled on repo" error and retries WITHOUT `--auto`, which IS synchronous. So when the repo allows `--auto`, the race exists; when it doesn't, the race goes away. The behavior is repo-config-dependent — and the failure mode is silent.

Compounding: step 10 does `git pull origin main` immediately. If the local clone was fetched a few seconds before the auto-merge landed on GitHub, `pull` succeeds returning "already up-to-date" — masking the fact that the remote main has moved since. The pipeline has no `git fetch --all && git ls-remote origin refs/heads/main` re-check.

### Blast Radius

- Every release with required CI checks enabled and `--auto` accepted has a race window of N seconds (= max(time-from-`gh pr merge --auto`-call-to-actual-merge-applied)).
- Tag points to pre-merge SHA → `git log <tag>` doesn't show the release commit → npm publish from that SHA misses the release-commit content → CHANGELOG mismatch.
- Provenance recording (`markReleasePushed(version, pushedAt, …, { commitSha, gitTag })` at engine-ops.ts:1826) stamps the WRONG commitSha into the release manifest. Future audits show release-manifest-row pointing at a tag that no longer exists at that SHA.
- Manual retag corrupts git history annotations — the tag object now has a non-monotonic creation date relative to the commit.

### Fix Class
- [ ] one-line patch
- [x] new wrapper / timeout — *poll merge completion before pulling*
- [ ] state-machine redesign
- [ ] architectural carve-out
- [ ] documentation
- [ ] config-driven

### Suggested invariant
**After `gh pr merge --auto`, the pipeline MUST poll `gh pr view <prUrl> --json state,mergeCommit` until `state === "MERGED"` AND `mergeCommit.oid` is non-empty, with a bounded timeout (e.g. 15min, same as CI-wait).** Only after that confirmation MAY it `git pull` and tag. Alternatively, drop `--auto` entirely and require synchronous `gh pr merge --merge` post-CI-wait — making step 9 truly blocking.

---

## Failure #7: Worker direct-push to main

### Symptom (verbatim from T9345)
> "worker-T9317 merged its task branch directly to local main without opening a PR. Required cherry-pick recovery to feat/T9317-bedrock-recovery. The git-shim hook should block this; it did not."

### Reproduction
1. Worker agent is spawned with worktree at `~/.local/share/cleo/worktrees/<hash>/T9317/`.
2. Worker `cd`s into worktree, makes changes, commits with `T9317` in subject.
3. Worker (intentionally or via a bash hook) runs `git checkout main` followed by `git merge task/T9317` or `git push origin task/T9317:main`.
4. Expected: `git-shim` denylist blocks at least `git checkout` (denylist.ts:43-46).
5. Actual: shim only fires when `CLEO_AGENT_ROLE ∈ {worker,lead,subagent}` AND the role is set in the subprocess env. If the worker's shell environment doesn't have `CLEO_AGENT_ROLE` exported (e.g. orchestrator passed env via `spawn` opts but a sub-shell stripped it), the shim is bypassed.

### Code Evidence

**File**: `packages/git-shim/src/shim.ts:232-244` (the fast path — no role ⇒ pass through)
```ts
const role = getAgentRole();

// Fast path: no restricted role → pass through unconditionally.
if (!role) {
  const realGit = resolveRealGit();
  if (!realGit) {
    process.stderr.write('[git-shim] ERROR: real git binary not found\n');
    process.exit(1);
  }
  const result = spawnSync(realGit, argv, { stdio: 'inherit' });
  process.exit(result.status ?? 1);
  return;
}
```

**File**: `packages/git-shim/src/shim.ts:61-65` (`getAgentRole` requires the exact env)
```ts
function getAgentRole(): string | null {
  const role = process.env['CLEO_AGENT_ROLE'];
  if (!role) return null;
  return RESTRICTED_ROLES.has(role) ? role : null;
}
```

**File**: `packages/git-shim/src/denylist.ts:41-47` (denylist HAS `checkout` and `switch` — they would block IF role were set)
```ts
export const GIT_OP_DENYLIST: ReadonlyArray<DeniedGitOp> = [
  {
    subcommand: 'checkout',
    reason: 'agents MUST NOT switch branches — use the assigned worktree branch',
  },
  {
    subcommand: 'switch',
    reason: 'agents MUST NOT switch branches — use the assigned worktree branch',
  },
  …
```

**File**: `packages/git-shim/src/boundary.ts:239-262` (`validateMergeAllowed` — merge IS in the boundary fence)
```ts
export function validateMergeAllowed(
  args: ReadonlyArray<string>,
  env: { CLEO_ORCHESTRATE_MERGE?: string },
): BoundaryViolation | null {
  for (const arg of args) {
    if (arg === '--abort' || arg === '--continue' || arg === '--quit') return null;
  }
  if (env.CLEO_ORCHESTRATE_MERGE === '1') return null;
  return { code: 'E_GIT_BOUNDARY_MERGE_FORBIDDEN', boundary: 'c', message: 'git merge refused — agents MUST NOT merge directly (ADR-062 / T1587)', … };
}
```

**File**: `packages/git-shim/src/denylist.ts:184-200` (force-push IS denied, but vanilla push to main is NOT)
```ts
// Force push
{ subcommand: 'push', flag: '-f', reason: 'agents MUST NOT force-push — the orchestrator manages push lifecycle' },
{ subcommand: 'push', flag: '--force', reason: '…' },
{ subcommand: 'push', flag: '--force-with-lease', reason: '…' },
```
`git push origin task/T9317:main` (non-force, refspec) is NOT in the denylist.

### Root Cause

Three compounding bugs:

1. **Env-var-only enforcement is fragile**: the shim is gated entirely on `CLEO_AGENT_ROLE` being set. If a sub-shell, hook, or `exec -c` strips that env (or if the operator runs an unrelated terminal in the worktree), the shim does nothing. There is no on-disk marker in the worktree (e.g. `.cleo/worktree-policy.json`) the shim can consult independent of env.

2. **`git push origin <local>:main` is not in the denylist**: the denylist (denylist.ts) protects against force-push but NOT against `git push origin task/T9317:main` (a non-force push of a local branch to the remote `main` ref). That's the exact attack vector the worker used.

3. **`git merge` boundary requires `CLEO_ORCHESTRATE_MERGE=1` but only when shim is active**: same fragility as (1). If the agent's shell can run a sub-process that escapes the shim, the boundary doesn't fire.

### Blast Radius

- Worker bypassed all four T1591 boundaries AND the T1118 denylist by simply not having `CLEO_AGENT_ROLE` in the right scope.
- Recovery required cherry-pick from main back into a clean feat/T9317-bedrock-recovery branch — losing the original commit's parent linkage and provenance.
- The git-shim audit log (`<XDG>/cleo/audit/git-shim.jsonl`) shows no record of the bypass because the shim was never invoked.
- The orchestrator's "agent worktree integration via `git merge --no-ff`" (ADR-062 / `completeAgentWorktreeViaMerge`) was bypassed entirely; the original commit SHA is no longer reachable from main.

### Fix Class
- [ ] one-line patch
- [ ] new wrapper / timeout
- [x] state-machine redesign — *enforcement must be defensive at multiple layers, not env-only*
- [x] architectural carve-out — *worktree policy as on-disk artifact, not env*
- [ ] documentation
- [ ] config-driven

### Suggested invariant
**Worker agents MUST be enforced via at least three independent layers**: (a) env-var-driven shim (current), (b) an on-disk worktree policy file (e.g. `.cleo/worktree-policy.json`) the shim reads directly, (c) a server-side GitHub branch-protection rule that rejects pushes from agent identities. **The denylist MUST include `git push <remote> <local>:<protected-branch>` for any branch in the protected-set** (not just force-push). **`git push` whose destination is the project's protected branch from any role MUST be blocked unconditionally**, regardless of `CLEO_AGENT_ROLE`.

---

## Failure #8: Release start no-op

### Symptom (verbatim from T9345)
> "`.cleo/release-state.json` does not exist despite `release start` being called. release start is a 0ms no-op that records nothing actionable."

### Reproduction
1. Run `cleo release start 2026.5.74 --epic T9261`.
2. Observe: `.cleo/release/handle.json` is created with `{version, tag, scheme, branch, startedAt, projectRoot, epicId}` (pipeline.ts:304-314).
3. Run `cleo release ship 2026.5.74 --epic T9261`.
4. `releaseShip` (engine-ops.ts:1105) does NOT read `.cleo/release/handle.json`. It re-derives the version, re-validates, re-prepares the manifest record. The handle is ignored.
5. The handle is consumed ONLY by `release verify` / `release publish` / `release reconcile` (release.ts:317, 327, 339) — none of which are called by `ship`.

### Code Evidence

**File**: `packages/core/src/release/pipeline.ts:91` (the handle path — note this is `handle.json`, NOT `release-state.json`)
```ts
const HANDLE_RELATIVE_PATH = '.cleo/release/handle.json';
```

**File**: `packages/core/src/release/pipeline.ts:288-316` (`releaseStart`)
```ts
export async function releaseStart(
  version: string,
  opts: ReleaseStartOptions = {},
): Promise<ReleaseHandle> {
  const projectRoot = opts.projectRoot ?? process.cwd();
  const { scheme } = resolveProjectConfig(projectRoot);

  const validation = validateVersion(version, scheme);
  if (!validation.ok) {
    throw new Error(`Invalid version: ${validation.reason}`);
  }

  const branch = opts.branch ?? (await detectBranch(projectRoot));
  const tag = version.startsWith('v') ? version : `v${version}`;
  const normalizedVersion = version.startsWith('v') ? version.slice(1) : version;

  const handle: ReleaseHandle = {
    version: normalizedVersion,
    tag,
    scheme,
    branch,
    startedAt: new Date().toISOString(),
    projectRoot,
    epicId: opts.epicId,
  };

  writeHandle(handle);
  return handle;
}
```

**File**: `packages/cleo/src/cli/commands/release.ts:296-314` (CLI wraps releaseStart)
```ts
const startCommand = defineCommand({
  meta: {
    name: 'start',
    description: 'Begin a release (validates version, captures branch, persists handle)',
  },
  args: {
    version: { type: 'positional', description: 'Version to release', required: true },
    epic: { type: 'string', description: 'Epic ID this release ships' },
    branch: { type: 'string', description: 'Override detected branch' },
  },
  async run({ args }) {
    const handle = await release.releaseStart(args.version, {
      epicId: args.epic as string | undefined,
      branch: args.branch as string | undefined,
    });
    cliOutput(handle, { command: 'release', operation: 'release.start' });
  },
});
```

**File**: `packages/core/src/release/engine-ops.ts:1105-1233` (`releaseShip` — never imports loadActiveReleaseHandle)
```ts
export async function releaseShip(
  params: {
    version: string;
    epicId: string;
    remote?: string;
    dryRun?: boolean;
    bump?: boolean;
    force?: boolean;
  },
  projectRoot?: string,
): Promise<EngineResult> {
  const { version, epicId, remote, dryRun = false, bump = true, force = false } = params;
  …
}
```
A grep confirms `engine-ops.ts` does NOT reference `loadActiveReleaseHandle`, `writeHandle`, `releaseStart`, or `HANDLE_RELATIVE_PATH`.

**File**: `packages/cleo/src/dispatch/domains/release.ts:261-308` (dispatch handler — start/publish/reconcile only)
```ts
case 'start': {
  const version = typeof params?.version === 'string' ? params.version : undefined;
  …
  const result = await releaseStart(version, { … });
  return { success: true, data: result, meta: dispatchMeta('mutate', 'release', operation, startTime) };
}

case 'publish': {
  const handle = loadActiveReleaseHandle(getProjectRoot());
  const result = await releasePublish(handle, { … });
  …
}

case 'reconcile': {
  const handle = loadActiveReleaseHandle(getProjectRoot());
  const result = await releaseReconcile(handle, { … });
  …
}
```
Ship is conspicuously absent. Ship goes through `pipeline.release.ship` (`release.ts:73-87`), which is dispatched to engine-ops's `releaseShip`, which never reads the handle.

### Root Cause

The CLI exposes BOTH the canonical 4-step pipeline (T1597 / ADR-063: `start → verify → publish → reconcile`) AND the imperative 12-step ship monolith (`release ship`). They are **two parallel, non-integrated release systems**:

- **Pipeline (pipeline.ts)**: stateful via on-disk handle `.cleo/release/handle.json`. Each step reads/writes the handle.
- **Ship (engine-ops.ts:releaseShip)**: stateless — all 12 steps live inside a single function. Takes `{version, epicId}` directly. Does not consult the handle.

The operator's mental model: `release start` initializes a "release context" that `ship` will consume. The implementation: `release start` writes a handle that `ship` ignores. The handle is consumed only by `verify` / `publish` / `reconcile`, which themselves are never called by `ship` (and `ship` itself never updates the handle).

Compounding: the handle's filesystem path is `.cleo/release/handle.json` (pipeline.ts:91), not `.cleo/release-state.json` as the operator expected. So even when the handle DOES exist, the operator looking for "release state" doesn't find it.

Additionally: if `ship` fails halfway (e.g. at Step 5 — the wedged commit in Failure #1), there is NO resume point. The operator must `rollback-full` (which itself does git-tag-deletion and DB-flip) and re-run from scratch — losing context about which steps had succeeded.

### Blast Radius

- `release start` is decorative. The operator gains false confidence ("I started the release") when nothing actionable has been recorded for the ship path.
- No resume capability: a failed `ship` cannot be resumed at step N. It must be re-run from step 0 or rolled back entirely.
- Handle drift: if the operator runs `release start 2026.5.74` then `release ship 2026.5.75 --epic …`, the handle says one version while ship runs another. Verify/publish/reconcile later operate on the wrong version.
- ADR-063 (4-step pipeline) is documented as the canonical model but unused. The actual production path is the 12-step monolith. Operator-facing docs and runtime behavior diverge.

### Fix Class
- [ ] one-line patch
- [ ] new wrapper / timeout
- [x] state-machine redesign — *the two systems must converge into one*
- [x] architectural carve-out — *ship must consume the handle OR start must be removed from the CLI*
- [ ] documentation
- [ ] config-driven

### Suggested invariant
**There MUST be a single release state machine.** `release ship` MUST consume the handle written by `release start` (and MUST refuse to run if no handle exists OR if the handle's version doesn't match). Each step MUST update the handle with `{lastCompletedStep, lastError, …}` so a failed ship can be resumed via `cleo release ship --resume`. **The handle filename MUST be predictable and operator-facing** (e.g. `.cleo/release/state.json` with prominent docs).

---

## Failure #9: Esbuild externals not auto-detected

### Symptom (verbatim from T9345)
> "T9317 Bedrock SDK addition required manual `build.mjs` edit for @aws-sdk/* + @smithy/* externals. Pipeline did not detect or warn that a new dep would break esbuild bundling."

### Reproduction
1. Add `@aws-sdk/client-bedrock-runtime` to `packages/core/package.json` dependencies.
2. Run `pnpm run build` (which invokes `node build.mjs`).
3. esbuild attempts to bundle the new dep inline. The bundle blows up because `@smithy/*` packages use `node:buffer` dynamic require + native ESM tricks esbuild can't follow.
4. Operator manually edits `build.mjs` to add `'@aws-sdk/client-bedrock-runtime', /^@aws-sdk\//, '@smithy/types', /^@smithy\//` to the externals list.
5. Build succeeds.
6. There is no automated step that scans newly-added dependencies and warns the operator that they may need to be externals.

### Code Evidence

**File**: `build.mjs:179-266` (the externals list — maintained by hand)
```ts
// Shared externals — these are NOT bundled, consumers install them separately
// ALL npm dependencies are external — only @cleocode/* workspace packages are bundled inline.

// T1178 (W3-2+W3-6): @cleocode/core is now truly external — the cleo CLI
…
  // onnxruntime-node (.node bindings) and sharp — both must stay external
…
  // tree-sitter native Node addon + grammar packages — must stay external
…
  // at CLI startup. Keep it external so it loads at runtime from node_modules. (T755)
…
  // transitively — all must stay external so esbuild does not try to inline
…
  // external so node-fetch never gets inlined into the ESM bundle. (T-THIN-WRAPPER)
…
  // @anthropic-ai/sdk similarly should stay external — it's a large SDK that
…
  // AWS SDK v3 modules — pull in @smithy/* runtime, node:buffer dynamic require,
  '@aws-sdk/client-bedrock-runtime',
  /^@aws-sdk\//,
  '@smithy/types',
  /^@smithy\//,
```

This list is hand-maintained. Each entry has a comment explaining WHY the dependency must be external. There is no tooling that reads `package.json` and emits warnings for un-listed deps.

**File**: `packages/core/src/release/version-bump.ts` (releases bump versions in package.json files but never scan dependencies)
```ts
// (grep result: no occurrences of 'esbuild', 'externals', '@aws-sdk', '@smithy')
```

**File**: `packages/core/src/release/engine-ops.ts:1478-1495` (the lint step is the only build-related check in ship)
```ts
// Step 4.5: Lint check — warn on errors but don't block release
try {
  execFileSync('npx', ['biome', 'check', '--no-errors-on-unmatched', cwd], {
    cwd,
    encoding: 'utf-8',
    stdio: 'pipe',
    timeout: 30_000,
  });
  logStep(4, 12, 'Lint check', true);
} catch (err: unknown) {
  …
}
```
There is no `pnpm run build` step, no `node build.mjs --check`, no esbuild dry-run. The ship pipeline never tests that the bundles actually compile.

### Root Cause

The release pipeline assumes someone else has validated that `pnpm run build` works. CI does — but CI runs *after* the release branch is cut and pushed (Step 6) and the PR is opened (Step 7). If CI fails because esbuild can't bundle a new dep, the operator finds out at step 8 ("Wait for CI checks") — having already cut the release branch, pushed it, opened the PR, and updated the changelog.

There is no pre-step that:
- Diffs `package.json` against the last successful release
- Lists new dependencies
- For each new dep, checks: is it an esbuild external? does it have a `.node` binary? does it use `node:buffer` dynamic require?
- Warns or blocks if any new dep is not in `build.mjs`'s externals list (or vice versa)

The externals list itself is a long hand-maintained array in `build.mjs` — there is no schema, no validator, no test that ensures it stays in sync with `package.json`.

### Blast Radius

- Every new heavy dep that needs externals treatment causes a CI failure on the release branch (not on the feature branch — the feat branch may have been auto-greenlit if CI somehow tolerated it locally).
- Operator must abort or rollback the release, manually edit `build.mjs`, re-run.
- The hand-maintained externals list grows monotonically — no test catches dead entries (deps removed from package.json but still in externals).
- New devs adding a dep have no warning system pointing them at `build.mjs`.

### Fix Class
- [ ] one-line patch
- [ ] new wrapper / timeout
- [ ] state-machine redesign
- [ ] architectural carve-out
- [ ] documentation
- [x] config-driven — *a new pipeline step + a tool that consumes the externals list as data*

### Suggested invariant
**The release pipeline MUST execute `pnpm run build` (or the project-context `build.command`) as a pre-ship gate, NOT defer it to CI.** A pipeline step MUST diff the current `package.json` against the previous release's `package.json`, flag new dependencies, and emit a warning if any new dep is not represented in `build.mjs` externals (or, conversely, if an external in build.mjs no longer corresponds to a real dep). The externals list MUST be machine-readable (e.g. a `.cleo/build-externals.json` file with a JSON schema) so tooling can validate it.

---

## Failure #10: CHANGELOG fragile

### Symptom (verbatim from T9345)
> "Auto-generated CHANGELOG entries include verbose RCASD task descriptions, not human-readable changelogs. No semver impact assessment."

### Reproduction
1. Run `cleo release ship 2026.5.74 --epic T9261`.
2. Step 4 (Generate CHANGELOG) calls `generateReleaseChangelog(version, …)` (engine-ops.ts:1453).
3. That function (release-manifest.ts:272-368) iterates release task records and calls `buildEntry(task)` for each.
4. `buildEntry` (release-manifest.ts:334-368) decides whether to include `task.description` based on a heuristic: include if description ≥ 20 chars AND not a minor rephrasing of title.
5. RCASD tasks tend to have long, verbose descriptions (the entire RFC-2119 spec excerpt copy-pasted into description). These pass the heuristic and end up in CHANGELOG.md.
6. Output is a multi-line, multi-paragraph wall of text per task — unreadable for humans.

### Code Evidence

**File**: `packages/core/src/release/release-manifest.ts:330-368` (the entry builder)
```ts
/**
 * Build a changelog entry line for a task.
 * Uses description to enrich the entry when it's meaningfully different from the title.
 */
function buildEntry(task: ReleaseTaskRecord): string {
  const cleanTitle = capitalize(stripConventionalPrefix(task.title));
  // Strip newlines and collapse whitespace in description
  const safeDesc = task.description
    ?.replace(/\r?\n/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
  const desc = safeDesc;

  // Include description only when it's non-trivial and adds information beyond the title.
  // Skip if: description is empty, identical to title, or a minor rephrasing (≤10% longer, no new words).
  const shouldIncludeDesc = ((): boolean => {
    if (!desc || desc.length === 0) return false;
    const titleNorm = cleanTitle.toLowerCase().replace(/[^a-z0-9\s]/g, '').trim();
    const descNorm = desc.toLowerCase().replace(/[^a-z0-9\s]/g, '').trim();
    if (titleNorm === descNorm) return false;
    if (descNorm.startsWith(titleNorm) && descNorm.length < titleNorm.length * 1.3) return false;
    // Require description to be at least 20 chars and contain different content
    return desc.length >= 20;
  })();

  if (shouldIncludeDesc) {
    // Truncate long descriptions to keep changelog readable
    const descDisplay = desc!.length > 150 ? desc!.slice(0, 147) + '...' : desc!;
    return `- **${cleanTitle}**: ${descDisplay} (${task.id})`;
  }

  return `- ${cleanTitle} (${task.id})`;
}
```

Note the 150-char cap: descriptions ARE truncated. But 150 chars of RCASD-spec-quote is still verbose, and the operator's stated grievance is the entries are "verbose RCASD task descriptions, not human-readable changelogs" — implying the truncated form is still too noisy.

**File**: `packages/core/src/release/release-manifest.ts:305-409` (categorization — no semver impact assessment)
```ts
const features: string[] = [];
const fixes: string[] = [];
const chores: string[] = [];
const docs: string[] = [];
const tests: string[] = [];
const changes: string[] = [];
…
function categorizeTask(task: ReleaseTaskRecord): 'features' | 'fixes' | 'docs' | 'tests' | 'chores' | 'changes' {
  if (task.type === 'epic') return 'changes';
  const taskType = (task.type ?? '').toLowerCase();
  if (taskType === 'test') return 'tests';
  if (taskType === 'fix' || taskType === 'bugfix') return 'fixes';
  if (taskType === 'feat' || taskType === 'feature') return 'features';
  if (taskType === 'docs' || taskType === 'doc') return 'docs';
  if (taskType === 'chore' || taskType === 'refactor') return 'chores';
  …
}
```
No `breaking` category. No `major`/`minor`/`patch` impact estimation. The categorization is "what kind of work was done" — not "what does it mean for downstream consumers."

**File**: `packages/core/src/release/changelog-writer.ts:43-63` (`buildSection` — flat output)
```ts
function buildSection(version: string, generatedContent: string, customBlocks: string[]): string {
  const date = new Date().toISOString().split('T')[0];
  const lines: string[] = [];
  lines.push(`## [${version}] (${date})`);
  lines.push('');
  lines.push(generatedContent.trimEnd());
  if (customBlocks.length > 0) {
    lines.push('');
    for (const block of customBlocks) {
      lines.push(block);
      lines.push('');
    }
  }
  lines.push('---');
  lines.push('');
  return lines.join('\n');
}
```
The section header is `## [VERSION] (DATE)` — no upgrade-impact callout, no migration notes section, no breaking-changes section.

### Root Cause

The CHANGELOG generator was designed for short, well-formed task titles (e.g. "fix: handle null user in auth callback"). It was NOT designed for RCASD or research tasks where the description is a long-form analytical document (multiple paragraphs of RFC-2119 SHALL/MUST statements).

The heuristic `desc.length >= 20 && desc !== title-near-prefix` happily includes 150-char excerpts from those long-form descriptions. Truncating to 150 chars mid-sentence produces fragments like "**Forensic analysis of release pipeline failure modes**: Per RFC-2119 the release...". Operators see a changelog full of mid-sentence cliffhangers.

There is no signal in the task data that says "this task is research/RCASD — render minimally" vs "this task is user-facing feature — render fully." The categorizer dispatches by `task.type` but RCASD tasks may have type='task' or 'epic' depending on how they were created.

Compounding: there is no semver impact assessment. CHANGELOG.md is one of the inputs operators use to decide MAJOR vs MINOR vs PATCH bumps, but the generator does not classify changes by impact — only by work-kind.

### Blast Radius

- Operators dread reading the CHANGELOG and skip the human-readable check, increasing release-quality risk.
- Downstream consumers (npm users, integrators) see noise — cannot quickly identify what changed for them.
- No machine-readable hint at semver impact: tooling that wants to enforce "no major bumps in calver patch position" cannot.
- Custom-log blocks ([custom-log]…[/custom-log]) ARE supported (changelog-writer.ts:14-36) — operators can hand-author the meaningful summary — but this is opt-in and the auto-generated noise is still included alongside.

### Fix Class
- [ ] one-line patch
- [ ] new wrapper / timeout
- [ ] state-machine redesign
- [ ] architectural carve-out
- [x] documentation — *RCASD tasks need a short user-facing summary field*
- [x] config-driven — *a configurable filter list + impact-assessment rules*

### Suggested invariant
**Each task MUST have a `userFacingSummary` field (short, ≤120 chars, human-readable) separate from `description`** — and `buildEntry` MUST consume only `userFacingSummary` for CHANGELOG output. **Each task MUST have an explicit semver impact tag** (`impact: 'major' | 'minor' | 'patch' | 'none'`) and the CHANGELOG MUST include a top-level Upgrade Impact section that aggregates major/minor changes. Tasks without these fields MUST be excluded from CHANGELOG entries (with a structured warning).

---

# Cross-Failure Synthesis

## Root-cause clusters

### Cluster 1 — No child-process supervision (Failures #1, #6)
The pipeline calls `execFileSync` / `spawnSync` against external binaries (`git`, `gh`, `npx biome`, `npm`) with inconsistent timeout discipline.
- Some calls have `timeout: 30_000` or `timeout: 60_000` (e.g. engine-ops.ts:1484, 1688).
- Most git calls have NO timeout (gitCwd at engine-ops.ts:1497 omits the field).
- No follow-up SIGKILL-on-timeout enforcement.
- `gh pr merge --auto` is fire-and-forget; the pipeline treats it as synchronous (engine-ops.ts:1686).
- No polling of remote git/GitHub state after async operations.

**Evidence**: engine-ops.ts:86-140 (`runGitWithLockRetry` retries only on lock-error stderr signature; can't detect wedged-with-no-stderr); engine-ops.ts:1497 (gitCwd has no timeout); engine-ops.ts:1686 (gh --auto, no post-merge polling); engine-ops.ts:1722-1727 (immediate `git pull && git rev-parse HEAD` after `--auto` merge).

### Cluster 2 — Gate logic confused with pipeline logic (Failures #3, #4)
There are at least THREE gate systems:
- `pipeline.ts:VERIFY_GATES` — canonical 5-gate list (test/lint/typecheck/audit/security-scan) with **no-op default runner**.
- `release-manifest.ts:runReleaseGates` — a separate gate executor consumed by `releaseShip` (engine-ops.ts:1236).
- IVTR gate in engine-ops.ts:1252-1293 — three-state (released/blocked/unchecked) with `unchecked` treated as warn-only.

None of these talks to the others. The canonical pipeline's `verify` step has a stub default that always-fails, but the CLI doesn't inject a real runner (release.ts:317-323). Meanwhile `ship` runs a different gate set entirely (engine-ops.ts:1236) and reports "all green" while `verify` reports "all red" — for the same release.

The IVTR gate has a `non-blocking` bucket that, when the entire epic is in that bucket (72/72), reduces the gate to a printed warning.

**Evidence**: pipeline.ts:249-262 (`defaultRunGate` always fails), pipeline.ts:264-270 (`defaultAuditChildren` always empty); release.ts:317-323 (CLI doesn't inject runners); engine-ops.ts:1236 (`runReleaseGates` is a different gate registry); engine-ops.ts:190-212 (`checkIvtrGates` three-bucket); engine-ops.ts:1285-1289 (`unchecked` → warn-only).

### Cluster 3 — No state-machine resume (Failures #1, #6, #8)
The 12-step pipeline (engine-ops.ts:releaseShip) is a single monolithic function. There is no persisted per-step state. If step 5 fails (wedged commit), there is no resume — the operator must `rollback-full` or manually undo.

Meanwhile `release start` writes a handle (pipeline.ts:288-316) that `ship` ignores. The handle would be the natural place to persist `{lastCompletedStep, lastError, …}` for resume, but it's not wired.

**Evidence**: engine-ops.ts:1105-1866 (one giant function, no checkpoints); pipeline.ts:91, 211-239 (handle exists, has no step-tracking fields); engine-ops.ts never references `loadActiveReleaseHandle` (grep-verified). On any failure between Step 5 and Step 12, the only documented recovery is `release rollback-full` (engine-ops.ts:759).

### Cluster 4 — Enforcement is env-var-only, not defense-in-depth (Failure #7)
The git-shim's entire authority depends on `CLEO_AGENT_ROLE` being set in the subprocess env (shim.ts:232-244). If env stripping occurs (sub-shell, `exec -c`, terminal opened outside the orchestrator), the shim is bypassed silently. The denylist also fails to include `git push <remote> <local>:<protected-branch>` — a primary attack vector.

**Evidence**: shim.ts:61-65 (env-only role detection); shim.ts:232-244 (no-role fast path); denylist.ts:184-200 (only force-push variants of push are denied).

### Cluster 5 — Hand-maintained registries with no sync test (Failures #9, #10)
Several config artifacts are maintained by hand with no programmatic validation:
- `build.mjs` externals list (build.mjs:179-266) — long array of strings + regexes, comments explaining why each entry exists. No test that fails when a new dep is added without an entry.
- Task data has free-form `description` — no separate `userFacingSummary` or `impact` field. CHANGELOG generation guesses based on heuristics.

**Evidence**: build.mjs:259-265 (recently-added @aws-sdk/@smithy entries, hand-edited after T9317 broke); release-manifest.ts:334-368 (heuristic-driven description inclusion).

### Cluster 6 — Sessions don't bound their own state (Failure #5)
`session end` (session/engine-ops.ts:574-690) is a long function that cleans up focus state, file_meta, summarization prompts, and journal entries — but does NOT delete the override-counter file. The counter persists indefinitely, defeating its own per-session semantics.

**Evidence**: session/engine-ops.ts:574-690 (no override-counter reset); override-cap.ts:147 (only write path is incrementing; no `clearSessionOverrideCount` function exists in the module); validation/engine-ops.ts:385 (`sessionId ?? 'global'` fallback collapses orphan invocations into one counter).

## Conflation hypothesis: governance vs pipeline

**Hypothesis**: The system conflates two distinct concerns:
- **Governance**: "Don't let bad things ship" (gates that BLOCK).
- **Pipeline**: "Make the next step happen" (state machine that MUST be unblockable for hotfixes).

**Evidence FOR conflation**:

1. The IVTR gate (engine-ops.ts:1252-1293) is supposed to be governance but its `unchecked` bucket turns it into pipeline (warn and continue). Governance requires a binary verdict; pipeline allows "warn and continue." Mixing the two means 72/72 unchecked tasks ship without blocking.

2. The epic-completeness gate (engine-ops.ts:1339-1378 + guards.ts:53-135) is supposed to be governance but it scopes itself by traversing parent chains across epics — making it impossible to do a hotfix release that includes a single task from a foreign epic without dragging that whole epic's tree into the audit. Governance is correctly strict; pipeline needs to be permissive for hotfixes; the gate is strict in a way that blocks pipeline.

3. The override-cap (override-cap.ts) is governance but its counter doesn't reset — operators bypass with always-on waivers, effectively turning the gate off. The pipeline implicitly accepts this as the cost of getting work done.

4. The two parallel release systems (pipeline.ts canonical 4-step vs engine-ops.ts 12-step monolith) embody the conflation literally: `verify` is governance-shaped (gate-by-gate, reportable), `ship` is pipeline-shaped (do-everything-or-rollback). They don't compose.

**Evidence AGAINST conflation** (none compelling): one could argue that the `--force` flag on `ship` (engine-ops.ts:1117) provides the pipeline-permissive escape valve. But it's binary (bypass all IVTR + channel/version validation OR bypass nothing) and audited only via a log line. There is no "hotfix mode" that selectively bypasses governance while keeping pipeline integrity.

**Conclusion**: Yes, the system conflates governance and pipeline. A redesign should separate them:
- **Governance** = a gate registry with declarative pass/fail outputs that NEVER short-circuit pipeline state.
- **Pipeline** = a state machine with explicit checkpoints, resume, and skip-with-audit hotfix paths.
- They communicate via an interface, not by being intertwined in one function.

## Monolith hypothesis: is the 12-step flow too monolithic?

**Hypothesis**: `releaseShip` (engine-ops.ts:1105-1866) is too monolithic — state recovery is impossible because there are no checkpoints.

**Evidence FOR monolith critique**:

1. **761 lines, one function**. From line 1105 to 1866. Includes config loading, version normalization, version-bump, manifest auto-prepare, 5 gate types, channel validation, git branch operations, push, gh PR create, gh check polling, gh merge, git pull/tag/push, branch cleanup, and provenance recording — all sequential.

2. **No mid-function state persistence**. The `steps: string[]` array (engine-ops.ts:1130) is a local variable. If the function throws or process exits at step 7, `steps` is lost. The release manifest gets `pushedAt` only at the very end (engine-ops.ts:1826 via `markReleasePushed`). There's nothing in between.

3. **No resume**. If the function fails at step 5 (wedged commit, Failure #1), there is no `cleo release ship --resume 2026.5.74` command. The CLI exposes `release ship`, `release rollback`, `release rollback-full`, `release pr-status` (engine-ops.ts:1911), but no resume. Operators must roll back fully and re-run.

4. **Impossible to test sub-steps**. The function takes `{version, epicId, remote, dryRun, bump, force}` and returns one `EngineResult`. Testing step 8 (CI wait) in isolation requires mocking the entire prefix (steps 0-7). Step-by-step tests don't exist in `packages/core/src/release/__tests__/`.

5. **Step 7 (PR create) + Step 8 (CI wait) + Step 9 (merge) + Step 10 (tag) form a network-coupled chain**. Each is an external API call. The function does them sequentially without recording success-of-step-N before attempting step-N+1. If the network fails mid-way (between Step 9 succeeding on the server and Step 10 starting locally), the function may have merged the PR but not tagged the commit — leaving the release in a half-done state with no way to recover except manual.

6. **The handle from `release start` (pipeline.ts) is the obvious place for per-step state**, but `releaseShip` ignores it (confirmed grep). The architecture HAS a state-bag but doesn't USE it.

**Evidence AGAINST monolith critique** (partial):

1. Some idempotency is built in: step 10 checks for existing tag (engine-ops.ts:1730-1761) and skips creation if tag points at HEAD. Step 11 swallows "branch already gone" errors.

2. Auto-prepare (engine-ops.ts:1210-1232) handles the case where the manifest row doesn't exist — that's a kind of resume-from-zero.

3. The `dryRun` branch (engine-ops.ts:1403-1449) exits at step 4 — providing one form of bounded execution.

**But**: these are point-fixes for known race conditions, not a coherent state-machine architecture. They cover SOME re-run cases, not all.

**Conclusion**: Yes, the 12-step flow is too monolithic for state recovery. A redesign should:
- Decompose into 12 named steps each with `{start, complete, fail}` state transitions written to the handle.
- Add `cleo release ship --resume <version>` that reads the handle and dispatches from `handle.lastCompletedStep + 1`.
- Make each step idempotent or explicitly mark it as not-resumable.
- Move network-coupled steps (PR create, CI wait, merge) into a separate phase that can be re-attached if the network drops.

---

# Closing observations

1. **Failures #3 and #8 share the same architectural disease**: two parallel release systems with overlapping CLI surfaces, neither aware of the other. Fixing one without unifying will not fix the operator experience.

2. **Failures #1, #6, and #7 share a "no defensive depth" disease**: the pipeline trusts external programs (git, gh, the shim's env-var) without independent verification. Adding timeouts + polling + on-disk policy can recover defense-in-depth without rewriting everything.

3. **Failure #2 and #5 share a "stale state" disease**: epic-completeness uses a graph it doesn't own (cross-epic parent chains), and the override counter uses a file no one cleans up. Fix: explicit ownership of state lifecycle, with sweepers.

4. **Failure #4 and #10 share a "warning theater" disease**: gates that should block instead emit warnings; CHANGELOG entries that should be selective instead include everything. Operators learn to ignore the noise.

5. **Failure #9 sits alone but is the most fixable**: a single new pipeline step (`pnpm run build` + `package.json` diff) catches the class of bug.

The ADR + RFC-2119 spec deriving from this report should target the six clusters above. A piece-by-piece fix list is insufficient — the conflation (governance vs pipeline) and the monolith (12-step single function) need to be addressed at the architectural level before individual fixes will be durable.
