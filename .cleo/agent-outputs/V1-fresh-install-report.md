# V1 Fresh Install Validation Report — v2026.4.152

**Date**: 2026-04-28  
**Agent**: Validation Team V1 (claude-sonnet-4-6)  
**Commit**: `f3ec270ee`

---

## Summary

**RESULT: GREEN — all smoke tests pass with two build fixes required**

---

## Step-by-Step Results

### Step 1: Version Bump (2026.4.151 → 2026.4.152)
- **Status**: PASS
- Found 19 package.json files via `grep -rl '"version": "2026.4.151"'`
- All 19 files updated with `sed -i`
- Verified no remaining `2026.4.151` references

### Step 2: `pnpm install`
- **Status**: PASS
- Lockfile already up to date
- `Done in 1.7s`

### Step 3: `pnpm run build`
- **Status**: PASS (after 2 fixes — see Issues section)
- Full monorepo build: lafs → contracts → worktree → git-shim → nexus → cant → caamp → core → runtime → adapters → playbooks → cleo → cleo-os
- Exits 0, "Build complete."

### Step 4: `pnpm pack --filter @cleocode/cleo`
- **Status**: PASS
- Tarball: `/mnt/projects/cleocode/cleocode-cleo-2026.4.152.tgz` (2.1MB)
- Also packed all 12 workspace dependencies for fresh-install testing

### Step 5: Tarball inspection
- **Status**: PASS
- `tar -tzf cleocode-cleo-2026.4.152.tgz | grep "^package/src"` → zero results
- No source file leakage confirmed
- `package/package.json` present

### Step 6: Fresh test project setup
- **Status**: PASS
- Created `/tmp/v152-validation/` with `pnpm init`
- All 13 workspace packages packed and installed via `pnpm overrides`
  (necessary because workspace deps resolve to `2026.4.152` not yet on npm)
- Install: `Done in 5.6s`

### Step 7: `npx cleo --version` → `2026.4.152`
- **Status**: PASS
- Output: `2026.4.152`
- Invoked via: `node node_modules/@cleocode/cleo/bin/cleo.js --version`

### Step 8: `cleo init --project-name "v152-validation"`
- **Status**: PASS
- `"success":true`
- Created: .cleo/ directory, config.json, tasks.db, brain.db, conduit.db, injection files
- NEXUS registration succeeded

### Step 9: `cleo add --title "validation task" --type task --priority high --acceptance "a|b|c"`
- **Status**: PASS (with workflow adjustment)
- Task T002 created successfully after creating parent epic T001
- Note: strict lifecycle mode requires `--type epic` for root tasks and `--parent` for child tasks
- Final JSON: `{"success":true,"data":{"task":{"id":"T002",...}}}`

### Step 10: `cleo show T002`
- **Status**: PASS
- Returns full JSON envelope with `"success":true`
- Task data, view.gatesStatus, readyToComplete fields all present

### Step 11: `cleo find "validation"`
- **Status**: PASS
- Returns 2 results (T001 + T002)
- `{"success":true,"data":{"results":[...],"total":2}}`

### Step 12: `cleo dash`
- **Status**: PASS
- Returns project state with `"success":true`
- Shows project "v152-validation", 2 pending tasks

---

## Issues Found and Fixed

### Issue 1: `@cleocode/caamp` DTS build failure
- **Symptom**: `tsc Error: Cannot find name 'console' / Cannot find name 'process'`  
  in `packages/caamp/src/cli.ts` DTS phase
- **Root cause**: `packages/caamp/tsconfig.json` lacked `"types": ["node"]` — TypeScript 6
  stricter DTS build (via tsup) requires explicit node types declaration
- **Fix**: Added `"types": ["node"]` to `packages/caamp/tsconfig.json` compilerOptions

### Issue 2: `Dynamic require of "stream" is not supported` — CRITICAL
- **Symptom**: `cleo --version` crashed with Error at startup when core installed as standalone tarball
- **Root cause**: `openai@4.104.0` was not externalized in `build.mjs` sharedExternals for the
  `@cleocode/core` esbuild bundle. `openai` bundles `node-fetch@2` (CJS) via its
  `node-runtime.mjs` shim. In an ESM bundle context, node-fetch's `require("stream")` calls
  throw via the `__require` shim. This regression was introduced when `openai` was added as
  a runtime dependency in the T1386 PSYCHE LLM Port (v2026.4.141+) but was not externalized.
  It went undetected until fresh-install testing because the workspace development setup
  resolves `openai` from the workspace node_modules where the package loads natively.
- **Fix**: Added `openai`, `/^openai\//`, `@google/generative-ai`, `/^@google\/generative-ai\//`,
  `@anthropic-ai/sdk`, and `/^@anthropic-ai\//` to `sharedExternals` in `build.mjs`.
  These LLM SDKs are loaded at runtime from node_modules and must not be inlined.
- **Impact**: All users installing `@cleocode/core@2026.4.148-2026.4.151` from npm
  would encounter this crash. v2026.4.152 is the fix.

---

## Commit

```
f3ec270ee chore(release): v2026.4.152 — T-THIN-WRAPPER + T-SDK-PUBLIC ship
```

Files changed: 21 (19 package.json version bumps + build.mjs + packages/caamp/tsconfig.json)

---

## Artifacts

- Tarballs at `/mnt/projects/cleocode/cleocode-*.tgz` (all 13 workspace packages)
- Test project: `/tmp/v152-validation/` (node_modules + .cleo/ initialized)
- Commit: `f3ec270ee` on branch `main`
