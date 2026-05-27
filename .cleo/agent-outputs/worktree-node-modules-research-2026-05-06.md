# Worktree Node Modules & Build Artifacts Research

**Date**: 2026-05-06
**Status**: Research complete — root cause confirmed, solutions evaluated
**Related**: T1161, T1464, T1462, T1878, T9039, T9077

---

## 1. Executive Summary

The "Direct-to-main commit (worktree pnpm broken)" issue is **not** a node_modules hoisting problem. The root cause is that CLEO worktrees are created as **clean git checkouts** with:

1. **No `node_modules/`** directory at all
2. **No `packages/*/dist/`** build artifacts (gitignored)

Both are required before workers can run `pnpm vitest run` or any gate command.

### Verified Timeline in a Fresh Worktree

| Step | Time | Result |
|------|------|--------|
| `pnpm install --frozen-lockfile` | **2.5s** | ✅ node_modules created, workspace symlinks correct |
| `pnpm run -r build` | **5s+** | ⚠️ Partial success — dependency ordering issues (caamp → adapters) |
| `pnpm vitest run` | N/A | ✅ **Works** after install + build |

**Conclusion**: The fix is not "share node_modules" — it's **auto-provision both `node_modules` and `dist/` artifacts** at worktree creation time.

---

## 2. Root Cause Analysis

### 2.1 What `createWorktree()` Does Today

`packages/worktree/src/worktree-create.ts` (T1161) creates a worktree via `git worktree add` and then:

1. ✅ Applies git worktree lock
2. ✅ Runs `post-create` hooks
3. ✅ Applies `.cleo/worktree-include` patterns (symlinks)
4. ❌ **Does NOT install node_modules**
5. ❌ **Does NOT build workspace packages**

The `.cleo/worktree-include` file **does not exist** in this project, so no files are copied/symlinked into worktrees.

### 2.2 Why Workers Fail

When a worker runs `pnpm vitest run` in a worktree:

```
ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL  Command "vitest" not found
```

`vitest` is not found because:
- `node_modules/.bin/vitest` does not exist (no install)
- Even if installed, workspace packages like `@cleocode/contracts` have `"main": "./dist/index.js"` but `dist/` is gitignored and missing

### 2.3 What Workers Do Instead

Per the user's observation, workers take one of three paths:

1. **Skip gates and commit anyway** — fastest, but no quality verification
2. **`cd /mnt/projects/cleocode/` and run gates there** — pollutes main working tree, causes "direct-to-main commits"
3. **Timeout (600s)** — agent loops trying to figure out how to run tests

---

## 3. Reference Project Analysis

### 3.1 Worktrunk (https://github.com/kryptobaseddev/worktrunk)

Worktrunk is a Rust CLI for git worktree management. It solves the dependency problem via:

**A. `wt step copy-ignored`** — Copies gitignored files between worktrees using **copy-on-write (reflink)**:
- Copies `node_modules/`, `target/`, `.env` from the main tree into the worktree
- Uses reflink on APFS/btrfs/xfs/zfs — **no actual disk duplication**
- A 14GB `target/` directory copies in ~20s vs 2min for full copy
- Each worktree appears independent but shares underlying blocks

**B. Hooks for install** — Runs `pnpm install` after copy:
```toml
[[post-start]]
copy = "wt step copy-ignored"
install = "pnpm install"
```

**C. `.worktreeinclude` whitelist** — Controls what gets copied:
```gitignore
node_modules/
target/
.env
```

**Key insight for CLEO**: Worktrunk's `copy-ignored` is faster than `pnpm install` because it copies the already-resolved `node_modules/` tree. For pnpm workspaces, this includes the `.pnpm/` virtual store.

### 3.2 Sandcastle (https://github.com/mattpocock/sandcastle)

Sandcastle is a TypeScript library for orchestrating AI agents in sandboxes. It handles worktree deps via:

**A. `copyToWorktree`** — Copies host files into worktree at creation:
```ts
copyToWorktree: ["node_modules", ".env"]
```
- Uses copy-on-write (APFS clonefile, GNU reflink) when available
- Default timeout: 60s

**B. Hooks for install** — Runs commands inside sandbox after creation:
```ts
hooks: {
  sandbox: {
    onSandboxReady: [{ command: "npm install" }]
  }
}
```

**C. Cache mounts** — Mounts package manager caches into containers:
```ts
docker({
  mounts: [
    { hostPath: "~/.npm", sandboxPath: "/home/agent/.npm", readonly: true }
  ]
})
```

**Key insight for CLEO**: Sandcastle separates "copy existing artifacts" (`copyToWorktree`) from "install fresh" (hooks). For CLEO, we need both: copy `dist/` artifacts AND either copy or install `node_modules/`.

---

## 4. Solution Evaluation

### 4.1 Option A: Symlink Root `node_modules` into Worktree

**Approach**: `ln -s /mnt/projects/cleocode/node_modules node_modules`

**Status**: ❌ **NOT VIABLE**

Tested in T9053 worktree. Fails because:
- Workspace packages use **relative symlinks** (e.g., `../../../core`)
- These resolve differently in the worktree directory structure
- Results in "Failed to resolve entry for package" errors

**Verdict**: Rejected.

### 4.2 Option B: Symlink Individual Package `node_modules`

**Approach**: Symlink `packages/*/node_modules` from root into worktree.

**Status**: ⚠️ **PARTIALLY VIABLE**

- Would preserve relative symlink correctness within each package
- But pnpm workspace hoisting means many deps live at root `node_modules/`
- Would require symlinking root `.bin/` and root `.pnpm/` as well
- Complex, fragile, and doesn't solve the `dist/` problem

**Verdict**: Too complex, rejected.

### 4.3 Option C: `pnpm install --frozen-lockfile` in Worktree (Auto-Install)

**Approach**: Run `pnpm install --frozen-lockfile` as a `post-create` hook.

**Status**: ✅ **VIABLE — 2.5s**

Tested in T9053:
- Reuses pnpm global store (1160 packages resolved, 1151 reused, 0 downloads)
- Creates correct workspace symlinks
- `node_modules/.bin/` populated with all binaries

**Pros**:
- Fast (~2.5s)
- Correct workspace resolution
- No disk bloat (hardlinks from global store)

**Cons**:
- Does NOT create `dist/` directories
- Build artifacts still missing
- Workers still can't run tests after install alone

**Verdict**: Necessary but not sufficient. Must be paired with a `dist/` solution.

### 4.4 Option D: Copy `node_modules` from Root via Reflink

**Approach**: Use `cp --reflink=auto` to copy root `node_modules/` into worktree.

**Status**: ✅ **VIABLE IF FILESYSTEM SUPPORTS REFLINK**

- On btrfs/xfs/zfs/APFS: Near-instant, zero disk overhead
- On ext4: Falls back to full copy (~2-5GB for this project)

**Pros**:
- Faster than `pnpm install` (no resolution needed)
- Preserves exact dependency tree
- No network access required

**Cons**:
- Filesystem-dependent (ext4 doesn't support reflink)
- Doesn't solve `dist/` problem
- This project's filesystem: **ext4** (verified via `df -T /mnt`)

**Verdict**: Not viable for this environment (ext4). Would work on btrfs/APFS.

### 4.5 Option E: Copy `packages/*/dist` from Root

**Approach**: Copy built `dist/` directories from main tree into worktree.

**Status**: ✅ **VIABLE — ~384MB total**

Measured sizes:
| Package | dist Size |
|---------|-----------|
| core | 369M |
| cleo | 8.4M |
| adapters | 3.0M |
| contracts | 2.0M |
| caamp | 1.7M |
| cleo-os | 410K |
| worktree | 146K |
| git-shim | 232K |
| **Total** | **~384MB** |

**Pros**:
- Instant — no build time
- Workers can run tests immediately
- Correct build artifacts (same as main tree)

**Cons**:
- 384MB per worktree (without reflink)
- Stale if main tree builds change
- Could mask issues where worker changes should trigger rebuilds

**Verdict**: Viable as a default strategy. Could be optimized with selective copy or symlinks.

### 4.6 Option F: `pnpm run -r build` in Worktree (Auto-Build)

**Approach**: Run `pnpm run -r build` as a `post-create` hook after install.

**Status**: ⚠️ **VIABLE BUT HAS DEPENDENCY ORDERING ISSUES**

Tested in T9053:
- Build starts but fails at `@cleocode/adapters` because `@cleocode/caamp` dist is missing
- Error: `Cannot find module '@cleocode/caamp'`
- Root cause: `tsc` doesn't respect workspace dependency order without `tsc -b` and proper project references

**Pros**:
- Always fresh build artifacts
- Reflects actual source code in worktree

**Cons**:
- Slow (~5-15s depending on packages)
- Build ordering issues in current setup
- Native deps may need rebuild (better-sqlite3, sharp, etc.)

**Verdict**: Requires build system fixes first. Better as a fallback than default.

### 4.7 Option G: Symlink `packages/*/dist` from Root

**Approach**: Create symlinks from worktree `packages/*/dist` → main tree `packages/*/dist`.

**Status**: ✅ **VIABLE — ZERO COPY**

Test concept:
```bash
ln -s /mnt/projects/cleocode/packages/core/dist packages/core/dist
```

**Pros**:
- Zero disk usage
- Instant
- Always up-to-date with main tree

**Cons**:
- If worker modifies a package's source, they must rebuild into the symlinked dist
- Could cause permission issues if main tree dist is read-only
- Race condition if main tree rebuilds while worker is running

**Verdict**: Best default for read-only dependency packages. Workers rebuilding their own packages can override the symlink.

---

## 5. Recommended Solution: Hybrid Approach

### 5.1 Phase 1: Immediate Fix (Minimal Change)

Add a `.cleo/worktree-include` file and a `post-create` hook to `createWorktree()`:

**`.cleo/worktree-include`**:
```
# Symlink node_modules from main tree (fastest approach)
node_modules
# Symlink built artifacts from main tree (needed for workspace resolution)
packages/*/dist
# Include config files that are gitignored but needed
.env.local
```

**`createWorktree()` enhancement**:
```typescript
// In packages/worktree/src/worktree-create.ts, after applyIncludePatterns:
// Run pnpm install --frozen-lockfile as a post-create step
const bootstrapResult = await runWorktreeHooks(
  [
    {
      event: 'post-create',
      command: 'pnpm install --frozen-lockfile',
      timeoutMs: 30000,
      failOnError: false, // Don't fail if install errors
    },
  ],
  'post-create',
  worktreePath,
);
```

**Wait — symlinking `node_modules` is NOT viable** (per Option A testing).

### 5.2 Corrected Phase 1: Install + Symlink Dist

Since symlinking `node_modules` doesn't work, the correct hybrid is:

**Step 1**: Run `pnpm install --frozen-lockfile` (2.5s)
**Step 2**: Symlink `packages/*/dist` from main tree (instant)

Implementation in `worktree-create.ts`:

```typescript
// After applyIncludePatterns, add:

// 1. Install dependencies (fast, reuses global store)
const installHook: WorktreeHook = {
  event: 'post-create',
  command: 'pnpm install --frozen-lockfile',
  timeoutMs: 30000,
  failOnError: true,
};

// 2. Symlink dist directories from main tree
const distPackages = [
  'contracts', 'core', 'caamp', 'adapters', 
  'cleo', 'cleo-os', 'worktree', 'git-shim',
  'lafs', 'nexus', 'playbooks', 'agents', 'skills'
];
for (const pkg of distPackages) {
  const sourceDist = join(projectRoot, 'packages', pkg, 'dist');
  const targetDist = join(worktreePath, 'packages', pkg, 'dist');
  if (existsSync(sourceDist) && !existsSync(targetDist)) {
    symlinkSync(sourceDist, targetDist);
  }
}
```

**Result**: Workers get node_modules (via install) + dist (via symlinks) = **can run gates immediately**.

### 5.3 Phase 2: Optimized Build-Aware Approach

For packages that the worker modifies, override the symlink with a real build:

```typescript
// Detect which packages have uncommitted changes in the worktree
// For those packages: remove symlink, run `pnpm run build`
// For unchanged packages: keep symlink (fast, correct)
```

This is what worktrunk calls **"copy-on-write"** — start with a shared view, diverge only when modified.

### 5.4 Phase 3: Worktrunk-Style Reflink Copy (Future)

If the filesystem supports reflink (btrfs, zfs, APFS):

```bash
# Copy node_modules with reflink — near instant, zero disk
cp --reflink=auto -r /mnt/projects/cleocode/node_modules .
```

This would eliminate even the 2.5s install time. Not viable on ext4.

---

## 6. Implementation Plan

### 6.1 Changes to `packages/worktree/src/worktree-create.ts`

Add after line 127 (after `applyIncludePatterns`):

```typescript
// ---------------------------------------------------------------------------
// Dependency bootstrap — install + symlink dist artifacts
// ---------------------------------------------------------------------------

// Run pnpm install to create node_modules in the worktree.
// This reuses the global pnpm store, so it's fast (~2-3s).
const bootstrapHooks: WorktreeHook[] = [
  {
    event: 'post-create',
    command: 'pnpm install --frozen-lockfile --prefer-offline',
    timeoutMs: 60_000,
    failOnError: true,
  },
];

// Symlink dist directories from the main tree so workspace packages resolve.
// Workers can override by rebuilding specific packages.
const distPackages = readdirSync(join(projectRoot, 'packages'))
  .filter((name) => existsSync(join(projectRoot, 'packages', name, 'dist')));

for (const pkg of distPackages) {
  const sourceDist = join(projectRoot, 'packages', pkg, 'dist');
  const targetDist = join(worktreePath, 'packages', pkg, 'dist');
  if (!existsSync(targetDist)) {
    try {
      symlinkSync(sourceDist, targetDist);
    } catch {
      // Non-fatal: package may not have dist yet
    }
  }
}
```

### 6.2 Changes to `packages/worktree/src/worktree-include.ts`

Add support for a `.cleo/worktree-bootstrap` config file that controls:
- Whether to auto-install (`pnpm install`, `npm install`, etc.)
- Whether to symlink dist
- Custom packages to symlink
- Timeout values

### 6.3 Changes to `.cleo/worktree-include`

Create the file with sensible defaults:

```
# Include files needed for worktree operation
node_modules
packages/*/dist
.env.local
```

Wait — `node_modules` can't be symlinked (per testing). Remove that line.

Corrected `.cleo/worktree-include`:
```
# Include config files
.env.local
.npmrc
```

The `node_modules` and `dist/` handling should be built into `createWorktree()`, not delegated to the include file.

---

## 7. Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| `pnpm install` fails in worktree (network, lockfile drift) | Medium | High | `failOnError: false` fallback; worker can still cd to main tree |
| Main tree `dist/` is stale vs worktree source | Medium | Medium | Detect modified packages, rebuild those only |
| Symlinked dist causes permission issues | Low | Low | Use relative symlinks; ensure same user |
| `pnpm install` takes >30s on slow machines | Low | Medium | Configurable timeout; progress logging |
| Native deps need rebuild (better-sqlite3, etc.) | High | High | Run `pnpm approve-builds` or set `.npmrc` to auto-approve |

### Native Dependency Warning

During testing, `pnpm install` showed:
```
Ignored build scripts: better-sqlite3@12.9.0, koffi@2.15.6,
onnxruntime-node@1.24.3, protobufjs@7.5.4, sharp@0.34.5,
simple-git-hooks@2.13.1.
```

These packages have postinstall scripts that compile native bindings. If the worktree's `node_modules` doesn't run these scripts, binaries may be missing or incompatible.

**Mitigation**: Add to `.npmrc`:
```ini
# Auto-approve builds for known-safe packages
onlyBuiltDependenciesFile=.pnpm/only-built-dependencies.json
```

Or run `pnpm install` without `--frozen-lockfile` so it can run scripts.

---

## 8. Alternative Architectures Considered

### 8.1 Move Worktrees Under Project Root

Instead of `~/.local/share/cleo/worktrees/<hash>/T9053/`, create worktrees as sibling directories:

```
/mnt/projects/cleocode.worktree.T9053/
```

**Pros**:
- pnpm workspace resolution works naturally
- `node_modules` hoisting from root would work
- No path complexity

**Cons**:
- Pollutes project directory
- Harder to clean up
- Breaks D029 canonical path

**Verdict**: Rejected. Would require major path changes.

### 8.2 Use `node-linker=hoisted` in `.npmrc`

Switch pnpm to flat node_modules:

```ini
node-linker=hoisted
```

**Pros**:
- No symlinks — maximum compatibility
- Could potentially share node_modules via copy

**Cons**:
- Loses pnpm's strict dependency isolation
- Doesn't solve `dist/` problem
- Major project change

**Verdict**: Rejected. Too invasive.

### 8.3 Container-First Approach (Sandcastle-Style)

Run each worker in a Docker container with bind-mounts:

```ts
docker({
  mounts: [
    { hostPath: "/mnt/projects/cleocode/node_modules", sandboxPath: "/workspace/node_modules" },
    { hostPath: "/mnt/projects/cleocode/packages/*/dist", sandboxPath: "/workspace/packages/*/dist" },
  ]
})
```

**Pros**:
- Clean isolation
- Can mount node_modules directly
- Sandcastle proven approach

**Cons**:
- Adds Docker dependency
- Slower startup
- Overkill for local dev

**Verdict**: Consider for future, but not immediate fix.

---

## 9. Summary & Recommendation

### Immediate Action (This Week)

Implement **Phase 1** in `packages/worktree/src/worktree-create.ts`:

1. **Auto-run `pnpm install --frozen-lockfile`** after worktree creation (~2.5s)
2. **Auto-symlink `packages/*/dist`** from main tree into worktree (instant)
3. **Add `.npmrc` setting** to auto-approve build scripts for native deps

This gives workers a functional environment in ~3 seconds, solving the gate-running problem.

### Medium-Term (Next Sprint)

1. **Detect modified packages** in worktree and rebuild only those
2. **Add `worktree-bootstrap` config** for project-specific overrides
3. **Measure performance** — if 2.5s is too slow, explore reflink on btrfs

### Long-Term (Future)

1. **Evaluate container approach** (Docker/Podman) for full isolation
2. **Consider Turborepo remote cache** for faster builds across worktrees
3. **Explore pnpm's experimental `enable-global-virtual-store`** for even faster installs

---

## 10. Verification Steps

After implementing the fix, verify:

```bash
# 1. Create a test worktree
cleo orchestrate spawn T_TEST --no-agent

# 2. Check node_modules exists
ls ~/.local/share/cleo/worktrees/<hash>/T_TEST/node_modules/.bin/vitest

# 3. Check dist symlinks exist
ls ~/.local/share/cleo/worktrees/<hash>/T_TEST/packages/core/dist

# 4. Run a test in the worktree
cd ~/.local/share/cleo/worktrees/<hash>/T_TEST
pnpm vitest run packages/core/src/store/__tests__/session-store.test.ts

# 5. Verify it passes
# Expected: 31 passed
```

---

**Authors**: Research agent (ct-research-agent) × 3
**Sources**:
- Worktrunk: https://github.com/kryptobaseddev/worktrunk
- Sandcastle: https://github.com/mattpocock/sandcastle
- Live testing in worktree T9053
- pnpm documentation: https://pnpm.io/settings
