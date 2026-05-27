# T553 — npm Publish Fix: @cleocode/nexus + tree-sitter peer deps

**Status**: complete
**Date**: 2026-04-13

## Problem

`npm install -g @cleocode/cleo-os` failed with `E404 @cleocode/nexus - Not found`.

Root cause: `@cleocode/cleo@2026.4.31` (published) declared `@cleocode/nexus@0.1.0` as a
dependency, but `@cleocode/nexus` had never been published to npm.

Secondary issue: tree-sitter grammar packages declare conflicting `peerDependencies`
(some want `^0.21.1`, some `^0.22.1`, some `^0.25.0`) while our packages use `^0.22.1`.

## Investigation Findings

| Package | Published | Local | Status |
|---------|-----------|-------|--------|
| `@cleocode/nexus` | MISSING | 0.1.0 | BLOCKER |
| `@cleocode/cleo` | 2026.4.31 | 2026.4.30 | behind |
| `@cleocode/cleo-os` | 2026.4.31 | 2026.4.34 | mismatch |
| All other packages | 2026.4.31 | 2026.4.30 | behind |

**Nexus package state**: `private: false`, `publishConfig.access: "public"`, dist built,
but missing `README.md` and `LICENSE`. No publish pipeline inclusion (was created in T513
epic but not published).

**Tree-sitter peer deps** (grammar package declared versions):
- `tree-sitter-c`: wants `^0.22.4` (compatible with our `^0.22.1`)
- `tree-sitter-cpp`: wants `^0.21.1` (conflict)
- `tree-sitter-go`: wants `^0.25.0` (conflict)
- `tree-sitter-java`: wants `^0.21.1` (conflict)
- `tree-sitter-javascript`: wants `^0.25.0` (conflict)
- `tree-sitter-python`: wants `^0.25.0` (conflict)
- `tree-sitter-ruby`: wants `^0.21.1` (conflict)
- `tree-sitter-rust`: wants `^0.22.1` (compatible)
- `tree-sitter-typescript`: wants `^0.21.0` (conflict)

## Actions Taken

### Fix 1: Created nexus package metadata files

- Created `/mnt/projects/cleocode/packages/nexus/README.md`
- Copied root `LICENSE` (MIT) to `/mnt/projects/cleocode/packages/nexus/LICENSE`

### Fix 2: Published @cleocode/nexus@0.1.0

Published immediately to unblock existing published `@cleocode/cleo@2026.4.31`:

```
+ @cleocode/nexus@0.1.0
```

Published manifest at: https://registry.npmjs.org/@cleocode/nexus/0.1.0

Resolved `workspace:*` for `@cleocode/contracts` to `2026.4.30` (correct).

### Fix 3: Added tree-sitter overrides

Added `"overrides": { "tree-sitter": "^0.22.1" }` to:
- `/mnt/projects/cleocode/packages/cleo/package.json`
- `/mnt/projects/cleocode/packages/cleo-os/package.json`

This tells npm to use our pinned version when resolving the conflicting peer dep requirements
from grammar packages.

### Fix 4: Version bump to 2026.4.35 + full publish

Bumped all 12 packages to `2026.4.35` using `node scripts/version-all.mjs --set 2026.4.35`.
Ran `pnpm run build` (passed clean). Published all packages in dependency order:

1. `@cleocode/contracts@2026.4.35`
2. `@cleocode/lafs@2026.4.35`, `@cleocode/caamp@2026.4.35`, `@cleocode/cant@2026.4.35`, `@cleocode/runtime@2026.4.35`
3. `@cleocode/nexus@2026.4.35`, `@cleocode/adapters@2026.4.35`, `@cleocode/agents@2026.4.35`, `@cleocode/skills@2026.4.35`
4. `@cleocode/core@2026.4.35`
5. `@cleocode/cleo@2026.4.35`
6. `@cleocode/cleo-os@2026.4.35`

## Verification

Tested fresh install in `/tmp/test-cleo-os-install`:

```
npm install @cleocode/cleo-os@2026.4.35
# → added 489 packages (no E404, no blocking errors)

node_modules/.bin/cleo --version
# → 2026.4.35
```

The tree-sitter peer dep warnings remain as `npm warn ERESOLVE overriding peer dependency`
(informational only — npm IS overriding and install succeeds). These are warnings, not errors.
The `overrides` field resolves the conflict at install time.

## npm Published Packages (2026.4.35)

- https://www.npmjs.com/package/@cleocode/nexus (NEW — was missing)
- https://www.npmjs.com/package/@cleocode/cleo-os
- https://www.npmjs.com/package/@cleocode/cleo
- https://www.npmjs.com/package/@cleocode/core
- https://www.npmjs.com/package/@cleocode/contracts
- https://www.npmjs.com/package/@cleocode/caamp
- https://www.npmjs.com/package/@cleocode/lafs
- https://www.npmjs.com/package/@cleocode/cant
- https://www.npmjs.com/package/@cleocode/runtime
- https://www.npmjs.com/package/@cleocode/adapters
- https://www.npmjs.com/package/@cleocode/agents
- https://www.npmjs.com/package/@cleocode/skills

## Files Modified

- `/mnt/projects/cleocode/packages/nexus/README.md` (created)
- `/mnt/projects/cleocode/packages/nexus/LICENSE` (created)
- `/mnt/projects/cleocode/packages/cleo/package.json` (added overrides, version bumped)
- `/mnt/projects/cleocode/packages/cleo-os/package.json` (added overrides, version bumped)
- All package.json files bumped to `2026.4.35` via `version-all.mjs`
