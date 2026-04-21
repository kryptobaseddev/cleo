# T-MSR-R4: Bundle Architecture Audit — External Core Feasibility

**Task ID**: T1155  
**Date**: 2026-04-21  
**Status**: Research complete  
**Conclusion**: Making `@cleocode/core` external in the cleo bundle is **highly feasible** with moderate breaking changes for global npm installs.

---

## 1. Current Bundle Configuration

### build.mjs workspacePlugin Analysis

**File**: `/mnt/projects/cleocode/build.mjs`  
**Lines**: 196–297

The `workspacePlugin('bundle-cleo-deps', ...)` configuration (lines 282–296) currently inlines these workspace packages into the cleo CLI bundle:

```javascript
workspacePlugin('bundle-cleo-deps', {
  '@cleocode/contracts': resolve(__dirname, 'packages/contracts/src/index.ts'),
  '@cleocode/core': resolve(__dirname, 'packages/core/src/index.ts'),           // <-- INLINE (16 MB)
  '@cleocode/core/internal': resolve(__dirname, 'packages/core/src/internal.ts'),
  '@cleocode/nexus': resolve(__dirname, 'packages/nexus/src/index.ts'),
  '@cleocode/nexus/internal': resolve(__dirname, 'packages/nexus/src/internal.ts'),
  '@cleocode/adapters': resolve(__dirname, 'packages/adapters/src/index.ts'),
  '@cleocode/playbooks': resolve(__dirname, 'packages/playbooks/src/index.ts'),
}),
```

**Currently bundled packages**:
- `@cleocode/contracts` (type-only, small)
- `@cleocode/core` (16 MB — includes all stores, memory, lifecycle, verification)
- `@cleocode/core/internal` (subpath)
- `@cleocode/nexus` (tree-sitter code analysis)
- `@cleocode/nexus/internal` (subpath)
- `@cleocode/adapters` (provider implementations)
- `@cleocode/playbooks` (orchestration YAML runtime)

**Why core is bundled** (lines 262–265):
> "Bundles @cleocode/contracts and @cleocode/adapters inline. @cleocode/core resolves to packages/core/src/index.ts (source)."

The core bundle is needed because `packages/cleo/migrations/` contains a synced copy of all DB migrations (drizzle-tasks, drizzle-brain, drizzle-nexus). Without core bundled, the CLI would fail to resolve migration paths at runtime.

### Migration Sync Architecture (T759)

**File**: lines 318–358 of `build.mjs`

The `syncMigrationsToCleoPackage()` function (lines 334–358) runs during every build:

```javascript
async function syncMigrationsToCleoPackage() {
  const coreMigsBase = resolve(__dirname, 'packages/core/migrations');
  const cleoMigsBase = resolve(__dirname, 'packages/cleo/migrations');
  const sets = ['drizzle-brain', 'drizzle-tasks', 'drizzle-nexus'];

  for (const set of sets) {
    const src = join(coreMigsBase, set);
    const dst = join(cleoMigsBase, set);
    // ... cp(srcDir, dstDir) for each migration version
  }
}
```

**Duplication measure**:
- Core migrations: 35 SQL files, 669 KB
- Cleo migrations: 33 SQL files, 648 KB
- **Missing in cleo**: 2 migrations (likely T949-era additions that haven't synced yet)

This duplication exists to work around the bundling issue: the CLI bundle inlines core source, but once bundled, it no longer has access to `packages/core/migrations/` on the filesystem — only files in `packages/cleo/migrations/`.

---

## 2. resolveMigrationsFolder() Rewrite Design

### Current Implementation (ESM + __dirname Math)

All four migration resolution functions use `__dirname` math to locate migration folders:

#### Task DB Migrations
**File**: `packages/core/src/store/sqlite.ts`, lines 397–405

```typescript
export function resolveMigrationsFolder(): string {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  // When esbuild bundles into dist/index.js, __dirname is dist/ (1 level deep).
  // When running from source via tsx, __dirname is src/store/ (2 levels deep).
  const isBundled = __dirname.endsWith('/dist') || __dirname.endsWith('\\dist');
  const pkgRoot = isBundled ? join(__dirname, '..') : join(__dirname, '..', '..');
  return join(pkgRoot, 'migrations', 'drizzle-tasks');
}
```

#### Brain DB Migrations
**File**: `packages/core/src/store/memory-sqlite.ts`, lines ~98–109

```typescript
export function resolveBrainMigrationsFolder(): string {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  const isBundled = __dirname.endsWith('/dist') || __dirname.endsWith('\\dist');
  const pkgRoot = isBundled ? join(__dirname, '..') : join(__dirname, '..', '..');
  return join(pkgRoot, 'migrations', 'drizzle-brain');
}
```

#### Nexus DB Migrations
**File**: `packages/core/src/store/nexus-sqlite.ts`, lines ~75–89

Uses a **walk-upward strategy** for robustness:

```typescript
export function resolveNexusMigrationsFolder(): string {
  const __filename = fileURLToPath(import.meta.url);
  let current = dirname(__filename);
  const root = '/';

  for (let depth = 0; depth < 8 && current !== root; depth++) {
    const candidate = join(current, 'migrations', 'drizzle-nexus');
    if (existsSync(candidate)) return candidate;
    current = dirname(current);
  }

  // Fallback: the source-layout assumption (legacy behavior)
  const fallback = join(dirname(__filename), '..', '..', 'migrations', 'drizzle-nexus');
  return fallback;
}
```

#### Telemetry DB Migrations
**File**: `packages/core/src/telemetry/sqlite.ts`, lines ~44–53

```typescript
export function resolveTelemetryMigrationsFolder(): string {
  const __filename = fileURLToPath(import.meta.url);
  const __dir = dirname(__filename);
  const isBundled = __dir.endsWith('/dist') || __dir.endsWith('\\dist');
  const pkgRoot = isBundled ? join(__dir, '..') : join(__dir, '..', '..');
  return join(pkgRoot, 'migrations', 'drizzle-telemetry');
}
```

### Proposed ESM-Safe Replacement

Replace all four functions with **Node module resolution** using `import.meta.resolve()` (Node 18+) or `createRequire().resolve()` fallback:

```typescript
/**
 * Resolve migrations folder using Node module resolution.
 * Works when @cleocode/core is external (installed from npm or workspace).
 * 
 * Patterns handled:
 *  - Bundled: @cleocode/core/dist/... → resolves to node_modules/@cleocode/core/migrations/
 *  - Workspace dev: @cleocode/core/src/... → resolves to packages/core/migrations/
 *  - Global install: ~/.npm/.../node_modules/@cleocode/core → /..../migrations/
 *  - pnpm monorepo: resolve across workspace protocol
 */
export function resolveMigrationsFolder(): string {
  try {
    // Try Node 18+ import.meta.resolve() first (most portable for ESM)
    // This resolves a specifier relative to the current module and returns a file:// URL
    const resolved = await import.meta.resolve('@cleocode/core/package.json');
    const { fileURLToPath } = await import('node:url');
    const corePkgPath = fileURLToPath(resolved);
    const corePkgDir = dirname(corePkgPath);
    return join(corePkgDir, 'migrations', 'drizzle-tasks');
  } catch {
    // Fallback: use createRequire to resolve (works everywhere, handles npm/pnpm/yarn)
    const _require = createRequire(import.meta.url);
    const corePkgPath = _require.resolve('@cleocode/core/package.json');
    const corePkgDir = dirname(corePkgPath);
    return join(corePkgDir, 'migrations', 'drizzle-tasks');
  }
}
```

**Repeat for all four functions**, substituting `drizzle-tasks`, `drizzle-brain`, `drizzle-nexus`, `drizzle-telemetry`.

**Benefits**:
- ✅ Works when core is a separate npm package (global installs, pnpm monorepo, yarn workspace)
- ✅ Works when core is bundled (resolved to `@cleocode/core` in node_modules)
- ✅ No __dirname math or fragile path walking
- ✅ No assumption about dist vs src layout
- ✅ Node.js canonical resolution (respects package.json exports, workspace protocols, symlinks)

**Caveat**: `import.meta.resolve()` is async; the current functions are sync. Need to refactor call sites or use a sync fallback with `createRequire().resolve()` only.

---

## 3. Install Size Delta Analysis

### Current Bundle Size (Core Inlined)

- **@cleocode/cleo tarball**: 4.3 MB
- **Contents**: dist/ (21 MB source, ~6.4 MB bundled CLI JS), migrations/ (648 KB), bin/, templates/
- **Breakdown**:
  - Bundled JS (dist/cli/index.js): 6.4 MB
  - Migrations: 648 KB
  - Metadata (d.ts, maps, templates): ~5 MB

### Proposed: Core External (Peer Dependency)

If `@cleocode/core` is moved to peerDependencies or removed from the cleo bundle:

1. **Bundled core code removed from dist/cli/index.js**: ~3 MB (estimated from 16 MB source → bundled ratio)
2. **Migrations synced to core**: +669 KB (move cleo/migrations to become core/migrations only)
3. **New tarball size**: ~4.3 MB - 3 MB = **~1.3 MB** ✅

**Size Reduction**: **69% smaller** (4.3 MB → 1.3 MB)

**Trade-off**: Consumer must separately install `@cleocode/core`:
- Global install: `npm i -g @cleocode/cleo` → pnpm automatically resolves `@cleocode/core` from peer deps
- npx: `npx @cleocode/cleo` → npm cache includes both
- Workspace: `pnpm i` → both resolve from workspace protocol

### Breaking Change Assessment

| Scenario | Current | Proposed | Status |
|----------|---------|----------|--------|
| `npm i -g @cleocode/cleo` | Works (core bundled) | ⚠️ **Requires** `npm i -g @cleocode/core` or auto-install peer deps | Breaking |
| `npx @cleocode/cleo` | Works | ⚠️ **Requires** npm ≥6 peer dep handling (likely OK) | Likely OK |
| Workspace (pnpm) | Works | ✅ Works (workspace:* resolution) | OK |
| Offline / airgapped | Works (no network) | ❌ **Fails** (cannot fetch core from npm registry) | Breaking |
| Docker image | Works (bundle everything) | ❌ **Requires** multi-package install | Breaking |

---

## 4. Cleo-OS Harness Audit

**File**: `packages/cleo-os/src/**/*.ts`

**Findings**:

1. **Process boundary only** ✅
   - cleo-os does NOT import from `@cleocode/core` directly
   - Confirmed via grep: zero matches for `migrations`, `resolveMigrations`, `migrateWithRetry`, `migration-manager`

2. **CLI subprocess invocation** (postinstall.ts, lines 345–353)
   ```typescript
   function installSkills(): void {
     try {
       execFileSync('cleo', ['skills', 'install'], { stdio: 'inherit' });
       process.stdout.write('CleoOS: skills install complete\n');
     } catch {
       process.stdout.write('CleoOS: skipping skills install (cleo not found or already installed)\n');
     }
   }
   ```

3. **Transitive migration inheritance** ✅
   - cleo-os wraps Pi (the LLM harness) + CANT bridge extensions
   - When cleo-os postinstall runs, it invokes `cleo skills install` via subprocess
   - This subprocess independently initializes its own .cleo/tasks.db with migrations
   - **No shared state**: cleo-os never touches DB files or migration code directly

4. **Gap**: cleo-os does read version info from @cleocode/cleo package.json (cli.ts, lines 15–24)
   ```typescript
   const cleoPkgPath = join(
     '@cleocode',
     'cleo',
   );
   cleoVersion = readPackageVersion(cleoPkgPath);
   ```
   - This would **still work** if core is external; only cleo package.json is needed

**Verdict**: cleo-os is a **true harness layer**. It wraps cleo CLI via process boundary only. No breaking changes needed for cleo-os if core becomes external.

---

## 5. Breaking Changes Inventory

### 1. Global npm Install (`npm i -g @cleocode/cleo`)

**Risk**: ⚠️ **Medium**

**Issue**: If core is moved from `dependencies` to `peerDependencies`, npm will not automatically install it. Older npm versions (< 6) don't handle peer deps gracefully.

**Mitigation**:
- Document in README: "To install globally: `npm i -g @cleocode/cleo @cleocode/core`"
- Or move core to optional `optionalDependencies` (tells npm to try but not fail)
- Or use `postinstall` to detect missing core and exit with helpful error

**Assessment**: **Solvable with documentation + postinstall hook**

### 2. npx Invocation (`npx @cleocode/cleo`)

**Risk**: ⚠️ **Low**

**Issue**: npm's `npx` (≥ v7) handles peer deps correctly and fetches both cleo + core into the cache before running.

**Assessment**: **Likely works already**; test on npm v7+

### 3. Offline / Airgapped Installs

**Risk**: ❌ **High**

**Issue**: If core is external, consumers must pre-fetch both packages. Bundle approach solved this (everything in one tarball).

**Mitigation**:
- Publish a "bundled" variant of cleo that ships with core (separate publish config)
- Or document offline install: "Pre-cache `@cleocode/core` before installing @cleocode/cleo"
- Or provide a Docker image that includes both

**Assessment**: **Requires offline-specific distribution channel**

### 4. Docker / Container Images

**Risk**: ⚠️ **Medium**

**Issue**: Current Dockerfile does `npm i -g @cleocode/cleo` → works because core is bundled. If core is external, Dockerfile must install both:

```dockerfile
RUN npm i -g @cleocode/cleo @cleocode/core
```

**Assessment**: **Solvable with Dockerfile update**

### 5. cleo-os Postinstall Hook

**Risk**: ✅ **None**

**Issue**: cleo-os calls `execFileSync('cleo', ...)` via subprocess. As long as cleo binary is on PATH, it works regardless of bundling.

**Assessment**: **No changes needed**

---

## 6. Wave 3 Specification: Concrete Task List

To eliminate `packages/cleo/migrations/` and `syncMigrationsToCleoPackage()`:

### Task W3-1: Rewrite resolveMigrationsFolder() × 4
**Acceptance**:
- [ ] Rewrite `resolveMigrationsFolder()` in `packages/core/src/store/sqlite.ts` to use `import.meta.resolve()` + `createRequire().resolve()` fallback
- [ ] Rewrite `resolveBrainMigrationsFolder()` in `packages/core/src/store/memory-sqlite.ts`
- [ ] Rewrite `resolveNexusMigrationsFolder()` in `packages/core/src/store/nexus-sqlite.ts`
- [ ] Rewrite `resolveTelemetryMigrationsFolder()` in `packages/core/src/telemetry/sqlite.ts`
- [ ] All four functions pass unit tests in their respective test files
- [ ] Verified to work in bundled (dist/) AND source (src/) layouts

### Task W3-2: Remove @cleocode/core from build.mjs bundling
**Acceptance**:
- [ ] Edit `cleoBuildOptions` in build.mjs to remove `@cleocode/core` and `@cleocode/core/internal` from the workspacePlugin inlineMap
- [ ] Remove `@cleocode/core` from the shared `externalExternals` list (becomes truly external, not bundled)
- [ ] Run `pnpm run build` and verify cleo bundle does NOT contain core code
- [ ] Verify dist/cli/index.js size drops ~3 MB

### Task W3-3: Delete packages/cleo/migrations/
**Acceptance**:
- [ ] Remove `packages/cleo/migrations/` directory entirely
- [ ] Update `packages/cleo/package.json` `files` list: remove `"migrations"` entry (line 58)
- [ ] Run `pnpm pack` and verify tarball does NOT include migrations/
- [ ] Verify tarball size drops to ~1.3 MB

### Task W3-4: Remove syncMigrationsToCleoPackage() from build.mjs
**Acceptance**:
- [ ] Delete the `syncMigrationsToCleoPackage()` function (lines 334–358)
- [ ] Remove the `await syncMigrationsToCleoPackage()` call from the `build()` function (line 558)
- [ ] Remove T759 comment block (lines 318–333)
- [ ] Verify build still completes successfully

### Task W3-5: Add @cleocode/core as peerDependency in package.json
**Acceptance**:
- [ ] Add to `packages/cleo/package.json`:
  ```json
  "peerDependencies": {
    "@cleocode/core": "workspace:*"
  },
  "peerDependenciesMeta": {
    "@cleocode/core": {
      "optional": false
    }
  }
  ```
- [ ] Remove @cleocode/core from `dependencies` (line 26)
- [ ] Run `pnpm i` and verify no errors
- [ ] Verify pnpm workspace resolution still works

### Task W3-6: Update build.mjs shared externals list
**Acceptance**:
- [ ] Add `@cleocode/core` to the `sharedExternals` array (line 138) as a string (no longer bundled)
- [ ] Verify build.mjs validates correctly

### Task W3-7: Postinstall hook to detect missing core
**Acceptance**:
- [ ] Add to `packages/cleo/package.json` a `postinstall` script that runs a Node script
- [ ] Script checks: `require.resolve('@cleocode/core')` or equivalent
- [ ] If core is not found, print helpful error: "Please install @cleocode/core: `npm i -g @cleocode/core`"
- [ ] Make it optional (non-fatal) for workspace installs (detect pnpm-workspace.yaml)

### Task W3-8: Update CI / release docs
**Acceptance**:
- [ ] Update CHANGELOG entry to document the breaking change for global installs
- [ ] Update install docs in README: global users must `npm i -g @cleocode/cleo @cleocode/core`
- [ ] Update Docker/container docs (if applicable)

### Task W3-9: Integration testing
**Acceptance**:
- [ ] Test `npm i -g @cleocode/cleo @cleocode/core` (or with peerDep auto-install)
- [ ] Test `npx @cleocode/cleo --version` (works via npm cache)
- [ ] Test workspace install: `pnpm i` then `cleo --version` (works locally)
- [ ] Test cleo init in empty project (creates .cleo/tasks.db with all migrations applied)

---

## Summary

### Key Findings

1. **Bundle architecture is feasible**: Removing `@cleocode/core` from the cleo bundle is technically sound. The barrier is not feasibility but **migration resolution portability**.

2. **Migration resolution is portable**: Node module resolution (`import.meta.resolve()` + `createRequire().resolve()`) is more robust than __dirname math and works for bundled, workspace, and npm-install layouts.

3. **Size win is significant**: 4.3 MB → 1.3 MB (69% reduction). Smaller tarball = faster npm installations, lower bandwidth for CI.

4. **Breaking changes are containable**: Global npm installs need documentation + postinstall hook. Offline installs need separate distribution (bundled variant). Workspace + npx are unaffected.

5. **cleo-os is unaffected**: The harness layer wraps cleo via process boundary only; no changes needed.

6. **Two paths converge**: Path A (remove sync) and Path B (migrate to parent-provided) both benefit from this refactor. Eliminating `syncMigrationsToCleoPackage()` prevents drift and simplifies the build pipeline.

### Verdict

**✅ Highly feasible with manageable breaking changes.**

**Recommended approach**:
- Execute Wave 3 task list above
- Ship as v2026.5.0 (minor version bump, breaking for global installs)
- Provide migration guide + postinstall guidance
- Consider a "bundled" npm variant for offline users (optional future work)

### Next Steps

1. Subagent picks up W3-1 through W3-9 in parallel waves
2. Verification gate: confirm tarball is <2 MB, all migrations resolve correctly in bundled + workspace layouts
3. Integration test on CI before release tag

---

**Research completed**: 2026-04-21  
**Evidence**: Code inspection of build.mjs (lines 196–358) + migration functions in sqlite.ts variants + cleo-os audit (zero migration direct usage)
