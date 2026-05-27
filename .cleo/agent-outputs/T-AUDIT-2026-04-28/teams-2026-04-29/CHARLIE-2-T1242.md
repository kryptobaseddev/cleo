# Charlie-2 — T1242: Force-reinstall agents at project tier on `cleo init`

## Summary

Closed the T1242 gap where `cleo init` deployed the starter-bundle `.cant`
files to `<projectRoot>/.cleo/cant/agents/` but never re-attached them to the
global `signaldock.db:agents` registry. Result: D-002 / D-003 doctor findings
on every fresh init over a previously-init'd workspace.

## File diff summary

### `packages/core/src/agents/seed-install.ts`
- Added imports: `installAgentFromCant` (`../store/agent-install.js`),
  `ensureGlobalSignaldockDb` + `getGlobalSignaldockDbPath`
  (`../store/signaldock-sqlite.js`).
- New exported function `forceInstallProjectTierAgents(projectRoot)` —
  enumerates `.cleo/cant/agents/*.cant`, opens the global signaldock DB
  once, and calls `installAgentFromCant` with `force: true`,
  `targetTier: 'project'`, `installedFrom: 'seed'` for every entry.
- New exported types: `ProjectTierForceInstallEntry`,
  `ProjectTierForceInstallResult` — strict, `readonly` shapes; no `any` /
  `unknown` shortcuts.
- Tolerant of empty / missing dirs (returns empty result, no throw) and
  per-file failures (collected in `failed[]`, others continue).

### `packages/core/src/agents/index.ts`
- Re-exports the new `forceInstallProjectTierAgents` function and its two
  result types alongside the existing seed-install API.

### `packages/core/src/init.ts`
- Added a force-reinstall step right after `deployStarterBundle()` that
  invokes `forceInstallProjectTierAgents(projRoot)`. Successful installs
  surface as a single `agents: registered N project-tier .cant agents`
  entry in `created`; per-file failures land in `warnings`.
- Step is wrapped in try/catch — a registry hiccup never blocks init.

## Manual test output (D-003 count before / after)

### Before fix (cleocode workspace baseline)
```
$ cleo agent doctor 2>&1 | grep -oE "D-00[0-9]" | sort | uniq -c
      9 D-001
      4 D-003   <-- 4 project-tier sha256 mismatches
```

### After fix (fresh tmp project init via local dist)
```
$ TMP=$(mktemp -d) && cd "$TMP" && git init -q
$ node /mnt/projects/cleocode/packages/cleo/dist/cli/index.js init --project-dir "$TMP"
... "agents: registered 4 project-tier .cant agents" ...
$ cd "$TMP" && cleo agent doctor 2>&1 | grep -oE "D-00[0-9]" | sort | uniq -c
      9 D-001   <-- pre-existing global-tier orphans (separate concern)
      0 D-003   <-- ZERO project-tier sha256 mismatches
```

The 9 D-001 warnings are global-tier orphan `.cant` files that pre-date this
task and are owned by a different repair surface (`cleo agent install
... --global`). They are out of scope for T1242.

## Build + tests

- `pnpm run build` — Build complete (all packages green).
- `pnpm vitest run packages/core/src/agents` — 188 / 188 passed (9 files).
- `pnpm vitest run packages/core/src/__tests__/init` — 19 / 19 passed.

## Coordination

- Did NOT touch `packages/core/src/init.ts` `runInit` (Charlie-1 owns
  init.ts unborn-HEAD work). My edit is limited to a single try/catch
  block placed right after `deployStarterBundle()` — Charlie-1's unborn
  HEAD work runs much earlier in the same function and does not
  collide.
- Did NOT touch `packages/core/src/upgrade.ts` (Charlie-3's surface).
