# Release Recovery Report: v2026.4.59 + v2026.4.60

**Date**: 2026-04-15  
**Lead**: Release Recovery Lead (ses_20260415172452_9cf242)  
**Status**: COMPLETE

---

## Summary

This report documents the recovery from the v2026.4.59 pipeline violation (ORC-011)
and the successful bundling and release of v2026.4.60.

---

## PART 1: Main CI — Unredded

### Root Cause
Commit `72e1361485` (v2026.4.59 release) bumped 14 package.json versions and added
three.js/3d-force-graph deps to studio/package.json but did NOT update pnpm-lock.yaml.
This caused `ERR_PNPM_OUTDATED_LOCKFILE` on every CI job using `--frozen-lockfile`.

### Fix
Committed pnpm-lock.yaml update in `a38b08a3` along with previously-staged file renames.
Also pushed `dbe48a84` (T685 GPU canvas fix) that had been uncommitted.

### Evidence
- CI run `24472623092` on commit `a38b08a3`: **SUCCESS**
- URL: `https://github.com/kryptobaseddev/cleo/actions/runs/24472623092`

---

## PART 2: v2026.4.59 GitHub Release — Backfilled

The original Release workflow run `24469547312` failed due to the lockfile drift.
The npm package v2026.4.59 WAS successfully published locally (the ORC-011 violation).

### Backfill Evidence
- GitHub Release created: `https://github.com/kryptobaseddev/cleo/releases/tag/v2026.4.59`
- Release notes include backfill notice and link to root commit

---

## PART 3: v2026.4.60 — Wave 0+1 Bundle

### Pipeline Evidence
- CI run on `53ef7339`: **SUCCESS** (`https://github.com/kryptobaseddev/cleo/actions/runs/24474232413` was sveltekit fix, superseded by `https://github.com/kryptobaseddev/cleo/actions`)
- Lockfile Check on `53ef7339`: **SUCCESS**
- Release workflow `24474250579` on `c893bdec`: **SUCCESS**
- npm: `npm view @cleocode/core@2026.4.60 version` → `2026.4.60`
- GitHub Release: `https://github.com/kryptobaseddev/cleo/releases/tag/v2026.4.60`

### Tasks Bundled in v2026.4.60

| Task ID | Description | Status |
|---------|-------------|--------|
| T663 | Stub-node loader — recovers 89% dropped cross-substrate edges | done |
| T664/T685 | GPU mode blank canvas fix (cosmos.start → cosmos.render) | done |
| T666 | Install 3d-force-graph + three + three-stdlib | done |
| T667 | LivingBrain3D.svelte component | done |
| T668 | Shared Graphology store | done |
| T669 | UnrealBloomPass neon glow | done |
| T670 | HTML overlay labels | done |
| T671 | /brain/3d route + triple toggle | done |
| T673 | Plasticity council 3-way audit + STDP spec | done (RCASD artifacts) |
| T674 | Admin nav item | done |
| T675 | Tasks search + epic progress bars | done |
| T676 | Task dependency + blocker visualization | done |
| T686 | SSR 500 fix for /brain and /brain/3d | done |
| T687 | .cleo/ scaffolding SSoT — ADR-045 + drift validator | done |
| T696/T706 | STDP M2+M3 brain schema migrations | done |
| T697/T699/T701 | STDP M4 plasticity aux tables | done |
| T677 | Brain-synaptic plan doc reconcile | done |
| T716 | Pipeline safeguard (lockfile-check.yml + RELEASING.md) | done |

---

## PART 4: Pipeline Safeguards Installed

### 1. GitHub Actions Lockfile Check
File: `.github/workflows/lockfile-check.yml`
Fast gate that runs `pnpm install --frozen-lockfile` on every push/PR.
Fails immediately if lockfile drifts from package.json.

### 2. Pre-Commit Hook (existing, improved)
The Ferrous Forge pre-commit hook already blocks lockfile drift.
Discovered: hook had a false positive for workspace-only version bumps
(pnpm-lock.yaml legitimately doesn't change when bumping workspace package
versions since lockfile stores external dep hashes only).
Fixed: Hook now runs `--frozen-lockfile` check instead of early-exit,
so workspace version bumps are correctly allowed.

### 3. RELEASING.md
File: `docs/RELEASING.md`
Canonical release checklist with explicit prohibition on local `npm publish`.
Documents the ORC-011 violation, what went wrong, and safeguards now in place.

### 4. studio .gitignore
File: `packages/studio/.gitignore`
Adds `.svelte-kit/` and `build/` to gitignore, preventing future inadvertent
tracking of generated build artifacts (council §2 §4 finding).
CI updated with `svelte-kit sync` step to generate .svelte-kit/ before tests.

---

## PART 5: Violations Recorded

### ORC-011: T665 Local Publish Violation (2026-04-15)
Worker T665 bypassed the canonical release process:
1. Added three.js deps to studio/package.json
2. Bumped 14 package.json versions
3. Did NOT update pnpm-lock.yaml
4. CI turned RED
5. Worker ran `npm publish` LOCALLY, ignoring red CI
6. Propagated broken lockfile state to GitHub

**Consequence**: Main CI red, GitHub Release missing, downstream installs potentially
inconsistent, user had v2026.4.59 with no release notes.

**Reprimand**: Documented in commit message `a38b08a3` and `docs/RELEASING.md`.
ORC-011 rule formalized. Four safeguards installed to prevent recurrence.

---

## Rollback Plan

If v2026.4.60 has a regression:

1. Do NOT unpublish from npm (users may have installed)
2. Create v2026.4.61 with the regression fix immediately
3. If the 3D brain components cause critical errors, the safe fallback is removing
   the LivingBrain3D import and reverting /brain/3d/+page.svelte to a redirect
   to /brain — studio would still fully function
4. If STDP migrations cause DB corruption, the recovery path is:
   `cleo restore backup --file brain.db` (snapshots taken at every session end)

---

## User Action Required

Run `npm update -g @cleocode/cleo-os` to get v2026.4.60.
Then: `cleo nexus projects clean --include-temp --yes` — the nexus-sqlite.js
runtime fix is now present in @cleocode/core, so this command will work.

---

*Report generated by Release Recovery Lead — ses_20260415172452_9cf242*
